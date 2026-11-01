import {
  type Asset,
  type AssetKind,
  type AssetStatus,
  assetKind,
  type DeliveredAsset,
  type LocalizedValue,
  type Scope,
  ValidationError,
} from '@contentworker/domain';
import type {
  BlobStore,
  EmbeddingsProvider,
  PublishedAsset,
  SearchIndex,
  VectorStore,
} from '@contentworker/ports';
import { assetProjectionContext, projectPublishedAsset } from './asset-delivery';
import { assetTextKey } from './assets';
import type { AppContext } from './context';
import type { RagDeps } from './rag';

/**
 * Asset search: hybrid, as entry search is (a lexical leg and a semantic one, fused by rank), over
 * an index of assets that ingest and publishing keep. Assets have their own lexical shards and
 * their own vector namespace, so neither leg ever mixes them with entries.
 */

/** The indexes asset search reads and ingest writes; each is optional, and so is its leg. */
export interface AssetSearchDeps {
  /** Embeddings and vectors for the semantic leg; absent, search is lexical only. */
  readonly embeddings?: EmbeddingsProvider;
  readonly vectors?: VectorStore;
  /** The asset corpus of the FTS5 shards; absent, the lexical leg scans recent assets. */
  readonly index?: SearchIndex;
}

/** The asset search indexes out of the RAG wiring (`embed: false` leaves the semantic leg out). */
export function assetSearchDeps(
  rag: RagDeps | undefined,
  opts: { readonly embed?: boolean } = {},
): AssetSearchDeps {
  return {
    ...(rag && opts.embed !== false ? { embeddings: rag.embeddings, vectors: rag.vectors } : {}),
    ...(rag?.assetSearchIndex ? { index: rag.assetSearchIndex } : {}),
  };
}

/** Characters of extracted text that go into an asset's embedding (the model reads ~512 tokens). */
export const ASSET_EMBED_EXCERPT_CHARS = 1_500;
/** Characters of extracted text the lexical index holds per asset. */
export const ASSET_INDEX_TEXT_CHARS = 100_000;

const localized = (value: LocalizedValue | undefined): string[] =>
  Object.values(value ?? {}).filter((v): v is string => typeof v === 'string' && v.trim() !== '');

/** What an asset is searched by, as one snapshot (published, or the library's draft). */
interface SearchSource {
  readonly id: string;
  readonly file: Asset['file'];
  readonly title: LocalizedValue;
  readonly description: LocalizedValue;
  readonly metadata: Asset['metadata'];
  readonly version: number;
}

/**
 * The text an asset is found by: its file name, title, caption (description), alt text and tag
 * names, and an excerpt of what ingest read out of the file. A published asset is indexed from its
 * published snapshot, so Delivery's search never ranks it on text only a draft has.
 */
async function searchText(
  ctx: AppContext,
  blob: BlobStore | undefined,
  scope: Scope,
  source: SearchSource,
  extractChars: number,
): Promise<string> {
  const tags = source.metadata.tags.length
    ? await ctx.store.taxonomy.listTags(scope)
    : ([] as { id: string; name: string }[]);
  const tagNames = new Map(tags.map((t) => [t.id, t.name]));
  const key = assetTextKey(scope, source.id, source.version);
  const extracted = key && blob ? ((await blob.get(key)) ?? '') : '';
  return [
    source.file.fileName,
    ...localized(source.title),
    ...localized(source.description),
    ...localized(source.metadata.altText),
    source.metadata.tags.map((id) => tagNames.get(id) ?? '').join(' '),
    extracted.slice(0, extractChars),
  ]
    .filter((p) => p.trim() !== '')
    .join('\n');
}

/** The snapshot an asset is indexed from: published when it is, else the library's. */
async function searchSource(
  ctx: AppContext,
  scope: Scope,
  assetId: string,
): Promise<SearchSource | null> {
  const [asset, published] = await Promise.all([
    ctx.store.assets.get(scope, assetId),
    ctx.store.assets.getPublished(scope, assetId),
  ]);
  if (!asset) return null;
  const from = published ?? asset;
  return {
    id: assetId,
    file: from.file,
    title: from.title,
    description: from.description,
    metadata: from.metadata,
    version: asset.version ?? 1,
  };
}

/**
 * Writes an asset's semantic leg: one vector over its search text. Idempotent (the vector is
 * replaced). Returns false when there is nothing to do (no embeddings, or the asset is gone).
 */
export async function embedAssetForSearch(
  ctx: AppContext,
  deps: AssetSearchDeps,
  blob: BlobStore | undefined,
  scope: Scope,
  assetId: string,
): Promise<boolean> {
  if (!deps.embeddings || !deps.vectors) return false;
  const source = await searchSource(ctx, scope, assetId);
  if (!source) return false;
  const text = await searchText(ctx, blob, scope, source, ASSET_EMBED_EXCERPT_CHARS);
  const [embedding] = await deps.embeddings.embed([text], { taskType: 'document' });
  if (!embedding) return false;
  await deps.vectors.upsertAsset(scope, {
    assetId,
    embedding,
    assetKind: assetKind(source.file.contentType),
    version: source.version,
  });
  return true;
}

/** Writes an asset's lexical leg: one document in the asset shards. Idempotent. */
export async function indexAssetText(
  ctx: AppContext,
  deps: AssetSearchDeps,
  blob: BlobStore | undefined,
  scope: Scope,
  assetId: string,
): Promise<boolean> {
  if (!deps.index) return false;
  const source = await searchSource(ctx, scope, assetId);
  if (!source) return false;
  const text = await searchText(ctx, blob, scope, source, ASSET_INDEX_TEXT_CHARS);
  await deps.index.index(scope, {
    entryId: assetId,
    contentTypeApiId: 'asset',
    textByLocale: { '*': text },
    entryVersion: source.version,
  });
  return true;
}

/** Both legs, for a publish or unpublish (whose snapshot is what search reads). */
export async function indexAssetForSearch(
  ctx: AppContext,
  deps: AssetSearchDeps,
  blob: BlobStore | undefined,
  scope: Scope,
  assetId: string,
): Promise<void> {
  await embedAssetForSearch(ctx, deps, blob, scope, assetId);
  await indexAssetText(ctx, deps, blob, scope, assetId);
}

/** Removes an asset from both legs. Idempotent. */
export async function removeAssetFromSearch(
  deps: AssetSearchDeps | undefined,
  scope: Scope,
  assetId: string,
): Promise<void> {
  await deps?.vectors?.deleteAsset(scope, assetId);
  await deps?.index?.remove(scope, assetId);
}

// ---- search -----------------------------------------------------------------------------------

/** Most results one search returns; also how many candidates each leg contributes. */
export const MAX_ASSET_SEARCH_RESULTS = 100;
/** Assets the lexical fallback scans when no index is bound (dev, tests): the most recent. */
export const ASSET_SCAN_LIMIT = 500;
/** Longest query accepted. */
export const MAX_ASSET_QUERY_LENGTH = 256;

export interface AssetSearchFilters {
  readonly kind?: AssetKind;
  readonly tag?: string;
  /** A folder id, or `null` for assets in no folder. */
  readonly folderId?: string | null;
  /** Omitted: everything but archived, as the library lists. Delivery ignores it. */
  readonly status?: AssetStatus | 'all';
}

export interface AssetSearchQuery {
  readonly q: string;
  /** 1..{@link MAX_ASSET_SEARCH_RESULTS}, default 20. */
  readonly limit?: number;
  readonly filters?: AssetSearchFilters;
}

/**
 * How many matches each facet value has. Each facet counts over the matches with every other
 * filter applied but not its own, so choosing a kind still shows how many of each other kind
 * there are. `folder` keys are folder ids, and `root` for assets in no folder.
 */
export interface AssetFacets {
  readonly kind: Readonly<Record<string, number>>;
  readonly tag: Readonly<Record<string, number>>;
  readonly folder: Readonly<Record<string, number>>;
}

export interface AssetSearchPage<T> {
  /** Best match first. */
  readonly items: readonly T[];
  /** Matches after the filters (of at most {@link MAX_ASSET_SEARCH_RESULTS} candidates). */
  readonly total: number;
  readonly facets: AssetFacets;
}

/** Reciprocal Rank Fusion constant, as entry search uses. */
const RRF_K = 60;

function checkQuery(query: AssetSearchQuery): { q: string; limit: number } {
  const q = query.q.trim();
  if (q === '' || q.length > MAX_ASSET_QUERY_LENGTH) {
    throw new ValidationError([
      { field: 'q', message: `q is 1 to ${MAX_ASSET_QUERY_LENGTH} characters` },
    ]);
  }
  const raw = query.limit ?? 20;
  const limit = Math.min(Math.max(1, Math.trunc(Number.isFinite(raw) ? raw : 20)), 100);
  return { q, limit };
}

const terms = (q: string) =>
  q
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/** Whether every term of the query appears in the texts (the fallback's AND semantics). */
function matches(texts: readonly string[], queryTerms: readonly string[]): number {
  const hay = texts.join('\n').toLowerCase();
  let score = 0;
  for (const t of queryTerms) {
    if (!hay.includes(t)) return 0;
    score += 1;
  }
  return score;
}

const scanTexts = (a: {
  file: Asset['file'];
  title: LocalizedValue;
  description: LocalizedValue;
  metadata: Asset['metadata'];
}) => [
  a.file.fileName,
  ...localized(a.title),
  ...localized(a.description),
  ...localized(a.metadata.altText),
];

/**
 * The fused candidate ids, best first. The lexical leg is the asset shards (falling back to
 * `scan` when unbound or unreachable, as entry search falls back to its store scan); the semantic
 * leg embeds the query and asks the asset vectors.
 */
async function candidates(
  deps: AssetSearchDeps,
  scope: Scope,
  q: string,
  scan: () => Promise<string[]>,
): Promise<string[]> {
  const lexical = async (): Promise<string[]> => {
    if (deps.index) {
      try {
        const hits = await deps.index.search(scope, q, { topK: MAX_ASSET_SEARCH_RESULTS });
        return hits.map((h) => h.entryId);
      } catch {
        return scan();
      }
    }
    return scan();
  };
  const semantic = async (): Promise<string[]> => {
    if (!deps.embeddings || !deps.vectors) return [];
    const [embedding] = await deps.embeddings.embed([q], { taskType: 'query' });
    if (!embedding) return [];
    const topK = Math.min(MAX_ASSET_SEARCH_RESULTS, deps.vectors.maxTopK ?? 50);
    // Orthogonal vectors share nothing; anything above that is a candidate the fusion ranks.
    const hits = await deps.vectors.queryAssets(scope, embedding, { topK, minScore: 1e-6 });
    return hits.map((h) => h.assetId);
  };
  const [lex, sem] = await Promise.all([lexical(), semantic()]);
  const fused = new Map<string, number>();
  const add = (ids: readonly string[]) =>
    ids.forEach((id, rank) => {
      fused.set(id, (fused.get(id) ?? 0) + 1 / (RRF_K + rank + 1));
    });
  add(lex);
  add(sem);
  return [...fused.entries()]
    .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
    .slice(0, MAX_ASSET_SEARCH_RESULTS)
    .map(([id]) => id);
}

interface Facetable {
  readonly kind: AssetKind;
  readonly tags: readonly string[];
  readonly folder: string | null;
}

/** Applies the kind/tag/folder filters and counts the facets (each without its own filter). */
function facetAndFilter<T>(
  rows: readonly { item: T; f: Facetable }[],
  filters: AssetSearchFilters,
): { items: T[]; facets: AssetFacets } {
  const keep = (f: Facetable, skip?: 'kind' | 'tag' | 'folder') =>
    (skip === 'kind' || !filters.kind || f.kind === filters.kind) &&
    (skip === 'tag' || !filters.tag || f.tags.includes(filters.tag)) &&
    (skip === 'folder' || filters.folderId === undefined || f.folder === filters.folderId);
  const kind: Record<string, number> = {};
  const tag: Record<string, number> = {};
  const folder: Record<string, number> = {};
  for (const { f } of rows) {
    if (keep(f, 'kind')) kind[f.kind] = (kind[f.kind] ?? 0) + 1;
    if (keep(f, 'tag')) for (const t of new Set(f.tags)) tag[t] = (tag[t] ?? 0) + 1;
    if (keep(f, 'folder')) {
      const k = f.folder ?? 'root';
      folder[k] = (folder[k] ?? 0) + 1;
    }
  }
  return { items: rows.filter((r) => keep(r.f)).map((r) => r.item), facets: { kind, tag, folder } };
}

const statusMatches = (asset: Asset, status: AssetSearchFilters['status']) =>
  status === undefined ? asset.status !== 'archived' : status === 'all' || asset.status === status;

/**
 * Searches the asset library (Management): drafts and published alike, archived left out unless
 * `filters.status` asks for them, filtered by kind, tag and folder, with facet counts.
 */
export async function searchAssets(
  ctx: AppContext,
  deps: AssetSearchDeps,
  scope: Scope,
  query: AssetSearchQuery,
): Promise<AssetSearchPage<Asset>> {
  const { q, limit } = checkQuery(query);
  const filters = query.filters ?? {};
  const queryTerms = terms(q);
  const ids = await candidates(deps, scope, q, async () => {
    const page = await ctx.store.assets.list(scope, {
      limit: ASSET_SCAN_LIMIT,
      filters: { status: filters.status ?? 'all' },
    });
    return page.items
      .map((a) => ({ id: a.id, score: matches(scanTexts(a), queryTerms) }))
      .filter((h) => h.score > 0)
      .sort((x, y) => y.score - x.score)
      .map((h) => h.id);
  });
  const byId = new Map((await ctx.store.assets.getMany(scope, ids)).map((a) => [a.id, a]));
  const rows = ids
    .map((id) => byId.get(id))
    .filter((a): a is Asset => a !== undefined && statusMatches(a, filters.status))
    .map((a) => ({
      item: a,
      f: { kind: assetKind(a.file.contentType), tags: a.metadata.tags, folder: a.folderId ?? null },
    }));
  const { items, facets } = facetAndFilter(rows, filters);
  return { items: items.slice(0, limit), total: items.length, facets };
}

/**
 * Searches what Delivery serves: published assets only, as their published snapshots project
 * (the media origin's URLs, renditions, srcset), filtered by kind, tag and folder (filing is read
 * live, as Delivery's listing reads it). A read: nothing is written, so it caches like any
 * delivery list.
 */
export async function searchDeliveredAssets(
  ctx: AppContext,
  deps: AssetSearchDeps,
  scope: Scope,
  query: AssetSearchQuery,
  opts: { readonly locale?: string } = {},
): Promise<AssetSearchPage<DeliveredAsset>> {
  const { q, limit } = checkQuery(query);
  const filters = query.filters ?? {};
  const queryTerms = terms(q);
  const ids = await candidates(deps, scope, q, async () => {
    const page = await ctx.store.assets.listPublished(scope, { limit: ASSET_SCAN_LIMIT });
    return page.items
      .map((p) => ({ id: p.assetId, score: matches(scanTexts(p), queryTerms) }))
      .filter((h) => h.score > 0)
      .sort((x, y) => y.score - x.score)
      .map((h) => h.id);
  });
  const [published, rows, pc] = await Promise.all([
    ctx.store.assets.getPublishedMany(scope, ids),
    ctx.store.assets.getMany(scope, ids),
    assetProjectionContext(ctx, scope, opts),
  ]);
  const snapshot = new Map(published.map((p) => [p.assetId, p]));
  const folderOf = new Map(rows.map((a) => [a.id, a.folderId ?? null]));
  const hits = ids
    .map((id) => snapshot.get(id))
    .filter((p): p is PublishedAsset => p !== undefined)
    .map((p) => ({
      item: p,
      f: {
        kind: assetKind(p.file.contentType),
        tags: p.metadata.tags,
        folder: folderOf.get(p.assetId) ?? null,
      },
    }));
  const { items, facets } = facetAndFilter(hits, filters);
  return {
    items: items.slice(0, limit).map((p) => projectPublishedAsset(ctx, scope, p, pc)),
    total: items.length,
    facets,
  };
}
