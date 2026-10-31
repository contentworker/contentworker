import {
  cancelAction,
  completeAction,
  failAction,
  InvalidStateError,
  NotFoundError,
  type ScheduledAction,
  type ScheduledActionType,
  type ScheduledEntityType,
  type Scope,
} from '@contentworker/domain';
import type { AppContext } from './context.js';
import { publishEntry, unpublishEntry } from './publishing.js';
import { publishRelease } from './releases.js';

export interface ScheduleActionInput {
  readonly action: ScheduledActionType;
  readonly entityType: ScheduledEntityType;
  readonly entityId: string;
  /** ISO-8601 instant the action becomes due. */
  readonly scheduledFor: string;
}

/** Schedules a publish/unpublish of an entry or release for a future instant. */
export async function scheduleAction(
  ctx: AppContext,
  scope: Scope,
  input: ScheduleActionInput,
): Promise<ScheduledAction> {
  // Validate the target exists now (it may still be deleted before firing — the
  // worker handles that by failing the action rather than crashing).
  if (input.entityType === 'Entry') {
    if (!(await ctx.store.entries.get(scope, input.entityId))) {
      throw new NotFoundError('Entry', input.entityId);
    }
  } else if (!(await ctx.store.releases.get(scope, input.entityId))) {
    throw new NotFoundError('Release', input.entityId);
  }

  const action: ScheduledAction = {
    id: ctx.ids.newId(),
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    scheduledFor: input.scheduledFor,
    status: 'pending',
    createdAt: ctx.clock.now().toISOString(),
  };
  await ctx.store.scheduledActions.create(scope, action);
  return action;
}

export async function listScheduledActions(
  ctx: AppContext,
  scope: Scope,
  query: { status?: string } = {},
): Promise<ScheduledAction[]> {
  return ctx.store.scheduledActions.list(scope, query);
}

/** Cancels a pending scheduled action so it never fires. */
export async function cancelScheduledAction(
  ctx: AppContext,
  scope: Scope,
  id: string,
): Promise<ScheduledAction> {
  const action = await ctx.store.scheduledActions.get(scope, id);
  if (!action) throw new NotFoundError('ScheduledAction', id);
  const canceled = cancelAction(action);
  await ctx.store.scheduledActions.save(scope, canceled);
  return canceled;
}

/** Executes one action's effect through the normal use-cases. */
async function execute(ctx: AppContext, scope: Scope, action: ScheduledAction): Promise<void> {
  if (action.entityType === 'Entry') {
    if (action.action === 'publish') await publishEntry(ctx, scope, action.entityId);
    else await unpublishEntry(ctx, scope, action.entityId);
    return;
  }
  // Release
  if (action.action === 'publish') {
    await publishRelease(ctx, scope, action.entityId);
    return;
  }
  throw new InvalidStateError('Unpublishing a release is not supported');
}

export interface RunDueResult {
  readonly executed: number;
  readonly failed: number;
}

/**
 * Runs every scheduled action whose time has arrived (across all scopes). Each
 * action is executed independently: a failure marks just that action `failed`
 * and the loop continues. Called on a timer by the worker. Idempotent by status
 * — a completed/canceled action is never re-run.
 */
export async function runDueScheduledActions(
  ctx: AppContext,
  opts: { limit?: number } = {},
): Promise<RunDueResult> {
  const now = ctx.clock.now().toISOString();
  const due = await ctx.store.scheduledActions.findDue(now, opts.limit);
  let executed = 0;
  let failed = 0;
  for (const { scope, action } of due) {
    try {
      await execute(ctx, scope, action);
      await ctx.store.scheduledActions.save(scope, completeAction(action, now));
      executed += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await ctx.store.scheduledActions.save(scope, failAction(action, now, message));
      failed += 1;
    }
  }
  return { executed, failed };
}
