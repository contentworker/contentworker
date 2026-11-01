import type { Asset, Scope } from '@contentworker/domain';
import type { BlobStore, BulkJob, BulkJobChunk } from '@contentworker/ports';
import { publishAsset } from './assets';
import { type ChainedJob, persistJob } from './bulk-jobs';
import type { AppContext } from './context';
import { importChunkKey } from './job-staging';
import {
  createSnapshotAsset,
  createSnapshotEntry,
  type EnvironmentSnapshot,
  exportSnapshot,
  type ImportOptions,
  type ImportReport,
  prepareSnapshotImport,
  publishSnapshotEntry,
  type StagedSnapshotEntry,
  type StagedSnapshotPublication,
  stagedEntry,
  stagedPublication,
  writeSnapshotModel,
} from './snapshots';

/**
 * Environment import and clone as durable jobs.
 *
 * Replaying a snapshot writes every entry through the use-cases, which for an environment of any
 * size is far more than one request can hold (CPU, and the request's lifetime). So the request
 * does what must be synchronous: every check (`prepareSnapshotImport`, so a bad snapshot is
 * refused before anything is written), then the content model, taxonomy and workflows, which are
 * small and which everything else depends on. The assets and entries are staged in object storage
 * in chunks and written by the bulk-job machinery, which brings resumability, cancellation, the
 * stall sweep and a per-item report.
 *
 * Two jobs, chained. The first creates asset records and entries as drafts. Publishing waits for
 * it to finish, because publishing an entry needs every entry and asset it links to to exist, and
 * chunks run concurrently. When the first job completes, the second (publish what was published,
 * then lay changed entries' drafts on top) starts in the same write that finalizes the first.
 */

/** Items per staged chunk: each is a few use-case calls, so a chunk stays well inside a queue
 *  consumer's limits. */
export const SNAPSHOT_JOB_CHUNK_SIZE = 100;

/** The `config` of a snapshot import job; `phase` says what its chunks do. */
export interface SnapshotJobConfig extends Record<string, unknown> {
  readonly kind: 'snapshot';
  readonly phase: 'create' | 'publish';
  /**
   * The snapshot's taxonomy ids mapped to the ones the import created (create phase). Entries are
   * staged with the snapshot's ids, before the model is written, and remapped as they are created.
   */
  readonly taxonomyIds?: Readonly<Record<string, string>>;
}

interface CreateChunk {
  readonly assets: readonly Asset[];
  readonly entries: readonly StagedSnapshotEntry[];
}

interface PublishChunk {
  readonly assetIds: readonly string[];
  readonly entries: readonly StagedSnapshotPublication[];
}

export interface StartedSnapshotImport {
  readonly report: ImportReport;
  /** The job creating the assets and entries; null when the snapshot has neither. */
  readonly job: BulkJob | null;
  /** The publishing job that starts when `job` completes; null when nothing is published. */
  readonly publishJobId: string | null;
}

export const isSnapshotJob = (config: unknown): config is SnapshotJobConfig =>
  (config as { kind?: unknown } | undefined)?.kind === 'snapshot';

/**
 * Starts importing a snapshot into `target` as a job. Everything that can refuse it is checked
 * first, exactly as `importSnapshot` does; then the model is written and the rest is staged.
 */
export async function startSnapshotImport(
  ctx: AppContext,
  blob: BlobStore,
  target: Scope,
  snapshot: EnvironmentSnapshot,
  options: ImportOptions = {},
): Promise<StartedSnapshotImport> {
  const { report, publishable } = await prepareSnapshotImport(ctx, target, snapshot, options);
  const publishing = options.publish !== false;

  const createItems = [
    ...snapshot.assets.map((asset) => ({ asset })),
    // With the snapshot's own taxonomy ids: remapped as each entry is created (see config).
    ...snapshot.entries.map((entry) => ({ entry: stagedEntry(entry, new Map(), publishing) })),
  ];
  if (createItems.length === 0) {
    await writeSnapshotModel(ctx, target, snapshot, report.skipped as string[]);
    return { report, job: null, publishJobId: null };
  }

  const publishItems = publishing
    ? [
        ...snapshot.assets.filter((a) => a.status === 'published').map((a) => ({ assetId: a.id })),
        ...publishable.map((entry) => ({ entry: stagedPublication(entry) })),
      ]
    : [];

  const now = ctx.clock.now().toISOString();
  const jobId = ctx.ids.newId();
  // Everything is staged first, before the model is written: a failure while staging leaves the
  // target untouched (still empty, so a retry works), and no chunk can ever be claimed before its
  // work is readable. After the model, the only write left is the job itself.
  const createChunks = await stageChunks(blob, target, jobId, createItems, itemId, (items) => ({
    assets: items.flatMap((i) => ('asset' in i ? [i.asset] : [])),
    entries: items.flatMap((i) => ('entry' in i ? [i.entry] : [])),
  }));
  let next: ChainedJob | undefined;
  if (publishItems.length > 0) {
    const publishJobId = ctx.ids.newId();
    const publishChunks = await stageChunks(
      blob,
      target,
      publishJobId,
      publishItems,
      itemId,
      (items) => ({
        assetIds: items.flatMap((i) => ('assetId' in i ? [i.assetId] : [])),
        entries: items.flatMap((i) => ('entry' in i ? [i.entry] : [])),
      }),
    );
    next = {
      id: publishJobId,
      totalItems: publishItems.length,
      chunkIds: publishChunks.map((c) => c.chunkId),
      config: { kind: 'snapshot', phase: 'publish' } satisfies SnapshotJobConfig,
    };
  }

  const taxonomyIds = await writeSnapshotModel(ctx, target, snapshot, report.skipped as string[]);
  const config: SnapshotJobConfig & { next?: ChainedJob } = {
    kind: 'snapshot',
    phase: 'create',
    taxonomyIds: Object.fromEntries(taxonomyIds),
    ...(next ? { next } : {}),
  };
  const job = await persistJob(
    ctx,
    target,
    {
      id: jobId,
      action: 'import',
      status: 'running',
      totalItems: createItems.length,
      totalChunks: createChunks.length,
      completedChunks: 0,
      succeeded: 0,
      failed: 0,
      createdAt: now,
      config,
    },
    createChunks,
    now,
  );
  return { report, job, publishJobId: next?.id ?? null };
}

/**
 * Clones `source` into `target` as a job: the export happens in the request (it is reads), the
 * writing in the job.
 */
export async function startEnvironmentClone(
  ctx: AppContext,
  blob: BlobStore,
  source: Scope,
  target: Scope,
  options: ImportOptions = {},
): Promise<StartedSnapshotImport> {
  return startSnapshotImport(ctx, blob, target, await exportSnapshot(ctx, source), options);
}

/** The id an item is reported under: the asset's or the entry's. */
const itemId = (item: {
  asset?: { id: string };
  assetId?: string;
  entry?: { id: string };
}): string => item.asset?.id ?? item.assetId ?? item.entry?.id ?? '';

/**
 * Splits `items` into staged chunks under `jobId`, returning the chunk rows to persist. Each row
 * lists its items' ids, so a chunk that fails for good reports every one of them as failed.
 */
async function stageChunks<T, P>(
  blob: BlobStore,
  scope: Scope,
  jobId: string,
  items: readonly T[],
  idOf: (item: T) => string,
  toPayload: (items: readonly T[]) => P,
): Promise<BulkJobChunk[]> {
  const chunks: BulkJobChunk[] = [];
  for (let at = 0; at < items.length; at += SNAPSHOT_JOB_CHUNK_SIZE) {
    const chunkId = `c${String(chunks.length).padStart(5, '0')}`;
    const payloadKey = importChunkKey(scope, jobId, chunkId);
    const slice = items.slice(at, at + SNAPSHOT_JOB_CHUNK_SIZE);
    await blob.put(payloadKey, JSON.stringify(toPayload(slice)), 'application/json');
    chunks.push({
      jobId,
      chunkId,
      entryIds: slice.map(idOf),
      payloadKey,
      status: 'pending',
      attempts: 0,
      failures: [],
    });
  }
  return chunks;
}

export interface SnapshotChunkOutcome {
  readonly succeeded: number;
  readonly failures: readonly { id: string; error: string }[];
}

/**
 * Runs one staged chunk of a snapshot import. Each item is attempted on its own, so one bad
 * entry is a reported failure rather than a stalled chunk; every step is safe to run again
 * (see `createSnapshotEntry` and `publishSnapshotEntry`), so a chunk re-run after a crash
 * finishes the job instead of duplicating it.
 */
export async function runSnapshotChunk(
  ctx: AppContext,
  blob: BlobStore,
  scope: Scope,
  config: SnapshotJobConfig,
  payloadKey: string,
): Promise<SnapshotChunkOutcome> {
  const raw = await blob.get(payloadKey);
  if (raw === null) {
    // Failing the chunk is right: reporting success would claim an import that never happened.
    throw new Error(`Staged work for this chunk is missing (${payloadKey})`);
  }
  let succeeded = 0;
  const failures: { id: string; error: string }[] = [];
  const attempt = async (id: string, work: () => Promise<void>) => {
    try {
      await work();
      succeeded += 1;
    } catch (err) {
      failures.push({ id, error: err instanceof Error ? err.message : String(err) });
    }
  };

  if (config.phase === 'create') {
    const chunk = JSON.parse(raw) as CreateChunk;
    const remap = (id: string) => config.taxonomyIds?.[id] ?? id;
    for (const asset of chunk.assets) {
      await attempt(asset.id, () => createSnapshotAsset(ctx, scope, asset));
    }
    for (const entry of chunk.entries) {
      const remapped = {
        ...entry,
        tags: entry.tags.map(remap),
        concepts: entry.concepts.map(remap),
      };
      await attempt(entry.id, () => createSnapshotEntry(ctx, scope, remapped));
    }
  } else {
    const chunk = JSON.parse(raw) as PublishChunk;
    for (const assetId of chunk.assetIds) {
      await attempt(assetId, async () => {
        const asset = await ctx.store.assets.get(scope, assetId);
        if (asset?.status !== 'published') await publishAsset(ctx, scope, assetId);
      });
    }
    for (const publication of chunk.entries) {
      await attempt(publication.id, () => publishSnapshotEntry(ctx, scope, publication));
    }
  }
  return { succeeded, failures };
}
