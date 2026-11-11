import type { Scope, SearchToggledEvent } from '@contentworker/domain';
import type { BlobStore, BulkJob, BulkJobChunk } from '@contentworker/ports';
import { getAiSettings } from './ai-settings';
import { type AssetSearchDeps, embedAssetForSearch } from './asset-search';
import { allAssets } from './assets';
import {
  type BulkChunkOutcome,
  cancelBulkJob,
  readableBulkJob,
  SEARCH_REINDEX_CHUNK_SIZE,
  startBulkJob,
} from './bulk-jobs';
import { type AppContext, withActor, withStarter } from './context';
import {
  indexEntryEmbeddings,
  MAX_REINDEX_ENTRIES,
  type RagDeps,
  removeEntryEmbeddings,
} from './rag';

/**
 * Turning the space's `search` capability on or off reindexes it (`search_reindex` bulk jobs): off,
 * every published entry's and every asset's vectors are deleted, so nothing stored keeps matching;
 * on, they are embedded again, so search doesn't wait for each one to be republished. The lexical
 * leg is the setting's to leave alone: it never reaches a model.
 *
 * `setAiSettings` appends one `search.toggled` per environment with the new version, in the unit
 * that saves it; the consumer starts that environment's job here. The job is the system's, not the
 * person's who turned it: it realizes the space's setting, which stays in force whoever set it, so
 * it runs to the end even if they lose access (their name is on it, as `config.actor`). It is
 * idempotent and resumable as every bulk job is (chunks CAS-claimed, the stall sweep), and each
 * chunk acts on the setting in force when it runs rather than the one that started it, so a chunk
 * of a job a later toggle overtook can only bring the index nearer the setting, never away from it.
 *
 * Embeddings are not metered by the cost guard (they never have been: they cost a fraction of a
 * generation and run on publish), and search has no tier, so neither the budget nor the deployment's
 * tier cap reaches this job. Its size is bounded instead: {@link MAX_REINDEX_ENTRIES} entries and as
 * many assets per environment, in chunks of {@link SEARCH_REINDEX_CHUNK_SIZE}.
 */

/** Recent jobs looked through for this environment's search reindexes. */
const RECENT_JOBS = 50;
const ENTRY = 'entry:';
const ASSET = 'asset:';

/** A chunk's ids of one kind, without their prefix. */
const idsOf = (chunk: BulkJobChunk, prefix: string): string[] =>
  chunk.entryIds.filter((id) => id.startsWith(prefix)).map((id) => id.slice(prefix.length));

/** What a search reindex job's `config` holds. */
interface SearchReindexConfig {
  readonly enabled?: unknown;
  readonly settingsVersion?: unknown;
}

const versionOf = (job: BulkJob): number => {
  const v = (job.config as SearchReindexConfig | undefined)?.settingsVersion;
  return typeof v === 'number' ? v : 0;
};

async function searchReindexJobs(ctx: AppContext, scope: Scope): Promise<BulkJob[]> {
  return (await ctx.store.bulkJobs.listJobs(scope, { limit: RECENT_JOBS })).filter(
    (j) => j.action === 'search_reindex',
  );
}

/**
 * The environment's latest search reindex job (newest first), running or not, or null: what the
 * admin's AI page shows progress from. A read.
 */
export async function getSearchReindexJob(ctx: AppContext, scope: Scope): Promise<BulkJob | null> {
  const [latest] = await searchReindexJobs(ctx, scope);
  return latest ? readableBulkJob(latest) : null;
}

export interface SearchReindexSources {
  /** Entries' vectors; absent (no embeddings bound), entries aren't listed. */
  readonly rag?: RagDeps;
  /** Assets' vectors; without `vectors`, assets aren't listed. */
  readonly assetSearch?: AssetSearchDeps;
}

/**
 * The `search.toggled` consumer: starts the environment's search reindex, superseding (cancelling)
 * one still running. Returns the job started, or the one a redelivered event already started; null
 * when there is nothing to do: an environment being purged, no vectors bound, nothing to index, or
 * a later toggle that overtook this one (its own event starts that job).
 */
export async function startSearchReindex(
  ctx: AppContext,
  sources: SearchReindexSources,
  event: SearchToggledEvent,
): Promise<BulkJob | null> {
  const { scope } = event;
  if ((await ctx.store.spaces.resolveName(scope.spaceId, scope.environmentId)).purging) return null;
  const entries = sources.rag !== undefined;
  const assets = sources.assetSearch?.vectors !== undefined;
  if (!entries && !assets) return null;
  // A toggle back before this one ran: the setting it asked for is no longer in force.
  const settings = await getAiSettings(ctx, scope.spaceId);
  if (settings.version > event.settingsVersion) {
    if (settings.capabilities.search.enabled !== event.enabled) return null;
  }
  const jobs = await searchReindexJobs(ctx, scope);
  // Redelivered (or overtaken by a later toggle's job): nothing new to start.
  const started = jobs.find((j) => versionOf(j) >= event.settingsVersion);
  if (started) return readableBulkJob(started);
  for (const old of jobs.filter((j) => j.status === 'running')) {
    await cancelBulkJob(ctx, scope, old.id);
  }

  const ids: string[] = [];
  if (entries) {
    let cursor = '';
    for (let n = 0; n < MAX_REINDEX_ENTRIES; ) {
      // Keyset paging by entry id, as the reindex slices page (stable under publishes meanwhile).
      const page = await ctx.store.entries.listPublished(scope, {
        limit: 500,
        afterEntryId: cursor,
        select: [],
      });
      for (const p of page.slice(0, MAX_REINDEX_ENTRIES - n)) ids.push(`${ENTRY}${p.entryId}`);
      n += page.length;
      const last = page[page.length - 1];
      if (!last || page.length < 500) break;
      cursor = last.entryId;
    }
  }
  if (assets) {
    // Every asset with a file: the library corpus is all of them, the published one those published.
    const library = await allAssets(ctx, scope);
    for (const a of library.slice(0, MAX_REINDEX_ENTRIES)) ids.push(`${ASSET}${a.id}`);
  }
  if (ids.length === 0) return null;
  // The system's job (no starter to re-check), its chunks attributed to whoever turned search.
  const acting = withStarter(withActor(ctx, event.actor), undefined);
  return startBulkJob(acting, scope, {
    action: 'search_reindex',
    entryIds: ids,
    config: { enabled: event.enabled, settingsVersion: event.settingsVersion },
  });
}

/**
 * The `search_reindex` chunk runner. Reads the setting once per chunk and brings each item in line
 * with it: an entry published now is embedded (on) or loses its vectors (off), one no longer
 * published loses them either way; an asset goes through `embedAssetForSearch`, which embeds both
 * corpora (on) or deletes them (off). Every write replaces or deletes, so a chunk run twice (a
 * redelivery, the stall sweep) ends the same. A failing embeddings call throws: the chunk is
 * released and retried, and failed for good after its attempts.
 */
export function searchReindexChunkRunner(
  ctx: AppContext,
  sources: SearchReindexSources & { readonly blob?: BlobStore },
): (scope: Scope, job: BulkJob, chunk: BulkJobChunk) => Promise<BulkChunkOutcome> {
  return async (scope, _job, chunk) => {
    const on = (await getAiSettings(ctx, scope.spaceId)).capabilities.search.enabled;
    const entryIds = idsOf(chunk, ENTRY);
    const assetIds = idsOf(chunk, ASSET);
    const unknown = chunk.entryIds.filter((id) => !id.startsWith(ENTRY) && !id.startsWith(ASSET));
    const { rag, assetSearch } = sources;
    if (rag && entryIds.length > 0) {
      const published = new Map(
        (await ctx.store.entries.getPublishedMany(scope, entryIds)).map((p) => [p.entryId, p]),
      );
      for (const id of entryIds) {
        const p = published.get(id);
        if (on && p) {
          await indexEntryEmbeddings(rag, scope, {
            entryId: id,
            fields: p.fields,
            entryVersion: p.version,
          });
        } else {
          await removeEntryEmbeddings(rag, scope, id);
        }
      }
    }
    const vectors = assetSearch?.vectors;
    if (assetSearch && vectors) {
      for (const id of assetIds) {
        if (on) {
          // Nothing when the asset is gone: its delete removed its vectors.
          await embedAssetForSearch(ctx, assetSearch, sources.blob, scope, id);
        } else {
          await vectors.deleteAsset(scope, id, 'library');
          await vectors.deleteAsset(scope, id, 'published');
        }
      }
    }
    return {
      succeeded: entryIds.length + assetIds.length,
      failures: unknown.map((id) => ({ id, error: 'Not an entry or asset of this job' })),
    };
  };
}
