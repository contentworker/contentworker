import {
  type BulkChunkDueEvent,
  canRunEntryBulkJob,
  ENTRY_BULK_JOB_KINDS,
  type EntryBulkJobKind,
  ForbiddenError,
  NotFoundError,
  type Principal,
  type Scope,
  ValidationError,
} from '@contentworker/domain';
import {
  type BlobStore,
  type BulkItemFailure,
  type BulkJob,
  type BulkJobAction,
  type BulkJobChunk,
  ENTRY_TRASH_BULK_ACTIONS,
  TransactionConflictError,
} from '@contentworker/ports';
import { type AppContext, withActor } from './context';
import { discardStagedJob, importChunkKey } from './job-staging';
import { publishEntriesTx, unpublishEntriesTx } from './publishing';

/** Entry ids processed per chunk (one transaction + one coalesced event each). */
export const BULK_JOB_CHUNK_SIZE = 200;
/**
 * Entry ids per chunk of a trash, restore or purge job. Those run each entry through its own
 * single-entry use-case, a unit of work and a few reads apiece, where a publish chunk is one
 * batched transaction. Measured on D1 (packages/db/test/trash-retention.test.ts): a purge is 10
 * statements in 5 round trips, so 200 would pass the 1,000 queries one invocation may send and
 * the chunk would be retried into the dead-letter queue; 50 is about 500.
 */
export const ENTRY_TRASH_CHUNK_SIZE = 50;

/**
 * The largest trash, restore or purge job. Its chunks are a quarter the size of a publish job's, so
 * the same id count would make four times the chunks, every one of them a row and an outbox nudge
 * written in the one batch that starts the job: 100,000 ids is 2,000 chunks, as many as a
 * 400,000-id publish job would make if one could be started.
 */
export const ENTRY_TRASH_MAX_ITEMS = 100_000;

/** Trash, restore and purge, and a content type's delete: each entry through its use-cases. */
const isEntryTrashAction = (action: BulkJobAction): boolean =>
  action === 'content_type_delete' ||
  (ENTRY_TRASH_BULK_ACTIONS as readonly string[]).includes(action);

/** How many ids one chunk of `action` takes. */
export const bulkChunkSizeOf = (action: BulkJobAction): number =>
  isEntryTrashAction(action) ? ENTRY_TRASH_CHUNK_SIZE : BULK_JOB_CHUNK_SIZE;

/** The most ids one job of `action` takes. */
export const bulkMaxItemsOf = (action: BulkJobAction): number =>
  isEntryTrashAction(action) ? ENTRY_TRASH_MAX_ITEMS : BULK_JOB_MAX_ITEMS;
/** Largest bulk job a single start call accepts. */
export const BULK_JOB_MAX_ITEMS = 250_000;
/** A chunk claimed longer than this is considered crashed and re-claimable. */
export const BULK_CHUNK_STALE_SECONDS = 300;
/** Attempts before a chunk is marked failed instead of retried. */
export const BULK_CHUNK_MAX_ATTEMPTS = 5;

/**
 * Refuses a principal who may not start, cancel or read the report of a bulk job of `action`: one
 * rule for both surfaces. A job over entries is checked by `canRunEntryBulkJob` (no per-type
 * grants, or one full `*` grant holding the job's actions); any other job (an import, an asset
 * job) still needs a principal with no per-type grants at all.
 */
export function authorizeBulkJob(principal: Principal, action: BulkJobAction): void {
  const allowed = (ENTRY_BULK_JOB_KINDS as readonly string[]).includes(action)
    ? canRunEntryBulkJob(principal, action as EntryBulkJobKind)
    : !principal.contentGrants;
  if (!allowed) {
    throw new ForbiddenError(`bulk ${action} jobs (a role holding them on every content type)`);
  }
}

export interface StartBulkJobInput {
  readonly action: BulkJobAction;
  readonly entryIds: readonly string[];
  /** What the job's chunks need to know of the request (an asset move's folder). */
  readonly config?: Readonly<Record<string, unknown>>;
}

/**
 * Starts a durable bulk job over entry (or asset) ids: persists the job and its chunks, then
 * appends one `bulk.chunk_due` control event per chunk to the outbox. The relay routes those onto
 * the bulk topic; consumers CAS-claim each chunk and run it: publish and unpublish through the
 * batched publish transaction, trash, restore and purge through each entry's single-entry
 * use-case (`entry-trash-bulk.ts`). Progress
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
  const max = bulkMaxItemsOf(input.action);
  if (ids.length > max) {
    throw new ValidationError([{ field: 'entryIds', message: `Job exceeds ${max} items` }]);
  }

  const jobId = ctx.ids.newId();
  const now = ctx.clock.now().toISOString();
  const chunks: BulkJobChunk[] = [];
  const size = bulkChunkSizeOf(input.action);
  for (let at = 0; at < ids.length; at += size) {
    chunks.push({
      jobId,
      // Zero-padded ordinal: sorts lexically in report order.
      chunkId: `c${String(chunks.length).padStart(5, '0')}`,
      entryIds: ids.slice(at, at + size),
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
    ...(input.config ? { config: input.config } : {}),
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
  // Its chunks run later, on a consumer with no principal: whoever started the job is recorded with
  // it, so what they write is theirs (see `jobActor`).
  if (ctx.actor !== undefined) job = { ...job, config: { ...job.config, actor: ctx.actor } };
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
  readonly failures: readonly BulkItemFailure[];
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
  /**
   * Sends an asset reindex chunk's assets through ingest again (`asset-ingest.ts`), injected for
   * the same reason: it needs the ingest queue. Absent, the chunk stays claimable.
   */
  readonly assetReindexChunk?: (
    scope: Scope,
    job: BulkJob,
    chunk: BulkJobChunk,
  ) => Promise<BulkChunkOutcome>;
  /**
   * Runs an asset library bulk action's chunk (`asset-bulk.ts`), injected because that module
   * starts its jobs through this one. Absent, the chunk stays claimable.
   */
  readonly assetBulkChunk?: (
    scope: Scope,
    job: BulkJob,
    chunk: BulkJobChunk,
  ) => Promise<BulkChunkOutcome>;
  /**
   * Runs an entry trash job's chunk (`entry-trash-bulk.ts`), injected because purging needs the
   * blob store its archived versions live in. Absent, the chunk stays claimable.
   */
  readonly entryTrashChunk?: (
    scope: Scope,
    job: BulkJob,
    chunk: BulkJobChunk,
  ) => Promise<BulkChunkOutcome>;
  /**
   * Runs a content type delete's chunk, trashing and purging its entries
   * (`content-type-lifecycle.ts`), injected for the blob store as above. Absent, the chunk stays
   * claimable.
   */
  readonly contentTypePurgeChunk?: (
    scope: Scope,
    job: BulkJob,
    chunk: BulkJobChunk,
  ) => Promise<BulkChunkOutcome>;
}

/** Who started `job` (recorded by `persistJob`), as its chunks' writes are authored; undefined when
 *  it was started before that was recorded. */
export const jobActor = (job: BulkJob): string | undefined =>
  typeof job.config?.actor === 'string' ? job.config.actor : undefined;

/** `ctx` writing as whoever started `job`. */
export const actingForJob = (ctx: AppContext, job: BulkJob): AppContext =>
  withActor(ctx, jobActor(job));

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
    return runChunkAndFold(ctx, deps.importChunk, scope, job, chunk);
  }
  // An asset reindex chunk hands its assets to ingest: nothing is written here but the report.
  if (job.action === 'asset_reindex') {
    return runChunkAndFold(ctx, deps.assetReindexChunk, scope, job, chunk);
  }
  // Trash, restore or purge: each entry through its single-entry use-case.
  if (job.action === 'trash' || job.action === 'restore' || job.action === 'purge') {
    return runChunkAndFold(ctx, deps.entryTrashChunk, scope, job, chunk);
  }
  // A content type's delete: its entries trashed and purged, each through its use-cases.
  if (job.action === 'content_type_delete') {
    return runChunkAndFold(ctx, deps.contentTypePurgeChunk, scope, job, chunk);
  }
  // An asset library action: each asset through its own use-case, failures reported by name.
  if (job.action !== 'publish' && job.action !== 'unpublish') {
    return runChunkAndFold(ctx, deps.assetBulkChunk, scope, job, chunk);
  }

  const runTx = job.action === 'publish' ? publishEntriesTx : unpublishEntriesTx;
  const acting = actingForJob(ctx, job);
  let batch: Awaited<ReturnType<typeof runTx>>;
  try {
    batch = await ctx.store.withTransaction(async (tx) => {
      // Per-entry events suppressed: the coalesced published_bulk below is
      // the chunk's single fact (otherwise every entry would dispatch twice).
      // `idempotent`: a re-run of a committed chunk counts already-satisfied
      // items as no-op successes, never report-corrupting failures.
      const result = await runTx(acting, tx, scope, chunk.entryIds, {
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
    readonly failures: readonly BulkItemFailure[];
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
  // A content type's delete stopped: the type stays, and its readers are told so as a completed
  // job's are (`finishContentTypeDeletion`), not left waiting for an outcome that never comes.
  if (job.action === 'content_type_delete') {
    const typeDeletion = { deleted: false, reason: 'the job was stopped' };
    await ctx.store.bulkJobs.mergeConfig(scope, id, { typeDeletion });
    return { ...job, config: { ...job.config, typeDeletion } };
  }
  return job;
}

/**
 * Runs an import, asset or entry trash chunk and folds its outcome into the job.
 *
 * Mirrors the publish path's bookkeeping exactly — claim, run, complete,
 * finalize — so progress, cancellation, the stall sweep and the per-item
 * report all behave the same regardless of what kind of job it is.
 */
async function runChunkAndFold(
  ctx: AppContext,
  run: BulkChunkDeps['importChunk'],
  scope: Scope,
  job: BulkJob,
  chunk: BulkJobChunk,
): Promise<RunBulkChunkResult> {
  if (!run) {
    // Releasing the claim rather than completing it: this is a wiring fault,
    // and a retry after the consumer is fixed should find the work waiting.
    await ctx.store.bulkJobs.releaseChunk(scope, job.id, chunk.chunkId);
    return { outcome: 'skipped' };
  }

  try {
    const { succeeded, failures } = await run(scope, job, chunk);
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
