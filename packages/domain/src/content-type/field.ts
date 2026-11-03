/**
 * Field definitions for content types. These mirror the structured-content
 * model: a content type is an ordered list of typed, validated fields.
 */

export const FIELD_TYPES = [
  'Symbol', // short text (single line)
  'Slug', // URL-safe identifier (normalized; usually unique)
  'Text', // long text (multi line)
  'RichText', // structured rich text document
  'Integer',
  'Number',
  'Boolean',
  'Date', // ISO-8601 string
  'Location', // { lat, lon }
  'Seo', // search engine metadata: a component of fixed shape (SEO_FIELDS), one per type
  'JSON', // arbitrary JSON object
  'Link', // reference to another entry or asset
  'Component', // a group of nested typed fields
  'Array', // array of Symbols, Links or Components
] as const;

export type FieldType = (typeof FIELD_TYPES)[number];

/** What a Link (or Array of Links) points at. */
export type LinkType = 'Entry' | 'Asset';

/**
 * Types a `unique` constraint can be declared on. Excluded: RichText, JSON,
 * Location, Link and Array have no single comparable value; Boolean has two,
 * so uniqueness would cap the type at two entries.
 */
export const UNIQUE_FIELD_TYPES: readonly FieldType[] = [
  'Symbol',
  'Slug',
  'Text',
  'Integer',
  'Number',
  'Date',
];

/**
 * Validation rules for a field. All optional; an absent rule is not enforced.
 * Stored as JSON on the field definition.
 */
export interface FieldValidations {
  /** Allowed values (enumeration). */
  in?: readonly (string | number)[];
  /** Regular expression a Symbol/Text value must match. */
  regexp?: { pattern: string; flags?: string };
  /** Numeric range (inclusive) for Integer/Number. */
  range?: { min?: number; max?: number };
  /** Length range (inclusive) for Symbol/Text, or item count for Array. */
  size?: { min?: number; max?: number };
  /** For Link/Array-of-Link: restrict to these content type apiIds. */
  linkContentTypes?: readonly string[];
}

export interface FieldDefinition {
  /** Stable machine identifier, unique within the content type. */
  readonly apiId: string;
  /** Human-facing name. */
  readonly name: string;
  readonly type: FieldType;
  /** Whether values may differ per locale. */
  readonly localized: boolean;
  readonly required: boolean;
  /** Ordering within the content type (ascending). */
  readonly position: number;
  /**
   * No two entries of this type may share a value, compared per locale. Backed
   * by a database constraint, not a read-then-write check, so it holds under
   * concurrent writes. Only meaningful on the scalar types in
   * {@link UNIQUE_FIELD_TYPES}.
   */
  readonly unique?: boolean;
  // No `indexed` attribute: field values live in a jsonb column, so honouring
  // it would mean issuing DDL per field when a content type is published.
  // Accepting the flag and silently not indexing would be a promise the
  // storage layer does not keep, so it is left out until it can be real.
  /**
   * Applied when an entry is created without a value for this field. A bare
   * value is used for every locale; a `{ locale: value }` map sets them
   * individually. Never applied on update — a field cleared on purpose stays
   * cleared.
   */
  readonly defaultValue?: unknown;
  readonly validations?: FieldValidations;
  /** For Link fields: whether it links an Entry or Asset. */
  readonly linkType?: LinkType;
  /** For Array fields: the element definition. */
  readonly items?: {
    readonly type: Extract<FieldType, 'Symbol' | 'Link' | 'Component'>;
    readonly linkType?: LinkType;
    readonly validations?: FieldValidations;
    /** For Array-of-Component: the shape of each element. */
    readonly fields?: readonly FieldDefinition[];
    /**
     * For Array-of-Component: the shapes an element may take, declared instead
     * of `fields` (never both). This is a blocks field: a page body made of a
     * hero, then a rich-text section, then a call to action, in whatever order
     * the editor chooses. Each stored element names its shape in `_type` and
     * carries a stable `_key`; see {@link ComponentVariant}.
     */
    readonly variants?: readonly ComponentVariant[];
  };
  /**
   * For Component fields: the nested field definitions.
   *
   * Nested fields are ordinary definitions with two things withheld — see
   * {@link COMPONENT_NESTED_RULES}. A repeating group ("feature cards",
   * "spec rows") is an `Array` whose `items.type` is `Component`.
   */
  readonly fields?: readonly FieldDefinition[];
}

/**
 * One shape an element of a blocks field may take.
 *
 * A variant is a component definition with a name: its `fields` follow the
 * same rules as any component's (see {@link COMPONENT_NESTED_RULES}) and count
 * toward {@link MAX_COMPONENT_DEPTH}. A stored element looks like
 * `{ "_type": "hero", "_key": "<uuidv7>", "heading": "…" }`. The `_` prefix
 * cannot collide with a field apiId, which must start with a letter.
 *
 * A single polymorphic slot is the same field with `validations.size.max: 1`;
 * a plain `Component` field has exactly one shape.
 */
export interface ComponentVariant {
  /** Stable machine identifier, unique within the field; stored as `_type`. */
  readonly apiId: string;
  /** Human-facing name, shown in the editor's "Add block" menu. */
  readonly name: string;
  readonly fields: readonly FieldDefinition[];
}

/** The key a blocks element names its variant under. */
export const BLOCK_TYPE_KEY = '_type';
/**
 * The key a blocks element is identified by within its field value. Assigned
 * on write when absent, kept when present, so a client can address one block
 * across reorders and edits (a comment anchor, a live-preview patch, a React
 * key) without relying on its position.
 */
export const BLOCK_KEY = '_key';

/** The variants of a blocks field (Array-of-Component declaring `items.variants`), else undefined. */
export function blockVariants(field: FieldDefinition): readonly ComponentVariant[] | undefined {
  return field.type === 'Array' && field.items?.type === 'Component'
    ? field.items.variants
    : undefined;
}

/** The variant a stored blocks element names in `_type`, if it names one that exists. */
export function variantOf(
  variants: readonly ComponentVariant[],
  item: unknown,
): ComponentVariant | undefined {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) return undefined;
  const type = (item as Record<string, unknown>)[BLOCK_TYPE_KEY];
  return typeof type === 'string' ? variants.find((v) => v.apiId === type) : undefined;
}

/**
 * The nested definitions that describe one value held by `field`: a component's
 * fields, or for an element of an Array-of-Component, the shared shape or the
 * shape its `_type` names. Undefined when the field holds no component, or the
 * element names no known variant.
 */
export function nestedFieldsFor(
  field: FieldDefinition,
  item: unknown,
): readonly FieldDefinition[] | undefined {
  if (field.type === 'Component') return field.fields;
  if (field.type !== 'Array' || field.items?.type !== 'Component') return undefined;
  const variants = field.items.variants;
  return variants ? variantOf(variants, item)?.fields : field.items.fields;
}

/**
 * How deep components may nest, counting the outermost component as 1.
 *
 * A cap exists because every consumer of a content type — validation, codegen,
 * GraphQL type generation, the editor — walks this tree, and an unbounded one
 * turns each of them into a way to hang the process. Three levels covers the
 * shapes people actually model; deeper usually wants a linked entry instead,
 * which is what the error says.
 */
export const MAX_COMPONENT_DEPTH = 3;

/**
 * Two attributes are refused on a nested field rather than accepted and
 * ignored, because each would be a promise nothing keeps:
 *
 * - `localized` — localization is decided once, on the field that holds the
 *   component. A per-leaf flag would mean one card in a list could be German
 *   while its sibling was not, which no editor UI can express and no fallback
 *   chain can resolve.
 * - `unique` — the constraint backing it is a row per (content type, field,
 *   locale, value). There is no row to write for the third card's title, so a
 *   nested `unique` would be a declaration nothing enforces.
 *
 * `Slug` is refused for a related reason: slugs are normalized on write by
 * walking the entry's top-level fields, so a nested one would be stored exactly
 * as typed and then fail its own validation.
 */
export const COMPONENT_NESTED_RULES = ['localized', 'unique', 'Slug'] as const;

const API_ID_RE = /^[a-zA-Z][a-zA-Z0-9_]*$/;

/** Returns true if `apiId` is a legal stable identifier. */
export function isValidApiId(apiId: string): boolean {
  return API_ID_RE.test(apiId) && apiId.length <= 64;
}

const ALLOWED_REGEX_FLAGS = 'gimsuy';
const MAX_REGEX_PATTERN_LENGTH = 1000;
// Heuristic for the classic catastrophic-backtracking shape: a quantifier
// applied to a group that itself contains a quantifier (e.g. (a+)+, ([a-z]*)+).
const NESTED_QUANTIFIER = /\([^()]*[+*][^()]*\)\s*[+*{]/;

/**
 * Rejects a user-authored validation regexp that is malformed or prone to ReDoS,
 * so a content-type author can't stall the write path (which compiles and runs
 * this pattern against every entry value). Returns `null` when safe, else a
 * human-readable reason. Kept dependency-free (domain depends on nothing), so it
 * is a conservative heuristic rather than a full static analysis.
 */
export function unsafeRegexReason(pattern: string, flags = ''): string | null {
  if (pattern.length > MAX_REGEX_PATTERN_LENGTH) {
    return `pattern must be at most ${MAX_REGEX_PATTERN_LENGTH} characters`;
  }
  for (const f of flags) {
    if (!ALLOWED_REGEX_FLAGS.includes(f)) return `unsupported regex flag "${f}"`;
  }
  if (NESTED_QUANTIFIER.test(pattern)) {
    return 'pattern rejected: nested quantifiers risk catastrophic backtracking';
  }
  try {
    new RegExp(pattern, flags);
  } catch {
    return 'invalid regular expression';
  }
  return null;
}
