import { Alert, AlertDescription, AlertTitle } from '@contentworker/ui/alert';
import { Button } from '@contentworker/ui/button';
import { SkeletonPill } from '@contentworker/ui/skeleton';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { InlineConfirm } from '~/cms/components/InlineConfirm';
import { useClient } from '~/cms/lib/client-context';
import {
  type MigrationApproval,
  type MigrationTemplateView,
  refusedSave,
} from '~/cms/lib/management';
import { approvalLine, retryingConflicts } from '~/cms/lib/migrations';
import { useScopedQuery } from '~/cms/lib/queries';
import { HELD, StepNotice, sentence } from './step-parts';
import { stepFailure } from './use-step-runner';

/**
 * Approving a template: the one step that changes the space's model, so it is confirmed on the page,
 * beside what is being approved, naming the content type it creates or revises. It sends the digest
 * of the version the person read; a version that moved on while the page was open has to be read
 * (and said to be) before it can be approved, whether this page noticed or the API's 409 did.
 */
export function TemplateApproval({
  template: t,
  runTypes,
  canApprove,
  reviewed,
  onReviewed,
  scriptShown,
  editing,
  runFailed,
  reload,
  onApproved,
}: {
  template: MigrationTemplateView;
  /** Content types the run's templates already hold: a type of that API ID is revised. */
  runTypes: readonly string[];
  canApprove: boolean | undefined;
  /** The digest of the version on screen that the person has read. */
  reviewed: string;
  onReviewed: (digest: string) => void;
  /** The script on screen is the template's own: it is read by its hash. */
  scriptShown: boolean;
  /** The model or script is open in an editor, so what's on screen isn't what would be approved. */
  editing: boolean;
  runFailed: boolean;
  reload: () => Promise<unknown>;
  onApproved: (a: MigrationApproval) => void;
}) {
  const { client } = useClient();
  const types = useScopedQuery(['content-types'], () => client.listContentTypes(), {
    silent: true,
  }).data;
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<MigrationApproval | null>(null);
  const [failed, setFailed] = useState<{ title: string; message: string } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const said = useRef<HTMLParagraphElement>(null);
  const changed = t.status !== 'approved' && t.reviewDigest !== reviewed;
  // The changed version the notice was raised for. Reading is said of that one only: if it changes
  // again meanwhile, the notice starts over, so a press meant for one version can't take another.
  const [offered, setOffered] = useState(t.reviewDigest);
  const again = changed && offered !== reviewed && offered !== t.reviewDigest;
  useEffect(() => {
    if (!changed) setOffered(reviewed);
    else setOffered((o) => (o === reviewed ? t.reviewDigest : o));
  }, [changed, reviewed, t.reviewDigest]);
  // What was being confirmed is no longer what is stored.
  useEffect(() => {
    if (changed) setAsking(false);
  }, [changed]);
  useEffect(() => {
    if (answer) said.current?.focus();
  }, [answer]);

  const approve = async (digest: string) => {
    if (busy) return;
    setBusy(true);
    setFailed(null);
    try {
      const a = await retryingConflicts(() =>
        client.approveMigrationTemplate(t.runId, t.id, digest),
      );
      setAnswer(a);
      onApproved(a);
    } catch (err) {
      await reload();
      // A 409 over a changed template shows as `changed` once it is read again; any other 409 (the
      // API ID is taken, another approval is under way) says its own reason.
      const told = t.status === 'approved';
      setFailed({
        title: refusedSave(err)
          ? told
            ? 'It wasn’t told'
            : 'It wasn’t approved'
          : told
            ? 'It may not have been told'
            : 'The approval didn’t confirm',
        message: refusedSave(err)
          ? stepFailure(err)
          : `${sentence(stepFailure(err))}Its status above is read again: press again if it hasn’t changed.`,
      });
    } finally {
      setBusy(false);
      setAsking(false);
    }
  };

  const apiId = t.proposal?.apiId;
  const exists = apiId && types ? types.some((x) => x.apiId === apiId) : undefined;
  const mine = !!apiId && runTypes.includes(apiId);
  const does =
    exists === undefined
      ? 'creates (or revises, if this run made it)'
      : exists && mine
        ? 'revises'
        : 'creates';

  if (t.status === 'approved') {
    return (
      <div className="space-y-3">
        <p
          ref={said}
          tabIndex={-1}
          role="status"
          className="max-w-measure text-sm outline-none wrap-anywhere"
        >
          {answer ? approvalLine(answer) : 'Approved.'}{' '}
          {t.contentTypeId ? (
            <Link
              to={`/content/${encodeURIComponent(t.contentTypeId)}`}
              className="hit-area text-link hover:underline"
            >
              Open its content type
            </Link>
          ) : null}
        </p>
        {(answer === null || answer.reason === 'unreachable') && canApprove ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-disabled={busy || undefined}
            className={HELD}
            onClick={() => {
              if (!busy) void approve(t.reviewDigest);
            }}
          >
            {busy ? 'Telling it…' : answer ? 'Tell it again' : 'Tell its background run'}
          </Button>
        ) : null}
        {failed ? <StepNotice title={failed.title}>{failed.message}</StepNotice> : null}
      </div>
    );
  }

  const why = runFailed
    ? 'The run failed, so its templates can’t be approved.'
    : !t.proposal
      ? 'Propose its content model first.'
      : !t.script
        ? 'Write its import script first.'
        : editing
          ? 'Save or discard the edit first: approving takes the stored version.'
          : !scriptShown
            ? 'The import script on screen has to load first.'
            : changed
              ? 'Read the changed version first.'
              : undefined;

  return (
    <div className="space-y-3">
      {changed ? (
        <Alert variant="warning">
          <AlertTitle>This template changed since you read it</AlertTitle>
          <AlertDescription>
            <p>
              Its model or script was saved again, and nothing was approved.{' '}
              {editing
                ? 'Save or discard the edit to see the new version.'
                : !scriptShown
                  ? 'The new version’s script is still loading.'
                  : again
                    ? 'It changed once more while this notice was up.'
                    : 'The version above is the new one: read it again.'}
            </p>
            {canApprove && !editing && scriptShown ? (
              <Button
                key={t.reviewDigest}
                type="button"
                size="sm"
                variant="outline"
                className="mt-2"
                onClick={() => {
                  if (again) {
                    setOffered(t.reviewDigest);
                    return;
                  }
                  setFailed(null);
                  onReviewed(t.reviewDigest);
                  trigger.current?.focus();
                }}
              >
                {again ? 'Show me the newest' : 'I’ve read this version'}
              </Button>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : failed ? (
        <StepNotice title={failed.title}>{failed.message}</StepNotice>
      ) : null}
      <p className="max-w-measure text-muted-foreground text-sm">
        Approving creates and publishes its content type, and settles its model and script: neither
        can be changed after that. Its pages are only taken in once it is approved.
      </p>
      {asking && apiId ? (
        <InlineConfirm
          message={
            <>
              Approve “{t.label}”? This {does} and publishes the content type{' '}
              <span>{t.proposal?.name}</span> (<code className="font-mono">{apiId}</code>).
            </>
          }
          note="Its model and script can’t be changed afterwards. No entries are made yet."
          details={
            exists && !mine ? (
              <p className="text-ui text-wait">
                A content type “{apiId}” is already here and isn’t this migration’s, so the approval
                will be refused. Propose another API ID.
              </p>
            ) : undefined
          }
          // Held while it runs: an approval can't be called back.
          onCancel={() => {
            if (!busy) setAsking(false);
          }}
          returnFocus={() => trigger.current}
        >
          <Button
            type="button"
            size="sm"
            aria-disabled={busy || undefined}
            className={HELD}
            onClick={() => {
              if (!busy) void approve(reviewed);
            }}
          >
            {busy ? 'Approving…' : 'Approve template'}
          </Button>
        </InlineConfirm>
      ) : canApprove ? (
        <div className="space-y-2">
          <Button
            ref={trigger}
            type="button"
            size="sm"
            // Held, not disabled, so “I’ve read this version” can hand it focus.
            aria-disabled={why ? true : undefined}
            className={HELD}
            aria-describedby={why ? `approve-why-${t.id}` : undefined}
            onClick={() => {
              if (!why) {
                setFailed(null);
                setAsking(true);
              }
            }}
          >
            {t.status === 'approving' ? 'Finish approving…' : 'Approve…'}
          </Button>
          {why ? (
            <p id={`approve-why-${t.id}`} className="text-muted-foreground text-xs">
              {why}
            </p>
          ) : null}
        </div>
      ) : canApprove === undefined ? (
        <SkeletonPill aria-hidden="true" />
      ) : (
        <p className="text-muted-foreground text-xs">Approving takes content:manage.</p>
      )}
    </div>
  );
}
