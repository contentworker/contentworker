/**
 * Parses the asset query strings (library, Delivery, search). The entry query language lives in
 * `@contentworker/application` (`entryQueryFrom`), shared with the GraphQL resolvers.
 */

import { type AssetSearchQuery, clampCount, MAX_PAGE_LIMIT } from '@contentworker/application';
import { ASSET_KINDS, type AssetKind, ValidationError } from '@contentworker/domain';
import type { AssetListQuery } from '@contentworker/ports';

const ASSET_STATUSES = ['draft', 'published', 'archived', 'all'] as const;
const ASSET_SORTS = ['updatedAt', 'createdAt', 'size'] as const;

/** Reads `value` as one of `allowed`, or refuses it naming the choices. */
function oneOf<T extends string>(
  field: string,
  value: string | undefined,
  allowed: readonly T[],
): T | undefined {
  if (value === undefined || value === '') return undefined;
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new ValidationError([{ field, message: `${field} must be one of ${allowed.join(', ')}` }]);
}

/** The most ids one asset listing looks up: a page's worth, so the default page holds them all. */
export const MAX_ASSET_IDS = MAX_PAGE_LIMIT;

/** `ids=a,b,c`: distinct asset ids, each 1 to 64 characters with no spaces. */
function assetIds(raw: string | undefined): string[] | undefined {
  if (raw === undefined || raw === '') return undefined;
  const ids = [...new Set(raw.split(','))];
  if (ids.length > MAX_ASSET_IDS) {
    throw new ValidationError([
      { field: 'ids', message: `ids names at most ${MAX_ASSET_IDS} assets` },
    ]);
  }
  if (ids.some((id) => id === '' || id.length > 64 || /\s/.test(id))) {
    throw new ValidationError([
      { field: 'ids', message: 'ids is a comma-separated list of asset ids' },
    ]);
  }
  return ids;
}

/** `contentHash=`: a file's SHA-256 as 64 hex digits, read in lower case as ingest writes it. */
function contentHash(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    throw new ValidationError([
      { field: 'contentHash', message: 'contentHash is a SHA-256 as 64 hex digits' },
    ]);
  }
  return raw.toLowerCase();
}

/**
 * The asset library's query string: `ids` (comma-separated, at most 100), `kind`, `mime`
 * (`image/png` or `image/*`), `tag`, `folder` (an id, or `root` for assets in no folder), `status`
 * (`all` includes archived), `contentHash` (the assets whose file has these bytes, once ingested),
 * `sort` and `order`, `limit` and `cursor`.
 */
export function parseAssetListQuery(q: Record<string, string | undefined>): AssetListQuery {
  const kind = oneOf('kind', q.kind, ASSET_KINDS);
  const status = oneOf('status', q.status, ASSET_STATUSES);
  const field = oneOf('sort', q.sort, ASSET_SORTS);
  const direction = oneOf('order', q.order, ['asc', 'desc'] as const);
  const limit = clampCount(q.limit, MAX_PAGE_LIMIT, { min: 1 });
  const folder = q.folder === undefined || q.folder === '' ? undefined : q.folder;
  const ids = assetIds(q.ids);
  const hash = contentHash(q.contentHash);
  return {
    ...(limit !== undefined ? { limit } : {}),
    ...(q.cursor ? { cursor: q.cursor } : {}),
    filters: {
      ...(ids ? { ids } : {}),
      ...(kind ? { kind } : {}),
      ...(q.mime ? { mime: q.mime.slice(0, 256) } : {}),
      ...(q.tag ? { tag: q.tag.slice(0, 128) } : {}),
      ...(folder !== undefined ? { folderId: folder === 'root' ? null : folder } : {}),
      ...(status ? { status } : {}),
      ...(hash ? { contentHash: hash } : {}),
    },
    ...(field || direction
      ? { sort: { field: field ?? 'updatedAt', direction: direction ?? 'desc' } }
      : {}),
  };
}

/**
 * A Delivery or Preview asset listing from query parameters: `limit`, `cursor` (or `skip`),
 * `kind`, `tag`, and `folder` (an id, or `root` for assets in no folder).
 */
export function parseDeliveredAssetQuery(q: Record<string, string | undefined>): {
  limit?: number;
  skip?: number;
  cursor?: string;
  filters: { kind?: AssetKind; tag?: string; folderId?: string | null };
} {
  const kind = oneOf('kind', q.kind, ASSET_KINDS);
  const limit = clampCount(q.limit, MAX_PAGE_LIMIT, { min: 1 });
  const skip = clampCount(q.skip, Number.MAX_SAFE_INTEGER, { min: 0 });
  const folder = q.folder === undefined || q.folder === '' ? undefined : q.folder;
  return {
    ...(limit !== undefined ? { limit } : {}),
    ...(q.cursor ? { cursor: q.cursor } : skip ? { skip } : {}),
    filters: {
      ...(kind ? { kind } : {}),
      ...(q.tag ? { tag: q.tag.slice(0, 128) } : {}),
      ...(folder !== undefined ? { folderId: folder === 'root' ? null : folder } : {}),
    },
  };
}

/**
 * An asset search's query string: `q`, `limit`, and the filters `kind`, `tag`, `folder` (an id,
 * or `root`) and, for the library, `status` (`all` includes archived).
 */
export function parseAssetSearchQuery(q: Record<string, string | undefined>): AssetSearchQuery {
  const kind = oneOf('kind', q.kind, ASSET_KINDS);
  const status = oneOf('status', q.status, ASSET_STATUSES);
  const limit = clampCount(q.limit, MAX_PAGE_LIMIT, { min: 1 });
  const folder = q.folder === undefined || q.folder === '' ? undefined : q.folder;
  return {
    q: q.q ?? '',
    ...(limit !== undefined ? { limit } : {}),
    filters: {
      ...(kind ? { kind } : {}),
      ...(q.tag ? { tag: q.tag.slice(0, 128) } : {}),
      ...(folder !== undefined ? { folderId: folder === 'root' ? null : folder } : {}),
      ...(status ? { status } : {}),
    },
  };
}
