import type { ContentTypeDraft } from '@contentworker/domain';
import { Alert, AlertDescription, AlertTitle } from '@contentworker/ui/alert';
import { Button } from '@contentworker/ui/button';
import { SkeletonPill, SkeletonText } from '@contentworker/ui/skeleton';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link, useBlocker, useParams } from 'react-router';
import { Ago } from '~/cms/components/ago';
import { TextView } from '~/cms/components/block-config/code-views';
import { CopyButton } from '~/cms/components/copy-button';
import { UNCONFIRMED_NOTE } from '~/cms/components/discard-guard';
import { InlineConfirm } from '~/cms/components/InlineConfirm';
import { LoadingStatus } from '~/cms/components/loading';
import { TryPage, Words } from '~/cms/components/migrations/OutputPreview';
import { RunnerStatus, StopButton } from '~/cms/components/migrations/RunnerParts';
import { StepButton } from '~/cms/components/migrations/step-parts';
import { TemplateApproval } from '~/cms/components/migrations/TemplateApproval';
import { MODEL_SCAFFOLD, TemplateModel } from '~/cms/components/migrations/TemplateModel';
import { TemplatePages } from '~/cms/components/migrations/TemplatePages';
import { TextEdit } from '~/cms/components/migrations/TextEdit';
import { useStepRunner } from '~/cms/components/migrations/use-step-runner';
import { Empty, PageHeader, Section } from '~/cms/components/page';
import { ToneBadge } from '~/cms/components/status';
import { useClient } from '~/cms/lib/client-context';
import { plural } from '~/cms/lib/format';
import {
  ApiError,
  apiErrorMessage,
  isForbidden,
  type MigrationTemplateView,
  type MigrationTryResult,
} from '~/cms/lib/management';
import {
  lockedReason,
  type MigrationRights,
  migrationRights,
  migrationTemplateKey,
  retryingConflicts,
  SCRIPT_MAX_BYTES,
  TEMPLATE_STATUS,
  utf8Bytes,
} from '~/cms/lib/migrations';
import { useInvalidate, useScopedQuery } from '~/cms/lib/queries';
import { useSpaceScopes } from '~/cms/lib/space-access';
import { migrationRunKey } from './Migrations';

/** What a template with no script yet starts from. */
const SCRIPT_SCAFFOLD = `export default function transform(page, ctx) {
  return { fields: {}, blocks: [], assets: [], links: [] };
}
`;

const sameModel = (a: ContentTypeDraft | null, b: ContentTypeDraft | null) =>
  JSON.stringify(a) === JSON.stringify(b);

/**
 * One template of a run, reviewed: the content type its pages become, the script that turns each
 * page into it, a try on the sample pages, the approval, and then its pages. A page's HTML is never
 * here, and whatever came from the source site or its script is drawn as text.
 */
export function MigrationTemplatePage() {
  const params = useParams();
  const runId = decodeURIComponent(params.runId ?? '');
  const templateId = decodeURIComponent(params.templateId ?? '');
  const { client } = useClient();
  const template = useScopedQuery(
    migrationTemplateKey(runId, templateId),
    () => client.getMigrationTemplate(runId, templateId),
    { silent: true, staleTime: 0 },
  );
  if (template.isPending) return <TemplateSkeleton />;
  if (template.isError && !template.data) {
    const missing = template.error instanceof ApiError && template.error.status === 404;
    return (
      <>
        <PageHeader title={missing ? 'Template not found' : 'Migration template'} />
        {missing || isForbidden(template.error) ? (
          <Section title={missing ? 'Nothing here' : 'Not for your role'}>
            <Empty
              action={
                <Button asChild variant="outline" size="sm">
                  <Link to={`/migrations/${encodeURIComponent(runId)}`}>Back to the run</Link>
                </Button>
              }
            >
              {missing
                ? 'This template isn’t in the run. The pages may have been clustered again since.'
                : 'Your role in this space can’t see migrations: reading them takes migration:run or content:manage.'}
            </Empty>
          </Section>
        ) : (
          <Alert variant="destructive">
            <AlertTitle>The template didn’t load</AlertTitle>
            <AlertDescription>
              <p>{apiErrorMessage(template.error)}</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-2"
                onClick={() => void template.refetch()}
              >
                Try again
              </Button>
            </AlertDescription>
          </Alert>
        )}
      </>
    );
  }
  return (
    <Review
      key={`${runId}/${templateId}`}
      template={template.data}
      refetch={() => template.refetch()}
      stale={template.isError ? apiErrorMessage(template.error) : undefined}
    />
  );
}

function Review({
  template: t,
  refetch,
  stale,
}: {
  template: MigrationTemplateView;
  refetch: () => Promise<unknown>;
  /** Why it couldn't be read again: what shows is the last read. */
  stale: string | undefined;
}) {
  const { client, conn } = useClient();
  const queryClient = useQueryClient();
  const invalidate = useInvalidate();
  const rights = migrationRights(useSpaceScopes());
  const viewQuery = useScopedQuery(
    migrationRunKey(t.runId),
    () => client.getMigrationRun(t.runId),
    { silent: true },
  );
  const view = viewQuery.data;
  // Read by its hash: the text on screen is always the version the template names, or none.
  const script = useScopedQuery(
    [...migrationTemplateKey(t.runId, t.id), 'script', t.script?.sha256 ?? null],
    () => client.getMigrationScript(t.runId, t.id),
    { silent: true, enabled: t.script !== null, staleTime: Number.POSITIVE_INFINITY },
  );
  const text = t.script && script.data?.sha256 === t.script.sha256 ? script.data.script : null;
  // The answer is a newer version than the template read here: read the template again.
  const behind = t.script !== null && script.data !== undefined && text === null;
  const refetchRef = useRef(refetch);
  refetchRef.current = refetch;
  useEffect(() => {
    if (behind) void refetchRef.current();
  }, [behind]);

  const [reviewed, setReviewed] = useState(t.reviewDigest);
  const [editing, setEditing] = useState<{ what: 'model' | 'script'; from: string } | null>(null);
  const [dirty, setDirty] = useState(false);
  const [unconfirmed, setUnconfirmed] = useState(false);
  const editModel = useRef<HTMLButtonElement>(null);
  const editScript = useRef<HTMLButtonElement>(null);
  const [focusBack, setFocusBack] = useState<'model' | 'script' | null>(null);
  useEffect(() => {
    if (!focusBack) return;
    setFocusBack(null);
    (focusBack === 'model' ? editModel : editScript).current?.focus();
  }, [focusBack]);

  // An edit is never left quietly: leaving the page asks, closing the tab warns.
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirty && currentLocation.pathname !== nextLocation.pathname,
  );
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const key = [conn.space, conn.environment, ...migrationTemplateKey(t.runId, t.id)];
  const show = (next: MigrationTemplateView) => queryClient.setQueryData(key, next);
  const refreshRun = () => viewQuery.refetch();
  /** The person's own save is read as they wrote it, unless the other half moved under it too. */
  const saved = (next: MigrationTemplateView, kept: boolean) => {
    if (kept && reviewed === t.reviewDigest) setReviewed(next.reviewDigest);
    show(next);
    void refreshRun();
  };

  const locked = lockedReason(t, view?.run);
  const canEdit = rights?.run === true && !locked;
  const status = TEMPLATE_STATUS[t.status];
  const close = () => {
    setFocusBack(editing?.what ?? null);
    setEditing(null);
    setDirty(false);
    setUnconfirmed(false);
  };
  const open = (what: 'model' | 'script') =>
    setEditing({
      what,
      from: what === 'model' ? JSON.stringify(t.proposal) : (t.script?.sha256 ?? ''),
    });

  return (
    <div className="space-y-4">
      <PageHeader
        title={t.label}
        subtitle={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span>{plural(t.pageCount, 'page')} of</span>
            <Link
              to={`/migrations/${encodeURIComponent(t.runId)}`}
              className="hit-area text-link hover:underline wrap-anywhere"
            >
              {view?.run.name ?? 'the run'}
            </Link>
            <Link
              to={`/migrations/${encodeURIComponent(t.runId)}?template=${encodeURIComponent(t.id)}#pages`}
              className="hit-area text-link hover:underline"
            >
              Show its pages
            </Link>
          </span>
        }
        actions={<ToneBadge tone={status.tone} label={status.label} />}
      />
      {blocker.state === 'blocked' ? (
        <InlineConfirm
          message="The edit isn’t saved. Leave without saving it?"
          note={unconfirmed ? UNCONFIRMED_NOTE : 'Nothing has been saved.'}
          cancelLabel="Stay"
          returnFocus={() => document.querySelector<HTMLElement>('main textarea, textarea')}
          onCancel={() => blocker.reset?.()}
        >
          <Button type="button" size="sm" variant="destructive" onClick={() => blocker.proceed?.()}>
            Leave without saving
          </Button>
        </InlineConfirm>
      ) : null}
      {stale ? (
        <p role="status" className="text-muted-foreground text-xs">
          The template couldn’t be read again: {stale} This is the last read.
        </p>
      ) : null}
      {locked ? (
        <p className="max-w-measure text-muted-foreground text-sm">{locked}</p>
      ) : rights && !rights.run ? (
        <p className="text-muted-foreground text-xs">
          Changing the model or script, and trying it, take migration:run. You can read them here.
        </p>
      ) : null}
      <Section
        title="Content model"
        description="The content type its pages become. Nothing in the space’s model changes until it is approved."
        actions={
          canEdit && editing === null ? (
            <Button
              ref={editModel}
              type="button"
              size="sm"
              variant="outline"
              onClick={() => open('model')}
            >
              {t.proposal ? 'Edit model' : 'Write model'}
            </Button>
          ) : undefined
        }
      >
        {editing?.what === 'model' ? (
          <TextEdit
            label="Content model as JSON"
            hint={`${t.contentTypeId ? `Its apiId stays “${t.contentTypeId}”: the template was approved as that content type. ` : ''}A content type’s definition. It needs a URL pattern and exactly one blocks field; sourceUrl is added when left out. Preview, layout, agent instructions and field help are dropped: add them on the content type after it is approved.`}
            initial={JSON.stringify(t.proposal ?? MODEL_SCAFFOLD, null, 2)}
            check={(json) => modelProblem(json, t.contentTypeId)}
            changedUnder={JSON.stringify(t.proposal) !== editing.from}
            saveLabel="Propose model"
            onDirty={setDirty}
            onUnconfirmed={() => setUnconfirmed(true)}
            onClose={close}
            onSave={async (json) => {
              const next = await retryingConflicts(() =>
                client.proposeMigrationModel(t.runId, t.id, JSON.parse(json)),
              );
              saved(next, next.script?.sha256 === t.script?.sha256);
            }}
          />
        ) : t.proposal ? (
          <TemplateModel model={t.proposal} />
        ) : (
          <Empty>No content model is proposed yet.</Empty>
        )}
      </Section>
      <Section
        title="Import script"
        description={
          t.script ? (
            <span className="flex flex-wrap items-center gap-x-2">
              <span>SHA-256</span>
              <code className="font-mono text-xs wrap-anywhere">{t.script.sha256}</code>
              <span>{plural(t.script.bytes, 'byte')}</span>
            </span>
          ) : (
            'Turns each page into the model’s fields and blocks, in a sandbox with no network.'
          )
        }
        actions={
          editing === null ? (
            <div className="flex flex-wrap gap-2">
              {text ? <CopyButton text={text} label="Copy script" /> : null}
              {canEdit && (text !== null || !t.script) ? (
                <Button
                  ref={editScript}
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => open('script')}
                >
                  {t.script ? 'Edit script' : 'Write script'}
                </Button>
              ) : null}
            </div>
          ) : undefined
        }
      >
        {editing?.what === 'script' ? (
          <TextEdit
            label="Import script"
            hint="An ES module whose default export takes (page, ctx) and returns { fields, blocks, assets, links }. At most 256 KiB. Saving stores it without running it."
            initial={text ?? SCRIPT_SCAFFOLD}
            check={scriptProblem}
            changedUnder={(t.script?.sha256 ?? '') !== editing.from}
            saveLabel="Save script"
            onDirty={setDirty}
            onUnconfirmed={() => setUnconfirmed(true)}
            onClose={close}
            onSave={async (source) => {
              const next = await retryingConflicts(() =>
                client.setMigrationScript(t.runId, t.id, source),
              );
              saved(next, sameModel(next.proposal, t.proposal));
            }}
          />
        ) : !t.script ? (
          <Empty>No import script is written yet.</Empty>
        ) : text !== null ? (
          <TextView text={text} label="Import script" />
        ) : script.isError || (behind && !script.isFetching) ? (
          <Alert variant="destructive">
            <AlertTitle>The script didn’t load</AlertTitle>
            <AlertDescription>
              <p>
                {script.isError
                  ? apiErrorMessage(script.error)
                  : 'It was saved again while it was read.'}
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-2"
                onClick={() => void refetch().then(() => script.refetch())}
              >
                Try again
              </Button>
            </AlertDescription>
          </Alert>
        ) : (
          <div aria-busy="true">
            <LoadingStatus>Loading the import script…</LoadingStatus>
            <SkeletonText width="60%" />
          </div>
        )}
      </Section>
      <Section
        title="Try"
        description="Runs the stored script on the sample pages and scores what comes back. Nothing is written but the summary."
      >
        <TemplateTry
          template={t}
          threshold={view?.run.threshold}
          rights={rights}
          editing={editing !== null}
          reload={async () => {
            await refetch();
            void refreshRun();
          }}
        />
      </Section>
      <Section title="Approve">
        <TemplateApproval
          template={t}
          runTypes={(view?.templates ?? []).flatMap((x) =>
            x.contentTypeId ? [x.contentTypeId] : [],
          )}
          canApprove={rights?.manage}
          reviewed={reviewed}
          onReviewed={setReviewed}
          scriptShown={text !== null}
          editing={editing !== null}
          canEdit={rights?.run === true}
          runFailed={view?.run.status === 'failed'}
          reload={refetch}
          onApproved={(a) => {
            show(a.template);
            // Read again for what its pages are waiting on, which an approval doesn't answer.
            void refetch();
            void refreshRun();
            void invalidate(['content-types']);
          }}
          onReopened={(next) => {
            show(next);
            void refreshRun();
          }}
        />
      </Section>
      <Section title="Transform and load" flush>
        <TemplatePages
          template={t}
          rights={rights}
          reload={async () => {
            await Promise.all([
              refetch(),
              refreshRun(),
              invalidate(['migrations', 'run', t.runId, 'pages'], ['entries']),
            ]);
          }}
        />
      </Section>
    </div>
  );
}

/** The last try in words, the try itself, and what this visit's one returned page by page. */
function TemplateTry({
  template: t,
  threshold,
  rights,
  editing,
  reload,
}: {
  template: MigrationTemplateView;
  threshold: number | undefined;
  rights: MigrationRights | undefined;
  editing: boolean;
  reload: () => Promise<unknown>;
}) {
  const { client } = useClient();
  const runner = useStepRunner(reload);
  const [tried, setTried] = useState<MigrationTryResult | null>(null);
  const last = t.lastTry;
  const old = (sha: string) => sha !== t.script?.sha256;
  const step = !t.proposal
    ? { available: false, reason: 'Propose its content model first.' }
    : !t.script
      ? { available: false, reason: 'Write its import script first.' }
      : editing
        ? {
            available: false,
            reason: 'Save or discard the edit first: a try runs the stored script.',
          }
        : { available: true };

  const run = () =>
    runner.run('try', { title: 'The try didn’t finish', loop: true }, async (signal) => {
      try {
        const r = await client.tryMigrationScript(t.runId, t.id, signal);
        setTried(r);
        return {
          line: `Tried ${plural(r.summary.pages, 'sample page')}: ${r.summary.passed} passed, mean score ${r.summary.meanScore.toFixed(2)}.`,
        };
      } catch (err) {
        if (signal.aborted) return { line: 'Stopped. The try may still finish on the server.' };
        throw err;
      }
    });

  return (
    <div className="space-y-4">
      {last ? (
        <div className="space-y-2">
          <p className="text-sm">
            Last tried <Ago at={last.at} />: {last.passed} of {plural(last.pages, 'sample page')}{' '}
            passed, {last.ok} fit the model, mean score {last.meanScore.toFixed(2)}
            {threshold !== undefined ? ` (a page needs ${threshold})` : ''}.
          </p>
          {old(last.scriptSha256) ? (
            <p className="text-ui text-wait">That was an earlier script. Try this one.</p>
          ) : null}
          {!tried ? <Words title="Problems found" lines={last.problems} /> : null}
        </div>
      ) : (
        <p className="text-muted-foreground text-sm">Not tried yet.</p>
      )}
      <RunnerStatus runner={runner} />
      {rights === undefined ? (
        <SkeletonPill aria-hidden="true" />
      ) : rights.run ? (
        runner.looping ? (
          <StopButton runner={runner} />
        ) : (
          <div className="space-y-1">
            <StepButton
              ref={runner.button('try')}
              step={step}
              busy={runner.busy}
              describedBy={`try-why-${t.id}`}
              label="Try on sample pages"
              onClick={() => void run()}
            />
            {!step.available ? (
              <p id={`try-why-${t.id}`} className="text-muted-foreground text-xs">
                {step.reason}
              </p>
            ) : null}
          </div>
        )
      ) : null}
      {tried && !runner.busy ? (
        <>
          {old(tried.summary.scriptSha256) ? (
            <p className="text-ui text-wait">These are an earlier script’s results.</p>
          ) : null}
          <ul aria-label="Sample pages tried" className="space-y-3">
            {tried.results.map((r) => (
              <TryPage key={r.pageId} result={r} threshold={threshold} model={t.proposal} />
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

/** Why the model's text can't be sent: JSON, and an object. What it must hold is the API's to say. */
function modelProblem(text: string, held: string | null): string | undefined {
  try {
    const v: unknown = JSON.parse(text);
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      return 'The model must be a JSON object.';
    }
    const { apiId } = v as { apiId?: unknown };
    return held !== null && apiId !== held
      ? `apiId: must stay “${held}”. The template was approved as that content type, and its loaded entries are of it.`
      : undefined;
  } catch (err) {
    return `This isn’t valid JSON: ${err instanceof Error ? err.message : 'it couldn’t be read'}`;
  }
}

function scriptProblem(text: string): string | undefined {
  if (!text.trim()) return 'The script is empty.';
  const bytes = utf8Bytes(text);
  return bytes > SCRIPT_MAX_BYTES
    ? `The script is ${Math.ceil(bytes / 1024)} KiB. It can be at most 256 KiB.`
    : undefined;
}

function TemplateSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true">
      <LoadingStatus>Loading the migration template…</LoadingStatus>
      <PageHeader
        title={<SkeletonText width="min(18rem, 60vw)" />}
        subtitle={<SkeletonText width="min(14rem, 50vw)" />}
        actions={<SkeletonPill />}
      />
      {['Content model', 'Import script', 'Try', 'Approve', 'Transform and load'].map((title) => (
        <Section key={title} title={title}>
          <div aria-hidden="true">
            <SkeletonText width="50%" />
          </div>
        </Section>
      ))}
    </div>
  );
}
