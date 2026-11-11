import { type ContentTypeGrant, holdsScope, type Principal } from '../auth/auth';

/**
 * Async operation jobs: an `async` operation is accepted at once as a job, and the engine runs it
 * on a durable Workflow (one instance per job) with a longer budget than a request has. The caller
 * polls the job for its output.
 *
 * The job keeps a snapshot of its caller (scopes and content grants), because the Workflow runs
 * after the request that asked for it is gone: the plugin's grant is narrowed to that snapshot
 * exactly as a sync call's is narrowed to the live caller. Before it runs, the caller is resolved
 * again and must still hold that access, and a job that doesn't start within
 * {@link APP_JOB_START_DEADLINE_MS} fails rather than run on a copy grown old. It also pins the plugin's checksum, so
 * a job never runs code other than what was installed when it was accepted.
 */

export type AppOperationJobStatus = 'pending' | 'running' | 'completed' | 'failed';

/** Who asked, as the job runs for them. Never shown to callers. */
export interface AppOperationJobCaller {
  readonly kind: Principal['kind'];
  readonly scopes: readonly string[];
  readonly contentGrants?: readonly ContentTypeGrant[];
  /**
   * Who that is, by reference and never a credential (an API key id or a team membership id, as
   * a bulk job records its starter): resolved again before the job runs, so a key revoked or a
   * person removed or narrowed since stops it. Absent for the deployment's own tokens.
   */
  readonly startedBy?:
    | { readonly kind: 'key'; readonly keyId: string }
    | { readonly kind: 'member'; readonly memberId: string }
    | { readonly kind: 'deployment' };
}

export interface AppOperationJob {
  readonly id: string;
  /** The plugin's id and the version and checksum accepted to run. */
  readonly plugin: string;
  readonly pluginVersion: string;
  readonly checksum: string;
  readonly operation: string;
  /** The scope the operation needed when accepted; reading the job needs it too. */
  readonly requires: string;
  readonly status: AppOperationJobStatus;
  readonly input: unknown;
  /** Once `completed`: what the operation returned (JSON, checked against its schema). */
  readonly output?: unknown;
  /** Once `failed`: why, said to the caller (redacted). */
  readonly error?: string;
  readonly caller: AppOperationJobCaller;
  /** The caller's audit identity. */
  readonly createdBy: string;
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  /** When the job, and its output, are deleted. */
  readonly expiresAt: string;
}

/** How long a job (and its output) is kept to be read. */
export const APP_JOB_RETENTION_SECONDS = 24 * 60 * 60;
/** Most async jobs one environment has pending or running at once; another is a 409. */
export const MAX_ACTIVE_APP_JOBS = 10;
/**
 * Most jobs one environment keeps (within their retention) at once; another is a 409. Each row
 * holds up to 64 KB of input and 64 KB of output, so this bounds what callers can store in D1.
 */
export const MAX_KEPT_APP_JOBS = 1000;
/**
 * A job not started this long after it was accepted never runs: it fails instead. The caller's
 * access was copied when it was accepted, so a run is kept close to that moment, and a key
 * revoked or a role narrowed in between can't act through a backlog for long.
 */
export const APP_JOB_START_DEADLINE_MS = 10 * 60_000;
/** An async operation's budget: wall time for the plugin call and every capability it makes. */
export const ASYNC_OPERATION_TIMEOUT_MS = 5 * 60_000;
/**
 * A job still running this long after it started is reported as failed: its Workflow is gone,
 * and nothing else will finish it.
 */
export const APP_JOB_STALE_MS = ASYNC_OPERATION_TIMEOUT_MS + APP_JOB_START_DEADLINE_MS;
/**
 * How far back, from acceptance, a job can still be active: started at the latest at its start
 * deadline, then stale {@link APP_JOB_STALE_MS} after that. What the active count looks back over.
 */
export const APP_JOB_ACTIVE_WINDOW_MS = APP_JOB_START_DEADLINE_MS + APP_JOB_STALE_MS;
/** Why a job that was never started failed. */
export const APP_JOB_NOT_STARTED = 'The operation did not start in time';

/** Most jobs a listing returns. */
export const MAX_APP_JOBS_LISTED = 50;

/** True while the job may still finish (and counts toward {@link MAX_ACTIVE_APP_JOBS}). */
export function appJobIsActive(job: AppOperationJob, now: Date): boolean {
  const { status } = effectiveAppJob(job, now);
  return status === 'pending' || status === 'running';
}

/**
 * The job as it stands at `now`: one still pending past its start deadline never runs (the
 * Workflow refuses it), and one running {@link APP_JOB_STALE_MS} after it started never finishes;
 * both read as failed.
 */
export function effectiveAppJob(job: AppOperationJob, now: Date): AppOperationJob {
  if (job.status === 'pending') {
    if (now.getTime() - Date.parse(job.createdAt) <= APP_JOB_START_DEADLINE_MS) return job;
    return { ...job, status: 'failed', error: APP_JOB_NOT_STARTED };
  }
  if (job.status !== 'running') return job;
  if (now.getTime() - Date.parse(job.startedAt ?? job.createdAt) <= APP_JOB_STALE_MS) return job;
  return { ...job, status: 'failed', error: 'The operation did not finish in time' };
}

/**
 * Whether `principal` (audit identity `actor`) may read `job`: the admin token always;
 * anyone else only if they could have produced it themselves, so holding the operation's scope and
 * every scope its caller held, and, for a principal with content grants, being the same caller
 * with the same grants. A job's output can carry what its caller's access let the plugin read.
 */
export function appJobVisibleTo(
  job: AppOperationJob,
  principal: Principal,
  actor: string,
): boolean {
  if (principal.kind === 'admin') return true;
  if (!holdsScope(principal.scopes, job.requires)) return false;
  if (!job.caller.scopes.every((s) => holdsScope(principal.scopes, s))) return false;
  if (principal.contentGrants === undefined) return true;
  return (
    job.createdBy === actor &&
    JSON.stringify(principal.contentGrants) === JSON.stringify(job.caller.contentGrants)
  );
}
