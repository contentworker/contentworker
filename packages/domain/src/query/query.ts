/**
 * Field-level query primitives shared by every store adapter (D1 and the
 * in-memory test store) so filtering/ordering/search behave identically across
 * surfaces. Pure domain logic: no infrastructure, no port types.
 *
 * Field values are localized (`locale -> value`); a query compares against a
 * single comparable scalar resolved from the requested locale, falling back to
 * the field's first (default-locale) value — keeping localized and
 * non-localized fields uniform.
 */

import type { EntryFields, LocaleCode, LocalizedValue } from '../types.js';

/** The comparison operators a field filter may use. */
export type FilterOp =
  | 'eq'
  | 'ne'
  | 'in'
  | 'nin'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'exists'
  | 'match';

/** A single field-level predicate. `field` may be a content field apiId or a
 *  `sys.*` pseudo-field (e.g. `sys.publishedAt`). */
export interface QueryFilter {
  readonly field: string;
  readonly op: FilterOp;
  /** Comparand: scalar for eq/ne/gt…; array for in/nin; boolean for exists. */
  readonly value?: unknown;
}

/** A sort key. `field` may be a content field apiId or a `sys.*` pseudo-field. */
export interface QueryOrder {
  readonly field: string;
  readonly direction: 'asc' | 'desc';
}

/**
 * Resolves the comparable scalar for a localized value: the requested locale,
 * then each locale in `fallbacks` (the space's default-locale chain), then any
 * remaining locale in SORTED key order.
 *
 * The sort matters for correctness, not tidiness: a store need not preserve the
 * key insertion order of a localized JSON value (a database's JSON type may
 * reorder keys), while the in-memory store keeps insertion order.
 * Iterating raw key order would therefore resolve a different locale per
 * backend for any field missing the requested locale — the same query
 * returning different rows depending on the store. Sorting makes the fallback
 * deterministic everywhere; `fallbacks` makes it semantically right.
 */
export function comparableValue(
  lv: LocalizedValue | undefined,
  locale?: LocaleCode,
  fallbacks?: readonly LocaleCode[],
): unknown {
  if (!lv) return undefined;
  const present = (loc: string) => lv[loc] !== undefined && lv[loc] !== null;
  if (locale && present(locale)) return lv[locale];
  for (const f of fallbacks ?? []) {
    if (present(f)) return lv[f];
  }
  // Non-localized fields hold a single (default-locale) value; localized fields
  // missing every preferred locale degrade to the first value in sorted key
  // order — arbitrary but identical across stores.
  for (const k of Object.keys(lv).sort()) {
    if (present(k)) return lv[k];
  }
  return undefined;
}

/** Coerces a string comparand to the runtime type of the field value it is
 *  compared against (query strings are untyped; field values are not). */
function coerce(filterValue: unknown, fieldValue: unknown): unknown {
  if (typeof filterValue !== 'string') return filterValue;
  if (typeof fieldValue === 'number') {
    const n = Number(filterValue);
    return Number.isNaN(n) ? filterValue : n;
  }
  if (typeof fieldValue === 'boolean') {
    if (filterValue === 'true') return true;
    if (filterValue === 'false') return false;
  }
  return filterValue;
}

/** Orders two comparable scalars; numbers numerically, otherwise lexically.
 *  `undefined`/`null` sort last. */
export function compareValues(a: unknown, b: unknown): number {
  const aMissing = a === undefined || a === null;
  const bMissing = b === undefined || b === null;
  if (aMissing && bMissing) return 0;
  if (aMissing) return 1;
  if (bMissing) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const as = String(a);
  const bs = String(b);
  return as < bs ? -1 : as > bs ? 1 : 0;
}

/** Evaluates a single operator against a resolved field value. */
export function matchOp(op: FilterOp, fieldValue: unknown, filterValue: unknown): boolean {
  // Array-valued fields (e.g. metadata.tags) match by membership/intersection.
  if (Array.isArray(fieldValue)) {
    const wanted = Array.isArray(filterValue) ? filterValue : [filterValue];
    switch (op) {
      case 'exists': {
        const want = filterValue === undefined ? true : Boolean(filterValue);
        const present = fieldValue.length > 0;
        return want === present;
      }
      case 'eq':
      case 'in':
        return wanted.some((w) => fieldValue.includes(w));
      case 'ne':
      case 'nin':
        return !wanted.some((w) => fieldValue.includes(w));
      default:
        return false;
    }
  }
  switch (op) {
    case 'exists': {
      const present = fieldValue !== undefined && fieldValue !== null;
      // A bare `exists` (no comparand) asserts presence.
      const want = filterValue === undefined ? true : Boolean(filterValue);
      return present === want;
    }
    case 'in':
    case 'nin': {
      const arr = (Array.isArray(filterValue) ? filterValue : [filterValue]).map((v) =>
        coerce(v, fieldValue),
      );
      const found = arr.some((v) => v === fieldValue);
      return op === 'in' ? found : !found;
    }
    case 'match': {
      if (fieldValue === undefined || fieldValue === null) return false;
      return String(fieldValue).toLowerCase().includes(String(filterValue).toLowerCase());
    }
    default: {
      const fv = coerce(filterValue, fieldValue);
      switch (op) {
        case 'eq':
          return fieldValue === fv;
        case 'ne':
          return fieldValue !== fv;
        case 'gt':
          return compareValues(fieldValue, fv) > 0;
        case 'gte':
          return compareValues(fieldValue, fv) >= 0;
        case 'lt':
          return compareValues(fieldValue, fv) < 0;
        case 'lte':
          return compareValues(fieldValue, fv) <= 0;
        default:
          return false;
      }
    }
  }
}

/** Resolves a filter/order field name to its comparable value, honoring the
 *  `sys.*` namespace (backed by the row's sys record). */
function resolveField(
  field: string,
  fields: EntryFields,
  sys: Record<string, unknown>,
  locale?: LocaleCode,
  fallbacks?: readonly LocaleCode[],
): unknown {
  // `sys.*` and `metadata.*` are pseudo-fields backed by the row's sys record
  // (which carries both, keyed by the bare name / the full `metadata.*` key).
  if (field.startsWith('sys.')) return sys[field.slice(4)];
  if (field.startsWith('metadata.')) return sys[field];
  return comparableValue(fields[field], locale, fallbacks);
}

/** True if every filter matches the entry's fields. */
function matchesFilters(
  fields: EntryFields,
  sys: Record<string, unknown>,
  filters: readonly QueryFilter[],
  locale?: LocaleCode,
  fallbacks?: readonly LocaleCode[],
): boolean {
  return filters.every((f) =>
    matchOp(f.op, resolveField(f.field, fields, sys, locale, fallbacks), f.value),
  );
}

/** True if `search` (case-insensitive) appears in any string field value. */
function matchesSearch(
  fields: EntryFields,
  search: string,
  locale?: LocaleCode,
  fallbacks?: readonly LocaleCode[],
): boolean {
  const needle = search.toLowerCase();
  for (const lv of Object.values(fields)) {
    const v = comparableValue(lv, locale, fallbacks);
    if (typeof v === 'string' && v.toLowerCase().includes(needle)) return true;
  }
  return false;
}

/** Projects an entry's fields down to `select` (field apiIds). */
export function projectFields(fields: EntryFields, select: readonly string[]): EntryFields {
  const keep = new Set(select);
  const out: EntryFields = {};
  for (const [k, v] of Object.entries(fields)) {
    if (keep.has(k)) out[k] = v;
  }
  return out;
}

/** What a row must expose for {@link runEntryQuery} to filter/order it. */
export interface EntryQueryInput {
  readonly filters?: readonly QueryFilter[];
  readonly order?: readonly QueryOrder[];
  readonly search?: string;
  readonly skip?: number;
  readonly limit?: number;
  /** Locale used to resolve field values for comparison. */
  readonly locale?: LocaleCode;
  /** Ordered fallback locales (the space's default-locale chain) tried when
   *  `locale` has no value for a field — keeps resolution deterministic and
   *  identical across stores. */
  readonly fallbackLocales?: readonly LocaleCode[];
}

/**
 * Filters, orders and paginates `rows` by a field-level query. `fieldsOf` and
 * `sysOf` adapt each row to its localized fields and `sys.*` values, so the same
 * engine drives both the published and the draft/preview read paths.
 *
 * Projection (`select`) is applied by the caller, since it reshapes the returned
 * row's `fields` and the row type varies per surface.
 */
export function runEntryQuery<T>(
  rows: readonly T[],
  query: EntryQueryInput,
  fieldsOf: (row: T) => EntryFields,
  sysOf: (row: T) => Record<string, unknown>,
): T[] {
  let result = [...rows];

  if (query.filters?.length) {
    result = result.filter((r) =>
      matchesFilters(
        fieldsOf(r),
        sysOf(r),
        query.filters as QueryFilter[],
        query.locale,
        query.fallbackLocales,
      ),
    );
  }
  if (query.search) {
    result = result.filter((r) =>
      matchesSearch(fieldsOf(r), query.search as string, query.locale, query.fallbackLocales),
    );
  }
  if (query.order?.length) {
    const order = query.order;
    result.sort((a, b) => {
      for (const o of order) {
        const av = resolveField(
          o.field,
          fieldsOf(a),
          sysOf(a),
          query.locale,
          query.fallbackLocales,
        );
        const bv = resolveField(
          o.field,
          fieldsOf(b),
          sysOf(b),
          query.locale,
          query.fallbackLocales,
        );
        const cmp = compareValues(av, bv);
        if (cmp !== 0) return o.direction === 'desc' ? -cmp : cmp;
      }
      return 0;
    });
  }

  const skip = query.skip ?? 0;
  const limit = query.limit ?? 100;
  return result.slice(skip, skip + limit);
}
