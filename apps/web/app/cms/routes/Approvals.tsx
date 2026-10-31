import type { AgentReview, WorkflowTask } from '@contentworker/domain';
import { Button } from '@contentworker/ui/button';
import { Textarea } from '@contentworker/ui/textarea';
import { Bot, Check, Stamp, X } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { Ago } from '~/cms/components/ago';
import { EmptyState, PageHeader, Section } from '~/cms/components/page';
import { ToneBadge } from '~/cms/components/status';
import { useClient, useLocalRun } from '../lib/client-context';
import { plural, toMs, until } from '../lib/format';
import { useInvalidate, useScopedQuery } from '../lib/queries';
import { useToast } from '../lib/toast';

/**
 * The Approvals inbox: what is waiting on a person in this space, oldest first. Two kinds:
 * workflow steps paused for a human decision (an approval or review node), and agent proposals
 * (an enrich, curate or repurpose run that ended `needs_review`). Each can be decided here; an
 * event wait is listed so it isn't forgotten, but only the event itself can move it on.
 */
export function Approvals() {
  const { client } = useClient();
  const tasks = useScopedQuery(['workflow-tasks', 'pending'], () =>
    client.listWorkflowTasks({ status: 'pending' }),
  );
  const reviews = useScopedQuery(['agent-reviews', 'pending'], () =>
    client.listAgentReviews({ status: 'pending' }),
  );
  const taskItems = [...(tasks.data ?? [])].sort(
    (a, b) => (toMs(a.requestedAt) ?? 0) - (toMs(b.requestedAt) ?? 0),
  );
  const reviewItems = [...(reviews.data ?? [])].sort(
    (a, b) => (toMs(a.createdAt) ?? 0) - (toMs(b.createdAt) ?? 0),
  );
  const total = taskItems.length + reviewItems.length;
  const loading = tasks.isPending || reviews.isPending;

  return (
    <div>
      <PageHeader
        title="Approvals"
        subtitle={
          loading
            ? 'Workflow steps and agent proposals waiting on a decision, oldest first.'
            : total
              ? `${plural(total, 'item')} waiting on a decision, oldest first.`
              : 'Workflow steps and agent proposals waiting on a decision, oldest first.'
        }
      />
      {!loading && total === 0 ? (
        <EmptyState
          icon={Stamp}
          title="Nothing is waiting on you"
          description="When a workflow pauses for an approval, or an agent proposes changes to an entry, it shows up here."
        />
      ) : (
        <div className="grid gap-6">
          <Section title="Workflow steps" flush>
            {tasks.isPending ? (
              <p className="px-5 py-4 text-muted-foreground text-sm">Loading…</p>
            ) : taskItems.length ? (
              <ul className="divide-y">
                {taskItems.map((t) => (
                  <TaskRow key={t.id} task={t} />
                ))}
              </ul>
            ) : (
              <p className="px-5 py-4 text-muted-foreground text-sm">
                No workflow step is waiting on a decision.
              </p>
            )}
          </Section>
          <Section title="Agent proposals" flush>
            {reviews.isPending ? (
              <p className="px-5 py-4 text-muted-foreground text-sm">Loading…</p>
            ) : reviewItems.length ? (
              <ul className="divide-y">
                {reviewItems.map((r) => (
                  <ReviewRow key={r.id} review={r} />
                ))}
              </ul>
            ) : (
              <p className="px-5 py-4 text-muted-foreground text-sm">
                No agent proposal is waiting for review.
              </p>
            )}
          </Section>
        </div>
      )}
    </div>
  );
}

const KIND_LABEL: Record<WorkflowTask['kind'], string> = {
  approval: 'Approval',
  review: 'Review',
  event: 'Waiting for an event',
};

/** The entry's editor link, by its content type. */
const entryHref = (contentType: string, entryId: string) =>
  `/content/${encodeURIComponent(contentType)}/${encodeURIComponent(entryId)}`;

function TaskRow({ task }: { task: WorkflowTask }) {
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
      await invalidate(['workflow-tasks'], ['workflow-runs']);
    });

  return (
    <li className="grid gap-2 px-5 py-4" aria-label={task.title}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="min-w-0">
          <h3 className="font-medium text-sm">{task.title}</h3>
          <p className="text-muted-foreground text-xs">
            {KIND_LABEL[task.kind]}
            {task.event ? ` “${task.event}”` : ''} on{' '}
            <Link
              to={entryHref(task.contentTypeApiId, task.entryId)}
              className="font-mono text-link hover:underline"
            >
              {task.entryId}
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
          <ToneBadge tone="wait" label="Pending" />
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

function ReviewRow({ review }: { review: AgentReview }) {
  const { client } = useClient();
  const invalidate = useInvalidate();
  const toast = useToast();
  const { busy, run } = useLocalRun();
  // The review names the entry, not its type: the entry's own record supplies the editor link.
  const entry = useScopedQuery(['entry', review.entryId], () => client.getEntry(review.entryId), {
    silent: true,
  });
  const fields = Object.keys(review.proposed ?? {});

  const decide = (approve: boolean) =>
    run(async () => {
      await (approve ? client.approveAgentReview(review.id) : client.rejectAgentReview(review.id));
      toast.success(approve ? 'Applied the proposal as a new draft' : 'Rejected the proposal');
      await invalidate(['agent-reviews'], ['entry'], ['entries']);
    });

  return (
    <li className="grid gap-2 px-5 py-4" aria-label={`${review.workflow} proposal`}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="min-w-0">
          <h3 className="flex items-center gap-1.5 font-medium text-sm">
            <Bot className="size-4 text-ai" aria-hidden="true" />
            {`An agent proposes changes (${review.workflow})`}
          </h3>
          <p className="text-muted-foreground text-xs">
            On{' '}
            {entry.data ? (
              <Link
                to={entryHref(entry.data.contentType, review.entryId)}
                className="font-mono text-link hover:underline"
              >
                {review.entryId}
              </Link>
            ) : (
              <span className="font-mono">{review.entryId}</span>
            )}{' '}
            · proposed <Ago at={review.createdAt} />
          </p>
        </div>
        <ToneBadge tone="wait" label="Pending" />
      </div>
      {fields.length ? (
        <p className="text-sm">
          {`Changes ${plural(fields.length, 'field')}: `}
          <span className="font-mono text-xs">{fields.join(', ')}</span>
        </p>
      ) : null}
      {review.notes.length ? (
        <ul className="max-w-measure list-disc pl-5 text-muted-foreground text-sm">
          {review.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={busy} onClick={() => void decide(true)}>
          <Check aria-hidden="true" /> Approve and apply
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void decide(false)}>
          <X aria-hidden="true" /> Reject
        </Button>
      </div>
    </li>
  );
}
