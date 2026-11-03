/**
 * Parses field-level query parameters into a port `EntryQuery`. Shared by
 * the Delivery, Preview, and GraphQL surfaces (the GraphQL `where`/`order`
 * arguments are this syntax too, see `deliveryGraphResolvers`) so the query
 * language is identical everywhere.
 *
 * Supported syntax:
 *   - `fields.<apiId>=v`                 → equals
 *   - `fields.<apiId>[op]=v`             → op ∈ ne|in|nin|gt|gte|lt|lte|exists|match
 *   - `fields.<link>[ref]=<id>`          → the field links to that entry (`[refIn]=<id>,<id>`: any)
 *   - `links_to_entry=<id>`              → any field links to that entry (`<id>,<id>`: any)
 *   - `sys.publishedAt[gt]=<iso>`        → `sys.*` pseudo-fields
 *   - `metadata.tags[in]=<id>,<id>`      → taxonomy associations by id (also `metadata.concepts`)
 *   - `metadata.tags.slug=news`          → by slug (eq|ne|in|nin; also `metadata.concepts.slug`)
 *   - `order=fields.title,-sys.publishedAt`  → sort keys (`-` = descending)
 *   - `select=fields.title,fields.body`  → projection (field apiIds)
 *   - `query=foo`                        → full-text search over string fields
 *   - `content_type`, `limit`, `skip`, `since`, `locale`  → as before
 */

import {
  ANY_FIELD,
  FILTER_OPS,
  type FilterOp,
  type QueryFilter,
  type QueryOrder,
  queryFilterIssues,
  ValidationError,
} from '@contentworker/domain';
import type { EntryQuery } from '@contentworker/ports';

const OPS: ReadonlySet<string> = new Set(FILTER_OPS);

/**
 * `fields.<apiId>`, `sys.<name>`, or a taxonomy association: `metadata.tags` /
 * `metadata.concepts` (ids) and `metadata.tags.slug` / `metadata.concepts.slug` (slugs).
 */
const FILTER_KEY =
  /^((?:fields|sys)\.[A-Za-z0-9_]+|metadata\.(?:tags|concepts)(?:\.slug)?)(?:\[(\w+)\])?$/;

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

const list = (raw: string) => raw.split(',').map((s) => s.trim());

function toFilter(path: string, op: string, raw: string): QueryFilter | null {
  if (!OPS.has(op)) return null;
  const field = fieldName(path);
  if (op === 'in' || op === 'nin' || op === 'refIn') {
    return { field, op: op as FilterOp, value: list(raw) };
  }
  if (op === 'exists') {
    return { field, op: 'exists', value: raw !== 'false' };
  }
  return { field, op: op as FilterOp, value: raw };
}

/** Throws the filter's problems, if it has any, naming the query-string key it came from. */
function checked(filter: QueryFilter, key: string): QueryFilter {
  const issues = queryFilterIssues(filter, key);
  if (issues.length) throw new ValidationError(issues);
  return filter;
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
    if (key === 'links_to_entry') {
      const ids = list(value).filter(Boolean);
      filters.push(
        checked(
          ids.length === 1
            ? { field: ANY_FIELD, op: 'ref', value: ids[0] }
            : { field: ANY_FIELD, op: 'refIn', value: ids },
          key,
        ),
      );
      continue;
    }
    const m = FILTER_KEY.exec(key);
    if (m) {
      const filter = toFilter(m[1] as string, m[2] ?? 'eq', value);
      if (filter) filters.push(checked(filter, key));
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
