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

import type { EntryFields, LocaleCode, LocalizedValue } from '../types';

/** The comparison operators a field filter may use, in the order the docs list them. */
export const FILTER_OPS = [
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
  'ref',
  'refIn',
] as const;

/**
 * The comparison operators a field filter may use. `ref` (one entry id) and `refIn` (several)
 * match a field that links to one of those entries.
 */
export type FilterOp = (typeof FILTER_OPS)[number];

/**
 * The `field` of a reference filter that looks in every field: `links_to_entry`. Only `ref` and
 * `refIn` take it.
 */
export const ANY_FIELD = '*';

/** A single field-level predicate. `field` may be a content field apiId, a `sys.*`
 *  pseudo-field (e.g. `sys.publishedAt`), a `metadata.*` association, or {@link ANY_FIELD} for
 *  a reference filter over every field. */
export interface QueryFilter {
  readonly field: string;
  readonly op: FilterOp;
  /** Comparand: scalar for eq/ne/gt…; array for in/nin/refIn; boolean for exists; an entry id
   *  for ref. */
  readonly value?: unknown;
}

/** An `in`, `nin` or `refIn` list holds at most this many values. */
export const MAX_FILTER_VALUES = 100;

/**
 * A field a filter may name, once any `fields.` prefix is stripped: a content field apiId, a
 * `sys.*` pseudo-field, a taxonomy association, or {@link ANY_FIELD}.
 */
const FILTER_FIELD =
  /^(?:\*|sys\.[A-Za-z0-9_]+|metadata\.(?:tags|concepts)(?:\.slug)?|[A-Za-z0-9_]+)$/;

type Issue = { readonly field: string; readonly message: string };

/**
 * Checks one field predicate: a field the query language knows, an operator it supports, and a
 * comparand of the operator's shape. Returns the problems, empty when it is valid. `at` names the
 * predicate in the issues (`fields.author[ref]`).
 */
export function queryFilterIssues(f: QueryFilter, at: string): Issue[] {
  const issues: Issue[] = [];
  const op = f.op as string;
  if (!(FILTER_OPS as readonly string[]).includes(op)) {
    return [{ field: at, message: `op must be one of ${FILTER_OPS.join(', ')}` }];
  }
  if (typeof f.field !== 'string' || !FILTER_FIELD.test(f.field)) {
    return [{ field: at, message: `"${String(f.field)}" is not a field a query can name` }];
  }
  const isRef = op === 'ref' || op === 'refIn';
  const content = !f.field.startsWith('sys.') && !f.field.startsWith('metadata.');
  if (f.field === ANY_FIELD && !isRef) {
    issues.push({ field: at, message: `"${ANY_FIELD}" takes only ref and refIn` });
  }
  if (isRef && !content) {
    issues.push({ field: at, message: `${op} filters a content field, not ${f.field}` });
  }
  const isId = (v: unknown) => typeof v === 'string' && v !== '' && v.length <= 128;
  const list = (min: number) =>
    Array.isArray(f.value) && f.value.length >= min && f.value.length <= MAX_FILTER_VALUES;
  switch (op) {
    case 'ref':
      if (!isId(f.value)) issues.push({ field: at, message: 'ref takes one entry id' });
      break;
    case 'refIn':
      if (!list(1) || !(f.value as unknown[]).every(isId))
        issues.push({
          field: at,
          message: `refIn takes 1 to ${MAX_FILTER_VALUES} entry ids`,
        });
      break;
    case 'in':
    case 'nin':
      if (!list(1))
        issues.push({ field: at, message: `${op} takes 1 to ${MAX_FILTER_VALUES} values` });
      break;
    case 'match':
      if (typeof f.value !== 'string' || f.value === '')
        issues.push({ field: at, message: `${op} takes a non-empty string` });
      break;
  }
  return issues;
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

/** Deepest a link search descends into one value; a real field is far shallower. */
const MAX_LINK_DEPTH = 32;

/**
 * Does `value` hold a link to one of `ids`? A link is a `{ id, linkType: 'Entry' }` object, found
 * wherever the content model puts one: a Link field, a list of links, a component's members, a
 * blocks element, or a rich-text document's embedded and inline entries (`data.target`).
 */
function linksTo(value: unknown, ids: ReadonlySet<string>, depth = 0): boolean {
  if (depth > MAX_LINK_DEPTH || !value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((v) => linksTo(v, ids, depth + 1));
  const o = value as Record<string, unknown>;
  if (o.linkType === 'Entry' && typeof o.id === 'string' && ids.has(o.id)) return true;
  return Object.values(o).some((v) => linksTo(v, ids, depth + 1));
}

/** True if one field predicate matches the entry. */
function matchesFilter(
  f: QueryFilter,
  fields: EntryFields,
  sys: Record<string, unknown>,
  locale?: LocaleCode,
  fallbacks?: readonly LocaleCode[],
): boolean {
  if (f.op === 'ref' || f.op === 'refIn') {
    const wanted = f.op === 'ref' ? [f.value] : Array.isArray(f.value) ? f.value : [];
    const ids = new Set(wanted.filter((v): v is string => typeof v === 'string'));
    // Every field, each in the resolved locale, like any other field predicate.
    if (f.field === ANY_FIELD) {
      return Object.values(fields).some((lv) =>
        linksTo(comparableValue(lv, locale, fallbacks), ids),
      );
    }
    return linksTo(resolveField(f.field, fields, sys, locale, fallbacks), ids);
  }
  return matchOp(f.op, resolveField(f.field, fields, sys, locale, fallbacks), f.value);
}

/** True if every filter matches the entry's fields. */
function matchesFilters(
  fields: EntryFields,
  sys: Record<string, unknown>,
  filters: readonly QueryFilter[],
  locale?: LocaleCode,
  fallbacks?: readonly LocaleCode[],
): boolean {
  return filters.every((f) => matchesFilter(f, fields, sys, locale, fallbacks));
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

/**
 * A row's place in a query's order, for keyset paging: its value for each key of the order
 * ({@link keysetOrder}), then its id, which breaks every tie.
 */
export interface EntryKeyset {
  readonly values: readonly unknown[];
  readonly id: string;
}

/** The order an entries list has when the query names none: least recently changed first. */
export const DEFAULT_ENTRY_ORDER: readonly QueryOrder[] = [
  { field: 'sys.updatedAt', direction: 'asc' },
];

/** The order keyset paging walks: the query's own, or the store's default when it has none. */
export function keysetOrder(order: readonly QueryOrder[] | undefined): readonly QueryOrder[] {
  return order?.length ? order : DEFAULT_ENTRY_ORDER;
}

/** Where `fields` + `sys` sit in {@link keysetOrder}`(order)`: what a page's next cursor holds. */
export function entryKeysetOf(
  order: readonly QueryOrder[] | undefined,
  fields: EntryFields,
  sys: Record<string, unknown>,
  locale?: LocaleCode,
  fallbacks?: readonly LocaleCode[],
): EntryKeyset {
  return {
    values: keysetOrder(order).map((o) => resolveField(o.field, fields, sys, locale, fallbacks)),
    id: String(sys.id ?? ''),
  };
}

/** Compares two keysets in `order`: each key in its direction, then the ids ascending. */
function compareKeysets(order: readonly QueryOrder[], a: EntryKeyset, b: EntryKeyset): number {
  for (const [i, o] of order.entries()) {
    const cmp = compareValues(a.values[i], b.values[i]);
    if (cmp !== 0) return o.direction === 'desc' ? -cmp : cmp;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** What a row must expose for {@link runEntryQuery} to filter/order it. */
export interface EntryQueryInput {
  readonly filters?: readonly QueryFilter[];
  readonly order?: readonly QueryOrder[];
  readonly search?: string;
  readonly skip?: number;
  readonly limit?: number;
  /**
   * Keyset paging: only rows strictly after this one in {@link keysetOrder}, ties broken by id.
   * `'start'` reads the first page in that same total order. Unset keeps the plain order (a
   * stable sort on `order`, the rows' own order without one), so existing lists are unchanged.
   */
  readonly afterRow?: EntryKeyset | 'start';
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
  if (query.afterRow !== undefined) {
    // A total order, so a page boundary is exact: the next page starts strictly after the
    // last row, whatever was edited between the two reads.
    const order = keysetOrder(query.order);
    const keyOf = (r: T) =>
      entryKeysetOf(order, fieldsOf(r), sysOf(r), query.locale, query.fallbackLocales);
    const keyed = result.map((r) => ({ r, key: keyOf(r) }));
    keyed.sort((a, b) => compareKeysets(order, a.key, b.key));
    const after = query.afterRow;
    result = (
      after === 'start' ? keyed : keyed.filter((k) => compareKeysets(order, k.key, after) > 0)
    ).map((k) => k.r);
  } else if (query.order?.length) {
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
