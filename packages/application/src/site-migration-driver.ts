import {
  authorize,
  InvalidStateError,
  type MigrationRun,
  type MigrationTemplate,
  NotFoundError,
  type Principal,
  SCOPES,
  type Scope,
  ValidationError,
} from '@contentworker/domain';
import type { MigrationRunner } from '@contentworker/ports';
import type { AppContext } from './context';
import { jobStarterOf } from './job-starter';
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
 * a run with a driver keeps it.
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
  const run = await requireRun(ctx, scope, runId);
  if (run.status === 'failed') {
    throw new InvalidStateError(`The run failed${run.error ? `: ${run.error}` : ''}`);
  }
  return { started: await runner.start({ scope, runId: run.id, startedBy }) };
}

export interface ApproveMigrationTemplateResult {
  readonly template: MigrationTemplate;
  /**
   * Whether the run's driver was told. False when there is no driver (a run taken step by step)
   * or it couldn't be reached: approving again (it answers the approved template) tells it again.
   */
  readonly signalled: boolean;
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
  if (!runner || template.status !== 'approved') return { template, signalled: false };
  try {
    await runner.templateApproved(scope, input.runId, template.id, {
      ...(template.approvedBy ? { approvedBy: template.approvedBy } : {}),
    });
    return { template, signalled: true };
  } catch {
    // The approval stands either way; the answer says the driver wasn't told.
    return { template, signalled: false };
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
 * A named release must exist here and be open. 404 (`not_found`) when the run has no driver.
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
  if (!input.viaRelease && (input.releaseId || input.releaseTitle)) {
    throw new ValidationError([
      { field: 'viaRelease', message: 'a release is named only when publishing through one' },
    ]);
  }
  const approvedBy = jobStarterOf(principal);
  if (!approvedBy) throw new InvalidStateError('This caller can’t be recorded as the approver');
  const run = await requireRun(ctx, scope, input.runId);
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

async function requireRun(ctx: AppContext, scope: Scope, id: string): Promise<MigrationRun> {
  const run = await ctx.store.migrations.getRun(scope, id);
  if (!run) throw new NotFoundError('Migration run', id);
  return run;
}
