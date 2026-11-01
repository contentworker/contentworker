import {
  type BulkChunkDueEvent,
  NotFoundError,
  type Scope,
  ValidationError,
} from '@contentworker/domain';
import {
  type BlobStore,
  type BulkJob,
  type BulkJobAction,
  type BulkJobChunk,
  TransactionConflictError,
} from '@contentworker/ports';
import type { AppContext } from './context';
import { discardStagedJob, importChunkKey } from './job-staging';
import { publishEntriesTx, unpublishEntriesTx } from './publishing';

/** Entry ids processed per chunk (one transaction + one coalesced event each). */
export const BULK_JOB_CHUNK_SIZE = 200;
/** Largest bulk job a single start call accepts. */
export const BULK_JOB_MAX_ITEMS = 250_000;
/** A chunk claimed longer than this is considered crashed and re-claimable. */
export const BULK_CHUNK_STALE_SECONDS = 300;
/** Attempts before a chunk is marked failed instead of retried. */
export const BULK_CHUNK_MAX_ATTEMPTS = 5;

export interface StartBulkJobInput {
  readonly action: BulkJobAction;
  readonly entryIds: readonly string[];
}

/**
 * Starts a durable bulk publish/unpublish job: persists the job and its
 * chunks, then appends one `bulk.chunk_due` control event per chunk to the
 * outbox. The relay routes those onto the bulk topic; consumers CAS-claim
 * each chunk and run it through the batched publish transaction. Progress
 * and the per-item compliance report live in the store, never in memory —
 * a crash anywhere resumes via the stall sweep.
 */
export async function startBulkJob(
  ctx: AppContext,
  scope: Scope,
  input: StartBulkJobInput,
): Promise<BulkJob> {
  const ids = [...new Set(input.entryIds)];
  if (ids.length === 0) {
    throw new ValidationError([{ field: 'entryIds', message: 'No items provided' }]);
  }
  if (ids.length > BULK_JOB_MAX_ITEMS) {
    throw new ValidationError([
      { field: 'entryIds', message: `Job exceeds ${BULK_JOB_MAX_ITEMS} items` },
    ]);
  }

  const jobId = ctx.ids.newId();
  const now = ctx.clock.now().toISOString();
  const chunks: BulkJobChunk[] = [];
  for (let at = 0; at < ids.length; at += BULK_JOB_CHUNK_SIZE) {
    chunks.push({
      jobId,
      // Zero-padded ordinal: sorts lexically in report order.
      chunkId: `c${String(chunks.length).padStart(5, '0')}`,
      entryIds: ids.slice(at, at + BULK_JOB_CHUNK_SIZE),
      status: 'pending',
      attempts: 0,
      failures: [],
    });
  }

  const job: BulkJob = {
    id: jobId,
    action: input.action,
    status: 'running',
    totalItems: ids.length,
    totalChunks: chunks.length,
    completedChunks: 0,
    succeeded: 0,
    failed: 0,
    createdAt: now,
  };
  return persistJob(ctx, scope, job, chunks, now);
}

/**
 * Commits a job, its chunks and their nudges together.
 *
 * One transaction, so no partial-start state — a job without chunks, or a
 * chunk without a nudge — can ever exist. The stall sweep is the backstop for
 * lost queue deliveries, not for lost rows.
 */
export async function persistJob(
  ctx: AppContext,
  scope: Scope,
  job: BulkJob,
  chunks: readonly BulkJobChunk[],
  now: string,
): Promise<BulkJob> {
  await ctx.store.withTransaction(async (tx) => {
    await tx.bulkJobs.createJob(scope, job);
    await tx.bulkJobs.createChunks(scope, chunks);
    await tx.outbox.appendMany(
      chunks.map((c) => ({
        id: ctx.ids.newId(),
        type: 'bulk.chunk_due' as const,
        scope,
        occurredAt: now,
        jobId: job.id,
        chunkId: c.chunkId,
      })),
    );
  });
  return job;
}

export interface RunBulkChunkResult {
  /** 'skipped' = someone else owns the chunk / job cancelled — a no-op. */
  readonly outcome: 'processed' | 'skipped' | 'failed_terminal';
  readonly succeeded?: number;
  readonly failed?: number;
}

/**
 * Consumer body for one `bulk.chunk_due` event. CAS-claims the chunk (a
 * redelivered or duplicate event loses the claim and no-ops), runs the batch
 * publish/unpublish transaction — which appends ONE coalesced
 * `entries.published_bulk` event in the same transaction — then folds the
 * outcome into the job and finalizes it when this was the last chunk.
 *
 * At-least-once safe: a crash after commit but before completeChunk leaves
 * the chunk `running` until the stall sweep re-claims it; the re-run
 * re-publishes already-published entries and counts already-unpublished ones
 * as no-op successes (`idempotent`), and re-emits the coalesced event — whose
 * synthesized per-entry webhook ids derive from (jobId, chunkId, entryId),
 * stable across re-runs, so receiver-side dedupe holds.
 *
 * Deliberate divergence from the per-entry publish path: bulk publishes do
 * NOT trigger on-publish agents (enrich/moderate) or per-entry live SSE
 * fan-out — at 100k-entry scale those are separate, opt-in workloads
 * (planned as a bulk-job flag alongside agent-batch support).
 */
/** What one chunk of work reported. */
export interface BulkChunkOutcome {
  readonly succeeded: number;
  readonly failures: readonly { id: string; error: string }[];
}

export interface BulkChunkDeps {
  /**
   * Runs an import chunk, injected rather than imported.
   *
   * An import chunk's work is staged in object storage rather than being a
   * list of ids, so running one needs a blob store this module has no business
   * knowing about — and importing the function that does would make these two
   * modules circular. A consumer that never runs imports may omit it; one that
   * does and forgets leaves the chunk claimable rather than reporting an
   * import that did not happen.
   */
  readonly importChunk?: (
    scope: Scope,
    job: BulkJob,
    chunk: BulkJobChunk,
  ) => Promise<BulkChunkOutcome>;
}

export async function runBulkChunk(
  ctx: AppContext,
  event: BulkChunkDueEvent,
  deps: BulkChunkDeps = {},
): Promise<RunBulkChunkResult> {
  const { scope, jobId, chunkId } = event;
  // A job in a deleted environment: its rows linger until purged, and must not be acted on.
  if ((await ctx.store.spaces.resolveName(scope.spaceId, scope.environmentId)).purging) {
    return { outcome: 'skipped' };
  }
  const job = await ctx.store.bulkJobs.getJob(scope, jobId);
  if (!job) return { outcome: 'skipped' };
  if (job.status !== 'running') return { outcome: 'skipped' };

  const now = ctx.clock.now();
  const staleBefore = new Date(now.getTime() - BULK_CHUNK_STALE_SECONDS * 1000);
  const chunk = await ctx.store.bulkJobs.claimChunk(scope, jobId, chunkId, { now, staleBefore });
  if (!chunk) return { outcome: 'skipped' };

  // A chunk that keeps crashing is terminal-failed rather than retried
  // forever: its items count as failures in the report and the job still
  // completes. (attempts was already incremented by this claim.)
  if (chunk.attempts > BULK_CHUNK_MAX_ATTEMPTS) {
    const failures = chunk.entryIds.map((id) => ({
      id,
      error: `Chunk failed after ${BULK_CHUNK_MAX_ATTEMPTS} attempts`,
    }));
    const updated = await ctx.store.bulkJobs.completeChunk(scope, jobId, chunkId, {
      status: 'failed',
      succeeded: 0,
      failed: failures.length,
      failures,
    });
    await finalizeIfDone(ctx, scope, updated);
    return { outcome: 'failed_terminal', succeeded: 0, failed: failures.length };
  }

  // An import chunk writes entries one at a time through the ordinary
  // use-cases; there is no batched transaction to run, and no coalesced
  // publish fact to emit, because an import publishes nothing.
  if (job.action === 'import') {
    return runImportChunkAndFold(ctx, deps, scope, job, chunk);
  }

  const runTx = job.action === 'publish' ? publishEntriesTx : unpublishEntriesTx;
  let batch: Awaited<ReturnType<typeof runTx>>;
  try {
    batch = await ctx.store.withTransaction(async (tx) => {
      // Per-entry events suppressed: the coalesced published_bulk below is
      // the chunk's single fact (otherwise every entry would dispatch twice).
      // `idempotent`: a re-run of a committed chunk counts already-satisfied
      // items as no-op successes, never report-corrupting failures.
      const result = await runTx(ctx, tx, scope, chunk.entryIds, {
        emitPerEntryEvents: false,
        idempotent: true,
      });
      if (result.published.length > 0) {
        // The coalesced fact for this chunk — same transaction as the writes,
        // so it exists iff the chunk committed. Downstream dispatch treats it
        // as the bulk-shaped replacement for N entry.published events.
        await tx.outbox.append({
          id: ctx.ids.newId(),
          type: 'entries.published_bulk',
          scope,
          occurredAt: ctx.clock.now().toISOString(),
          jobId,
          chunkId,
          // Narrowed, not cast blindly: only publish/unpublish reach here, and
          // an import that ever did would be emitting a publish fact about
          // entries it left as drafts.
          action: job.action === 'unpublish' ? 'unpublish' : 'publish',
          entryIds: result.published.map((e) => e.id),
        });
      }
      return result;
    });
  } catch (err) {
    // The chunk transaction rolled back: release the claim so the QUEUE's
    // retries (seconds apart) do real work instead of losing the CAS until
    // the 5-minute stale window passes. Attempts already counted this try.
    await ctx.store.bulkJobs.releaseChunk(scope, jobId, chunkId);
    throw err;
  }

  const succeeded = batch.published.length + batch.unchanged.length;
  const failed = batch.failures.length;
  const updated = await ctx.store.bulkJobs.completeChunk(scope, jobId, chunkId, {
    status: 'completed',
    succeeded,
    failed,
    failures: batch.failures,
  });
  await finalizeIfDone(ctx, scope, updated);
  return { outcome: 'processed', succeeded, failed };
}

/**
 * A job that starts when another completes, named in the first job's `config.next`. Its chunks'
 * work is staged under its own id (`importChunkKey`) before the first job is persisted, so it can
 * be created in the same write that finalizes the first: exactly once, and only on completion (a
 * cancelled first job never starts it).
 */
export interface ChainedJob {
  readonly id: string;
  readonly totalItems: number;
  readonly chunkIds: readonly string[];
  readonly config: Readonly<Record<string, unknown>>;
}

const chainedJobOf = (job: BulkJob): ChainedJob | undefined =>
  (job.config as { next?: ChainedJob } | undefined)?.next;

/** Finalizes the job and emits `bulk.job_completed` once all chunks are in. */
async function finalizeIfDone(ctx: AppContext, scope: Scope, job: BulkJob): Promise<void> {
  if (job.status !== 'running' || job.completedChunks < job.totalChunks) return;
  await ctx.store
    .withTransaction(async (tx) => {
      const at = ctx.clock.now();
      const finalized = await tx.bulkJobs.finalizeJob(scope, job.id, 'completed', at);
      // finalizeJob CASes on `running`, so exactly one competing finalizer
      // wins and the completed event is emitted once.
      if (!finalized) return;
      // Only after a clean run: a chained job builds on the first one's results (a snapshot's
      // publishing needs every entry the first job created), so after any failure it doesn't
      // start; the first job's report names what failed. Its staged work is discarded with the
      // first job's on `bulk.job_completed`.
      const next = finalized.failed === 0 ? chainedJobOf(finalized) : undefined;
      if (next) {
        const nowIso = at.toISOString();
        await tx.bulkJobs.createJob(scope, {
          id: next.id,
          action: finalized.action,
          status: 'running',
          totalItems: next.totalItems,
          totalChunks: next.chunkIds.length,
          completedChunks: 0,
          succeeded: 0,
          failed: 0,
          createdAt: nowIso,
          config: next.config,
        });
        await tx.bulkJobs.createChunks(
          scope,
          next.chunkIds.map((chunkId) => ({
            jobId: next.id,
            chunkId,
            entryIds: [],
            payloadKey: importChunkKey(scope, next.id, chunkId),
            status: 'pending' as const,
            attempts: 0,
            failures: [],
          })),
        );
        await tx.outbox.appendMany(
          next.chunkIds.map((chunkId) => ({
            id: ctx.ids.newId(),
            type: 'bulk.chunk_due' as const,
            scope,
            occurredAt: nowIso,
            jobId: next.id,
            chunkId,
          })),
        );
      }
      await tx.outbox.append({
        id: ctx.ids.newId(),
        type: 'bulk.job_completed',
        scope,
        occurredAt: ctx.clock.now().toISOString(),
        jobId: finalized.id,
        action: finalized.action,
        total: finalized.totalItems,
        succeeded: finalized.succeeded,
        failed: finalized.failed,
      });
    })
    .catch((err: unknown) => {
      // Another finalizer's CAS won at commit: it emitted the event, so this one is a no-op.
      if (err instanceof TransactionConflictError) return;
      throw err;
    });
}

/**
 * Crash-recovery sweep (cron/worker interval): re-appends `bulk.chunk_due`
 * for chunks that are pending-but-never-nudged or whose claim went stale, and
 * finalizes jobs whose chunks are ALL terminal but whose finalize was lost (a
 * crash between the last completeChunk and finalizeIfDone — no further
 * chunk_due will ever arrive for those, so only this sweep can complete them
 * and emit `bulk.job_completed`). Duplicate nudges are harmless — the CAS
 * claim admits exactly one runner; finalize CASes on `running`.
 */
export async function resumeStalledBulkJobs(
  ctx: AppContext,
  opts: { limit?: number } = {},
): Promise<number> {
  const limit = opts.limit ?? 200;

  const unfinalized = await ctx.store.bulkJobs.findUnfinalizedJobs(limit);
  for (const u of unfinalized) {
    const job = await ctx.store.bulkJobs.getJob(u.scope, u.jobId);
    if (job) await finalizeIfDone(ctx, u.scope, job);
  }

  const staleBefore = new Date(ctx.clock.now().getTime() - BULK_CHUNK_STALE_SECONDS * 1000);
  const stalled = await ctx.store.bulkJobs.findStalledChunks(staleBefore, limit);
  if (stalled.length === 0) return unfinalized.length;
  const occurredAt = ctx.clock.now().toISOString();
  await ctx.store.outbox.appendMany(
    stalled.map((s) => ({
      id: ctx.ids.newId(),
      type: 'bulk.chunk_due' as const,
      scope: s.scope,
      occurredAt,
      jobId: s.jobId,
      chunkId: s.chunkId,
    })),
  );
  return stalled.length + unfinalized.length;
}

export async function getBulkJob(ctx: AppContext, scope: Scope, id: string): Promise<BulkJob> {
  const job = await ctx.store.bulkJobs.getJob(scope, id);
  if (!job) throw new NotFoundError('BulkJob', id);
  return job;
}

export async function listBulkJobs(
  ctx: AppContext,
  scope: Scope,
  opts?: { limit?: number },
): Promise<BulkJob[]> {
  return ctx.store.bulkJobs.listJobs(scope, opts);
}

/** The compliance report: job totals + every per-item failure, per chunk. */
export interface BulkJobReport {
  readonly job: BulkJob;
  readonly chunks: readonly {
    readonly chunkId: string;
    readonly status: string;
    readonly attempts: number;
    readonly itemCount: number;
    readonly failures: readonly { id: string; error: string }[];
  }[];
}

export async function getBulkJobReport(
  ctx: AppContext,
  scope: Scope,
  id: string,
): Promise<BulkJobReport> {
  const job = await getBulkJob(ctx, scope, id);
  const chunks = await ctx.store.bulkJobs.listChunks(scope, id);
  return {
    job,
    chunks: chunks.map((c) => ({
      chunkId: c.chunkId,
      status: c.status,
      attempts: c.attempts,
      itemCount: c.entryIds.length,
      failures: c.failures,
    })),
  };
}

/**
 * Cancels a running job: pending chunks are skipped by their consumers (the
 * job-status check precedes the claim); a chunk mid-transaction finishes —
 * cancellation is a stop-taking-new-work signal, not a rollback.
 */
export async function cancelBulkJob(
  ctx: AppContext,
  scope: Scope,
  id: string,
  deps: { readonly blob?: BlobStore } = {},
): Promise<BulkJob> {
  const job = await ctx.store.bulkJobs.finalizeJob(scope, id, 'cancelled', ctx.clock.now());
  // Its unrun chunks' staged work, and that of the job it would have started, are never read now.
  if (job && deps.blob) await discardStagedJob(deps.blob, scope, job, { nextStarted: false });
  if (!job) {
    const existing = await ctx.store.bulkJobs.getJob(scope, id);
    if (!existing) throw new NotFoundError('BulkJob', id);
    return existing; // already terminal — cancel is idempotent
  }
  return job;
}

/**
 * Runs an import chunk and folds its outcome into the job.
 *
 * Mirrors the publish path's bookkeeping exactly — claim, run, complete,
 * finalize — so progress, cancellation, the stall sweep and the per-item
 * report all behave the same regardless of what kind of job it is.
 */
async function runImportChunkAndFold(
  ctx: AppContext,
  deps: BulkChunkDeps,
  scope: Scope,
  job: BulkJob,
  chunk: BulkJobChunk,
): Promise<RunBulkChunkResult> {
  if (!deps.importChunk) {
    // Releasing the claim rather than completing it: this is a wiring fault,
    // and a retry after the consumer is fixed should find the work waiting.
    await ctx.store.bulkJobs.releaseChunk(scope, job.id, chunk.chunkId);
    return { outcome: 'skipped' };
  }

  try {
    const { succeeded, failures } = await deps.importChunk(scope, job, chunk);
    const updated = await ctx.store.bulkJobs.completeChunk(scope, job.id, chunk.chunkId, {
      status: 'completed',
      succeeded,
      failed: failures.length,
      failures,
    });
    await finalizeIfDone(ctx, scope, updated);
    return { outcome: 'processed', succeeded, failed: failures.length };
  } catch (err) {
    await ctx.store.bulkJobs.releaseChunk(scope, job.id, chunk.chunkId);
    throw err;
  }
}
