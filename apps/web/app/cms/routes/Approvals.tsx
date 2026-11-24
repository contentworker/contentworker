import type { AgentReview, ContentType, ModerationHold, WorkflowTask } from '@contentworker/domain';
import { Button } from '@contentworker/ui/button';
import { Skeleton } from '@contentworker/ui/skeleton';
import { Textarea } from '@contentworker/ui/textarea';
import { Check, EyeOff, Send, Stamp, X } from 'lucide-react';
import { Fragment, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { Ago } from '~/cms/components/ago';
import { type EntryRef, entryPath } from '~/cms/components/dashboard/entry-titles';
import { useEntriesById } from '~/cms/components/dashboard/use-entries-by-id';
import { type FieldChange, FieldChanges } from '~/cms/components/EntryDiff';
import { ConfirmButton } from '~/cms/components/InlineConfirm';
import { EmptyState, PageHeader, Section } from '~/cms/components/page';
import { StatusBadge, ToneBadge } from '~/cms/components/status';
import { Mark } from '~/components/mark';
import {
  APPROVALS_COUNT_KEY,
  moderationFlagsLabel,
  usePendingAgentReviews,
  usePendingModerationHolds,
  usePendingWorkflowTasks,
} from '../lib/approvals';
import { useClient, useLocalRun } from '../lib/client-context';
import { humanize, plural, toMs, until } from '../lib/format';
import type { PreviewEntry } from '../lib/management';
import { useContentTypesQuery, useInvalidate } from '../lib/queries';
import { useToast } from '../lib/toast';

/**
 * The Approvals inbox: what is waiting on a person in this space, oldest first. Three kinds:
 * workflow steps paused for a human decision (an approval or review node), agent proposals (an
 * enrich, curate or repurpose run that ended `needs_review`), and entries the moderation agent
 * took offline (a hold). Each can be decided here; an event wait is listed so it isn't forgotten,
 * but only the event itself can move it on. A proposal is shown as a diff of the entry's current
 * values against the proposed ones, so nothing is applied unseen.
 */
export function Approvals() {
  const tasks = usePendingWorkflowTasks();
  const reviews = usePendingAgentReviews();
  const holds = usePendingModerationHolds();
  // The shell's count is its own query: whenever these lists refresh, it does too, so the
  // badge never disagrees with the inbox it opens.
  const invalidateCount = useInvalidate();
  useEffect(() => {
    if (tasks.dataUpdatedAt || reviews.dataUpdatedAt || holds.dataUpdatedAt) {
      void invalidateCount(APPROVALS_COUNT_KEY);
    }
  }, [tasks.dataUpdatedAt, reviews.dataUpdatedAt, holds.dataUpdatedAt, invalidateCount]);
  const types = useContentTypesQuery().data;
  const taskItems = useMemo(
    () =>
      [...(tasks.data ?? [])].sort(
        (a, b) => (toMs(a.requestedAt) ?? 0) - (toMs(b.requestedAt) ?? 0),
      ),
    [tasks.data],
  );
  const reviewItems = useMemo(
    () =>
      [...(reviews.data ?? [])].sort((a, b) => (toMs(a.createdAt) ?? 0) - (toMs(b.createdAt) ?? 0)),
    [reviews.data],
  );
  const holdItems = useMemo(
    () =>
      [...(holds.data ?? [])].sort((a, b) => (toMs(a.createdAt) ?? 0) - (toMs(b.createdAt) ?? 0)),
    [holds.data],
  );
  // Every entry on the page is named by its title, from one batched lookup rather than a request
  // per row. Reviews name only the entry, so its record also supplies the type and current values.
  const entryIds = useMemo(
    () => [
      ...taskItems.map((t) => t.entryId),
      ...reviewItems.map((r) => r.entryId),
      ...holdItems.map((h) => h.entryId),
    ],
    [taskItems, reviewItems, holdItems],
  );
  const lookup = useEntriesById(entryIds);
  const total = taskItems.length + reviewItems.length + holdItems.length;
  const loading = tasks.isPending || reviews.isPending || holds.isPending;

  const steps = (
    <Section
      title="Workflow steps"
      description="Pending: the workflow is paused here until someone approves or rejects the step. A wait for an event moves on only when the event arrives."
      flush
    >
      {tasks.isPending ? (
        <RowsSkeleton label="Loading workflow steps" />
      ) : taskItems.length ? (
        <ul className="divide-y">
          {taskItems.map((t) => (
            <TaskRow
              key={t.id}
              task={t}
              entry={lookup.refs.get(t.entryId)}
              resolving={lookup.resolving(t.entryId)}
            />
          ))}
        </ul>
      ) : (
        <p className="px-5 py-4 text-muted-foreground text-sm">
          No workflow step is waiting on a decision.
        </p>
      )}
    </Section>
  );
  const proposals = (
    <Section
      title="Agent proposals"
      description={
        <>
          Needs review: an agent proposed changes to the entry, and nothing is applied until someone
          approves them.
        </>
      }
      flush
    >
      {reviews.isPending ? (
        <RowsSkeleton label="Loading agent proposals" diff />
      ) : reviewItems.length ? (
        <ul className="divide-y">
          {reviewItems.map((r) => {
            const entry = lookup.entries.get(r.entryId);
            return (
              <ReviewRow
                key={r.id}
                review={r}
                entry={entry}
                entryRef={lookup.refs.get(r.entryId)}
                type={types?.find((t) => t.apiId === entry?.contentType)}
                resolving={lookup.resolving(r.entryId)}
              />
            );
          })}
        </ul>
      ) : (
        <p className="px-5 py-4 text-muted-foreground text-sm">
          No agent proposal is waiting for review.
        </p>
      )}
    </Section>
  );

  const held = (
    <Section
      title="Held by moderation"
      description="Unpublished: the moderation agent flagged the entry after it went live and took it offline. It stays offline until someone republishes it or keeps it unpublished."
      flush
    >
      {holds.isPending ? (
        <RowsSkeleton label="Loading moderation holds" />
      ) : holdItems.length ? (
        <ul className="divide-y">
          {holdItems.map((h) => (
            <HoldRow
              key={h.id}
              hold={h}
              entry={lookup.refs.get(h.entryId)}
              typeName={types?.find((t) => t.apiId === h.contentTypeApiId)?.name}
              resolving={lookup.resolving(h.entryId)}
            />
          ))}
        </ul>
      ) : (
        <p className="px-5 py-4 text-muted-foreground text-sm">No entry is held by moderation.</p>
      )}
    </Section>
  );

  // What is waiting comes first: a settled, empty section follows the ones with items (in their
  // own order), so on a phone the first decision opens on the first screen.
  const sections = [
    { key: 'steps', node: steps, empty: !tasks.isPending && taskItems.length === 0 },
    { key: 'proposals', node: proposals, empty: !reviews.isPending && reviewItems.length === 0 },
    { key: 'held', node: held, empty: !holds.isPending && holdItems.length === 0 },
  ];
  const ordered = [...sections.filter((x) => !x.empty), ...sections.filter((x) => x.empty)];

  return (
    <div>
      <PageHeader
        title="Approvals"
        subtitle={
          !loading && total
            ? `${plural(total, 'item')} waiting on a decision, oldest first.`
            : 'Workflow steps, agent proposals and moderation holds waiting on a decision, oldest first.'
        }
      />
      {!loading && total === 0 ? (
        <EmptyState
          icon={Stamp}
          title="Nothing is waiting on you"
          description="When a workflow pauses for an approval, an agent proposes changes to an entry, or moderation takes an entry offline, it shows up here."
        />
      ) : (
        <div className="grid gap-6">
          {ordered.map((x) => (
            <Fragment key={x.key}>{x.node}</Fragment>
          ))}
        </div>
      )}
    </div>
  );
}

/** Placeholder rows in the shape of the list they stand for: title, meta, (a diff,) actions. */
function RowsSkeleton({ label, diff }: { label: string; diff?: boolean }) {
  return (
    <ul className="divide-y" aria-busy="true" aria-label={label}>
      {[0, 1].map((i) => (
        <li key={i} className="grid gap-2 px-5 py-4" aria-hidden="true">
          <Skeleton className="h-5 w-2/5" />
          <Skeleton className="h-4 w-3/5" />
          {diff ? <Skeleton className="h-16 w-full" /> : null}
          <div className="flex gap-2">
            <Skeleton className="h-8 w-24" />
            <Skeleton className="h-8 w-20" />
          </div>
        </li>
      ))}
    </ul>
  );
}

/** An entry's name in a row: its title once known, a placeholder while it resolves. */
function EntryName({ entry, resolving }: { entry: EntryRef | undefined; resolving: boolean }) {
  if (entry) return <>{entry.title}</>;
  if (resolving) return <Skeleton className="inline-block h-3.5 w-24 align-middle" aria-hidden />;
  // Not returned by the lookup: deleted, trashed or hidden from this principal.
  return <>Entry no longer available</>;
}

const KIND_LABEL: Record<WorkflowTask['kind'], string> = {
  approval: 'Approval',
  review: 'Review',
  event: 'Waiting for an event',
};

function TaskRow({
  task,
  entry,
  resolving,
}: {
  task: WorkflowTask;
  entry: EntryRef | undefined;
  resolving: boolean;
}) {
  const { client } = useClient();
  const invalidate = useInvalidate();
  const toast = useToast();
  const { busy, run } = useLocalRun();
  const [note, setNote] = useState('');
  const [noting, setNoting] = useState(false);
  const decidable = task.kind !== 'event';
  const deadline = toMs(task.deadline);
  const overdue = deadline !== null && deadline < Date.now();

  const decide = (decision: 'approved' | 'rejected') =>
    run(async () => {
      await client.decideWorkflowTask(task.id, {
        decision,
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      toast.success(`${decision === 'approved' ? 'Approved' : 'Rejected'} “${task.title}”`);
      await invalidate(['workflow-tasks'], ['workflow-runs'], APPROVALS_COUNT_KEY);
    });

  return (
    <li className="grid gap-2 px-5 py-4" aria-label={task.title}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="min-w-0">
          <h3 className="font-medium text-sm">{task.title}</h3>
          <p className="text-muted-foreground text-xs">
            {KIND_LABEL[task.kind]}
            {task.event ? ` “${task.event}”` : ''} on{' '}
            {/* The task names its content type, so the editor link holds before the title loads. */}
            <Link
              to={entryPath({ contentType: task.contentTypeApiId, id: task.entryId })}
              className="text-link underline-offset-2 hover:underline"
            >
              <EntryName entry={entry} resolving={resolving} />
            </Link>{' '}
            · requested <Ago at={task.requestedAt} />
            {task.assignee ? ` · for ${task.assignee}` : ''}
          </p>
        </div>
        <span className="flex items-center gap-2">
          {overdue ? (
            <ToneBadge tone="bad" label="Overdue" />
          ) : deadline ? (
            <span className="text-muted-foreground text-xs">Due {until(deadline)}</span>
          ) : null}
          <StatusBadge status="pending" />
        </span>
      </div>
      {task.instructions ? (
        <p className="max-w-measure whitespace-pre-line text-sm">{task.instructions}</p>
      ) : null}
      {task.separateDuties ? (
        <p className="text-muted-foreground text-xs">
          Separation of duties: whoever started this run can’t decide it.
        </p>
      ) : null}
      {decidable ? (
        <div className="grid gap-2">
          {noting ? (
            <Textarea
              aria-label={`Note for “${task.title}”`}
              placeholder="Why (optional, kept with the decision)"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="max-w-xl"
            />
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={busy} onClick={() => void decide('approved')}>
              <Check aria-hidden="true" /> Approve
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void decide('rejected')}
            >
              <X aria-hidden="true" /> Reject
            </Button>
            {noting ? null : (
              <Button size="sm" variant="ghost" onClick={() => setNoting(true)}>
                Add a note
              </Button>
            )}
          </div>
        </div>
      ) : null}
    </li>
  );
}

/**
 * The proposal as before/after pairs, in the content type's field order and by its field names.
 * Proposed values are locale-keyed; a locale is named beside the field only when it isn't the
 * one being edited, or the proposal spans several (the edited locale's row comes first).
 */
export function proposalChanges(
  proposed: AgentReview['proposed'],
  current: PreviewEntry | undefined,
  type: ContentType | undefined,
  locale: string,
): FieldChange[] {
  const position = (apiId: string) =>
    type?.fields.find((f) => f.apiId === apiId)?.position ?? Number.MAX_SAFE_INTEGER;
  const changes: FieldChange[] = [];
  const apiIds = Object.keys(proposed ?? {}).sort((a, b) => position(a) - position(b));
  for (const apiId of apiIds) {
    const byLocale = proposed[apiId] ?? {};
    const now = current?.fields[apiId];
    const nowByLocale =
      now && typeof now === 'object' && !Array.isArray(now) ? (now as Record<string, unknown>) : {};
    // The locale being edited first, then the rest in a stable order.
    const locales = Object.keys(byLocale).sort((a, b) =>
      a === locale ? -1 : b === locale ? 1 : a.localeCompare(b),
    );
    const label = type?.fields.find((f) => f.apiId === apiId)?.name ?? humanize(apiId);
    for (const loc of locales) {
      changes.push({
        key: `${apiId}:${loc}`,
        label,
        ...(locales.length > 1 || loc !== locale ? { detail: loc } : {}),
        before: nowByLocale[loc],
        after: byLocale[loc],
      });
    }
  }
  return changes;
}

function ReviewRow({
  review,
  entry,
  entryRef,
  type,
  resolving,
}: {
  review: AgentReview;
  entry: PreviewEntry | undefined;
  entryRef: EntryRef | undefined;
  type: ContentType | undefined;
  resolving: boolean;
}) {
  const { client, conn } = useClient();
  const invalidate = useInvalidate();
  const toast = useToast();
  const { busy, run } = useLocalRun();
  const changes = useMemo(
    () => proposalChanges(review.proposed, entry, type, conn.locale),
    [review.proposed, entry, type, conn.locale],
  );
  const agent = `${humanize(review.workflow)} agent`;
  const name = entryRef?.title;

  const decide = (approve: boolean) =>
    run(async () => {
      await (approve ? client.approveAgentReview(review.id) : client.rejectAgentReview(review.id));
      toast.success(
        approve
          ? `Applied the proposal to ${name ? `“${name}”` : 'the entry'} as a new draft`
          : 'Rejected the proposal',
      );
      await invalidate(['agent-reviews'], ['entry'], ['entries'], APPROVALS_COUNT_KEY);
    });

  return (
    <li
      className="grid gap-3 px-5 py-4"
      aria-label={name ? `Proposal for ${name}` : `${agent} proposal`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="min-w-0">
          <h3 className="font-medium text-sm">
            {entryRef ? (
              <Link to={entryPath(entryRef)} className="underline-offset-2 hover:underline">
                {entryRef.title}
              </Link>
            ) : (
              <EntryName entry={undefined} resolving={resolving} />
            )}
          </h3>
          <p className="flex flex-wrap items-center gap-x-1.5 text-muted-foreground text-xs">
            {entryRef ? <span>{entryRef.typeName} ·</span> : null}
            <Mark className="size-3.5 text-ai" />
            <span>
              Proposed by the {agent} <Ago at={review.createdAt} />
            </span>
          </p>
        </div>
        <StatusBadge status="needs_review" />
      </div>
      {resolving ? (
        <Skeleton className="h-16 w-full" aria-hidden />
      ) : changes.length ? (
        <div className="grid gap-1.5">
          <p className="text-sm">
            {/* Rows are field × locale; the count is of fields. */}
            {`Changes ${plural(new Set(changes.map((c) => c.key.slice(0, c.key.indexOf(':')))).size, 'field')}`}
          </p>
          {entry ? null : (
            <p className="text-muted-foreground text-xs">
              The entry couldn’t be loaded, so its current values aren’t shown.
            </p>
          )}
          <FieldChanges
            changes={changes}
            caption={`Changes proposed to ${name ?? 'the entry'}`}
            beforeLabel="Current"
            afterLabel="Proposed"
          />
        </div>
      ) : (
        <p className="text-muted-foreground text-sm">This proposal changes no fields.</p>
      )}
      {review.notes.length ? (
        <ul className="max-w-measure list-disc pl-5 text-muted-foreground text-sm">
          {review.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {/* Held until the diff is on screen: approving applies these values as a new draft. */}
        <Button size="sm" disabled={busy || resolving} onClick={() => void decide(true)}>
          <Check aria-hidden="true" /> Approve and apply
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void decide(false)}>
          <X aria-hidden="true" /> Reject
        </Button>
      </div>
    </li>
  );
}

function HoldRow({
  hold,
  entry,
  typeName,
  resolving,
}: {
  hold: ModerationHold;
  entry: EntryRef | undefined;
  /** The held type's name, for when the entry itself can't be named. */
  typeName: string | undefined;
  resolving: boolean;
}) {
  const { client } = useClient();
  const invalidate = useInvalidate();
  const toast = useToast();
  const { busy, run } = useLocalRun();
  // The reason typed into Republish's confirm, and only for it: backing out drops it, and Keep
  // unpublished never sends it.
  const [note, setNote] = useState('');
  const name = entry?.title;
  const quoted = name ? `“${name}”` : 'the entry';

  const decide = (republish: boolean) =>
    run(async () => {
      const why = note.trim() || undefined;
      await (republish
        ? client.republishModerationHold(hold.id, why)
        : client.keepModerationHold(hold.id));
      setNote('');
      toast.success(republish ? `Republished ${quoted}` : `Kept ${quoted} unpublished`);
      await invalidate(['moderation-holds'], ['entry'], ['entries'], APPROVALS_COUNT_KEY);
    });

  return (
    <li
      className="grid gap-3 px-5 py-4"
      aria-label={name ? `Held: ${name}` : 'Entry held by moderation'}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="min-w-0">
          <h3 className="font-medium text-sm">
            {entry ? (
              <Link to={entryPath(entry)} className="underline-offset-2 hover:underline">
                {entry.title}
              </Link>
            ) : (
              <EntryName entry={undefined} resolving={resolving} />
            )}
          </h3>
          <p className="text-muted-foreground text-xs">
            {entry?.typeName ?? typeName ?? humanize(hold.contentTypeApiId)} · held by the
            moderation agent <Ago at={hold.createdAt} />
          </p>
        </div>
        <ToneBadge tone="ai" label="Held" />
      </div>
      <p className="max-w-measure text-sm">
        <span className="text-muted-foreground">Flagged for </span>
        {moderationFlagsLabel(hold.flags)}
      </p>
      <div className="flex flex-wrap gap-2">
        {/* Republishing overrides the agent, so it asks first; keeping it offline doesn't. */}
        <ConfirmButton
          message={`Republish ${quoted}?`}
          note="It goes back to delivery as moderation held it, over the agent’s flag. Your name is kept with the decision."
          details={
            <Textarea
              aria-label={`Why republish ${quoted}`}
              placeholder="Why (optional, kept with the decision)"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          }
          confirmLabel="Republish"
          tone="default"
          busy={busy}
          onConfirm={() => void decide(true)}
          onCancel={() => setNote('')}
        >
          {(ask) => (
            <Button size="sm" disabled={busy || resolving} onClick={ask}>
              <Send aria-hidden="true" /> Republish
            </Button>
          )}
        </ConfirmButton>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void decide(false)}>
          <EyeOff aria-hidden="true" /> Keep unpublished
        </Button>
      </div>
    </li>
  );
}
