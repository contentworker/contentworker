import type { BlockManifest } from './block-catalog';
import type { EffectiveBlockRules } from './block-config';
import type { ContentType } from './content-type';
import { DATE_FORMAT_EXAMPLES } from './dates';
import {
  BLOCK_TYPE_KEY,
  blockVariants,
  type ComponentVariant,
  type DateFormat,
  type FieldDefinition,
  MAX_BLOCK_DEPTH,
  normalizeOptions,
  optionValue,
  variantNamed,
} from './field';

/**
 * The JSON Schema a model fills to generate content: a draft's scalar fields, and a blocks field
 * (or one slot of a block) as a tree of the blocks the rules in force allow there.
 *
 * Pure: the use-case reads the rules, the catalog and the entry, and describes each field and
 * block for the model (`describe`, `describeBlock`), so author text is delimited where the prompt
 * defences live, in the application. What the schema can't say (a locked region, a count that
 * includes blocks already stored) the save path judges afterwards; the schema only keeps the model
 * from proposing what can't be placed.
 *
 * The tree has no `_key`: the server assigns one to every block it inserts. An image is asked for
 * as `{ "$asset": { "query": "…" } }`, a description of the picture wanted, which the use-case
 * resolves against the asset library ({@link resolveAssetRequests}): the model never invents an
 * asset id. `$` can't start a field apiId, so a request is never mistaken for a value.
 *
 * Left out of a block: rich text, entry links, lists of links, plain components and repeaters,
 * JSON, locations, an image a field's MIME rule doesn't take, and a slot the rules lock (its blocks
 * are the developer's to place). A block that requires one of them isn't offered at all.
 *
 * A block shape that occurs more than once (a grid allowed at the top and inside a section, a
 * card in every column of a six-deep layout) is written once, under `$defs`, and referenced with
 * `$ref` wherever it occurs; one that occurs once stays inline. Inlining every occurrence made the
 * schema grow with the number of paths through the tree, exponential in its depth; shared, it
 * grows with the number of distinct shapes, at most one per block and depth. Workers AI's JSON
 * mode takes any valid JSON Schema, as the structured outputs it is compatible with do, and
 * `$defs` with local `$ref`s is standard JSON Schema. What the model returns is checked against
 * the schema (`conforms` resolves the references) and then judged by the save path either way.
 */

export type JsonSchema = Record<string, unknown>;

/** Field types a model fills directly: one scalar value each. */
export const DRAFTABLE_FIELD_TYPES: ReadonlySet<string> = new Set([
  'Symbol',
  'Text',
  'Integer',
  'Number',
  'Boolean',
  'Date',
]);

/** The key an image request is made under, inside a block's single Asset link field. */
export const ASSET_REQUEST_KEY = '$asset';

/** How a field (or a block) is described to the model; its name when no describer is given. */
export type Describe = (field: FieldDefinition) => string;

/**
 * A scalar field as JSON Schema, its validations as constraints (a range, allowed values, a
 * length, a pattern), so the model is told the rules the value is then held to instead of learning
 * them from a refusal. Undefined for a field type a model doesn't fill directly.
 */
export function draftableFieldSchema(
  field: FieldDefinition,
  describe: Describe = (f) => f.name,
): JsonSchema | undefined {
  if (!DRAFTABLE_FIELD_TYPES.has(field.type)) return undefined;
  const base: JsonSchema = { description: describe(field), ...constraintsFor(field) };
  switch (field.type) {
    case 'Integer':
      return { ...base, type: 'integer' };
    case 'Number':
      return { ...base, type: 'number' };
    case 'Boolean':
      return { ...base, type: 'boolean' };
    case 'Date':
      return {
        ...base,
        type: 'string',
        description: `${describe(field)} (${dateWritten(field.format)})`,
      };
    default:
      return { ...base, type: 'string' };
  }
}

/** How a Date value is written, for the model: its format's form, or any ISO-8601 date. */
function dateWritten(format: DateFormat | undefined): string {
  if (format === 'date') return `a date, ${DATE_FORMAT_EXAMPLES.date}`;
  if (format === 'datetime') return `a date and time, ${DATE_FORMAT_EXAMPLES.datetime}`;
  if (format === 'time') return `a time of day, ${DATE_FORMAT_EXAMPLES.time}`;
  return 'ISO-8601 date';
}

function constraintsFor(field: FieldDefinition): JsonSchema {
  const v = field.validations;
  if (!v) return {};
  const numeric = field.type === 'Integer' || field.type === 'Number';
  const text = field.type === 'Symbol' || field.type === 'Text';
  // Usable options only, once each: a list stored before options were checked may hold anything.
  const options = normalizeOptions(v.in, field.type);
  return {
    // The stored values only: a label is what an editor picks by, not what is written.
    ...(options.length ? { enum: options.map(optionValue) } : {}),
    ...(numeric && v.range?.min !== undefined ? { minimum: v.range.min } : {}),
    ...(numeric && v.range?.max !== undefined ? { maximum: v.range.max } : {}),
    ...(text && v.size?.min !== undefined ? { minLength: v.size.min } : {}),
    ...(text && v.size?.max !== undefined ? { maxLength: v.size.max } : {}),
    ...(text && v.regexp ? { pattern: v.regexp.pattern } : {}),
  };
}

/** A single link to an asset: what a block's image becomes in the schema. */
const isAssetLink = (f: FieldDefinition) => f.type === 'Link' && f.linkType === 'Asset';

/**
 * Whether an image may fill the asset link `f`: no MIME rule, or one that takes some image type.
 * A link that only takes a PDF or a video is never offered an image.
 */
export function acceptsImages(f: FieldDefinition): boolean {
  const allowed = f.validations?.assetMimeTypes;
  return !allowed?.length || allowed.some((m) => m.toLowerCase().startsWith('image/'));
}

function assetRequestSchema(field: FieldDefinition, describe: Describe): JsonSchema {
  return {
    type: 'object',
    description: `${describe(field)}: an image from the asset library, asked for by what it shows`,
    properties: {
      [ASSET_REQUEST_KEY]: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'A few words describing the picture wanted, to search the library with',
            maxLength: 256,
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
    required: [ASSET_REQUEST_KEY],
    additionalProperties: false,
  };
}

/** One step down to a slot: a block of `variant` (its `_type`), and its slot `slot`. */
export interface SlotStep {
  readonly variant: string;
  readonly slot: string;
}

/** Where the blocks are generated: a blocks field's top level, or one slot of a block in it. */
export interface BlocksTarget {
  /** A top-level blocks field of the type. */
  readonly field: string;
  /**
   * The slot, as the steps from the field's top level to it: each ancestor block's `_type` and the
   * slot it sits in, then the parent block's `_type` and the slot to fill. Where the parent sits
   * decides its depth and its definition, not the first variant that shares its `_type`.
   */
  readonly slot?: readonly SlotStep[];
  /** Blocks the place holds already: the count bounds take them into account. */
  readonly held?: number;
}

export interface BlocksSchemaOptions {
  /** The rules in force (`effectiveBlockRules`); null or absent when no catalog targets the type. */
  readonly rules?: EffectiveBlockRules | null;
  /** The catalog's blocks, for their descriptions. */
  readonly catalog?: readonly BlockManifest[];
  readonly describe?: Describe;
  /** How a block is described to the model: its name and the catalog's description. */
  readonly describeBlock?: (block: { name: string; description?: string }) => string;
  /**
   * Images can be found in the asset library for this caller. Without it, no image is asked for,
   * and a block whose image is required is not offered.
   */
  readonly images?: boolean;
}

/** The bounds and list one place follows: the rules in force, else the content model's own. */
export interface PlaceRules {
  /** The block ids (variant apiIds) it takes, in order. */
  readonly allowed: readonly string[];
  readonly min?: number;
  readonly max?: number;
  readonly locked: boolean;
}

export type BlocksSchemaResult =
  | {
      readonly ok: true;
      /**
       * An object schema with one property, `blocks`: the array the model fills. Block shapes
       * that occur more than once are under its `$defs`, referenced as `#/$defs/<name>`.
       */
      readonly schema: JsonSchema;
      readonly place: PlaceRules;
      /** The blocks field that is the place: the top-level field, or the slot's definition. */
      readonly field: FieldDefinition;
      /** The block ids the schema offers: the place's, less any it can't fill. */
      readonly offered: readonly string[];
    }
  | {
      readonly ok: false;
      readonly code: 'not_a_blocks_field' | 'not_a_slot' | 'locked' | 'nothing_allowed' | 'full';
      readonly message: string;
    };

/**
 * The schema of the blocks to generate at `target`: one variant per block the place takes (its
 * `_type` a `const`), each with its scalar fields, image requests for its single Asset links, and
 * its slots recursing with their own allowed children down to {@link MAX_BLOCK_DEPTH}; the
 * place's `min` and `max` (less what it holds already) as `minItems` and `maxItems`. A shape that
 * occurs more than once is shared through `$defs` (see the module comment).
 *
 * A block with a required field the model isn't asked for (rich text, an entry link, a component,
 * a locked or empty slot, an image the caller can't search for) is not offered: every block in an
 * answer can then pass the save. Refused, with a reason, for a place that is locked, full, or
 * offers nothing.
 */
export function blocksSchemaFor(
  contentType: ContentType,
  target: BlocksTarget,
  options: BlocksSchemaOptions = {},
): BlocksSchemaResult {
  const top = contentType.fields.find((f) => f.apiId === target.field);
  if (!top || !blockVariants(top)) {
    return {
      ok: false,
      code: 'not_a_blocks_field',
      message: `"${target.field}" is not a blocks field of ${contentType.apiId}`,
    };
  }
  let field: FieldDefinition = top;
  let parentVariant: string | undefined;
  // `depth` is the component depth of the field holding the place's blocks: the top level is 1.
  let depth = 1;
  for (const step of target.slot ?? []) {
    const variant = variantNamed(blockVariants(field) ?? [], step.variant);
    const slot = variant?.fields.find((f) => f.apiId === step.slot);
    if (!variant || !slot || !blockVariants(slot)) {
      return {
        ok: false,
        code: 'not_a_slot',
        message: `"${step.slot}" is not a slot of the block "${step.variant}"`,
      };
    }
    field = slot;
    parentVariant = variant.apiId;
    depth += 1;
  }
  const place = placeRules(contentType.apiId, field, parentVariant, options.rules);
  if (place.locked) {
    return {
      ok: false,
      code: 'locked',
      message: 'The block rules lock this place: its blocks can’t be added to',
    };
  }
  const held = target.held ?? 0;
  const max = place.max === undefined ? undefined : place.max - held;
  if (max !== undefined && max <= 0) {
    return {
      ok: false,
      code: 'full',
      message: `This place holds ${place.max} blocks at most, and has ${held}`,
    };
  }
  const min = place.min === undefined ? undefined : Math.max(0, place.min - held);
  const shapes = new ShapeTable(target.field);
  const array = slotSchema(contentType.apiId, field, place, depth, options, shapes);
  if (!array) {
    return {
      ok: false,
      code: 'nothing_allowed',
      message: 'No block the model can fill can be placed here',
    };
  }
  const { value, defs } = shapes.finish({
    ...array.schema,
    ...(min ? { minItems: min } : {}),
    ...(max !== undefined ? { maxItems: max } : {}),
  });
  return {
    ok: true,
    place,
    field,
    offered: array.offered,
    schema: {
      type: 'object',
      properties: { blocks: value },
      required: ['blocks'],
      additionalProperties: false,
      ...(Object.keys(defs).length > 0 ? { $defs: defs } : {}),
    },
  };
}

/**
 * The blocks field `field`'s schema as one property of a draft's: the place's bounds, without the
 * `blocks` wrapper, and the shapes it shares, which belong under the draft schema's own `$defs`
 * (each is named for the field first, so two fields' shapes never collide). Undefined when the
 * field's top level is locked or offers nothing.
 */
export function blocksFieldSchema(
  contentType: ContentType,
  field: string,
  options: BlocksSchemaOptions = {},
):
  | { readonly schema: JsonSchema; readonly defs: Readonly<Record<string, JsonSchema>> }
  | undefined {
  const result = blocksSchemaFor(contentType, { field }, options);
  if (!result.ok) return undefined;
  return {
    schema: (result.schema.properties as Record<string, JsonSchema>).blocks as JsonSchema,
    defs: (result.schema.$defs as Record<string, JsonSchema> | undefined) ?? {},
  };
}

/**
 * The block shapes of one schema, each written once. A shape is recorded under a name (the
 * field's apiId and the block's, `body.card`, and a count after it when the same block takes
 * another shape at another depth) and every occurrence becomes a `$ref` to it; {@link finish}
 * then puts back inline each shape referenced only once, so a schema with nothing shared reads as
 * it always has. Shapes are compared by their JSON, their own slots already references, so the
 * comparison stays as small as one block.
 */
class ShapeTable {
  private readonly names = new Map<string, string>();
  private readonly shapes = new Map<string, JsonSchema>();

  constructor(private readonly prefix: string) {}

  /** A reference to `shape`, recorded under `apiId` the first time it is seen. */
  ref(apiId: string, shape: JsonSchema): JsonSchema {
    const json = JSON.stringify(shape);
    let name = this.names.get(json);
    if (!name) {
      const base = `${this.prefix}.${apiId}`;
      name = base;
      for (let n = 2; this.shapes.has(name); n++) name = `${base}.${n}`;
      this.names.set(json, name);
      this.shapes.set(name, shape);
    }
    return { $ref: `#/$defs/${name}` };
  }

  /** `value` with each shape used once inline, and the shapes used more than once. */
  finish(value: JsonSchema): { value: JsonSchema; defs: Record<string, JsonSchema> } {
    // Uses are counted from the root, each shared shape's own body once: a shape referenced from
    // a shared one is used once however often that one is.
    const uses = new Map<string, number>();
    const count = (node: unknown): void => {
      if (Array.isArray(node)) node.forEach(count);
      else if (node && typeof node === 'object') {
        const name = refName(node as JsonSchema);
        if (name !== undefined) {
          const seen = uses.get(name) ?? 0;
          uses.set(name, seen + 1);
          if (seen === 0) count(this.shapes.get(name));
        } else Object.values(node).forEach(count);
      }
    };
    count(value);
    const resolve = (node: unknown): unknown => {
      if (Array.isArray(node)) return node.map(resolve);
      if (!node || typeof node !== 'object') return node;
      const name = refName(node as JsonSchema);
      if (name !== undefined) return uses.get(name) === 1 ? resolve(this.shapes.get(name)) : node;
      return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, resolve(v)]));
    };
    const defs: Record<string, JsonSchema> = {};
    for (const [name, n] of uses) {
      if (n > 1) defs[name] = resolve(this.shapes.get(name)) as JsonSchema;
    }
    return { value: resolve(value) as JsonSchema, defs };
  }
}

const refName = (node: JsonSchema): string | undefined =>
  typeof node.$ref === 'string' && node.$ref.startsWith('#/$defs/')
    ? node.$ref.slice('#/$defs/'.length)
    : undefined;

/** A place's rules: the target's or the block's slot's in force, narrowed by the field's size. */
export function placeRules(
  contentTypeApiId: string,
  field: FieldDefinition,
  parentVariant: string | undefined,
  rules: EffectiveBlockRules | null | undefined,
): PlaceRules {
  const variants = blockVariants(field) ?? [];
  const own = field.validations?.size;
  let allowed = variants.map((v) => v.apiId);
  let min = own?.min;
  let max = own?.max;
  let locked = false;
  const fromRules =
    parentVariant === undefined
      ? rules?.targets.find(
          (t) => t.contentTypeApiId === contentTypeApiId && t.field === field.apiId,
        )
      : rules?.blocks.find((b) => b.block === parentVariant)?.slots[field.apiId];
  if (fromRules) {
    const list = 'blocks' in fromRules ? fromRules.blocks : fromRules.allowedChildren;
    const named = new Set(list);
    allowed = allowed.filter((id) => named.has(id));
    if (fromRules.min !== undefined) min = Math.max(min ?? 0, fromRules.min);
    if (fromRules.max !== undefined) max = Math.min(max ?? fromRules.max, fromRules.max);
    locked = fromRules.locked;
  }
  return {
    allowed,
    ...(min !== undefined && min > 0 ? { min } : {}),
    ...(max !== undefined ? { max } : {}),
    locked,
  };
}

/** The array schema of one place and the blocks it offers, or undefined when it offers none. */
function slotSchema(
  contentTypeApiId: string,
  field: FieldDefinition,
  place: PlaceRules,
  depth: number,
  options: BlocksSchemaOptions,
  table: ShapeTable,
): { schema: JsonSchema; offered: string[] } | undefined {
  const variants = (blockVariants(field) ?? []).filter((v) => place.allowed.includes(v.apiId));
  const offered: string[] = [];
  const shapes: JsonSchema[] = [];
  for (const v of variants) {
    const shape = variantSchema(contentTypeApiId, v, depth, options, table);
    if (!shape) continue;
    offered.push(v.apiId);
    shapes.push(table.ref(v.apiId, shape));
  }
  if (shapes.length === 0) return undefined;
  const describe = options.describe ?? ((f: FieldDefinition) => f.name);
  return {
    offered,
    schema: {
      type: 'array',
      description: describe(field),
      items: shapes.length === 1 ? shapes[0] : { anyOf: shapes },
    },
  };
}

/**
 * One block as an object: `_type` fixed, its scalar fields, its images, its open slots. Undefined
 * when a required field of it is one the model isn't asked for, so the block could never save.
 */
function variantSchema(
  contentTypeApiId: string,
  variant: ComponentVariant,
  depth: number,
  options: BlocksSchemaOptions,
  table: ShapeTable,
): JsonSchema | undefined {
  const describe = options.describe ?? ((f: FieldDefinition) => f.name);
  const manifest = options.catalog?.find((b) => b.id === variant.apiId);
  const described = options.describeBlock
    ? options.describeBlock({
        name: variant.name,
        ...(manifest?.description ? { description: manifest.description } : {}),
      })
    : variant.name;
  const properties: Record<string, JsonSchema> = {
    [BLOCK_TYPE_KEY]: { type: 'string', const: variant.apiId },
  };
  for (const f of variant.fields) {
    const filled = fieldSchema(contentTypeApiId, variant, f, depth, options, describe, table);
    if (filled) properties[f.apiId] = filled;
    else if (f.required) return undefined;
  }
  return {
    type: 'object',
    description: described,
    properties,
    // Strict structured output requires every property in `required`.
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

/** What the model is asked for one field of a block, or undefined when it isn't asked for it. */
function fieldSchema(
  contentTypeApiId: string,
  variant: ComponentVariant,
  f: FieldDefinition,
  depth: number,
  options: BlocksSchemaOptions,
  describe: Describe,
  table: ShapeTable,
): JsonSchema | undefined {
  const scalar = draftableFieldSchema(f, describe);
  if (scalar) return scalar;
  if (isAssetLink(f)) {
    return options.images && acceptsImages(f) ? assetRequestSchema(f, describe) : undefined;
  }
  if (!blockVariants(f) || depth >= MAX_BLOCK_DEPTH) return undefined;
  const place = placeRules(contentTypeApiId, f, variant.apiId, options.rules);
  // A locked slot is the developer's to fill; a new block leaves it empty.
  if (place.locked) return undefined;
  const array = slotSchema(contentTypeApiId, f, place, depth + 1, options, table);
  if (!array) return undefined;
  // A slot that must hold blocks is a required field: one empty would not save.
  const min = place.min ?? (f.required ? 1 : undefined);
  return {
    ...array.schema,
    ...(min ? { minItems: min } : {}),
    ...(place.max !== undefined ? { maxItems: place.max } : {}),
  };
}

// --- image requests ------------------------------------------------------------------------------

/** One image a generated tree asks for: where, what, and what the field takes. */
export interface AssetRequestSite {
  /** The path validation names the field by: `body[0].image`, `body[1].items[0].image`. */
  readonly path: string;
  readonly query: string;
  readonly required: boolean;
  /** The field's MIME rule, when it has one: the image found must be one of these. */
  readonly accepts?: readonly string[];
}

/** An image request the library had no answer for, by where it was asked. */
export interface UnresolvedImage {
  readonly path: string;
  readonly query: string;
  /** The field is required: the blocks can't be saved until an image is chosen for it. */
  readonly required?: true;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The query of an image request, when `value` is one. */
function requestQuery(value: unknown): string | undefined {
  if (!isObject(value)) return undefined;
  const req = value[ASSET_REQUEST_KEY];
  return isObject(req) && typeof req.query === 'string' ? req.query : undefined;
}

/**
 * Every image request in `blocks` (the blocks of the place `field`, numbered from `offset`, the
 * blocks it held already), walked by the content model: each block's variant, its Asset links and
 * its slots. A request anywhere else in the tree is not one the schema asked for and is not found.
 */
export function assetRequestSites(
  field: FieldDefinition,
  blocks: readonly unknown[],
  path: string,
  offset = 0,
): AssetRequestSite[] {
  const sites: AssetRequestSite[] = [];
  const walk = (f: FieldDefinition, items: readonly unknown[], at: string, from: number) => {
    const variants = blockVariants(f) ?? [];
    items.forEach((item, i) => {
      if (!isObject(item)) return;
      const variant = variants.find((v) => v.apiId === item[BLOCK_TYPE_KEY]);
      const here = `${at}[${from + i}]`;
      for (const nested of variant?.fields ?? []) {
        const value = item[nested.apiId];
        const query = isAssetLink(nested) ? requestQuery(value) : undefined;
        if (query !== undefined && query.trim() !== '') {
          const accepts = nested.validations?.assetMimeTypes;
          sites.push({
            path: `${here}.${nested.apiId}`,
            query: query.trim(),
            required: nested.required,
            ...(accepts?.length ? { accepts } : {}),
          });
        } else if (blockVariants(nested) && Array.isArray(value)) {
          walk(nested, value, `${here}.${nested.apiId}`, 0);
        }
      }
    });
  };
  walk(field, blocks, path, offset);
  return sites;
}

/**
 * A generated tree with each image request replaced by the asset `found` names for its path
 * (`{ id, linkType: 'Asset' }`), and the field left out where it names none, listed in
 * `unresolved`. Paths are numbered as {@link assetRequestSites} numbers them.
 */
export function resolveAssetRequests<T>(
  value: T,
  found: ReadonlyMap<string, string>,
  path: string,
  offset = 0,
): { readonly value: T; readonly unresolved: readonly UnresolvedImage[] } {
  const unresolved: UnresolvedImage[] = [];
  const walk = (v: unknown, at: string): unknown => {
    if (Array.isArray(v)) return v.map((item, i) => walk(item, `${at}[${i}]`));
    if (!isObject(v)) return v;
    const out: Record<string, unknown> = {};
    for (const [k, child] of Object.entries(v)) {
      const q = requestQuery(child);
      if (q === undefined) {
        out[k] = walk(child, `${at}.${k}`);
        continue;
      }
      const id = found.get(`${at}.${k}`);
      if (id) out[k] = { id, linkType: 'Asset' };
      else unresolved.push({ path: `${at}.${k}`, query: q });
    }
    return out;
  };
  const resolved = Array.isArray(value)
    ? value.map((item, i) => walk(item, `${path}[${offset + i}]`))
    : walk(value, path);
  return { value: resolved as T, unresolved };
}
