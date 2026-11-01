/**
 * Parses field-level query parameters into a port `EntryQuery`. Shared by
 * the Delivery, Preview, and GraphQL surfaces so the query language is identical
 * everywhere.
 *
 * Supported syntax:
 *   - `fields.<apiId>=v`                 → equals
 *   - `fields.<apiId>[op]=v`             → op ∈ ne|in|nin|gt|gte|lt|lte|exists|match
 *   - `sys.publishedAt[gt]=<iso>`        → `sys.*` pseudo-fields
 *   - `order=fields.title,-sys.publishedAt`  → sort keys (`-` = descending)
 *   - `select=fields.title,fields.body`  → projection (field apiIds)
 *   - `query=foo`                        → full-text search over string fields
 *   - `content_type`, `limit`, `skip`, `since`, `locale`  → as before
 */

import {
  ASSET_KINDS,
  type FilterOp,
  type QueryFilter,
  type QueryOrder,
  ValidationError,
} from '@contentworker/domain';
import type { AssetListQuery, EntryQuery } from '@contentworker/ports';

const OPS: ReadonlySet<string> = new Set([
  'eq',
  'ne',
  'in',
  'nin',
  'gt',
  'gte',
  'lt',
  'lte',
  'exists',
  'match',
]);

const FILTER_KEY = /^((?:fields|sys)\.[A-Za-z0-9_]+)(?:\[(\w+)\])?$/;

/** Largest page a client may request; caps memory/DB work per request. */
export const MAX_PAGE_LIMIT = 100;

/**
 * Coerces a raw `limit`/`skip`/`top_k` string to a bounded non-negative integer,
 * defending the store from `NaN`, negative, `Infinity`, or absurd values that
 * would otherwise reach `LIMIT`/`OFFSET`. Returns `undefined` for an absent
 * value so callers keep their own default.
 */
export function clampCount(
  raw: string | number | undefined,
  max: number,
  { min = 0 }: { min?: number } = {},
): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  if (Number.isNaN(n)) return min;
  // ±Infinity clamps naturally: Math.max(Infinity, min) → Infinity → Math.min → max.
  return Math.min(Math.max(Math.trunc(n), min), max);
}

/** Strips the leading `fields.` namespace; leaves `sys.*` keys intact. */
function fieldName(path: string): string {
  return path.startsWith('fields.') ? path.slice('fields.'.length) : path;
}

function toFilter(path: string, op: string, raw: string): QueryFilter | null {
  if (!OPS.has(op)) return null;
  const field = fieldName(path);
  if (op === 'in' || op === 'nin') {
    return { field, op: op as FilterOp, value: raw.split(',').map((s) => s.trim()) };
  }
  if (op === 'exists') {
    return { field, op: 'exists', value: raw !== 'false' };
  }
  return { field, op: op as FilterOp, value: raw };
}

function parseOrder(raw: string): QueryOrder[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((token) => {
      const direction = token.startsWith('-') ? 'desc' : 'asc';
      const path = token.replace(/^-/, '');
      return { field: fieldName(path), direction };
    });
}

/** Builds an `EntryQuery` from raw query-string entries (key/value pairs). */
export function entryQueryFrom(entries: Iterable<[string, string]>): EntryQuery {
  const filters: QueryFilter[] = [];
  let order: QueryOrder[] | undefined;
  let select: string[] | undefined;
  let search: string | undefined;
  let contentTypeApiId: string | undefined;
  let limit: number | undefined;
  let skip: number | undefined;
  let since: string | undefined;
  let locale: string | undefined;
  let archived: boolean | undefined;

  for (const [key, value] of entries) {
    if (key === 'order') {
      order = parseOrder(value);
      continue;
    }
    if (key === 'select') {
      select = value
        .split(',')
        .map((s) => fieldName(s.trim()))
        .filter((s) => s && !s.startsWith('sys.'));
      continue;
    }
    if (key === 'query') {
      search = value;
      continue;
    }
    if (key === 'content_type') {
      contentTypeApiId = value;
      continue;
    }
    if (key === 'limit') {
      limit = clampCount(value, MAX_PAGE_LIMIT, { min: 1 });
      continue;
    }
    if (key === 'skip') {
      skip = clampCount(value, Number.MAX_SAFE_INTEGER, { min: 0 });
      continue;
    }
    if (key === 'since') {
      since = value;
      continue;
    }
    if (key === 'locale') {
      locale = value;
      continue;
    }
    // `?trashed=true` switches a list to the trash view. Anything else — absent,
    // "false", a typo — means the normal list, so a malformed value can never
    // silently hide live content.
    if (key === 'trashed') {
      archived = value === 'true';
      continue;
    }
    const m = FILTER_KEY.exec(key);
    if (m) {
      const filter = toFilter(m[1] as string, m[2] ?? 'eq', value);
      if (filter) filters.push(filter);
    }
  }

  return {
    contentTypeApiId,
    limit,
    skip,
    since,
    locale,
    archived,
    filters: filters.length ? filters : undefined,
    order,
    select,
    search,
  };
}

/** Convenience: parse straight from a `URLSearchParams`. */
export function parseEntryQuery(params: URLSearchParams): EntryQuery {
  return entryQueryFrom(params.entries());
}

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

/**
 * The asset library's query string: `kind`, `mime` (`image/png` or `image/*`), `tag`, `folder`
 * (an id, or `root` for assets in no folder), `status` (`all` includes archived), `sort` and
 * `order`, `limit` and `cursor`.
 */
export function parseAssetListQuery(q: Record<string, string | undefined>): AssetListQuery {
  const kind = oneOf('kind', q.kind, ASSET_KINDS);
  const status = oneOf('status', q.status, ASSET_STATUSES);
  const field = oneOf('sort', q.sort, ASSET_SORTS);
  const direction = oneOf('order', q.order, ['asc', 'desc'] as const);
  const limit = clampCount(q.limit, MAX_PAGE_LIMIT, { min: 1 });
  const folder = q.folder === undefined || q.folder === '' ? undefined : q.folder;
  return {
    ...(limit !== undefined ? { limit } : {}),
    ...(q.cursor ? { cursor: q.cursor } : {}),
    filters: {
      ...(kind ? { kind } : {}),
      ...(q.mime ? { mime: q.mime.slice(0, 256) } : {}),
      ...(q.tag ? { tag: q.tag.slice(0, 128) } : {}),
      ...(folder !== undefined ? { folderId: folder === 'root' ? null : folder } : {}),
      ...(status ? { status } : {}),
    },
    ...(field || direction
      ? { sort: { field: field ?? 'updatedAt', direction: direction ?? 'desc' } }
      : {}),
  };
}
