import {
  authorize,
  InvalidStateError,
  MIGRATION_RUN_ENDED,
  MigrationDriverFinishedError,
  type MigrationRun,
  type MigrationTemplate,
  NotFoundError,
  type Principal,
  SCOPES,
  type Scope,
} from '@contentworker/domain';
import type { MigrationRunner } from '@contentworker/ports';
import type { AppContext } from './context';
import { jobStarterOf } from './job-starter';
import { assertReleaseTarget } from './site-migration-load';
import { type ApproveTemplateInput, approveTemplate } from './site-migration-templates';

/**
 * Site migration, the calls that reach a run's durable driver (`MigrationRunner`): start it,
 * approve a template and wake it, and give it the go-ahead to publish. The HTTP API and MCP both
 * call these, so they check the same things.
 *
 * The runner names its instance for the run and ignores scope, so each call reads the run in the
 * caller's scope first: a run of another space or environment is not found, and nothing is sent.
 * Who acts is the caller (`jobStarterOf`), never a value from the request.
 */

/** Whether the run's driver was started by this call; false when it was running already. */
export interface StartMigrationResult {
  readonly started: boolean;
}

/**
 * Starts the run's driver, which takes it from wherever it is (created, inventoried, clustered)
 * through to the go-ahead to publish, acting for the caller. Needs `migration:run`. Safe to repeat:
 * a run with a running driver keeps it. Refused (`InvalidStateError`) for a run that failed or
 * stopped, and for one whose driver has finished: Workflows holds the instance's id until its
 * retention passes, so a finished driver can't be started again in its place.
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
  const state = await runner.start({ scope, runId: run.id, startedBy });
  if (state === 'finished') throw new MigrationDriverFinishedError(run.id);
  return { started: state === 'started' };
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

/**
 * The go-ahead to publish, sent to the run's driver, which publishes as the caller once its pages
 * are loaded. Needs `content:publish`, and `content:write` through a release, as publishing does
 * (`publishMigration`, which the driver calls as the caller, checks each type's `publish` then).
 * A named release must exist here and be open. Refused for a run that failed or stopped, and
 * (`MigrationDriverFinishedError`) for one whose driver has finished; 404 (`not_found`) when the
 * run has no driver.
 */
export async function approveMigrationPublish(
  ctx: AppContext,
  runner: MigrationRunner,
  principal: Principal,
  scope: Scope,
  input: ApproveMigrationPublishInput,
): Promise<void> {
  authorize(principal, SCOPES.contentPublish, scope.spaceId);
  if (input.viaRelease) authorize(principal, SCOPES.contentWrite, scope.spaceId);
  assertReleaseTarget(input);
  const approvedBy = jobStarterOf(principal);
  if (!approvedBy) throw new InvalidStateError('This caller can’t be recorded as the approver');
  const run = await requireLiveRun(ctx, scope, input.runId);
  if (input.releaseId) {
    const release = await ctx.store.releases.get(scope, input.releaseId);
    if (!release) throw new NotFoundError('Release', input.releaseId);
    if (release.status !== 'open') {
      throw new InvalidStateError(`Cannot add to a ${release.status} release`);
    }
  }
  await runner.publishApproved(scope, run.id, {
    approvedBy,
    ...(input.viaRelease ? { viaRelease: true } : {}),
    ...(input.releaseId ? { releaseId: input.releaseId } : {}),
    ...(input.releaseTitle ? { releaseTitle: input.releaseTitle } : {}),
  });
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
