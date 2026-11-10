/**
 * Pure generator: content-type definitions in → TypeScript source out.
 * The emitted module gives every SDK a typed field shape to plug into their
 * `F extends Fields` generics: `client.getEntry<ArticleFields>(id)`.
 */

/** The subset of a content-type definition the generator reads. Matches the
 *  Management API's `GET .../content-types` items (extra keys are ignored). */
export interface ContentTypeInput {
  readonly apiId: string;
  readonly name?: string;
  readonly fields: readonly FieldInput[];
}

/** An allowed value of an `in` rule: bare, or with the label an editor picks it by. */
export type OptionInput =
  | string
  | number
  | { readonly value: string | number; readonly label?: string };

export interface FieldInput {
  readonly apiId: string;
  readonly name?: string;
  readonly type: string;
  readonly localized?: boolean;
  readonly required?: boolean;
  /** What the field means; emitted as the property's doc comment. */
  readonly description?: string;
  /** How to fill it; emitted as the property's doc comment when there is no description. */
  readonly help?: string;
  readonly validations?: {
    readonly in?: readonly OptionInput[];
    readonly linkContentTypes?: readonly string[];
  };
  readonly linkType?: 'Entry' | 'Asset';
  /** Conditional rules; a field a rule can hide may be absent even when required. */
  readonly rules?: readonly { readonly action: string }[];
  /** For a Date field: `date`, `datetime` or `time`; noted in the doc comment. */
  readonly format?: string;
  readonly items?: {
    readonly type: string;
    readonly format?: string;
    readonly linkType?: 'Entry' | 'Asset';
    readonly validations?: { readonly in?: readonly OptionInput[] };
    readonly fields?: readonly FieldInput[];
    /** For a blocks field (Array-of-Component): the shapes an element may take. */
    readonly variants?: readonly VariantInput[];
  };
  /** For Component fields: the nested definitions. */
  readonly fields?: readonly FieldInput[];
}

/** One variant of a blocks field: an element `{ _type: apiId, _key, ...fields }`. */
export interface VariantInput {
  readonly apiId: string;
  readonly name?: string;
  /** Ids the variant had before; noted on its block type. */
  readonly aliases?: readonly string[];
  readonly fields: readonly FieldInput[];
}

/**
 * A block catalog, or the part of it the generator reads: what `GET …/block-catalog` answers, and
 * the shape of a `contentworker.blocks.json`. Extra keys are ignored.
 */
export interface BlockCatalogInput {
  readonly blocks: readonly BlockManifestInput[];
}

/** One block of a catalog: its id, former ids, props and slots. */
export interface BlockManifestInput {
  readonly id: string;
  readonly name?: string;
  readonly description?: string;
  readonly aliases?: readonly string[];
  readonly fields: readonly FieldInput[];
  readonly slots?: readonly {
    readonly apiId: string;
    readonly name?: string;
    readonly help?: string;
    readonly allowedChildren: readonly string[];
    readonly min?: number;
  }[];
}

export interface GenerateOptions {
  /** Header comment noting provenance (defaults to a generic banner). */
  readonly banner?: string;
  /**
   * The block catalog, for the block types (`BlockTypes`): its blocks are typed from it, and every
   * other block (a blocks field the catalog doesn't target) from the content types' variants.
   */
  readonly blockCatalog?: BlockCatalogInput;
}

/** Shared helper types emitted once at the top of every generated module. */
const PRELUDE = `/** A reference to another entry. Delivery may embed the linked entry in place
 *  of this shape when \`include\` depth covers it. */
export interface EntryLink {
  id: string;
  linkType: 'Entry';
}

/** A reference to an asset. */
export interface AssetLink {
  id: string;
  linkType: 'Asset';
}

/** A published asset as Delivery embeds it in place of an \`AssetLink\` (within \`include\`). URLs
 *  are on the media origin: \`renditions\` by name, \`srcset\` the width ladder. Title,
 *  description and alt text are one locale's value with \`?locale=\`, else keyed by locale. */
export interface DeliveredAsset {
  id: string;
  title: string | Record<string, unknown> | null;
  description: string | Record<string, unknown> | null;
  altText: string | Record<string, unknown> | null;
  focalPoint: { x: number; y: number } | null;
  contentType: string;
  size: number | null;
  width: number | null;
  height: number | null;
  kind: 'image' | 'video' | 'audio' | 'document' | 'other';
  url: string;
  renditions: Record<string, string>;
  srcset: { width: number; url: string }[];
  /** ThumbHash (base64) and dominant colour (#rrggbb) to show while it loads; null until ingested. */
  placeholder: { thumbhash: string; dominantColor: string } | null;
  video?: {
    status: string;
    hlsUrl?: string;
    dashUrl?: string;
    thumbnailUrl?: string;
    durationSeconds?: number;
  };
  rights?: { credit?: string; license?: string };
  file: Record<string, unknown>;
}

export interface RichTextMark {
  type: string;
}

/** The data of an \`embed\` node: external media (a video, a post, a track) as structured
 *  metadata, never the provider's HTML. \`url\` is an https page on an allowed provider; render a
 *  player for \`provider\` from it, or a link card. */
export interface EmbedData {
  url: string;
  provider: 'youtube' | 'vimeo' | 'x' | 'bluesky' | 'spotify' | 'soundcloud' | 'mastodon' | (string & {});
  kind?: 'video' | 'post' | 'audio' | 'other';
  title?: string;
  authorName?: string;
  thumbnail?: { url: string; width?: number; height?: number };
  width?: number;
  height?: number;
  aspectRatio?: number;
}

/** A rich-text node. Reference nodes carry \`data.target\`; an \`embed\` node's data is \`EmbedData\`. */
export interface RichTextNode {
  nodeType: string;
  content?: RichTextNode[];
  value?: string;
  marks?: RichTextMark[];
  data?: { target?: EntryLink | AssetLink } & Partial<EmbedData> & Record<string, unknown>;
}

export interface RichTextDocument {
  nodeType: 'document';
  content: RichTextNode[];
  data?: Record<string, unknown>;
}

export interface Location {
  lat: number;
  lon: number;
}

/** Management (draft) values are keyed by locale code. */
export type Localized<T> = Record<string, T>;
`;

/** Generates a self-contained TypeScript module from content-type definitions. */
export function generateTypes(
  contentTypes: readonly ContentTypeInput[],
  opts: GenerateOptions = {},
): string {
  const banner =
    opts.banner ??
    'Generated by @contentworker/sdk-codegen from your content model. Do not edit by hand.';
  const names = assignTypeNames(contentTypes);
  const sections: string[] = [`// ${banner}\n`, PRELUDE];

  for (const ct of contentTypes) {
    const typeName = names.get(ct.apiId) as string;
    sections.push(renderContentType(ct, typeName));
  }

  if (contentTypes.length > 0) {
    const ids = contentTypes.map((ct) => literal(ct.apiId)).join(' | ');
    const deliveryRows = contentTypes
      .map((ct) => `  ${propertyKey(ct.apiId)}: ${names.get(ct.apiId)}Fields;`)
      .join('\n');
    const draftRows = contentTypes
      .map((ct) => `  ${propertyKey(ct.apiId)}: ${names.get(ct.apiId)}DraftFields;`)
      .join('\n');
    sections.push(
      `export type ContentTypeApiId = ${ids};\n`,
      `/** Delivery field shapes by content type apiId. */\nexport interface FieldsByContentType {\n${deliveryRows}\n}\n`,
      `/** Management (locale-keyed) field shapes by content type apiId. */\nexport interface DraftFieldsByContentType {\n${draftRows}\n}\n`,
    );
  }

  sections.push(...renderBlockTypes(blockShapes(contentTypes, opts.blockCatalog)));

  return sections.join('\n');
}

// --- block types -------------------------------------------------------------------------------

/** One block as the generator types it: its props, and its slots by the block ids they take. */
interface BlockShape {
  readonly id: string;
  readonly name?: string;
  readonly description?: string;
  readonly aliases?: readonly string[];
  readonly fields: readonly FieldInput[];
  readonly slots: readonly {
    readonly apiId: string;
    readonly present: boolean;
    readonly comment: string;
    readonly children: readonly string[];
  }[];
}

/** A blocks field (an Array of Component with variants): its variants, else undefined. */
function variantsOf(field: FieldInput): readonly VariantInput[] | undefined {
  return field.type === 'Array' && field.items?.type === 'Component' && field.items.variants?.length
    ? field.items.variants
    : undefined;
}

/** A list from JSON the generator didn't check, or none. */
const list = <T>(v: readonly T[] | undefined): readonly T[] => (Array.isArray(v) ? v : []);

/**
 * The catalog's blocks, then every variant of a blocks field the catalog doesn't define (by id or
 * former id): a model can hold blocks fields of its own beside the ones a catalog fills.
 */
function blockShapes(
  contentTypes: readonly ContentTypeInput[],
  catalog: BlockCatalogInput | undefined,
): BlockShape[] {
  const variants = variantShapes(contentTypes);
  if (!catalog) return variants;
  const fromCatalog = catalogShapes(catalog);
  // A former id of a catalog block is that block, not one of the model's own.
  const defined = new Set(fromCatalog.flatMap((b) => [b.id, ...list(b.aliases)]));
  return [...fromCatalog, ...variants.filter((v) => !defined.has(v.id))];
}

function catalogShapes(catalog: BlockCatalogInput): BlockShape[] {
  return list(catalog.blocks).map((b) => ({
    id: b.id,
    name: b.name,
    description: b.description,
    aliases: b.aliases,
    fields: list(b.fields),
    slots: list(b.slots).map((slot) => ({
      apiId: slot.apiId,
      present: (slot.min ?? 0) > 0,
      comment: fieldComment({ apiId: slot.apiId, name: slot.name, help: slot.help, type: 'Array' }),
      children: list(slot.allowedChildren),
    })),
  }));
}

/**
 * Every variant of every blocks field in the model, at any depth, in the order they are met. A
 * catalog expands each block once per place it goes, so the same id is met more than once.
 */
function variantShapes(contentTypes: readonly ContentTypeInput[]): BlockShape[] {
  const shapes: BlockShape[] = [];
  const visitFields = (fields: readonly FieldInput[] | undefined) => {
    for (const f of fields ?? []) {
      const variants = variantsOf(f);
      if (variants) for (const v of variants) visitVariant(v);
      else if (f.type === 'Component') visitFields(f.fields);
      else if (f.type === 'Array' && f.items?.type === 'Component') visitFields(f.items.fields);
    }
  };
  const visitVariant = (v: VariantInput) => {
    const fields: FieldInput[] = [];
    const slots: BlockShape['slots'][number][] = [];
    const children: VariantInput[] = [];
    for (const f of v.fields ?? []) {
      const nested = variantsOf(f);
      if (!nested) {
        fields.push(f);
        if (f.type === 'Component') visitFields(f.fields);
        else if (f.type === 'Array' && f.items?.type === 'Component') visitFields(f.items.fields);
        continue;
      }
      slots.push({
        apiId: f.apiId,
        present: present(f),
        comment: fieldComment(f),
        children: nested.map((n) => n.apiId),
      });
      children.push(...nested);
    }
    // A block before the blocks its slots hold, as a catalog lists them.
    shapes.push({ id: v.apiId, name: v.name, aliases: v.aliases, fields, slots });
    for (const n of children) visitVariant(n);
  };
  for (const ct of contentTypes) visitFields(ct.fields);
  return shapes;
}

/**
 * Each block id's type, `<Id>Block`, and `BlockTypes` mapping every id to it: the map
 * `<Blocks components={…}>` is typed by. Slots are typed as lists of their blocks' types. An id
 * the model gives two shapes (two fields defining it apart) is typed as either.
 */
function renderBlockTypes(shapes: readonly BlockShape[]): string[] {
  const byId = new Map<string, BlockShape[]>();
  for (const shape of shapes) {
    if (!shape.id) continue;
    byId.set(shape.id, [...(byId.get(shape.id) ?? []), shape]);
  }
  if (byId.size === 0) return [];
  const names = new Map<string, string>();
  const taken = new Set<string>();
  for (const id of byId.keys()) {
    const base = `${pascalCase(id) || 'Unnamed'}Block`;
    let candidate = base;
    for (let n = 2; taken.has(candidate); n++) candidate = `${base.slice(0, -5)}${n}Block`;
    taken.add(candidate);
    names.set(id, candidate);
  }
  const shapeType = (shape: BlockShape): string => {
    const rows = [`  _type: ${literal(shape.id)};`, '  _key: string;'];
    for (const f of shape.fields) {
      rows.push(
        `${fieldComment(f)}  ${propertyKey(f.apiId)}${present(f) ? '' : '?'}: ${fieldValueType(f, { delivered: true })};`,
      );
    }
    for (const slot of shape.slots) {
      const children = [...new Set(slot.children)].flatMap((c) => {
        const name = names.get(c);
        return name ? [name] : [];
      });
      const element = children.length ? children.join(' | ') : '{ _type: string; _key: string }';
      rows.push(
        `${slot.comment}  ${propertyKey(slot.apiId)}${slot.present ? '' : '?'}: ${children.length > 1 ? `(${element})` : element}[];`,
      );
    }
    return `{\n${rows.join('\n')}\n}`;
  };
  const out: string[] = [];
  for (const [id, variants] of byId) {
    const first = variants[0] as BlockShape;
    const shapesOf = [...new Set(variants.map(shapeType))];
    const notes: string[] = [];
    notes.push(escapeComment(first.name ? `${first.name} (\`${id}\`)` : `\`${id}\``));
    const aliases = [...new Set(variants.flatMap((v) => v.aliases ?? []))];
    if (aliases.length) {
      notes.push(escapeComment(`formerly ${aliases.map((a) => `\`${a}\``).join(', ')}`));
    }
    const guidance = first.description?.replace(/\s+/g, ' ').trim();
    if (guidance) notes.push(escapeComment(guidance));
    out.push(
      `/** ${notes.join(' — ')} */\nexport type ${names.get(id)} = ${shapesOf.join(' | ')};\n`,
    );
  }
  const rows = [...byId.keys()].map((id) => `  ${propertyKey(id)}: ${names.get(id)};`).join('\n');
  out.push(
    `/** Each block id's type: what \`BlockComponents<BlockTypes>\` (@contentworker/sdk/react, /vue) types each component's block by. */\nexport type BlockTypes = {\n${rows}\n};\n`,
    `export type BlockId = keyof BlockTypes;\n`,
  );
  return out;
}

function renderContentType(ct: ContentTypeInput, typeName: string): string {
  const label = escapeComment(ct.name ? `${ct.name} (\`${ct.apiId}\`)` : `\`${ct.apiId}\``);
  const delivery: string[] = [];
  const draft: string[] = [];

  for (const field of ct.fields) {
    const key = propertyKey(field.apiId);
    const opt = present(field) ? '' : '?';
    const comment = fieldComment(field);
    delivery.push(`${comment}  ${key}${opt}: ${fieldValueType(field, { delivered: true })};`);
    draft.push(`${comment}  ${key}${opt}: Localized<${fieldValueType(field)}>;`);
  }

  // Type aliases, not interfaces: aliases get an implicit index signature, so
  // they satisfy the SDKs' `F extends Record<string, unknown>` generics.
  return [
    `/** ${label} — Delivery shape (locale-flattened; request with \`?locale=\`). */\nexport type ${typeName}Fields = {\n${delivery.join('\n')}\n};\n`,
    `/** ${label} — Management shape (locale-keyed draft values). */\nexport type ${typeName}DraftFields = {\n${draft.join('\n')}\n};\n`,
  ].join('\n');
}

/**
 * Maps a field definition to the TypeScript type of a single (locale-resolved) value. With
 * `delivered`, an asset link may arrive embedded (Delivery resolves it within `include`); a draft
 * value is always the bare link.
 */
export function fieldValueType(field: FieldInput, opts: { delivered?: boolean } = {}): string {
  const asset = opts.delivered ? 'AssetLink | DeliveredAsset' : 'AssetLink';
  // `in` validations narrow to a literal union only where the domain actually
  // enforces them (Symbol/Text/Integer/Number) — elsewhere stored values may
  // legally fall outside the list, so the wider type is the truthful one.
  switch (field.type) {
    case 'Symbol':
    case 'Text':
      return literalUnion(field.validations?.in) ?? 'string';
    // A Slug is a constrained string; the constraint is enforced on write, and
    // a narrower TS type would only make consumers cast.
    case 'Slug':
      return 'string';
    case 'Date':
      return 'string';
    case 'Integer':
    case 'Number':
      return literalUnion(field.validations?.in) ?? 'number';
    case 'Boolean':
      return 'boolean';
    case 'Location':
      return 'Location';
    case 'JSON':
      return 'Record<string, unknown>';
    case 'RichText':
      return 'RichTextDocument';
    case 'Link':
      return field.linkType === 'Asset' ? asset : 'EntryLink';
    // Emitted inline rather than as a named interface: a component's shape has
    // no identity outside the field that holds it, and naming it would mean
    // inventing collision-prone names for something nobody imports by name.
    case 'Component':
      return componentType(field.fields, opts);
    // A component of fixed shape (the domain's SEO_FIELDS), spelled out: the SDK depends on nothing.
    case 'Seo':
      return `{ title?: string; description?: string; canonicalUrl?: string; noindex?: boolean; ogImage?: ${asset} }`;
    case 'Array': {
      const items = field.items;
      if (items?.type === 'Link') {
        return items.linkType === 'Asset'
          ? opts.delivered
            ? '(AssetLink | DeliveredAsset)[]'
            : 'AssetLink[]'
          : 'EntryLink[]';
      }
      if (items?.type === 'Component' && items.variants?.length) {
        return `(${items.variants.map((v) => blockType(v, opts)).join(' | ')})[]`;
      }
      if (items?.type === 'Component') return `${componentType(items.fields, opts)}[]`;
      if (items?.type === 'Integer' || items?.type === 'Number') return 'number[]';
      // Symbol, Text and Date elements are strings.
      return 'string[]';
    }
    default:
      return 'unknown';
  }
}

/**
 * Whether a value is always there: a required field, unless a rule can hide it (a hidden field is
 * not required, so its value may be missing).
 */
function present(field: FieldInput): boolean {
  if (!field.required) return false;
  return !(Array.isArray(field.rules) && field.rules.some((r) => r?.action === 'hide'));
}

/** A component's nested fields as an inline object type. */
function componentType(
  fields: readonly FieldInput[] | undefined,
  opts: { delivered?: boolean } = {},
): string {
  if (!fields || fields.length === 0) return 'Record<string, unknown>';
  const rows = fields
    .map((f) => `${propertyKey(f.apiId)}${present(f) ? '' : '?'}: ${fieldValueType(f, opts)}`)
    .join('; ');
  // No `Localized<>` on nested values: a component is localized as a whole, so
  // the locale is resolved one level up and every leaf here is a bare value.
  return `{ ${rows} }`;
}

/**
 * One blocks variant as an inline object type, discriminated on `_type`, so a
 * `switch (block._type)` narrows to the variant's fields. `_key` is always
 * present on a stored block: the server assigns one on write.
 */
function blockType(variant: VariantInput, opts: { delivered?: boolean } = {}): string {
  const rows = variant.fields
    .map((f) => `${propertyKey(f.apiId)}${present(f) ? '' : '?'}: ${fieldValueType(f, opts)}`)
    .join('; ');
  return `{ _type: ${literal(variant.apiId)}; _key: string${rows ? `; ${rows}` : ''} }`;
}

/** An `in` validation becomes a literal union of its stored values (`'a' | 'b'`); absent → null. */
function literalUnion(options: readonly OptionInput[] | undefined): string | null {
  if (!Array.isArray(options) || options.length === 0) return null;
  return options.map((o) => literal(typeof o === 'object' ? o.value : o)).join(' | ');
}

function literal(value: string | number): string {
  return typeof value === 'number' ? String(value) : `'${escapeString(value)}'`;
}

/** Escapes a value for a single-quoted TS string literal. */
function escapeString(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Quotes a property key unless it is already a valid identifier. */
function propertyKey(apiId: string): string {
  return IDENTIFIER.test(apiId) ? apiId : `'${escapeString(apiId)}'`;
}

function fieldComment(field: FieldInput): string {
  const notes: string[] = [];
  if (field.name && field.name !== field.apiId) notes.push(escapeComment(field.name));
  // One line of guidance: the description says what the field means, which is what someone
  // reading a type wants; help is the fallback.
  const guidance = (field.description ?? field.help)?.replace(/\s+/g, ' ').trim();
  if (guidance) notes.push(escapeComment(guidance));
  const format =
    field.type === 'Date'
      ? field.format
      : field.items?.type === 'Date'
        ? field.items.format
        : undefined;
  const written = format ? DATE_WRITTEN[format] : undefined;
  if (written) notes.push(written);
  if (field.localized) notes.push('localized');
  if (Array.isArray(field.rules) && field.rules.length > 0) {
    const actions = [...new Set(field.rules.map((r) => r?.action).filter(Boolean))];
    notes.push(escapeComment(`conditional: ${actions.join(', ')} by rules`));
  }
  if (field.linkType || field.items?.linkType) {
    const allowed = field.validations?.linkContentTypes;
    if (allowed?.length) notes.push(escapeComment(`links: ${allowed.join(', ')}`));
  }
  return notes.length ? `  /** ${notes.join(' — ')} */\n` : '';
}

/** How each Date format is written, for the doc comment. */
const DATE_WRITTEN: Readonly<Record<string, string>> = {
  date: 'date: YYYY-MM-DD',
  datetime: 'date and time: YYYY-MM-DDThh:mm',
  time: 'time: hh:mm',
};

function escapeComment(text: string): string {
  return text.replace(/\*\//g, '*\\/');
}

/** apiId → PascalCase type name, deduplicated across the model. */
function assignTypeNames(contentTypes: readonly ContentTypeInput[]): Map<string, string> {
  const names = new Map<string, string>();
  const taken = new Set<string>();
  for (const ct of contentTypes) {
    let name = pascalCase(ct.apiId);
    if (!name) name = 'ContentType';
    let candidate = name;
    let n = 2;
    while (taken.has(candidate)) candidate = `${name}${n++}`;
    taken.add(candidate);
    names.set(ct.apiId, candidate);
  }
  return names;
}

function pascalCase(apiId: string): string {
  return apiId
    .replace(/^[0-9]+/, '')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}
