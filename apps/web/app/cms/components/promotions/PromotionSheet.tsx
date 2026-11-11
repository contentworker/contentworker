import type { Promotion } from '@contentworker/domain';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@contentworker/ui/alert';
import { Button } from '@contentworker/ui/button';
import { Sheet, SheetDescription, SheetHeader, SheetTitle } from '@contentworker/ui/sheet';
import { SkeletonPill, SkeletonText } from '@contentworker/ui/skeleton';
import { useEffect, useRef, useState } from 'react';
import { Ago } from '~/cms/components/ago';
import { ConfirmDialog } from '~/cms/components/ConfirmDialog';
import { ConfirmButton } from '~/cms/components/InlineConfirm';
import { LoadingStatus } from '~/cms/components/loading';
import { ResponsiveSheetContent } from '~/cms/components/responsive-sheet';
import { StatusBadge, ToneBadge } from '~/cms/components/status';
import { When } from '~/cms/components/when';
import { type ActorDirectory, actorLabel } from '~/cms/lib/authorship';
import { plural } from '~/cms/lib/format';
import { ApiError, apiErrorMessage, refusedSave } from '~/cms/lib/management';
import { useClient, useLocalRun } from '../../lib/client-context';
import { useInvalidate, useScopedQuery } from '../../lib/queries';
import {
  copiesLine,
  LongList,
  type Refusal,
  RefusalAlert,
  RiskReasons,
  refusalOf,
  shortId,
  usePromotionViewer,
} from './parts';

/** How often an open record that is applying asks again. */
const APPLYING_REFRESH_MS = 3000;

/**
 * One promotion's record, in a sheet: where it stands (and, while it waits, Approve and Reject for
 * someone who may decide it), why it needed approval and the risk check, what it pins, what it
 * did, and its history. Its status is a polite live region, so an apply that ends while the sheet
 * is open is heard, and the record asks again every few seconds while it applies.
 */
export function PromotionSheet(props: { id: string | null; onClose: () => void }) {
  const { client } = useClient();
  const { id } = props;
  const [polling, setPolling] = useState(false);
  const query = useScopedQuery(['promotion', id], () => client.getPromotion(id ?? ''), {
    enabled: !!id,
    silent: true,
    ...(polling ? { refetchInterval: APPLYING_REFRESH_MS } : {}),
  });
  const p = query.data?.id === id ? query.data : undefined;
  const applying = p?.status === 'applying';
  useEffect(() => setPolling(applying), [applying]);

  return (
    <Sheet open={!!id} onOpenChange={(o) => !o && props.onClose()}>
      <ResponsiveSheetContent className="w-full sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>
            {p ? (
              <>
                Promotion <span className="font-mono">{p.source}</span> →{' '}
                <span className="font-mono">{p.target}</span>
              </>
            ) : (
              'Promotion'
            )}
          </SheetTitle>
          {p ? (
            <SheetDescription>
              {copiesLine(p)} · requested <Ago at={p.createdAt} />
            </SheetDescription>
          ) : (
            <>
              <SheetDescription className="sr-only">The promotion’s record</SheetDescription>
              <SkeletonText width="14rem" />
            </>
          )}
        </SheetHeader>
        <div className="space-y-6 px-4 pb-6">
          {p ? (
            <Record promotion={p} />
          ) : query.isError ? (
            <Alert variant="destructive">
              <AlertTitle>Couldn’t read this promotion</AlertTitle>
              <AlertDescription>
                <p>
                  {query.error instanceof ApiError && query.error.status === 404
                    ? 'It isn’t in this space. The link may be for another space.'
                    : apiErrorMessage(query.error)}
                </p>
              </AlertDescription>
              <AlertAction>
                <Button type="button" variant="outline" size="xs" onClick={() => query.refetch()}>
                  Retry
                </Button>
              </AlertAction>
            </Alert>
          ) : (
            <div aria-busy="true" className="space-y-3">
              <LoadingStatus>Loading the promotion…</LoadingStatus>
              <div aria-hidden="true" className="space-y-3">
                <SkeletonPill />
                <SkeletonText width="80%" />
                <SkeletonText width="60%" />
              </div>
            </div>
          )}
        </div>
      </ResponsiveSheetContent>
    </Sheet>
  );
}

function Record({ promotion: p }: { promotion: Promotion }) {
  const { client } = useClient();
  const { busy, run } = useLocalRun();
  const invalidate = useInvalidate();
  const { directory, canApprove, canReject, access } = usePromotionViewer();
  const [refused, setRefused] = useState<Refusal>();
  const status = useRef<HTMLDivElement>(null);
  // Set once a decision lands, so the confirm hands focus to what happened, not back to Approve.
  const decided = useRef(false);

  const reread = () => invalidate(['promotion', p.id], ['promotions']);

  /**
   * Approves from the confirm, which holds until the answer and says a refusal (in the API's
   * words) or no answer itself. An approval whose apply failed answers with the apply's error,
   * after the record moved to `failed` as this person's: the record is read again, and when it
   * says so the confirm closes on it rather than calling it unapproved.
   */
  const approve = async () => {
    setRefused(undefined);
    try {
      await client.approvePromotion(p.id);
    } catch (err) {
      if (!refusedSave(err)) throw err;
      const now = await client.getPromotion(p.id).catch(() => null);
      await reread();
      const applied =
        now?.status === 'failed' && !!access?.subject && now.decidedBy === access.subject;
      if (!applied) throw err;
    }
    decided.current = true;
    await reread();
  };

  const reject = () =>
    run(async () => {
      setRefused(undefined);
      try {
        await client.rejectPromotion(p.id);
      } catch (err) {
        const refusal = refusalOf(err);
        if (!refusal) throw err;
        setRefused(refusal);
        // A 409 means it was decided meanwhile: read it again, so the record shows how.
        await reread();
        return;
      }
      await reread();
      // Approve and Reject are gone now: the keyboard carries on from what happened.
      status.current?.focus();
    });

  const waiting = p.status === 'awaiting_approval';
  const mine = !!access?.subject && access.subject === p.requestedBy;
  const approvable = canApprove(p);
  const rejectable = canReject(p);

  return (
    <>
      {/* One status region, mounted with the record, so a change of status is heard. */}
      <p role="status" className="sr-only">
        {spoken(p)}
      </p>
      <div ref={status} tabIndex={-1} className="space-y-3 rounded-xl">
        <Standing promotion={p} directory={directory} />
        {refused ? (
          <RefusalAlert
            title="It wasn’t rejected"
            refusal={refused}
            unconfirmed="The decision didn’t answer in time. It may still have gone through: this record updates when it does."
          />
        ) : null}
        {waiting && (approvable || rejectable) ? (
          <div className="flex flex-wrap items-center gap-2">
            {approvable ? (
              <ConfirmDialog
                tone="default"
                message={`Approve and promote into ${p.target}?`}
                note={`This copies ${copiesLine(p).toLowerCase()} from ${p.source} into ${p.target} now, and what is live in ${p.source} goes live there. Readers and webhooks get it at once; there is no undo.`}
                confirmLabel="Approve and promote"
                busy={busy}
                onConfirm={approve}
                onCloseAutoFocus={(e) => {
                  if (!decided.current) return;
                  decided.current = false;
                  e.preventDefault();
                  status.current?.focus();
                }}
              >
                {(ask) => (
                  <Button type="button" disabled={busy} onClick={ask}>
                    Approve and promote…
                  </Button>
                )}
              </ConfirmDialog>
            ) : null}
            <ConfirmButton
              message="Reject this promotion?"
              note={`Nothing is copied into ${p.target}. To promote it later, request it again.`}
              confirmLabel="Reject"
              tone="default"
              busy={busy}
              onConfirm={() => void reject()}
            >
              {(ask) => (
                <Button type="button" variant="outline" disabled={busy} onClick={ask}>
                  {busy ? 'Rejecting…' : 'Reject'}
                </Button>
              )}
            </ConfirmButton>
          </div>
        ) : null}
        {waiting ? (
          <p className="max-w-measure text-muted-foreground text-sm">
            {mine
              ? 'You requested it, so someone else approves or rejects it.'
              : !access
                ? null
                : !rejectable
                  ? 'Deciding it takes a role that can publish content, with no content-type or field limits.'
                  : !approvable
                    ? 'Approving it also takes content:manage, since it copies content types or blocks.'
                    : null}
          </p>
        ) : null}
      </div>

      <RiskReasons promotion={p} />
      <Copies promotion={p} />
      {p.result ? <Outcome promotion={p} /> : null}
      <History promotion={p} directory={directory} />
    </>
  );
}

/** Where it stands in a sentence, for the status region. */
function spoken(p: Promotion): string {
  switch (p.status) {
    case 'awaiting_approval':
      return 'Awaiting approval';
    case 'applying':
      return 'Applying';
    case 'completed':
      return `Promoted into ${p.target}`;
    case 'failed':
      return `The promotion failed. ${p.error ?? ''}`.trim();
    case 'rejected':
      return 'Rejected';
  }
}

/** Where it stands, drawn (the status region above says it). */
function Standing({
  promotion: p,
  directory,
}: {
  promotion: Promotion;
  directory: ActorDirectory;
}) {
  const by = (actor: string | undefined) => actorLabel(actor, directory, 'inSentence');
  switch (p.status) {
    case 'awaiting_approval':
      return (
        <div className="space-y-1.5">
          <StatusBadge status={p.status} />
          <p className="max-w-measure text-sm">
            Nothing is copied into {p.target} until someone other than {by(p.requestedBy)} approves
            it.
          </p>
        </div>
      );
    case 'applying':
      return (
        <div className="space-y-1.5">
          <StatusBadge status={p.status} />
          <p className="max-w-measure text-sm">
            Applying since <Ago at={p.decidedAt ?? p.createdAt} />. This updates when it ends.
          </p>
          <p className="max-w-measure text-muted-foreground text-xs">
            An apply still running an hour after it started is marked failed; what it wrote by then
            stays.
          </p>
        </div>
      );
    case 'completed':
      return (
        <Alert variant="success" role="note">
          <AlertTitle>Promoted into {p.target}</AlertTitle>
          <AlertDescription>
            <p>
              <When at={p.completedAt} />
            </p>
          </AlertDescription>
        </Alert>
      );
    case 'failed':
      return (
        <Alert variant="destructive" role="note">
          <AlertTitle>The promotion failed</AlertTitle>
          <AlertDescription className="space-y-1">
            <p>{p.error ?? 'It stopped without saying why.'}</p>
            <p>
              <When at={p.completedAt} />
            </p>
          </AlertDescription>
        </Alert>
      );
    case 'rejected':
      return (
        <Alert role="note">
          <AlertTitle>Rejected</AlertTitle>
          <AlertDescription>
            <p>
              Rejected by {by(p.decidedBy)}, <When at={p.decidedAt} />. Nothing was copied.
            </p>
          </AlertDescription>
        </Alert>
      );
  }
}

/** What it pins: each content type and entry by version, and the blocks' versions. */
function Copies({ promotion: p }: { promotion: Promotion }) {
  return (
    <section aria-labelledby={`${p.id}-copies`} className="space-y-3">
      <h3 id={`${p.id}-copies`} className="caption">
        What it copies
      </h3>
      {p.contentTypes.length > 0 ? (
        <LongList
          label="Content types"
          items={p.contentTypes}
          keyOf={(t) => t.apiId}
          render={(t) => (
            <>
              <span className="flex-1 truncate font-mono text-xs">{t.apiId}</span>
              <span className="text-muted-foreground text-xs tabular">v{t.version}</span>
            </>
          )}
        />
      ) : null}
      {p.entries.length > 0 ? (
        <LongList
          label="Entries"
          items={p.entries}
          keyOf={(e) => e.entryId}
          render={(e) => (
            <>
              <span className="flex-1 truncate font-mono text-xs" title={e.entryId}>
                {e.contentTypeApiId} · {shortId(e.entryId)}
              </span>
              <span className="text-muted-foreground text-xs tabular">v{e.version}</span>
              {/* Green only once it is live: until the apply publishes it, going live is a plan. */}
              {p.status === 'completed' && p.result?.published.includes(e.entryId) ? (
                <StatusBadge status="published" label="Live" />
              ) : (
                <ToneBadge tone="idle" label={e.publish ? 'Goes live' : 'As a draft'} />
              )}
            </>
          )}
        />
      ) : null}
      {p.blocks ? (
        <p className="text-sm">
          The block catalog (v{p.blocks.catalogVersion})
          {p.blocks.configVersion > 0
            ? ` and block config (v${p.blocks.configVersion})`
            : `; ${p.target}’s block config stays as it is`}
          .
        </p>
      ) : null}
    </section>
  );
}

/** What the apply did: copied and published counts, entries a workflow kept as drafts, mismatches. */
function Outcome({ promotion: p }: { promotion: Promotion }) {
  const r = p.result;
  if (!r) return null;
  return (
    <section aria-labelledby={`${p.id}-result`} className="space-y-3">
      <h3 id={`${p.id}-result`} className="caption">
        {p.status === 'failed' ? 'Written before it stopped' : 'What it did'}
      </h3>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Content types</dt>
        <dd className="tabular">{r.contentTypes.length}</dd>
        <dt className="text-muted-foreground">Entries</dt>
        <dd className="tabular">{r.entries.length}</dd>
        <dt className="text-muted-foreground">Published</dt>
        <dd className="tabular">{r.published.length}</dd>
        {r.blocks ? (
          <>
            <dt className="text-muted-foreground">Blocks</dt>
            <dd>
              {r.blocks.catalog || r.blocks.config
                ? [
                    r.blocks.catalog ? 'Catalog changed' : '',
                    r.blocks.config ? 'Config changed' : '',
                  ]
                    .filter(Boolean)
                    .join(', ')
                : 'Unchanged'}
            </dd>
          </>
        ) : null}
      </dl>
      {r.gated.length > 0 ? (
        <div className="space-y-1.5">
          <p className="text-sm">
            {plural(r.gated.length, 'entry', 'entries')} went as drafts: a workflow publishes{' '}
            {r.gated.length === 1 ? 'it' : 'them'} in {p.target}.
          </p>
          <LongList
            label="Entries that went as drafts"
            items={r.gated}
            keyOf={(id) => id}
            render={(id) => <span className="font-mono text-xs">{id}</span>}
          />
        </div>
      ) : null}
      {r.mismatched.length > 0 ? (
        <Alert variant="warning" role="note">
          <AlertTitle>
            {plural(r.mismatched.length, 'entry doesn’t', 'entries don’t')} match what was pinned
          </AlertTitle>
          <AlertDescription className="space-y-1">
            <p>Their fields in {p.target} differ from the pinned version since the apply.</p>
            <ul className="space-y-0.5">
              {r.mismatched.map((id) => (
                <li key={id} className="font-mono text-xs">
                  {id}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}
    </section>
  );
}

/** Its request, decision and outcome, each with who and when (each is also in the audit log). */
function History({ promotion: p, directory }: { promotion: Promotion; directory: ActorDirectory }) {
  const steps: { what: string; who?: string; at?: string }[] = [
    { what: 'Requested', who: p.requestedBy, at: p.createdAt },
  ];
  if (p.decidedAt) {
    steps.push({
      what: p.status === 'rejected' ? 'Rejected' : 'Approved',
      ...(p.decidedBy ? { who: p.decidedBy } : {}),
      at: p.decidedAt,
    });
  } else if (!p.risk.requiresApproval && p.status !== 'awaiting_approval') {
    steps.push({ what: 'Needed no approval' });
  }
  if (p.completedAt) {
    steps.push({ what: p.status === 'failed' ? 'Failed' : 'Completed', at: p.completedAt });
  }
  return (
    <section aria-labelledby={`${p.id}-history`} className="space-y-2">
      <h3 id={`${p.id}-history`} className="caption">
        History
      </h3>
      <ol className="space-y-1.5 text-sm">
        {steps.map((s) => (
          <li key={s.what} className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-medium">{s.what}</span>
            {s.who ? (
              <span className="text-muted-foreground">
                by {actorLabel(s.who, directory, 'inSentence')}
              </span>
            ) : null}
            {s.at ? (
              <span className="text-muted-foreground">
                <When at={s.at} />
              </span>
            ) : null}
          </li>
        ))}
      </ol>
    </section>
  );
}
