import {
  APP_JOB_ACTIVE_WINDOW_MS,
  APP_JOB_NOT_STARTED,
  APP_JOB_RETENTION_SECONDS,
  APP_JOB_START_DEADLINE_MS,
  AppOperationFailedError,
  type AppOperationJob,
  type AppOperationJobStatus,
  ASYNC_OPERATION_TIMEOUT_MS,
  appJobVisibleTo,
  authorize,
  ConflictError,
  DomainError,
  effectiveAppJob,
  holdsScope,
  type InstalledPlugin,
  MAX_ACTIVE_APP_JOBS,
  MAX_APP_JOBS_LISTED,
  MAX_KEPT_APP_JOBS,
  MAX_OPERATION_PAYLOAD_BYTES,
  NotConfiguredError,
  NotFoundError,
  normalizeInstalledPlugin,
  type OperationSchema,
  operationValueIssues,
  type PermissionScope,
  type PluginOperation,
  type PluginOperationMode,
  type Principal,
  principalActorId,
  type Scope,
  ValidationError,
} from '@contentworker/domain';
import type { AppOperationJobParams, WorkflowSteps } from '@contentworker/ports';
import { redactCredentials } from '@contentworker/redaction';
import type { AppContext } from './context';
import { jobStarterOf, resolveStarter } from './job-starter';

/**
 * App operations: the named, typed calls installed plugins offer (manifest v2), listed and
 * invoked through one use-case each, so REST, OpenAPI and MCP serve the same thing.
 *
 * Who may call an operation is the scope its manifest declares (`requires`), checked like any
 * route's. What the operation may then do is the plugin's grant narrowed to that caller
 * (`createPluginOperationRunner`). Input is checked against the declared schema before the
 * plugin sees it, and output after, so a plugin can neither be handed nor hand back anything
 * the manifest a human approved did not describe.
 *
 * An `async` operation is accepted as a job instead ({@link AppOperationJob}): the job and its
 * `app_operation.requested` event commit in one unit, the engine's Workflow runs it
 * ({@link runAppOperationJob}) with a longer budget, and the caller reads the outcome from the
 * job ({@link getAppOperationJob}).
 */

/** One operation as callers see it. */
export interface AppOperationView {
  /** The plugin's id: `com.example.seo`. */
  readonly plugin: string;
  readonly pluginName: string;
  readonly pluginVersion: string;
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly requires: PermissionScope;
  readonly mode: PluginOperationMode;
  readonly input: OperationSchema;
  readonly output?: OperationSchema;
}

/**
 * The operations `principal` may invoke in `spaceId`: every enabled plugin's, less those whose
 * `requires` the caller doesn't hold. A plugin awaiting re-approval offers none.
 */
export async function listAppOperations(
  ctx: AppContext,
  principal: Principal,
  spaceId: string,
): Promise<AppOperationView[]> {
  authorizeSpace(principal, spaceId);
  const plugins = (await ctx.store.plugins.list(spaceId)).map(normalizeInstalledPlugin);
  return plugins
    .filter((p) => p.enabled && !p.needsReapproval)
    .sort((a, b) => a.id.localeCompare(b.id))
    .flatMap((p) =>
      (p.manifest.operations ?? [])
        .filter((op) => holdsScope(principal.scopes, op.requires))
        .map((op) => view(p.id, p.manifest.name, p.manifest.version, op)),
    );
}

/** A job as its callers see it: never the caller snapshot or the plugin checksum it pins. */
export interface AppOperationJobView {
  readonly id: string;
  readonly plugin: string;
  readonly pluginVersion: string;
  readonly operation: string;
  readonly status: AppOperationJobStatus;
  readonly input: unknown;
  readonly output?: unknown;
  readonly error?: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly expiresAt: string;
}

/** A sync operation's output, or the job an async one was accepted as. */
export type AppOperationResult =
  | { readonly output: unknown }
  | { readonly job: AppOperationJobView };

/**
 * Invokes one operation for `principal`: a sync one returns its output, an async one the job it
 * was accepted as. Unknown, disabled and not-permitted operations are told apart only by status:
 * not found for the first two, forbidden for the last (the caller could see it exists from the
 * list only if permitted, so this names nothing new).
 */
export async function invokeAppOperation(
  ctx: AppContext,
  principal: Principal,
  scope: Scope,
  pluginId: string,
  name: string,
  input: unknown,
): Promise<AppOperationResult> {
  authorizeSpace(principal, scope.spaceId);
  const raw = await ctx.store.plugins.get(scope.spaceId, pluginId);
  const plugin = raw ? normalizeInstalledPlugin(raw) : undefined;
  const operation = plugin?.manifest.operations?.find((op) => op.name === name);
  if (!plugin || !plugin.enabled || plugin.needsReapproval || !operation) {
    throw new NotFoundError('App operation', `${pluginId}/${name}`);
  }
  authorize(principal, operation.requires, scope.spaceId);

  const payload = input ?? {};
  assertSize(payload, 'input');
  const issues = operationValueIssues(operation.input, payload, 'input');
  if (issues.length > 0) throw new ValidationError(issues);

  if (!ctx.appOperations) {
    throw new NotConfiguredError('plugins', 'This deployment does not run plugin code');
  }
  if (operation.mode === 'async') {
    return { job: jobView(await acceptJob(ctx, principal, scope, plugin, operation, payload)) };
  }
  let output: unknown;
  try {
    output = await ctx.appOperations.run(plugin, operation, payload, scope, principal);
  } catch (err) {
    if (err instanceof DomainError) throw err;
    // A plugin's message can carry what it fetched with, a key in a URL among it: redacted
    // before it reaches the caller.
    throw new AppOperationFailedError(
      plugin.id,
      name,
      redactCredentials(err instanceof Error ? err.message : 'error'),
    );
  }
  output = output ?? null;
  const problem = outputProblem(operation, output);
  if (problem) throw new AppOperationFailedError(plugin.id, name, problem);
  return { output };
}

/** Why `output` can't be handed back for `operation`, or undefined when it can. */
function outputProblem(operation: PluginOperation, output: unknown): string | undefined {
  if (!fits(output)) return 'its output is too large or not JSON';
  if (operation.output) {
    const bad = operationValueIssues(operation.output, output, 'output');
    if (bad.length > 0) {
      return `its output does not match the declared schema (${bad[0]?.field}: ${bad[0]?.message})`;
    }
  }
  return undefined;
}

/**
 * Accepts an async call as a job: refused with a 409 while the environment has
 * {@link MAX_ACTIVE_APP_JOBS} pending or running, so one caller can't queue unbounded plugin work.
 */
async function acceptJob(
  ctx: AppContext,
  principal: Principal,
  scope: Scope,
  plugin: InstalledPlugin,
  operation: PluginOperation,
  input: unknown,
): Promise<AppOperationJob> {
  const now = ctx.clock.now();
  // Counted in the store, without reading the rows: a job past its stale mark no longer counts.
  const active = await ctx.store.appOperationJobs.countActive(
    scope,
    new Date(now.getTime() - APP_JOB_ACTIVE_WINDOW_MS),
    MAX_ACTIVE_APP_JOBS,
  );
  if (active >= MAX_ACTIVE_APP_JOBS) {
    throw new ConflictError(
      `${MAX_ACTIVE_APP_JOBS} operations are already running here; wait for one to finish`,
    );
  }
  if (
    (await ctx.store.appOperationJobs.countKept(scope, now, MAX_KEPT_APP_JOBS)) >= MAX_KEPT_APP_JOBS
  ) {
    throw new ConflictError(
      `${MAX_KEPT_APP_JOBS} operation jobs are kept here; wait for older ones to expire`,
    );
  }
  const startedBy = jobStarterOf(principal);
  const job: AppOperationJob = {
    id: ctx.ids.newId(),
    plugin: plugin.id,
    pluginVersion: plugin.manifest.version,
    checksum: plugin.checksum,
    operation: operation.name,
    requires: operation.requires,
    status: 'pending',
    input,
    caller: {
      kind: principal.kind,
      scopes: principal.scopes,
      ...(principal.contentGrants ? { contentGrants: principal.contentGrants } : {}),
      ...(startedBy ? { startedBy } : {}),
    },
    createdBy: principalActorId(principal),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + APP_JOB_RETENTION_SECONDS * 1000).toISOString(),
  };
  await ctx.store.withTransaction(async (tx) => {
    await tx.appOperationJobs.create(scope, job);
    await tx.outbox.append({
      id: ctx.ids.newId(),
      type: 'app_operation.requested',
      scope,
      occurredAt: job.createdAt,
      jobId: job.id,
    });
  });
  return job;
}

/**
 * One job, as it stands now. Not found unless `principal` could have produced it
 * ({@link appJobVisibleTo}): a job's output can carry what its caller's access let the plugin read.
 */
export async function getAppOperationJob(
  ctx: AppContext,
  principal: Principal,
  scope: Scope,
  id: string,
): Promise<AppOperationJobView> {
  authorizeSpace(principal, scope.spaceId);
  const job = await ctx.store.appOperationJobs.get(scope, id);
  if (!job || !appJobVisibleTo(job, principal, principalActorId(principal))) {
    throw new NotFoundError('App operation job', id);
  }
  return jobView(effectiveAppJob(job, ctx.clock.now()));
}

/** The environment's recent jobs `principal` may read, newest first. */
export async function listAppOperationJobs(
  ctx: AppContext,
  principal: Principal,
  scope: Scope,
): Promise<AppOperationJobView[]> {
  authorizeSpace(principal, scope.spaceId);
  const actor = principalActorId(principal);
  const now = ctx.clock.now();
  return (await ctx.store.appOperationJobs.list(scope, MAX_APP_JOBS_LISTED))
    .filter((j) => appJobVisibleTo(j, principal, actor))
    .map((j) => jobView(effectiveAppJob(j, now)));
}

/** What the claim step decides. */
type JobClaim =
  | { readonly kind: 'skip' }
  | { readonly kind: 'claimed' }
  | { readonly kind: 'failed'; readonly error: string };

/** What the run step hands the record step. */
type JobOutcome =
  | { readonly kind: 'completed'; readonly output: unknown }
  | { readonly kind: 'failed'; readonly error: string };

/**
 * The engine's body for one job (one Workflow instance per job id), in three steps:
 *
 * - **claim** (retried like any step): takes a pending job that is still within its start
 *   deadline, whose caller still holds the access it was accepted with, whose plugin is still enabled, approved and the very code accepted (its checksum),
 *   and marks it running. Anything else ends the job here, the plugin never called.
 * - **run** (never retried: an operation may have effects outside, and a second attempt could
 *   repeat them): calls the plugin with the grant narrowed to the caller snapshot. A run that
 *   errors out, the step itself failing included, is recorded as the job's failure.
 * - **record**: writes the outcome, so a lost write is retried without running the plugin again.
 */
export async function runAppOperationJob(
  steps: WorkflowSteps,
  ctx: AppContext,
  params: AppOperationJobParams,
): Promise<AppOperationJobStatus | 'skipped'> {
  const { scope, jobId } = params;
  const claim = await steps.do<JobClaim>('claim', async () => {
    const job = await ctx.store.appOperationJobs.get(scope, jobId);
    if (!job || job.status !== 'pending') return { kind: 'skip' };
    // Its caller's access was copied when it was accepted: too late, it never runs on it.
    if (ctx.clock.now().getTime() - Date.parse(job.createdAt) > APP_JOB_START_DEADLINE_MS) {
      return { kind: 'failed', error: APP_JOB_NOT_STARTED };
    }
    const lost = await callerLostAccess(ctx, scope, job);
    if (lost) return { kind: 'failed', error: lost };
    const runnable = await resolveRunnable(ctx, scope, job);
    if ('error' in runnable) return { kind: 'failed', error: runnable.error };
    await ctx.store.appOperationJobs.update(scope, job.id, {
      status: 'running',
      startedAt: ctx.clock.now().toISOString(),
    });
    return { kind: 'claimed' };
  });
  if (claim.kind === 'skip') return 'skipped';

  let outcome: JobOutcome;
  if (claim.kind === 'failed') {
    outcome = claim;
  } else {
    try {
      outcome = await steps.do<JobOutcome>(
        'run',
        { retries: { limit: 0, delay: '1 second' }, timeout: '10 minutes' },
        async () => {
          try {
            return await runJob(ctx, scope, jobId);
          } catch (err) {
            return { kind: 'failed', error: failureMessage(err) };
          }
        },
      );
    } catch (err) {
      outcome = { kind: 'failed', error: failureMessage(err) };
    }
  }
  await steps.do('record', async () => {
    const completedAt = ctx.clock.now().toISOString();
    await ctx.store.appOperationJobs.update(
      scope,
      jobId,
      outcome.kind === 'completed'
        ? { status: 'completed', output: outcome.output, completedAt }
        : { status: 'failed', error: outcome.error, completedAt },
    );
  });
  return outcome.kind;
}

/**
 * Why whoever started `job` may no longer run it, or null. They are resolved again from the store,
 * as their next request would be (`resolveStarter`: a key revoked, expired or re-roled, a person
 * disabled, removed or re-roled), and must still hold the operation's scope, every scope the
 * snapshot holds, and content grants no narrower than it (unrestricted, or the same). The
 * snapshot stays the ceiling the plugin's grant is narrowed to. A job naming no starter (the
 * deployment's own tokens) runs on the snapshot alone.
 */
async function callerLostAccess(
  ctx: AppContext,
  scope: Scope,
  job: AppOperationJob,
): Promise<string | null> {
  const starter = job.caller.startedBy;
  if (!starter || starter.kind === 'deployment') return null;
  const now = await resolveStarter(ctx, scope.spaceId, starter);
  if (!now) {
    return starter.kind === 'key'
      ? 'The API key or token that started this operation no longer works here'
      : 'The person who started this operation is no longer on the team, or is disabled';
  }
  const scopesHeld = [job.requires, ...job.caller.scopes].every((s) => holdsScope(now.scopes, s));
  const grantsHeld =
    now.contentGrants === undefined ||
    JSON.stringify(now.contentGrants) === JSON.stringify(job.caller.contentGrants);
  if (scopesHeld && grantsHeld) return null;
  return `The ${starter.kind === 'key' ? 'key' : 'person'} that started this operation may no longer run it`;
}

/** The plugin and operation a job may run on now, or why it may not. */
async function resolveRunnable(
  ctx: AppContext,
  scope: Scope,
  job: AppOperationJob,
): Promise<{ plugin: InstalledPlugin; operation: PluginOperation } | { error: string }> {
  const raw = await ctx.store.plugins.get(scope.spaceId, job.plugin);
  const plugin = raw ? normalizeInstalledPlugin(raw) : undefined;
  const operation = plugin?.manifest.operations?.find((op) => op.name === job.operation);
  if (
    !plugin ||
    !plugin.enabled ||
    plugin.needsReapproval ||
    plugin.checksum !== job.checksum ||
    !operation ||
    operation.mode !== 'async'
  ) {
    return { error: 'The plugin was changed, disabled or removed before the operation ran' };
  }
  if (!ctx.appOperations) return { error: 'This deployment does not run plugin code' };
  return { plugin, operation };
}

async function runJob(ctx: AppContext, scope: Scope, jobId: string): Promise<JobOutcome> {
  const job = await ctx.store.appOperationJobs.get(scope, jobId);
  if (!job || job.status !== 'running') {
    return { kind: 'failed', error: 'The job was removed before it ran' };
  }
  // Checked again: the plugin could change between the claim and this step.
  const runnable = await resolveRunnable(ctx, scope, job);
  if ('error' in runnable) return { kind: 'failed', error: runnable.error };
  const { plugin, operation } = runnable;
  const caller: Principal = {
    spaceId: scope.spaceId,
    kind: job.caller.kind,
    scopes: job.caller.scopes,
    ...(job.caller.contentGrants ? { contentGrants: job.caller.contentGrants } : {}),
  };
  const output =
    (await ctx.appOperations?.run(plugin, operation, job.input, scope, caller, {
      timeoutMs: ASYNC_OPERATION_TIMEOUT_MS,
    })) ?? null;
  const problem = outputProblem(operation, output);
  return problem ? { kind: 'failed', error: problem } : { kind: 'completed', output };
}

/** A failure as the job's caller reads it: a plugin's message can carry a credential. */
function failureMessage(err: unknown): string {
  return redactCredentials(err instanceof Error ? err.message : 'error');
}

/** Expired jobs one sweep deletes per statement, and the most statements one tick runs. */
const APP_JOB_SWEEP_BATCH = 100;
const APP_JOB_SWEEP_BATCHES = 50;

/**
 * Deletes jobs (and their output) past their retention, a batch per statement until none is left
 * or the tick's share is spent. The engine's hourly cron.
 */
export async function sweepExpiredAppOperationJobs(ctx: AppContext): Promise<{ removed: number }> {
  let removed = 0;
  for (let batch = 0; batch < APP_JOB_SWEEP_BATCHES; batch++) {
    const n = await ctx.store.appOperationJobs.deleteExpired(ctx.clock.now(), APP_JOB_SWEEP_BATCH);
    removed += n;
    if (n < APP_JOB_SWEEP_BATCH) break;
  }
  return { removed };
}

function jobView(job: AppOperationJob): AppOperationJobView {
  return {
    id: job.id,
    plugin: job.plugin,
    pluginVersion: job.pluginVersion,
    operation: job.operation,
    status: job.status,
    input: job.input,
    ...(job.status === 'completed' ? { output: job.output ?? null } : {}),
    ...(job.error !== undefined ? { error: job.error } : {}),
    createdBy: job.createdBy,
    createdAt: job.createdAt,
    ...(job.startedAt ? { startedAt: job.startedAt } : {}),
    ...(job.completedAt ? { completedAt: job.completedAt } : {}),
    expiresAt: job.expiresAt,
  };
}

function view(
  plugin: string,
  pluginName: string,
  pluginVersion: string,
  op: PluginOperation,
): AppOperationView {
  return {
    plugin,
    pluginName,
    pluginVersion,
    name: op.name,
    title: op.title,
    description: op.description,
    requires: op.requires,
    mode: op.mode ?? 'sync',
    input: op.input,
    ...(op.output ? { output: op.output } : {}),
  };
}

/** Any principal of the space may ask; what it gets is narrowed by each operation's `requires`. */
function authorizeSpace(principal: Principal, spaceId: string): void {
  if (principal.spaceId !== '*' && principal.spaceId !== spaceId) {
    throw new NotFoundError('Space', spaceId);
  }
}

function assertSize(value: unknown, field: string): void {
  if (!fits(value)) {
    throw new ValidationError([
      { field, message: `must be JSON of at most ${MAX_OPERATION_PAYLOAD_BYTES} bytes` },
    ]);
  }
}

function fits(value: unknown): boolean {
  try {
    const text = JSON.stringify(value);
    return (
      text !== undefined && new TextEncoder().encode(text).length <= MAX_OPERATION_PAYLOAD_BYTES
    );
  } catch {
    return false;
  }
}
