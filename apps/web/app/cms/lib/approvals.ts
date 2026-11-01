import { useClient } from './client-context';
import { useScopedQuery } from './queries';

type PendingOpts = {
  readonly silent?: boolean;
  readonly enabled?: boolean;
  readonly refetchInterval?: number;
};

/** The most a list asks for (the API's cap); the shell writes anything past 99 as 99+. */
const PENDING_LIMIT = 200;

/**
 * What waits on a person in this space: workflow steps paused for a decision, and agent
 * proposals awaiting review. The Approvals inbox and the shell's count read the same two queries,
 * so deciding an item in the inbox (which invalidates them) updates the count too.
 */
export function usePendingWorkflowTasks(opts?: PendingOpts) {
  const { client } = useClient();
  return useScopedQuery(
    ['workflow-tasks', 'pending'],
    () => client.listWorkflowTasks({ status: 'pending', limit: PENDING_LIMIT }),
    opts,
  );
}

export function usePendingAgentReviews(opts?: PendingOpts) {
  const { client } = useClient();
  return useScopedQuery(
    ['agent-reviews', 'pending'],
    () => client.listAgentReviews({ status: 'pending' }),
    opts,
  );
}

/** How often the shell asks again while the tab is visible: work arrives from agents and runs. */
const COUNT_REFRESH_MS = 60_000;

/**
 * How many items wait on a decision, once both lists have loaded; undefined until then or when
 * either can't be read (a role without the scope), so the shell shows no number rather than a
 * wrong one. Past 99 it is written 99+, so the lists' cap of 200 never shows. It refreshes every
 * minute while the tab is visible, on focus, and whenever the inbox decides an item.
 * `enabled` waits for the scope (the shell mounts before the space is known).
 */
export function usePendingApprovalsCount(enabled = true): number | undefined {
  const opts = { silent: true, enabled, refetchInterval: COUNT_REFRESH_MS };
  const tasks = usePendingWorkflowTasks(opts);
  const reviews = usePendingAgentReviews(opts);
  if (!tasks.data || !reviews.data) return undefined;
  return tasks.data.length + reviews.data.length;
}

/** The count as the shell writes it: 99+ past two digits. */
export const approvalsCountLabel = (n: number) => (n > 99 ? '99+' : String(n));
