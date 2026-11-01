import type { ContentType } from '../content-type/content-type';
import {
  type FieldDefinition,
  type FieldValidations,
  unsafeRegexReason,
} from '../content-type/field';
import { isSlug } from '../content-type/slug';
import { type FieldIssue, ValidationError } from '../errors';
import { validateRichText } from '../rich-text/rich-text';
import type { EntryFields, LocaleCode } from '../types';

export interface ValidationContext {
  readonly defaultLocale: LocaleCode;
  /** Locale codes permitted in the space. */
  readonly locales: readonly LocaleCode[];
}

/** Max serialized size of a single JSON field value (per locale). */
const MAX_JSON_FIELD_BYTES = 256 * 1024;

/**
 * Validates a full set of entry field values against a content type. Returns
 * the issues found (empty when valid). This is the single source of truth used
 * by both human API writes and AI-generated content, so an agent can never
 * produce an entry a human couldn't.
 */
export function validateEntryFields(
  contentType: ContentType,
  fields: EntryFields,
  ctx: ValidationContext,
): FieldIssue[] {
  const issues: FieldIssue[] = [];
  const definedByApiId = new Map(contentType.fields.map((f) => [f.apiId, f]));

  // Reject values for fields not in the schema.
  for (const apiId of Object.keys(fields)) {
    if (!definedByApiId.has(apiId)) {
      issues.push({ field: apiId, message: `Unknown field "${apiId}"` });
    }
  }

  for (const field of contentType.fields) {
    const localized = fields[field.apiId] ?? {};
    const targetLocales = field.localized ? ctx.locales : [ctx.defaultLocale];

    for (const locale of targetLocales) {
      const value = localized[locale];
      if (value === undefined || value === null) {
        // Required is enforced on the default locale only; other locales are
        // optional and resolve via the fallback chain at delivery time.
        if (field.required && locale === ctx.defaultLocale) {
          issues.push({ field: field.apiId, locale, message: 'Field is required' });
        }
        continue;
      }
      validateValue(field, value, locale, issues, field.apiId);
    }

    // A non-localized field must not carry values under non-default locales.
    if (!field.localized) {
      for (const locale of Object.keys(localized)) {
        if (locale !== ctx.defaultLocale) {
          issues.push({
            field: field.apiId,
            locale,
            message: 'Field is not localized; only the default locale is allowed',
          });
        }
      }
    }
  }

  return issues;
}

/** Convenience wrapper that throws a ValidationError when issues exist. */
export function assertEntryFieldsValid(
  contentType: ContentType,
  fields: EntryFields,
  ctx: ValidationContext,
): void {
  const issues = validateEntryFields(contentType, fields, ctx);
  if (issues.length > 0) throw new ValidationError(issues);
}

/**
 * Validates one value against one field definition.
 *
 * `path` is what an issue is reported against. For a top-level field that is
 * just its apiId, but inside a component it becomes `hero.cta.label` or
 * `cards[2].title` — an editor looking at a list of eight cards needs to be
 * told which one is wrong, not that something somewhere is.
 */
function validateValue(
  field: FieldDefinition,
  value: unknown,
  locale: LocaleCode,
  issues: FieldIssue[],
  path: string,
): void {
  const push = (message: string): void => {
    issues.push({ field: path, locale, message });
  };
  const v = field.validations;

  switch (field.type) {
    case 'Slug': {
      if (typeof value !== 'string') {
        push('Expected a string');
        return;
      }
      checkSize(value.length, v?.size, push, 'length');
      // Slugs are normalized on write, so anything reaching here that is not
      // already a slug means normalization was bypassed — report it rather
      // than silently storing a value that will break a URL.
      if (!isSlug(value)) {
        push('Must be lowercase letters, digits and single hyphens');
      }
      break;
    }
    case 'Symbol':
    case 'Text': {
      if (typeof value !== 'string') {
        push('Expected a string');
        return;
      }
      checkSize(value.length, v?.size, push, 'length');
      checkIn(value, v, push);
      if (v?.regexp) {
        // Defence in depth: patterns are screened at content-type authoring time
        // (unsafeRegexReason), but a bad/unsafe pattern here must surface as a
        // validation issue, never an uncaught 500.
        const reason = unsafeRegexReason(v.regexp.pattern, v.regexp.flags);
        if (reason) {
          push(`Invalid pattern: ${reason}`);
        } else if (!new RegExp(v.regexp.pattern, v.regexp.flags).test(value)) {
          push(`Does not match pattern /${v.regexp.pattern}/`);
        }
      }
      break;
    }
    case 'Integer':
    case 'Number': {
      if (typeof value !== 'number' || Number.isNaN(value)) {
        push('Expected a number');
        return;
      }
      if (field.type === 'Integer' && !Number.isInteger(value)) push('Expected an integer');
      checkRange(value, v?.range, push);
      checkIn(value, v, push);
      break;
    }
    case 'Boolean':
      if (typeof value !== 'boolean') push('Expected a boolean');
      break;
    case 'Date':
      if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
        push('Expected an ISO-8601 date string');
      }
      break;
    case 'Location': {
      const loc = value as { lat?: unknown; lon?: unknown };
      if (typeof loc?.lat !== 'number' || typeof loc?.lon !== 'number') {
        push('Expected { lat: number, lon: number }');
      }
      break;
    }
    case 'JSON': {
      if (typeof value !== 'object' || value === null) {
        push('Expected a JSON object');
        break;
      }
      // Cap the serialized size so a single field can't store an unbounded blob.
      try {
        if (JSON.stringify(value).length > MAX_JSON_FIELD_BYTES) {
          push(`JSON value exceeds ${MAX_JSON_FIELD_BYTES} bytes`);
        }
      } catch {
        push('JSON value is not serializable');
      }
      break;
    }
    case 'RichText': {
      for (const issue of validateRichText(value)) push(issue);
      break;
    }
    case 'Link':
      if (!isLink(value)) push('Expected a link { id, linkType }');
      break;
    case 'Component': {
      validateComponent(field.fields ?? [], value, locale, issues, path, push);
      break;
    }
    case 'Array': {
      if (!Array.isArray(value)) {
        push('Expected an array');
        return;
      }
      checkSize(value.length, v?.size, push, 'item count');
      const itemType = field.items?.type;
      value.forEach((item, index) => {
        if (itemType === 'Link' && !isLink(item))
          push('Array item must be a link { id, linkType }');
        if (itemType === 'Symbol' && typeof item !== 'string') push('Array item must be a string');
        if (itemType === 'Component') {
          // Indexed, so "the third card is missing its title" is sayable.
          const at = `${path}[${index}]`;
          validateComponent(field.items?.fields ?? [], item, locale, issues, at, (m) =>
            issues.push({ field: at, locale, message: m }),
          );
        }
      });
      break;
    }
  }
}

/**
 * Validates a component value: an object keyed by the nested field apiIds.
 *
 * Nested fields carry no locale of their own — the component field decides
 * that once — so every leaf is checked under the locale its container was
 * checked under.
 */
function validateComponent(
  nested: readonly FieldDefinition[],
  value: unknown,
  locale: LocaleCode,
  issues: FieldIssue[],
  path: string,
  push: (message: string) => void,
): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    push('Expected an object of nested field values');
    return;
  }
  const values = value as Record<string, unknown>;
  const defined = new Set(nested.map((f) => f.apiId));
  for (const key of Object.keys(values)) {
    if (!defined.has(key)) {
      issues.push({ field: `${path}.${key}`, locale, message: `Unknown field "${key}"` });
    }
  }

  for (const f of nested) {
    const at = `${path}.${f.apiId}`;
    const nestedValue = values[f.apiId];
    if (nestedValue === undefined || nestedValue === null) {
      // Required means required wherever the component appears — including in
      // the fourth item of a repeater, which is the case that would otherwise
      // slip through.
      if (f.required) issues.push({ field: at, locale, message: 'Field is required' });
      continue;
    }
    validateValue(f, nestedValue, locale, issues, at);
  }
}

function isLink(value: unknown): value is { id: string; linkType: string } {
  const l = value as { id?: unknown; linkType?: unknown };
  return typeof l?.id === 'string' && typeof l?.linkType === 'string';
}

function checkIn(
  value: string | number,
  v: FieldValidations | undefined,
  push: (m: string) => void,
) {
  if (v?.in && !v.in.includes(value)) push(`Value must be one of: ${v.in.join(', ')}`);
}

function checkRange(value: number, range: FieldValidations['range'], push: (m: string) => void) {
  if (range?.min !== undefined && value < range.min) push(`Must be >= ${range.min}`);
  if (range?.max !== undefined && value > range.max) push(`Must be <= ${range.max}`);
}

function checkSize(
  n: number,
  size: FieldValidations['size'],
  push: (m: string) => void,
  label: string,
) {
  if (size?.min !== undefined && n < size.min) push(`${label} must be >= ${size.min}`);
  if (size?.max !== undefined && n > size.max) push(`${label} must be <= ${size.max}`);
}
