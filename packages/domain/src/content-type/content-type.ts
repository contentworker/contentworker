import { ConflictError, ValidationError } from '../errors';
import type { ContentTypeStatus } from '../types';
import {
  type ComponentVariant,
  type FieldDefinition,
  isValidApiId,
  MAX_COMPONENT_DEPTH,
  UNIQUE_FIELD_TYPES,
  unsafeRegexReason,
} from './field';

/**
 * A content type: the schema for a class of entries. Definitions are versioned
 * and environment-scoped (carried by the repository, not the entity itself).
 */
export interface ContentType {
  readonly apiId: string;
  readonly name: string;
  /** apiId of the field used as the entry's display title. */
  readonly displayField: string;
  readonly fields: readonly FieldDefinition[];
  /**
   * Where the type's entries live on the site, e.g. `/blog/{slug}` (`urlPath`). A publish that
   * changes a slug it names redirects the old path to the new one; a preview link can be built
   * from it too.
   */
  readonly urlPattern?: string;
  readonly version: number;
  readonly status: ContentTypeStatus;
}

export interface ContentTypeDraft {
  apiId: string;
  name: string;
  displayField: string;
  fields: FieldDefinition[];
  /** `null` or `''` clears it on a revision. */
  urlPattern?: string | null;
}

/**
 * Validates a content type definition for internal consistency and returns a
 * normalized `ContentType` at version 1, status "draft". Throws on invalid
 * input so callers never persist a malformed schema.
 */
export function defineContentType(draft: ContentTypeDraft): ContentType {
  if (!isValidApiId(draft.apiId)) {
    throw new ValidationError([
      { field: 'apiId', message: `Invalid content type apiId "${draft.apiId}"` },
    ]);
  }
  assertFieldsValid(draft.fields, draft.displayField);
  const urlPattern = draft.urlPattern ? checkUrlPattern(draft.urlPattern, draft.fields) : undefined;
  return {
    apiId: draft.apiId,
    name: draft.name,
    displayField: draft.displayField,
    fields: [...draft.fields].sort((a, b) => a.position - b.position),
    ...(urlPattern ? { urlPattern } : {}),
    version: 1,
    status: 'draft',
  };
}

/** Produces the next version of a content type from an edited field set. */
export function reviseContentType(
  current: ContentType,
  changes: Partial<Pick<ContentTypeDraft, 'name' | 'displayField' | 'fields' | 'urlPattern'>>,
): ContentType {
  const fields = changes.fields ?? [...current.fields];
  const displayField = changes.displayField ?? current.displayField;
  assertFieldsValid(fields, displayField);
  // Checked against the revised fields too: removing the slug a kept pattern names is refused.
  const pattern = changes.urlPattern === undefined ? current.urlPattern : changes.urlPattern;
  const urlPattern = pattern ? checkUrlPattern(pattern, fields) : undefined;
  const { urlPattern: _old, ...rest } = current;
  return {
    ...rest,
    name: changes.name ?? current.name,
    displayField,
    fields: [...fields].sort((a, b) => a.position - b.position),
    ...(urlPattern ? { urlPattern } : {}),
    version: current.version + 1,
    status: 'draft',
  };
}

function assertFieldsValid(fields: readonly FieldDefinition[], displayField: string): void {
  const seen = assertFieldSetValid(fields, '', 0);
  if (fields.length > 0 && !seen.has(displayField)) {
    throw new ValidationError([
      { field: 'displayField', message: `displayField "${displayField}" is not a defined field` },
    ]);
  }
}

/**
 * Checks one level of field definitions, recursing into components.
 *
 * `path` prefixes every message so an author editing a deep group is told which
 * field is wrong, not merely that something is. `depth` counts components
 * entered so far; 0 is the content type's own field list.
 */
function assertFieldSetValid(
  fields: readonly FieldDefinition[],
  path: string,
  depth: number,
): Set<string> {
  const seen = new Set<string>();
  const at = (f: FieldDefinition) => (path ? `${path}.${f.apiId}` : f.apiId);

  for (const f of fields) {
    const where = at(f);
    if (!isValidApiId(f.apiId)) {
      throw new ValidationError([{ field: where, message: `Invalid field apiId "${f.apiId}"` }]);
    }
    if (seen.has(f.apiId)) {
      throw new ConflictError(`Duplicate field apiId "${where}"`);
    }
    seen.add(f.apiId);
    const rx = f.validations?.regexp;
    if (rx) {
      const reason = unsafeRegexReason(rx.pattern, rx.flags);
      if (reason) throw new ValidationError([{ field: where, message: reason }]);
    }
    // Refuse `unique` where it cannot mean anything, rather than accepting the
    // declaration and quietly never enforcing it.
    if (f.unique && !UNIQUE_FIELD_TYPES.includes(f.type)) {
      throw new ValidationError([{ field: where, message: `A ${f.type} field cannot be unique` }]);
    }

    if (depth > 0) assertNestedFieldAllowed(f, where);
    if (f.type === 'Seo' && [...fields].filter((g) => g.type === 'Seo').length > 1) {
      // The sitemap and every client read a page's SEO from its one Seo field.
      throw new ValidationError([
        { field: where, message: 'A content type has at most one Seo field' },
      ]);
    }

    const isComponent = f.type === 'Component' || f.items?.type === 'Component';
    if (!isComponent) {
      // Declaring a shape on a field that is not a component means the author
      // expected nesting they will not get. Checked on every place it could be
      // written, so none is silently dropped.
      if (f.fields || f.items?.fields || f.items?.variants) {
        throw new ValidationError([
          { field: where, message: `A ${f.type} field cannot define nested fields` },
        ]);
      }
      continue;
    }

    const nested = f.type === 'Component' ? f.fields : f.items?.fields;
    if (f.items?.variants === undefined && (!nested || nested.length === 0)) {
      throw new ValidationError([
        { field: where, message: 'A component must define at least one field' },
      ]);
    }
    if (depth + 1 > MAX_COMPONENT_DEPTH) {
      throw new ValidationError([
        {
          field: where,
          message: `Components may nest ${MAX_COMPONENT_DEPTH} deep at most. Model anything deeper as its own content type and link to it.`,
        },
      ]);
    }
    if (f.items?.variants !== undefined) {
      assertVariantsValid(f, where, depth);
      continue;
    }
    assertFieldSetValid(nested ?? [], where, depth + 1);
  }
  return seen;
}

/**
 * A blocks field's variants: at least one, each a legal apiId used once, each
 * a component in its own right. A variant's fields sit one level deeper, so
 * they obey the nested rules and count toward the depth cap like any
 * component's.
 *
 * A field declares `items.fields` or `items.variants`, never both: with both,
 * an element without a `_type` would have two plausible shapes, and which one
 * wins would be a guess the author never made.
 */
function assertVariantsValid(f: FieldDefinition, where: string, depth: number): void {
  const fail = (message: string, at = where): never => {
    throw new ValidationError([{ field: at, message }]);
  };
  if (f.type !== 'Array') {
    fail(
      'Only an Array of Component can declare variants. For a single block, use an Array with validations.size.max of 1.',
    );
  }
  if (f.items?.fields !== undefined) {
    fail('Declare items.fields or items.variants, not both');
  }
  const variants = f.items?.variants;
  if (!Array.isArray(variants) || variants.length === 0) {
    fail('A blocks field must define at least one variant');
  }
  const seen = new Set<string>();
  for (const v of variants as readonly ComponentVariant[]) {
    const apiId = (v as { apiId?: unknown } | null)?.apiId;
    if (typeof apiId !== 'string' || !isValidApiId(apiId)) {
      fail(`Invalid variant apiId "${String(apiId)}"`);
    }
    const at = `${where}[${apiId}]`;
    if (seen.has(apiId as string)) fail(`Duplicate variant apiId "${apiId}"`, at);
    seen.add(apiId as string);
    if (typeof v.name !== 'string' || v.name.trim() === '') fail('A variant needs a name', at);
    if (!Array.isArray(v.fields) || v.fields.length === 0) {
      fail('A variant must define at least one field', at);
    }
    assertFieldSetValid(v.fields, at, depth + 1);
  }
}

/** The attributes a nested field may not carry. See COMPONENT_NESTED_RULES. */
function assertNestedFieldAllowed(f: FieldDefinition, where: string): void {
  if (f.localized) {
    throw new ValidationError([
      {
        field: where,
        message:
          'A field inside a component cannot be localized on its own; ' +
          'localize the component field that holds it.',
      },
    ]);
  }
  if (f.unique) {
    throw new ValidationError([
      { field: where, message: 'A field inside a component cannot be unique' },
    ]);
  }
  if (f.type === 'Slug') {
    throw new ValidationError([
      {
        field: where,
        message:
          'A Slug cannot live inside a component: slugs are normalized from the ' +
          "entry's top-level fields, so a nested one would never be normalized.",
      },
    ]);
  }
  if (f.type === 'Seo') {
    throw new ValidationError([
      {
        field: where,
        message:
          'A Seo field cannot live inside a component: it describes the whole page, and the ' +
          "sitemap reads it from the entry's top-level fields.",
      },
    ]);
  }
}

// --- URL pattern ------------------------------------------------------------

/** Longest URL pattern. */
export const MAX_URL_PATTERN_LENGTH = 512;

const URL_PLACEHOLDER = /\{([^{}]*)\}/g;

/**
 * Checks a content type's URL pattern against its fields, or throws `ValidationError`. A pattern
 * is a site path starting with `/` (no query or fragment) whose `{…}` placeholders are `{id}` (the
 * entry id), `{locale}`, or the apiId of one of the type's own Slug fields: slugs are the only
 * values normalized to be safe in a URL.
 */
export function checkUrlPattern(input: string, fields: readonly FieldDefinition[]): string {
  const refuse = (message: string): never => {
    throw new ValidationError([{ field: 'urlPattern', message }]);
  };
  const pattern = input.trim();
  if (!pattern.startsWith('/') || pattern.startsWith('//')) {
    refuse('A URL pattern is a path starting with /, e.g. /blog/{slug}');
  }
  if (pattern.length > MAX_URL_PATTERN_LENGTH) {
    refuse(`A URL pattern is at most ${MAX_URL_PATTERN_LENGTH} characters`);
  }
  if (/[\s?#[\]\\]/.test(pattern)) {
    refuse('A URL pattern cannot hold spaces, ?, #, [, ] or \\');
  }
  const slugs = new Set(fields.filter((f) => f.type === 'Slug').map((f) => f.apiId));
  if (
    pattern.replace(URL_PLACEHOLDER, '').includes('{') ||
    pattern.replace(URL_PLACEHOLDER, '').includes('}')
  ) {
    refuse('A placeholder is written {name}');
  }
  for (const m of pattern.matchAll(URL_PLACEHOLDER)) {
    const name = m[1] ?? '';
    if (name === 'id' || name === 'locale' || slugs.has(name)) continue;
    refuse(`{${name}} is not {id}, {locale} or one of this type's Slug fields`);
  }
  return pattern;
}

/** The Slug fields a URL pattern names. */
export const urlPatternSlugFields = (pattern: string): string[] =>
  [...pattern.matchAll(URL_PLACEHOLDER)]
    .map((m) => m[1] ?? '')
    .filter((name) => name !== 'id' && name !== 'locale');

/**
 * An entry's path on the site in one locale, from its type's URL pattern, or null when a slug the
 * pattern names has no value in that locale. `fields` are the entry's (locale → value per field).
 */
export function urlPath(
  pattern: string,
  entry: {
    readonly id: string;
    readonly fields: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  },
  locale: string,
): string | null {
  let missing = false;
  const path = pattern.replace(URL_PLACEHOLDER, (_whole, name: string) => {
    if (name === 'id') return encodeURIComponent(entry.id);
    if (name === 'locale') return encodeURIComponent(locale);
    const value = entry.fields[name]?.[locale];
    if (typeof value !== 'string' || value === '') {
      missing = true;
      return '';
    }
    return encodeURIComponent(value);
  });
  return missing ? null : path;
}
