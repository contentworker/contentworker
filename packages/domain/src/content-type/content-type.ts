import { ConflictError, ValidationError } from '../errors';
import type { ContentTypeStatus } from '../types';
import {
  type ComponentVariant,
  FIELD_GUIDANCE_LIMITS,
  type FieldDefinition,
  type FieldOption,
  type FieldValidations,
  isValidApiId,
  MAX_COMPONENT_DEPTH,
  MESSAGE_RULES,
  type MessageRule,
  normalizeOptions,
  optionKey,
  optionProblem,
  optionValue,
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
  /**
   * At most one entry outside the trash: a site's settings, its home page, its footer. Delivery
   * serves it at `GET …/singletons/:apiId`. Present only when true. Held by a unique claim
   * ({@link singletonClaim}), so two concurrent creates can't both win.
   */
  readonly singleton?: true;
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
  /** Holds at most one entry ({@link ContentType.singleton}). Left out on a revision, kept. */
  singleton?: boolean;
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
  assertFieldsValid(draft.fields, draft.displayField, undefined);
  const urlPattern = draft.urlPattern ? checkUrlPattern(draft.urlPattern, draft.fields) : undefined;
  return {
    apiId: draft.apiId,
    name: draft.name,
    displayField: draft.displayField,
    fields: [...draft.fields].map(withoutBlankGuidance).sort((a, b) => a.position - b.position),
    ...(urlPattern ? { urlPattern } : {}),
    ...(draft.singleton ? { singleton: true as const } : {}),
    version: 1,
    status: 'draft',
  };
}

/**
 * Produces the next version of a content type from an edited field set. The
 * current definition is the baseline for the checks that only refuse what is
 * new, so a type stored before a check existed can still be revised.
 */
export function reviseContentType(
  current: ContentType,
  changes: Partial<
    Pick<ContentTypeDraft, 'name' | 'displayField' | 'fields' | 'urlPattern' | 'singleton'>
  >,
): ContentType {
  const fields = changes.fields ?? [...current.fields];
  const displayField = changes.displayField ?? current.displayField;
  assertFieldsValid(fields, displayField, current.fields);
  // Checked against the revised fields too: removing the slug a kept pattern names is refused.
  const pattern = changes.urlPattern === undefined ? current.urlPattern : changes.urlPattern;
  const urlPattern = pattern ? checkUrlPattern(pattern, fields) : undefined;
  const singleton = changes.singleton ?? current.singleton === true;
  const { urlPattern: _old, singleton: _was, ...rest } = current;
  return {
    ...rest,
    name: changes.name ?? current.name,
    displayField,
    fields: [...fields].map(withoutBlankGuidance).sort((a, b) => a.position - b.position),
    ...(urlPattern ? { urlPattern } : {}),
    ...(singleton ? { singleton: true as const } : {}),
    version: current.version + 1,
    status: 'draft',
  };
}

function assertFieldsValid(
  fields: readonly FieldDefinition[],
  displayField: string,
  previous: readonly FieldDefinition[] | undefined,
): void {
  const seen = assertFieldSetValid(fields, '', 0, previous);
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
 * entered so far; 0 is the content type's own field list. `previous` is the
 * same level of the definition being revised, if any.
 */
function assertFieldSetValid(
  fields: readonly FieldDefinition[],
  path: string,
  depth: number,
  previous: readonly FieldDefinition[] | undefined,
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
    const before = previous?.find((p) => p.apiId === f.apiId);
    assertGuidanceValid(f, where, before);
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
      assertVariantsValid(f, where, depth, before);
      continue;
    }
    const nestedBefore = before?.type === 'Component' ? before.fields : before?.items?.fields;
    assertFieldSetValid(nested ?? [], where, depth + 1, nestedBefore);
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
function assertVariantsValid(
  f: FieldDefinition,
  where: string,
  depth: number,
  before: FieldDefinition | undefined,
): void {
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
    const variantBefore = before?.items?.variants?.find((b) => b.apiId === apiId);
    assertFieldSetValid(v.fields, at, depth + 1, variantBefore?.fields);
  }
}

/**
 * The guidance a field carries for whoever fills it: `help`, `placeholder` and
 * `description` as capped plain text, usable `in` options, and a custom message
 * only for a rule the field declares. `before` is the field as currently
 * stored, when this is a revision.
 *
 * Options were not checked before guidance existed, so a stored list may hold
 * a duplicate or a stray `true`. Those are refused only when the revision adds
 * them: refusing what is already stored would leave the type impossible to
 * edit at all.
 */
function assertGuidanceValid(
  f: FieldDefinition,
  where: string,
  before: FieldDefinition | undefined,
): void {
  const fail = (message: string): never => {
    throw new ValidationError([{ field: where, message }]);
  };
  for (const key of ['help', 'placeholder', 'description'] as const) {
    const text: unknown = f[key];
    // Unchanged from what is stored passes, whatever it is (main once stored anything).
    if (text === undefined || text === null || sameJson(text, before?.[key])) continue;
    if (typeof text !== 'string') fail(`${key} must be a string`);
    else if (text.length > FIELD_GUIDANCE_LIMITS[key]) {
      fail(`${key} must be at most ${FIELD_GUIDANCE_LIMITS[key]} characters`);
    }
  }
  assertValidationsGuidanceValid(f.validations, before?.validations, where, fail);
  // Per-element `in` is accepted (and kept) but not yet enforced on an Array's
  // elements; a message would explain an error that never happens, so it is refused.
  const itemMessages: unknown = f.items?.validations?.messages;
  if (itemMessages !== undefined && !sameJson(itemMessages, before?.items?.validations?.messages)) {
    fail(`${where} items: validations.messages are not enforced on an Array's elements`);
  }
  assertOptionsValid(
    f.items?.validations?.in,
    before?.items?.validations?.in,
    `${where} items`,
    fail,
  );
}

/** Equal as stored JSON: for the scalars and small objects a revision may carry over unchanged. */
const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function assertValidationsGuidanceValid(
  v: FieldValidations | undefined,
  before: FieldValidations | undefined,
  label: string,
  fail: (message: string) => never,
): void {
  if (v === undefined) return;
  assertOptionsValid(v.in, before?.in, label, fail);
  const messages: unknown = v.messages;
  if (messages === undefined || sameJson(messages, before?.messages)) return;
  if (typeof messages !== 'object' || messages === null || Array.isArray(messages)) {
    fail(`${label}: validations.messages maps a rule to its message`);
  }
  const stored: unknown = before?.messages;
  for (const [rule, message] of Object.entries(messages as Record<string, unknown>)) {
    // A message stored as it stands is not new, even where it explains nothing.
    if (
      typeof stored === 'object' &&
      stored !== null &&
      sameJson(message, (stored as Record<string, unknown>)[rule])
    ) {
      continue;
    }
    if (!(MESSAGE_RULES as readonly string[]).includes(rule)) {
      fail(`${label}: no message for "${rule}" (one of: ${MESSAGE_RULES.join(', ')})`);
    }
    if (v[rule as MessageRule] === undefined) {
      fail(`${label}: a message for "${rule}" needs the ${rule} rule it explains`);
    }
    if (typeof message !== 'string' || message.trim() === '') {
      fail(`${label}: the "${rule}" message must be non-empty text`);
    } else if (message.length > FIELD_GUIDANCE_LIMITS.message) {
      fail(`${label}: a message is at most ${FIELD_GUIDANCE_LIMITS.message} characters`);
    }
  }
}

/**
 * Each option usable and listed once, by its text (`'1'` and `1` clash).
 * An option that breaks either rule is let through when the stored list
 * already holds it at least as many times: it is not new. Options are
 * compared by type, text and label, so an object's key order never matters.
 */
function assertOptionsValid(
  options: unknown,
  before: unknown,
  label: string,
  fail: (message: string) => never,
): void {
  if (options === undefined) return;
  if (!Array.isArray(options)) {
    if (!sameJson(options, before)) fail(`${label}: validations.in must be a list`);
    return;
  }
  const identity = (o: unknown): string => {
    const labelled = typeof o === 'object' && o !== null;
    const value = labelled ? (o as { value?: unknown }).value : o;
    const optionLabel = labelled ? (o as { label?: unknown }).label : undefined;
    return JSON.stringify([typeof value, String(value), optionLabel ?? null]);
  };
  const stored = Array.isArray(before) ? before : [];
  const count = (list: readonly unknown[], o: unknown) =>
    list.filter((x) => identity(x) === identity(o)).length;
  const seen = new Set<string>();
  for (const option of options as unknown[]) {
    const problem =
      optionProblem(option) ??
      (seen.has(optionKey(option as FieldOption))
        ? `option ${JSON.stringify(optionValue(option as FieldOption))} is listed twice`
        : null);
    if (problem === null) seen.add(optionKey(option as FieldOption));
    else if (count(options, option) > count(stored, option)) fail(`${label}: ${problem}`);
  }
}

/**
 * Guidance that is blank (or a stored null) says nothing, so it is left out: a whitespace-only
 * `description` would otherwise win over a real `help` wherever one stands in
 * for the other. Nested definitions are cleaned the same way.
 */
function withoutBlankGuidance(f: FieldDefinition): FieldDefinition {
  const blank = (t: unknown) => t === null || (typeof t === 'string' && t.trim() === '');
  // Each level is rebuilt only when something under it changed: callers compare definitions by
  // reference (a block's variant fields, say), and the common case changes nothing.
  const list = (fields: readonly FieldDefinition[] | undefined) => {
    const next = fields?.map(withoutBlankGuidance);
    return next?.some((g, i) => g !== fields?.[i]) ? next : fields;
  };
  const fields = list(f.fields);
  const itemFields = list(f.items?.fields);
  const variants = f.items?.variants?.map((v) => {
    const vf = list(v.fields) ?? v.fields;
    return vf === v.fields ? v : { ...v, fields: vf };
  });
  const variantsChanged = variants?.some((v, i) => v !== f.items?.variants?.[i]) ?? false;
  const keys = (['help', 'placeholder', 'description'] as const).filter((k) => blank(f[k]));
  if (
    keys.length === 0 &&
    fields === f.fields &&
    itemFields === f.items?.fields &&
    !variantsChanged
  ) {
    return f;
  }
  const out: Record<string, unknown> = { ...f };
  for (const k of keys) delete out[k];
  if (fields !== f.fields) out.fields = fields;
  if (f.items && (itemFields !== f.items.fields || variantsChanged)) {
    out.items = {
      ...f.items,
      ...(itemFields ? { fields: itemFields } : {}),
      ...(variantsChanged ? { variants } : {}),
    };
  }
  return out as unknown as FieldDefinition;
}

/**
 * Field definitions written before guidance was checked (an environment
 * snapshot, a clone), made acceptable to {@link defineContentType} without
 * failing on what the source was allowed to store, at every depth:
 *
 * - each `in` list keeps its usable options, once each (see `normalizeOptions`),
 *   and goes when none is left, since an empty list would refuse every value;
 * - guidance that is not text, or over its cap, goes;
 * - a message goes unless it is text within its cap for a rule the field
 *   declares; an Array element's messages go, as nothing enforces them.
 */
export function normalizeLegacyFields(fields: readonly FieldDefinition[]): FieldDefinition[] {
  const rules = (
    v: FieldValidations | undefined,
    type: FieldDefinition['type'],
    element: boolean,
  ): FieldValidations | undefined => {
    if (v === undefined || v === null || typeof v !== 'object') return undefined;
    const { in: options, messages, ...rest } = v;
    const kept: FieldValidations = { ...rest };
    if (options !== undefined) {
      const usable = normalizeOptions(options, type);
      if (usable.length > 0) kept.in = usable;
    }
    if (!element && typeof messages === 'object' && messages !== null) {
      const usable = Object.fromEntries(
        MESSAGE_RULES.filter((rule) => kept[rule] !== undefined).flatMap((rule) => {
          const text: unknown = (messages as Record<string, unknown>)[rule];
          return typeof text === 'string' &&
            text.trim() !== '' &&
            text.length <= FIELD_GUIDANCE_LIMITS.message
            ? [[rule, text]]
            : [];
        }),
      );
      if (Object.keys(usable).length > 0) kept.messages = usable;
    }
    return Object.keys(kept).length > 0 ? kept : undefined;
  };
  const guidance = (f: FieldDefinition) => {
    const out: { help?: string; placeholder?: string; description?: string } = {};
    for (const key of ['help', 'placeholder', 'description'] as const) {
      const text: unknown = f[key];
      if (typeof text === 'string' && text.length <= FIELD_GUIDANCE_LIMITS[key]) out[key] = text;
    }
    return out;
  };
  return fields.map((f) => {
    const { help: _h, placeholder: _p, description: _d, validations: _v, ...rest } = f;
    const validations = rules(f.validations, f.type, false);
    const itemRules = rules(f.items?.validations, f.items?.type ?? 'Symbol', true);
    const { validations: _iv, ...itemRest } = f.items ?? {};
    const items = f.items && {
      ...(itemRest as NonNullable<FieldDefinition['items']>),
      ...(itemRules ? { validations: itemRules } : {}),
      ...(f.items.fields ? { fields: normalizeLegacyFields(f.items.fields) } : {}),
      ...(f.items.variants
        ? {
            variants: f.items.variants.map((v) => ({
              ...v,
              fields: normalizeLegacyFields(v.fields),
            })),
          }
        : {}),
    };
    return {
      ...rest,
      ...guidance(f),
      ...(validations ? { validations } : {}),
      ...(f.fields ? { fields: normalizeLegacyFields(f.fields) } : {}),
      ...(items ? { items } : {}),
    };
  });
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
