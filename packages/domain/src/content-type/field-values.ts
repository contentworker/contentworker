import type { EntryFields, LocaleCode, LocalizedValue } from '../types';
import type { ContentType } from './content-type';
import { type FieldDefinition, UNIQUE_FIELD_TYPES } from './field';
import { normalizeSlug } from './slug';

/**
 * Field-value transformations that sit between "what the caller sent" and
 * "what gets stored": defaults, slug normalization, and the unique claims an
 * entry stakes on write. Pure — the use-cases own persistence and the clock.
 */

/**
 * Applies `defaultValue` to fields the caller left out.
 *
 * Only on create. An update that omits a field is expressing "leave it alone",
 * and one that clears it is expressing "make it empty" — re-applying a default
 * in either case would override an editor's intent.
 *
 * A bare default fills every locale of a localized field; a `{ locale: value }`
 * map sets them individually, which is how a field gets different defaults per
 * market.
 */
export function applyDefaults(
  contentType: ContentType,
  fields: EntryFields,
  locales: readonly LocaleCode[],
  defaultLocale: LocaleCode,
): EntryFields {
  const out: EntryFields = { ...fields };
  for (const field of contentType.fields) {
    if (field.defaultValue !== undefined) {
      const existing = out[field.apiId];
      if (!existing || Object.keys(existing).length === 0) {
        const target = field.localized ? locales : [defaultLocale];
        out[field.apiId] = isLocaleMap(field.defaultValue, locales)
          ? { ...(field.defaultValue as LocalizedValue) }
          : Object.fromEntries(target.map((locale) => [locale, field.defaultValue]));
      }
    }

    // Defaults inside a component fill gaps in the objects that are there —
    // including every item of a repeater, which is where a default earns its
    // keep ("each new card starts as the primary variant"). A component the
    // author never supplied stays absent: materializing one from its nested
    // defaults would invent content nobody asked for.
    const nested = field.type === 'Component' ? field.fields : field.items?.fields;
    const localized = nested ? out[field.apiId] : undefined;
    if (nested && localized) {
      out[field.apiId] = Object.fromEntries(
        Object.entries(localized).map(([locale, value]) => [
          locale,
          field.type === 'Component'
            ? withComponentDefaults(nested, value)
            : Array.isArray(value)
              ? value.map((item) => withComponentDefaults(nested, item))
              : value,
        ]),
      );
    }
  }
  return out;
}

/** Fills absent nested keys from their definitions' defaults, recursively. */
function withComponentDefaults(nested: readonly FieldDefinition[], value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const out = { ...(value as Record<string, unknown>) };
  for (const f of nested) {
    if (out[f.apiId] === undefined && f.defaultValue !== undefined) {
      out[f.apiId] = f.defaultValue;
    }
    const deeper = f.type === 'Component' ? f.fields : f.items?.fields;
    if (!deeper || out[f.apiId] === undefined) continue;
    out[f.apiId] =
      f.type === 'Component'
        ? withComponentDefaults(deeper, out[f.apiId])
        : Array.isArray(out[f.apiId])
          ? (out[f.apiId] as unknown[]).map((item) => withComponentDefaults(deeper, item))
          : out[f.apiId];
  }
  return out;
}

/**
 * True when a default looks like a per-locale map rather than a plain value.
 *
 * Checked against the space's locales, not merely "is an object": a JSON field
 * whose default is `{ theme: 'dark' }` must not be mistaken for a locale map
 * and silently torn apart.
 */
function isLocaleMap(value: unknown, locales: readonly LocaleCode[]): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value as Record<string, unknown>);
  return keys.length > 0 && keys.every((k) => locales.includes(k));
}

/**
 * Normalizes every Slug field in place, so a caller can send a title and get a
 * usable slug. Idempotent, so it is safe on every write.
 */
export function normalizeSlugFields(contentType: ContentType, fields: EntryFields): EntryFields {
  const out: EntryFields = { ...fields };
  for (const field of contentType.fields) {
    if (field.type !== 'Slug') continue;
    const values = out[field.apiId];
    if (!values) continue;
    out[field.apiId] = Object.fromEntries(
      Object.entries(values).map(([locale, value]) => [
        locale,
        typeof value === 'string' ? normalizeSlug(value) : value,
      ]),
    );
  }
  return out;
}

/**
 * One value an entry claims exclusively, compared per locale.
 *
 * Scoped by content type as well as field: two types may each define a `slug`,
 * and a post named "about" must not stop a page being named "about".
 */
export interface UniqueClaim {
  readonly contentTypeApiId: string;
  readonly fieldApiId: string;
  readonly locale: LocaleCode;
  /** Stringified for comparison — uniqueness is per rendered value. */
  readonly value: string;
}

/**
 * The claims an entry stakes given its fields.
 *
 * Empty and null values are skipped: "no value" is not a value, and treating
 * it as one would let a single entry with an empty slug block every other
 * entry from having one.
 */
export function uniqueClaims(contentType: ContentType, fields: EntryFields): UniqueClaim[] {
  const claims: UniqueClaim[] = [];
  for (const field of contentType.fields) {
    if (!field.unique || !UNIQUE_FIELD_TYPES.includes(field.type)) continue;
    const values = fields[field.apiId];
    if (!values) continue;
    for (const [locale, value] of Object.entries(values)) {
      if (value === null || value === undefined || value === '') continue;
      claims.push({
        contentTypeApiId: contentType.apiId,
        fieldApiId: field.apiId,
        locale,
        value: String(value),
      });
    }
  }
  return claims;
}

/** True when the content type declares any unique field at all. */
export function hasUniqueFields(contentType: ContentType): boolean {
  return contentType.fields.some((f) => f.unique && UNIQUE_FIELD_TYPES.includes(f.type));
}
