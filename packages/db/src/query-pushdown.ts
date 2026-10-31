import type { QueryFilter } from '@contentworker/domain';
import { and, type SQL, sql } from 'drizzle-orm';

/**
 * SQL prefilters for field-level entry queries (SQLite JSON1).
 *
 * The domain engine (`runEntryQuery`) is the single source of truth for query
 * SEMANTICS — locale resolution order, string→field-type coercion, array
 * membership, numeric-vs-lexical comparison. Reproducing all of that in SQL
 * would risk silent divergence on the busiest read path, so this module never
 * tries to. Instead every predicate it emits is a **superset**: it may admit
 * rows the engine will later reject, but it must never exclude a row the
 * engine would have kept. The engine then runs over the (bounded) candidate
 * set and produces the exact answer.
 *
 * That turns "load the entire scoped published set into memory" into "load the
 * rows that could plausibly match", which is the actual scaling problem, while
 * keeping D1 and the in-memory store bit-identical in behavior.
 *
 * Ops with no superset-safe translation (negations, comparisons on JSON field
 * values whose ordering depends on runtime type) are simply not pushed down —
 * omitting a predicate only widens the candidate set, which is always safe.
 *
 * Field names are never spliced into JSON paths (SQLite's quoted path labels
 * cannot escape `"`); every lookup walks `json_each(fields)` and compares the
 * key as a bound parameter. Comparand lists travel as ONE JSON-array parameter
 * (`json_each(?)`), so no filter can push a statement past D1's 100-parameter cap.
 *
 * CASE FOLDING: SQLite's LIKE folds ASCII only, while the engine uses JS
 * Unicode `toLowerCase`. {@link likePattern} therefore turns every needle
 * character whose folding SQLite cannot reproduce into a `%` wildcard, which
 * only widens the match. The cross-store equivalence suite carries non-ASCII
 * cases precisely to catch a regression here.
 */

/** A field value can live under any locale key; these are the JSON forms a
 *  comparand could equal once the engine coerces it to the field's type. */
function comparandForms(value: unknown): unknown[] | null {
  const forms: unknown[] = [value];
  if (typeof value === 'string') {
    // Mirror domain `coerce` EXACTLY: it converts a string comparand to a
    // number whenever `Number(s)` is not NaN, so both forms must be admitted.
    // The condition must not be "tightened" — `Number('')` is 0, not NaN, so
    // an `eq ''` filter really does match a numeric 0 field in the engine, and
    // skipping that form here would drop the row (a superset violation caught
    // by the adversarial probe in query-equivalence.test.ts).
    const n = Number(value);
    if (!Number.isNaN(n)) forms.push(n);
    if (value === 'true') forms.push(true);
    if (value === 'false') forms.push(false);
  } else if (typeof value === 'number' || typeof value === 'boolean') {
    forms.push(String(value));
  } else if (value !== null) {
    // Objects/arrays/undefined: no scalar form to match on. Not pushing the
    // predicate down is always safe.
    return null;
  }
  return forms;
}

/**
 * Does the JSON value `c` (a `json_each` row) equal one of the forms in the
 * `json_each` row `f`? Numbers compare numerically across integer/real (as in
 * the engine, where `5 === 5.0`); strings exactly; booleans and null by type.
 */
const sameScalar = (c: string, f: string) =>
  sql.raw(`((${c}.type = ${f}.type OR (${c}.type IN ('integer','real') AND ${f}.type IN ('integer','real')))
    AND (${c}.atom = ${f}.atom OR ${c}.type IN ('true','false','null')))`);

/**
 * Superset predicate for `eq`/`in` on a content field: the field exists and
 * SOME locale's value equals one of the comparand forms, or is an array that
 * contains one (the engine's array-field membership semantics).
 */
function fieldValueMatches(fieldsCol: SQL, field: string, values: readonly unknown[]): SQL | null {
  const forms: unknown[] = [];
  for (const v of values) {
    const f = comparandForms(v);
    if (!f) return null;
    forms.push(...f);
  }
  if (forms.length === 0) return null;
  const formsJson = JSON.stringify(forms);
  // CASE, not AND: a malformed/imported (non-object) field value must widen
  // the scan, never be excluded.
  return sql`EXISTS (
    SELECT 1 FROM json_each(${fieldsCol}) AS fld
    WHERE fld.key = ${field} AND CASE WHEN fld.type = 'object' THEN EXISTS (
      SELECT 1 FROM json_each(fld.value) AS kv, json_each(${formsJson}) AS f
      WHERE ${sameScalar('kv', 'f')}
        OR (kv.type = 'array' AND EXISTS (
          SELECT 1 FROM json_each(kv.value) AS el WHERE ${sameScalar('el', 'f')}
        ))
    ) ELSE 1 END
  )`;
}

/** ASCII letters that a non-ASCII character lowercases onto (İ→i̇, K→k). */
const FOLDS_FROM_NON_ASCII = new Set(['i', 'I', 'k', 'K']);

/**
 * Wraps a literal needle as a case-insensitive LIKE pattern that is a superset
 * of the engine's `haystack.toLowerCase().includes(needle.toLowerCase())`.
 *
 * - Characters SQLite cannot fold like JS does (non-ASCII, plus `i`/`k`, which
 *   `İ` and the Kelvin sign lowercase onto) and control characters become `%`.
 *   A wildcard matches any run, so differing folded lengths can't drop a row.
 * - `%` and `_` are left as wildcards on purpose: they only WIDEN the match.
 * - No ESCAPE clause is used, so a backslash is an ordinary literal character.
 */
export function likePattern(needle: string): string {
  let out = '%';
  for (const ch of needle) {
    const code = ch.codePointAt(0) ?? 0;
    const safe = code >= 0x20 && code < 0x7f && !FOLDS_FROM_NON_ASCII.has(ch);
    out += safe ? ch : '%';
  }
  return `${out}%`.replace(/%{2,}/g, '%');
}

/**
 * The text the engine's `String(value)` would produce for a decoded locale
 * value, or a match-anything for value types whose rendering SQLite cannot
 * reproduce exactly (numbers: exponent formats differ; arrays/objects: JS joins
 * them, JSON text does not). Null never matches (`match` rejects null).
 */
const matchText = (kv: string, pattern: string) =>
  sql`CASE ${sql.raw(kv)}.type
    WHEN 'text' THEN ${sql.raw(kv)}.atom LIKE ${pattern}
    WHEN 'true' THEN 'true' LIKE ${pattern}
    WHEN 'false' THEN 'false' LIKE ${pattern}
    WHEN 'null' THEN 0
    ELSE 1 END`;

/**
 * Superset for a case-insensitive substring match on a field: does any LOCALE
 * value of the field contain the needle? Matches decoded values (`json_each`
 * atoms), never the JSON-encoded text, where `\` and `"` appear escaped.
 */
function fieldTextLike(fieldsCol: SQL, field: string, needle: string): SQL {
  return sql`EXISTS (
    SELECT 1 FROM json_each(${fieldsCol}) AS fld
    WHERE fld.key = ${field} AND CASE WHEN fld.type = 'object' THEN EXISTS (
      SELECT 1 FROM json_each(fld.value) AS kv WHERE ${matchText('kv', likePattern(needle))}
    ) ELSE 1 END
  )`;
}

/** Columns a `sys.*` pseudo-field maps to, when the row has a real column. */
export interface SysColumns {
  readonly entryId: SQL;
  readonly contentTypeApiId: SQL;
  /** Epoch-millisecond column (the engine sees it as an ISO string). */
  readonly publishedAt?: SQL;
}

/** The epoch ms for an ISO comparand the engine could equal, or null if none can. */
const isoMs = (v: unknown): number | null => {
  if (typeof v !== 'string') return null;
  const d = new Date(v);
  return !Number.isNaN(d.getTime()) && d.toISOString() === v ? d.getTime() : null;
};

/**
 * Builds the superset prefilter for a set of field predicates.
 * Returns null when nothing could be pushed down (caller scans unfiltered).
 */
export function buildFilterPrefilter(
  filters: readonly QueryFilter[],
  fieldsCol: SQL,
  sys: SysColumns,
): SQL | null {
  const conds: SQL[] = [];
  for (const f of filters) {
    // `sys.*`/`metadata.*` resolve from the row's sys record. Only the ones
    // backed by real columns are pushed; metadata arrays stay in JS.
    if (f.field.startsWith('sys.')) {
      const name = f.field.slice(4);
      if (name === 'publishedAt') {
        // Stored as epoch ms; the engine compares the ISO string exactly, so
        // only a canonical ISO comparand can match — anything else is left to JS.
        if (!sys.publishedAt) continue;
        if (f.op === 'eq') {
          const ms = isoMs(f.value);
          if (ms !== null) conds.push(sql`${sys.publishedAt} = ${ms}`);
        }
        continue;
      }
      const col =
        name === 'id' ? sys.entryId : name === 'contentType' ? sys.contentTypeApiId : undefined;
      if (!col) continue;
      if (f.op === 'eq' && typeof f.value === 'string') {
        conds.push(sql`${col} = ${f.value}`);
      } else if (f.op === 'in' && Array.isArray(f.value) && f.value.length > 0) {
        const list = JSON.stringify(f.value.map((v) => String(v)));
        conds.push(sql`${col} IN (SELECT value FROM json_each(${list}))`);
      }
      // Ranges on sys columns are left to the engine (ISO-string comparison).
      continue;
    }
    if (f.field.startsWith('metadata.')) continue;

    switch (f.op) {
      case 'eq': {
        const c = fieldValueMatches(fieldsCol, f.field, [f.value]);
        if (c) conds.push(c);
        break;
      }
      case 'in': {
        if (!Array.isArray(f.value) || f.value.length === 0) break;
        const c = fieldValueMatches(fieldsCol, f.field, f.value);
        if (c) conds.push(c);
        break;
      }
      case 'match': {
        if (typeof f.value !== 'string' || f.value === '') break;
        conds.push(fieldTextLike(fieldsCol, f.field, f.value));
        break;
      }
      case 'exists': {
        // Only the positive form is superset-safe: `exists:false` matches rows
        // where the key is absent OR present-but-null.
        const want = f.value === undefined ? true : Boolean(f.value);
        if (want) {
          conds.push(
            sql`EXISTS (SELECT 1 FROM json_each(${fieldsCol}) AS fld WHERE fld.key = ${f.field})`,
          );
        }
        break;
      }
      // ne / nin / gt / gte / lt / lte: no superset-safe form (negation can
      // exclude; ordering depends on the field's runtime type). Left to JS.
      default:
        break;
    }
  }
  return conds.length > 0 ? (and(...conds) as SQL) : null;
}

/**
 * Superset for free-text `search`: the engine matches a case-insensitive
 * SUBSTRING of any string field value. Tokenizing full-text search would MISS
 * substrings (`ell` in `hello`), so it cannot be used as a prefilter here — a
 * LIKE over every decoded locale value is the correct superset.
 */
export function buildSearchPrefilter(search: string, fieldsCol: SQL): SQL | null {
  if (!search.trim()) return null;
  const pattern = likePattern(search);
  return sql`EXISTS (
    SELECT 1 FROM json_each(${fieldsCol}) AS fld
    WHERE CASE WHEN fld.type = 'object' THEN EXISTS (
      SELECT 1 FROM json_each(fld.value) AS kv
      WHERE kv.type = 'text' AND kv.atom LIKE ${pattern}
    ) ELSE 1 END
  )`;
}
