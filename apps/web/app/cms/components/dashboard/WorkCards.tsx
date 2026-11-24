import type {
  AgentReview,
  ModerationHold,
  Release,
  ScheduledAction,
  WorkflowTask,
} from '@contentworker/domain';
import { Card, CardContent, CardHeader, CardTitle } from '@contentworker/ui/card';
import { Skeleton } from '@contentworker/ui/skeleton';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { StatusBadge, ToneBadge } from '~/cms/components/status';
import { moderationFlagsLabel } from '../../lib/approvals';
import { humanize, toMs } from '../../lib/format';
import { type EntryRef, entryPath, shortDateTime } from './entry-titles';

/** How many rows a work card shows before pointing elsewhere for the rest. */
export const WORK_ROWS = 8;

/** Async slice a work card renders: loading, failed, or loaded. */
export interface Loadable<T> {
  readonly data: T | undefined;
  readonly isLoading: boolean;
  readonly isError: boolean;
}

function WorkCard(props: {
  title: string;
  count?: ReactNode;
  description: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-baseline justify-between gap-2">
          <h2 className="font-heading font-medium text-base">{props.title}</h2>
          {props.count !== undefined && (
            <span className="text-muted-foreground text-xs tabular-nums">{props.count}</span>
          )}
        </CardTitle>
        <p className="text-muted-foreground text-sm">{props.description}</p>
      </CardHeader>
      <CardContent className="space-y-3">
        {props.children}
        {props.footer}
      </CardContent>
    </Card>
  );
}

function Rows<T>(props: {
  slice: Loadable<readonly T[]>;
  empty: string;
  error: string;
  limit?: number;
  render: (item: T) => ReactNode;
}) {
  const { slice } = props;
  if (slice.isLoading) {
    return (
      <div className="space-y-2" aria-hidden>
        <Skeleton className="h-5 w-3/4" />
        <Skeleton className="h-5 w-2/3" />
        <Skeleton className="h-5 w-1/2" />
      </div>
    );
  }
  if (slice.isError) return <p className="text-muted-foreground text-sm">{props.error}</p>;
  const items = slice.data ?? [];
  if (items.length === 0) return <p className="text-muted-foreground text-sm">{props.empty}</p>;
  return (
    <ul className="divide-y divide-border">
      {items.slice(0, props.limit ?? WORK_ROWS).map(props.render)}
    </ul>
  );
}

/** One row: a linked title that truncates, a muted secondary line, a trailing badge/time. */
function Row(props: { to?: string; title: string; meta: ReactNode; trailing?: ReactNode }) {
  return (
    <li className="flex min-w-0 items-center gap-3 py-2 first:pt-0 last:pb-0">
      <div className="min-w-0 flex-1">
        {props.to ? (
          <Link
            to={props.to}
            className="block truncate font-medium text-sm underline-offset-2 hover:underline"
            title={props.title}
          >
            {props.title}
          </Link>
        ) : (
          <span className="block truncate font-medium text-sm" title={props.title}>
            {props.title}
          </span>
        )}
        <p className="truncate text-muted-foreground text-xs">{props.meta}</p>
      </div>
      {props.trailing && <div className="shrink-0">{props.trailing}</div>}
    </li>
  );
}

const countLabel = (n: number, cap: number) => (n >= cap ? `${cap}+` : String(n));

/** Drafts and published entries with unpublished edits, newest first. */
export function UnpublishedWorkCard(props: {
  entries: Loadable<readonly EntryRef[]>;
  cap: number;
}) {
  const n = props.entries.data?.length ?? 0;
  return (
    <WorkCard
      title="Not yet published"
      count={props.entries.data ? countLabel(n, props.cap) : undefined}
      description="Drafts and entries with changes that aren’t live. Newest entries first."
      footer={
        n > WORK_ROWS && (
          <p className="text-muted-foreground text-xs">
            Showing {WORK_ROWS} of {countLabel(n, props.cap)}. Filter by status in each content list
            for the rest.
          </p>
        )
      }
    >
      <Rows
        slice={props.entries}
        empty="Everything is published. Nothing waiting on you."
        error="Couldn’t load unpublished entries."
        render={(e) => (
          <Row
            key={e.id}
            to={entryPath(e)}
            title={e.title}
            meta={e.typeName}
            trailing={<StatusBadge status={e.status} />}
          />
        )}
      />
    </WorkCard>
  );
}

/**
 * How long a pending action may sit past its time before it reads as overdue. The engine's sweep
 * runs every minute, so an action at this minute is still on its way, not missed.
 */
export const OVERDUE_GRACE_MS = 2 * 60_000;

/**
 * Pending actions split by whether their time has passed: `overdue` (past it, so the sweep
 * hasn't run them) and `upcoming` (still ahead), each soonest first.
 */
export function splitSchedule(actions: readonly ScheduledAction[], now: number) {
  const overdue: ScheduledAction[] = [];
  const upcoming: ScheduledAction[] = [];
  for (const a of [...actions].sort((x, y) => x.scheduledFor.localeCompare(y.scheduledFor))) {
    (Date.parse(a.scheduledFor) < now - OVERDUE_GRACE_MS ? overdue : upcoming).push(a);
  }
  return { overdue, upcoming };
}

/** Pending scheduled actions (past their time first, then soonest) and releases still open. */
export function UpcomingCard(props: {
  scheduled: Loadable<readonly ScheduledAction[]>;
  releases: Loadable<readonly Release[]>;
  /** Resolves a scheduled entry to a linkable title, when known. */
  entryById: (id: string) => EntryRef | undefined;
  /** The time the split is made at (ms). */
  now: number;
}) {
  const { scheduled } = props;
  const split = scheduled.data ? splitSchedule(scheduled.data, props.now) : undefined;
  const releaseTitle = (id: string) =>
    props.releases.data?.find((r) => r.id === id)?.title ?? 'Release no longer open';
  const row = (a: ScheduledAction, overdue: boolean) => {
    const entry = a.entityType === 'Entry' ? props.entryById(a.entityId) : undefined;
    const verb = a.action === 'publish' ? 'Publish' : 'Unpublish';
    const when = (
      <time dateTime={a.scheduledFor} className="text-muted-foreground text-xs tabular-nums">
        {shortDateTime(a.scheduledFor)}
      </time>
    );
    return (
      <Row
        key={a.id}
        to={entry ? entryPath(entry) : a.entityType === 'Release' ? '/releases' : undefined}
        title={
          a.entityType === 'Release'
            ? releaseTitle(a.entityId)
            : (entry?.title ?? 'Entry no longer available')
        }
        meta={
          <>
            {verb} {a.entityType === 'Release' ? 'release' : (entry?.typeName ?? 'entry')}
            {/* The time sits in the meta line here, so the trailing slot can carry the state. */}
            {overdue ? <> · was due {when}</> : null}
          </>
        }
        trailing={overdue ? <ToneBadge tone="bad" label="Overdue" /> : when}
      />
    );
  };
  return (
    <WorkCard
      title="Coming up"
      description="Scheduled publishes and releases that haven’t shipped."
    >
      {split && split.overdue.length > 0 ? (
        <div className="space-y-2">
          <h3 className="font-medium text-muted-foreground text-xs">Overdue</h3>
          <p className="text-muted-foreground text-xs">
            Past their time and not run yet. Publish them by hand; if this keeps happening, the
            scheduler isn’t running.
          </p>
          <Rows
            slice={{ ...scheduled, data: split.overdue }}
            limit={5}
            empty=""
            error="Couldn’t load scheduled actions."
            render={(a) => row(a, true)}
          />
        </div>
      ) : null}
      <div
        className={
          split && split.overdue.length > 0 ? 'space-y-2 border-border border-t pt-3' : 'space-y-2'
        }
      >
        <h3 className="font-medium text-muted-foreground text-xs">Scheduled</h3>
        <Rows
          slice={{ ...scheduled, data: split?.upcoming }}
          limit={5}
          empty="Nothing scheduled."
          error="Couldn’t load scheduled actions."
          render={(a) => row(a, false)}
        />
      </div>
      <div className="space-y-2 border-border border-t pt-3">
        <h3 className="font-medium text-muted-foreground text-xs">Open releases</h3>
        <Rows
          slice={props.releases}
          limit={5}
          empty="No open releases."
          error="Couldn’t load releases."
          render={(r) => (
            <Row
              key={r.id}
              to="/releases"
              title={r.title}
              meta={`Opened ${shortDateTime(r.createdAt)}`}
            />
          )}
        />
      </div>
    </WorkCard>
  );
}

/**
 * What waits on a person, from the same lists Approvals shows: workflow steps paused for a
 * decision, agent proposals, and entries moderation took offline. The count is the shell's own
 * (`approvals/count`), so the card, the inbox and the nav badge give one number.
 */
export function DecisionsCard(props: {
  tasks: Loadable<readonly WorkflowTask[]>;
  reviews: Loadable<readonly AgentReview[]>;
  holds: Loadable<readonly ModerationHold[]>;
  /** The server's uncapped count; undefined until it answers, or for a role without the scope. */
  total: number | undefined;
  entryById: (id: string) => EntryRef | undefined;
  now: number;
}) {
  const { tasks, reviews, holds } = props;
  const listed =
    tasks.data && reviews.data && holds.data
      ? tasks.data.length + reviews.data.length + holds.data.length
      : undefined;
  const total = props.total ?? listed;
  return (
    <WorkCard
      title="Waiting on a decision"
      count={total}
      description="Workflow steps, agent proposals and moderation holds that need someone to decide them, oldest first."
      footer={
        total ? (
          <Link to="/approvals" className="text-link text-sm underline-offset-2 hover:underline">
            Review in Approvals
          </Link>
        ) : null
      }
    >
      <div className="space-y-2">
        <h3 className="font-medium text-muted-foreground text-xs">Workflow steps</h3>
        <Rows
          slice={{
            ...tasks,
            data:
              tasks.data &&
              [...tasks.data].sort((a, b) => a.requestedAt.localeCompare(b.requestedAt)),
          }}
          limit={5}
          empty="No workflow step is waiting."
          error="Couldn’t load workflow steps."
          render={(t) => {
            const entry = props.entryById(t.entryId);
            const deadline = toMs(t.deadline);
            return (
              <Row
                key={t.id}
                to={entryPath(entry ?? { contentType: t.contentTypeApiId, id: t.entryId })}
                title={t.title}
                meta={`${entry?.title ?? 'Entry no longer available'} · requested ${shortDateTime(t.requestedAt)}`}
                trailing={
                  deadline !== null && deadline < props.now ? (
                    <ToneBadge tone="bad" label="Overdue" />
                  ) : (
                    <StatusBadge status="pending" />
                  )
                }
              />
            );
          }}
        />
      </div>
      <div className="space-y-2 border-border border-t pt-3">
        <h3 className="font-medium text-muted-foreground text-xs">Agent proposals</h3>
        <Rows
          slice={{
            ...reviews,
            data:
              reviews.data &&
              [...reviews.data].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
          }}
          limit={5}
          empty="No agent proposal is waiting."
          error="Couldn’t load agent proposals."
          render={(r) => {
            const entry = props.entryById(r.entryId);
            const meta = `${humanize(r.workflow)} agent · ${shortDateTime(r.createdAt)}`;
            return (
              <Row
                key={r.id}
                to={entry ? entryPath(entry) : undefined}
                // An entry the lookup couldn't find was deleted or is hidden: say so, never its id.
                title={entry?.title ?? 'Entry no longer available'}
                meta={entry ? `${entry.typeName} · ${meta}` : meta}
                trailing={<StatusBadge status="needs_review" />}
              />
            );
          }}
        />
      </div>
      <div className="space-y-2 border-border border-t pt-3">
        <h3 className="font-medium text-muted-foreground text-xs">Held by moderation</h3>
        <Rows
          slice={{
            ...holds,
            data:
              holds.data && [...holds.data].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
          }}
          limit={5}
          empty="No entry is held by moderation."
          error="Couldn’t load moderation holds."
          render={(h) => {
            const entry = props.entryById(h.entryId);
            const meta = `${moderationFlagsLabel(h.flags)} · ${shortDateTime(h.createdAt)}`;
            return (
              <Row
                key={h.id}
                to={entry ? entryPath(entry) : '/approvals'}
                title={entry?.title ?? 'Entry no longer available'}
                meta={entry ? `${entry.typeName} · ${meta}` : meta}
                trailing={<ToneBadge tone="ai" label="Held" />}
              />
            );
          }}
        />
      </div>
    </WorkCard>
  );
}
