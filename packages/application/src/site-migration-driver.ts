import {
  authorize,
  InvalidStateError,
  MIGRATION_RUN_ENDED,
  type MigrationActor,
  MigrationDriverFinishedError,
  type MigrationDriverStatus,
  type MigrationGoAhead,
  MigrationGoAheadTakenError,
  type MigrationPublishTarget,
  type MigrationRun,
  type MigrationTemplate,
  migrationPublishTarget,
  NotFoundError,
  type Principal,
  SCOPES,
  type Scope,
  sameMigrationActor,
  sameMigrationTarget,
} from '@contentworker/domain';
import { type MigrationRunner, TransactionConflictError } from '@contentworker/ports';
import type { AppContext } from './context';
import { jobStarterOf } from './job-starter';
import { assertReleaseTarget } from './site-migration-load';
import { type ApproveTemplateInput, approveTemplate } from './site-migration-templates';

/**
 * Site migration, the calls that reach a run's durable driver (`MigrationRunner`): start it,
 * approve a template and wake it, give it the go-ahead to publish, and say where it is. The HTTP API
 * and MCP both call these, so they check the same things.
 *
 * The runner names its instance for the run and ignores scope, so each call reads the run in the
 * caller's scope first: a run of another space or environment is not found, and nothing is sent.
 * Who acts is the caller (`jobStarterOf`), never a value from the request.
 */

/** Times a write of the run is made over after losing its compare-and-set. */
const WRITE_ATTEMPTS = 5;
/** How long a read of a run waits for Workflows before it says the driver's state is unknown. */
const DRIVER_STATUS_TIMEOUT_MS = 2_000;

/** Whether the run's driver was started by this call; false when it was running already. */
export interface StartMigrationResult {
  readonly started: boolean;
}

/**
 * Starts the run's driver, which takes it from wherever it is (created, inventoried, clustered)
 * through to the go-ahead to publish, acting for the caller. Needs `migration:run`. Safe to repeat:
 * a run with a running driver keeps it. Refused (`InvalidStateError`) for a run that failed or
 * stopped, and for one whose driver has finished: Workflows holds the instance's id until its
 * retention passes, so a finished driver can't be started again in its place. One that was given
 * the go-ahead isn't started again even past that: its go-ahead was the finished driver's.
 */
export async function startMigration(
  ctx: AppContext,
  runner: MigrationRunner,
  principal: Principal,
  scope: Scope,
  runId: string,
): Promise<StartMigrationResult> {
  authorize(principal, SCOPES.migrationRun, scope.spaceId);
  const startedBy = jobStarterOf(principal);
  if (!startedBy) throw new InvalidStateError('This caller can’t be recorded as a run’s starter');
  const run = await requireLiveRun(ctx, scope, runId);
  if (run.goAhead) {
    const now = await runner.status(scope, run.id);
    if (now === 'none' || now === 'finished') throw new MigrationDriverFinishedError(run.id);
    return { started: false };
  }
  const before = ctx.clock.now().toISOString();
  const state = await runner.start({ scope, runId: run.id, startedBy, recorded: true });
  if (state === 'finished') throw new MigrationDriverFinishedError(run.id);
  if (state === 'started') {
    // The driver has started whatever becomes of this, and records itself as it begins
    // (`recordDriver` again), so a read right after finds it and a write that fails costs nothing.
    await recordDriver(ctx, scope, run.id, startedBy, before).catch(() => undefined);
  }
  return { started: state === 'started' };
}

/**
 * Records on the run that `startedBy` started its driver, unless it says so already (as of `since`,
 * when given: a driver started again after Workflows forgot the last is a new one). Given up quietly
 * when it keeps losing its race. The run as it then is; null when it is gone.
 */
export async function recordDriver(
  ctx: AppContext,
  scope: Scope,
  runId: string,
  startedBy: MigrationActor,
  since?: string,
): Promise<MigrationRun | null> {
  for (let attempt = 1; ; attempt++) {
    const run = await ctx.store.migrations.getRun(scope, runId);
    if (!run || MIGRATION_RUN_ENDED.has(run.status)) return run;
    const known = run.driver;
    if (
      known &&
      sameMigrationActor(known.startedBy, startedBy) &&
      (since === undefined || known.startedAt >= since)
    ) {
      return run;
    }
    const at = ctx.clock.now().toISOString();
    const next: MigrationRun = {
      ...run,
      driver: { startedBy, startedAt: at },
      version: run.version + 1,
      updatedAt: at,
    };
    try {
      await ctx.store.migrations.saveRun(scope, next, run.version);
      return next;
    } catch (err) {
      if (!(err instanceof TransactionConflictError)) throw err;
      if (attempt >= WRITE_ATTEMPTS) return run;
    }
  }
}

/**
 * Why a driver wasn't told: `no-driver` (none is bound, or the run was never started: it is taken
 * step by step), `driver-finished` (its driver has ended and waits for nothing), `unreachable` (the
 * driver couldn't be reached now: approving again tells it again).
 */
export type MigrationSignalMiss = 'no-driver' | 'driver-finished' | 'unreachable';

export interface ApproveMigrationTemplateResult {
  readonly template: MigrationTemplate;
  /** Whether the run's driver was told; approving again (it answers the template) tells it again. */
  readonly signalled: boolean;
  /** Why it wasn't, when it wasn't. */
  readonly reason?: MigrationSignalMiss;
}

/**
 * {@link approveTemplate} (which needs `content:manage` and the reviewed digest), then the
 * driver's wake-up, sent only once the approval has committed: the driver reads the approval from
 * the store, so an event sent before it would find nothing to act on.
 */
export async function approveMigrationTemplate(
  ctx: AppContext,
  runner: MigrationRunner | undefined,
  principal: Principal,
  scope: Scope,
  input: ApproveTemplateInput,
): Promise<ApproveMigrationTemplateResult> {
  const template = await approveTemplate(ctx, principal, scope, input);
  if (!runner) return { template, signalled: false, reason: 'no-driver' };
  try {
    await runner.templateApproved(scope, input.runId, template.id, {
      ...(template.approvedBy ? { approvedBy: template.approvedBy } : {}),
    });
    return { template, signalled: true };
  } catch (err) {
    // The approval has committed and stands whatever the driver says; the answer says why it
    // wasn't told, so a caller can tell a run taken by hand from one to approve again.
    const reason: MigrationSignalMiss =
      err instanceof MigrationDriverFinishedError
        ? 'driver-finished'
        : err instanceof NotFoundError
          ? 'no-driver'
          : 'unreachable';
    return { template, signalled: false, reason };
  }
}

export interface ApproveMigrationPublishInput {
  readonly runId: string;
  /** Add the entries to a release rather than publish them (needs `content:write` too). */
  readonly viaRelease?: boolean;
  /** The open release to add to; absent, the run's own. */
  readonly releaseId?: string;
  readonly releaseTitle?: string;
}

export interface ApproveMigrationPublishResult {
  /** Whether the run's driver was told. */
  readonly signalled: boolean;
  /** It couldn't be reached now: giving the same go-ahead again tells it. */
  readonly reason?: 'unreachable';
}

/**
 * The go-ahead to publish: recorded on the run at its compare-and-set, then the driver's wake-up,
 * sent only once that has committed. The driver publishes as the caller once its pages are loaded.
 *
 * A run takes one. Given again by the same caller for the same target (a lost response, or a
 * driver that couldn't be reached) it is answered again, and sent again to a driver that goes on (one
 * that has it already drops it); anyone else's, or one for another target, is refused (`MigrationGoAheadTakenError`),
 * whatever order they come in.
 *
 * Needs `content:publish`, and `content:write` through a release, as publishing does
 * (`publishMigration`, which the driver calls as the caller, checks each type's `publish` then).
 * A named release must exist here and be open. Refused for a run that failed or stopped, and
 * (`MigrationDriverFinishedError`) for one whose driver has finished; 404 (`not_found`) when the
 * run has no driver. While Workflows can't be asked, nothing is recorded.
 */
export async function approveMigrationPublish(
  ctx: AppContext,
  runner: MigrationRunner,
  principal: Principal,
  scope: Scope,
  input: ApproveMigrationPublishInput,
): Promise<ApproveMigrationPublishResult> {
  authorize(principal, SCOPES.contentPublish, scope.spaceId);
  if (input.viaRelease) authorize(principal, SCOPES.contentWrite, scope.spaceId);
  assertReleaseTarget(input);
  const approvedBy = jobStarterOf(principal);
  if (!approvedBy) throw new InvalidStateError('This caller can’t be recorded as the approver');
  const target = migrationPublishTarget(input);
  const run = await requireLiveRun(ctx, scope, input.runId);
  const given = standing(run, approvedBy, target);
  const event = { approvedBy, ...target, recorded: true } as const;
  if (given?.deliveredAt) {
    // It arrived, so it is answered again whatever the driver says now. One still going is told
    // again too: an instance an operator restarted waits for an event it has no record of.
    const live = await runner.status(scope, run.id).then(isLive, () => false);
    if (live) await runner.publishApproved(scope, run.id, event).catch(() => undefined);
    return { signalled: true };
  }
  if (!given) await assertOpenRelease(ctx, scope, target);
  const now = await runner.status(scope, run.id);
  if (now === 'none') throw new NotFoundError('Migration driver', run.id);
  if (now === 'finished') throw new MigrationDriverFinishedError(run.id);
  const taken = given ? run : await takeGoAhead(ctx, scope, run, approvedBy, target);
  // All of it, not only the wake-up: an engine rolled back to before go-aheads were recorded takes
  // it from the event.
  try {
    await runner.publishApproved(scope, run.id, event);
  } catch (err) {
    if (err instanceof MigrationDriverFinishedError || err instanceof NotFoundError) throw err;
    return { signalled: false, reason: 'unreachable' };
  }
  // A driver that was started before go-aheads were recorded may have taken one already, and then
  // drops this unread: only its own record of acting on it is certain.
  if (taken.driver) await recordDelivered(ctx, scope, run.id).catch(() => undefined);
  return { signalled: true };
}

const isLive = (status: MigrationDriverStatus) =>
  status === 'running' || status === 'waiting' || status === 'paused';

/** The go-ahead `run` holds when it is this one; refused when it holds another. */
function standing(
  run: MigrationRun,
  approvedBy: MigrationActor,
  target: MigrationPublishTarget,
): MigrationGoAhead | null {
  const { goAhead } = run;
  if (!goAhead) return null;
  if (
    !sameMigrationActor(goAhead.approvedBy, approvedBy) ||
    !sameMigrationTarget(goAhead.target, target)
  ) {
    throw new MigrationGoAheadTakenError();
  }
  return goAhead;
}

/** Records the go-ahead on the run; of two at once, one is recorded and the other finds it. */
async function takeGoAhead(
  ctx: AppContext,
  scope: Scope,
  first: MigrationRun,
  approvedBy: MigrationActor,
  target: MigrationPublishTarget,
): Promise<MigrationRun> {
  let run = first;
  for (let attempt = 1; ; attempt++) {
    if (standing(run, approvedBy, target)) return run;
    const at = ctx.clock.now().toISOString();
    const next: MigrationRun = {
      ...run,
      goAhead: { approvedBy, at, target, deliveredAt: null },
      version: run.version + 1,
      updatedAt: at,
    };
    try {
      await ctx.store.migrations.saveRun(scope, next, run.version);
      return next;
    } catch (err) {
      if (!(err instanceof TransactionConflictError) || attempt >= WRITE_ATTEMPTS) throw err;
      run = await requireLiveRun(ctx, scope, run.id);
    }
  }
}

/** Records that the run's go-ahead certainly reached its driver; given up quietly on lost races. */
export async function recordDelivered(
  ctx: AppContext,
  scope: Scope,
  runId: string,
): Promise<MigrationRun | null> {
  for (let attempt = 1; ; attempt++) {
    const run = await ctx.store.migrations.getRun(scope, runId);
    if (!run?.goAhead || run.goAhead.deliveredAt) return run;
    const at = ctx.clock.now().toISOString();
    const next: MigrationRun = {
      ...run,
      goAhead: { ...run.goAhead, deliveredAt: at },
      version: run.version + 1,
      updatedAt: at,
    };
    try {
      await ctx.store.migrations.saveRun(scope, next, run.version);
      return next;
    } catch (err) {
      if (!(err instanceof TransactionConflictError)) throw err;
      if (attempt >= WRITE_ATTEMPTS) return run;
    }
  }
}

async function assertOpenRelease(
  ctx: AppContext,
  scope: Scope,
  target: MigrationPublishTarget,
): Promise<void> {
  if (!target.releaseId) return;
  const release = await ctx.store.releases.get(scope, target.releaseId);
  if (!release) throw new NotFoundError('Release', target.releaseId);
  if (release.status !== 'open') {
    throw new InvalidStateError(`Cannot add to a ${release.status} release`);
  }
}

/** A run's background driver and its go-ahead to publish, as `caller` reads them. */
export interface MigrationDriverView {
  readonly state: MigrationDriverStatus;
  /** Null when none was started, and for one started before starts were recorded. */
  readonly startedBy: MigrationActor | null;
  readonly startedAt: string | null;
  /** It acts as the caller does. */
  readonly startedByYou: boolean;
  readonly goAhead: MigrationGoAheadView;
}

/**
 * `unknown`: the driver was started before go-aheads were recorded (or couldn't be asked), so one
 * may have been given that isn't recorded.
 */
export type MigrationGoAheadView =
  | { readonly status: 'none' | 'unknown' }
  | (MigrationPublishTarget & {
      readonly status: 'given';
      readonly approvedBy: MigrationActor;
      readonly approvedAt: string;
      /** The caller gave it, so they can send the same one again. */
      readonly byYou: boolean;
      /** It certainly reached the driver; false when that isn't known. */
      readonly delivered: boolean;
    });

/**
 * Where a run's driver is, and its go-ahead. What was recorded comes from the run as read; only
 * whether it runs now is Workflows', asked once for this run (never for a list of them, nor for a
 * run that ended, whose driver has) and given up after two seconds: this never fails a read or holds
 * it up, it says `unknown`.
 */
export async function migrationDriver(
  runner: MigrationRunner | undefined,
  principal: Principal,
  scope: Scope,
  run: MigrationRun,
): Promise<MigrationDriverView> {
  const caller = jobStarterOf(principal);
  const you = (actor: MigrationActor) => !!caller && sameMigrationActor(actor, caller);
  const state = await driverState(runner, scope, run);
  const { driver, goAhead } = run;
  return {
    state,
    startedBy: driver?.startedBy ?? null,
    startedAt: driver?.startedAt ?? null,
    startedByYou: driver ? you(driver.startedBy) : false,
    goAhead: goAhead
      ? {
          status: 'given',
          ...goAhead.target,
          approvedBy: goAhead.approvedBy,
          approvedAt: goAhead.at,
          byYou: you(goAhead.approvedBy),
          delivered: goAhead.deliveredAt !== null,
        }
      : { status: driver || state === 'none' ? 'none' : 'unknown' },
  };
}

async function driverState(
  runner: MigrationRunner | undefined,
  scope: Scope,
  run: MigrationRun,
): Promise<MigrationDriverStatus> {
  // Only a driver ends a run, as it ends itself.
  if (MIGRATION_RUN_ENDED.has(run.status)) return 'finished';
  const had = run.driver !== null || run.goAhead !== null;
  if (!runner) return had ? 'unknown' : 'none';
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const state = await Promise.race([
      runner.status(scope, run.id),
      new Promise<MigrationDriverStatus>((resolve) => {
        timer = setTimeout(() => resolve('unknown'), DRIVER_STATUS_TIMEOUT_MS);
      }),
    ]);
    // Workflows forgets an instance some time after it finished.
    return state === 'none' && had ? 'finished' : state;
  } catch {
    return 'unknown';
  } finally {
    clearTimeout(timer);
  }
}

/** The run in `scope`, refused once it has failed or stopped: its driver waits for nothing. */
async function requireLiveRun(ctx: AppContext, scope: Scope, id: string): Promise<MigrationRun> {
  const run = await ctx.store.migrations.getRun(scope, id);
  if (!run) throw new NotFoundError('Migration run', id);
  if (MIGRATION_RUN_ENDED.has(run.status)) {
    throw new InvalidStateError(
      `The run has ${run.status}${run.error ? ` (${run.error})` : ''}: its driver waits for nothing, so take it on step by step`,
    );
  }
  return run;
}
