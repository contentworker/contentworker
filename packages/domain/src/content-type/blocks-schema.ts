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
  MAX_COMPONENT_DEPTH,
  normalizeOptions,
  optionValue,
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
 * Left out of a block (the save judges them, and a required one makes the result refused): rich
 * text, entry links, lists of links, plain components and repeaters, JSON, locations. A slot the
 * rules lock is left out of a new block too: its blocks are the developer's to place.
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

/** Where the blocks are generated: a blocks field's top level, or one slot of a block in it. */
export interface BlocksTarget {
  /** A top-level blocks field of the type. */
  readonly field: string;
  /** The slot of a block: the block's variant (`_type`) and the slot's apiId. */
  readonly parent?: { readonly variant: string; readonly slot: string };
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
      /** An object schema with one property, `blocks`: the array the model fills. */
      readonly schema: JsonSchema;
      readonly place: PlaceRules;
    }
  | {
      readonly ok: false;
      readonly code: 'not_a_blocks_field' | 'not_a_slot' | 'locked' | 'nothing_allowed' | 'full';
      readonly message: string;
    };

/**
 * The schema of the blocks to generate at `target`: one variant per block the place takes (its
 * `_type` a `const`), each with its scalar fields, image requests for its single Asset links, and
 * its slots recursing with their own allowed children down to {@link MAX_COMPONENT_DEPTH}; the
 * place's `min` and `max` (less what it holds already) as `minItems` and `maxItems`. Refused, with
 * a reason, for a place that is locked, takes nothing, or is full.
 */
export function blocksSchemaFor(
  contentType: ContentType,
  target: BlocksTarget,
  options: BlocksSchemaOptions = {},
): BlocksSchemaResult {
  const top = contentType.fields.find((f) => f.apiId === target.field);
  const topVariants = top ? blockVariants(top) : undefined;
  if (!top || !topVariants) {
    return {
      ok: false,
      code: 'not_a_blocks_field',
      message: `"${target.field}" is not a blocks field of ${contentType.apiId}`,
    };
  }
  let field: FieldDefinition = top;
  let place = placeRules(contentType.apiId, top, undefined, options.rules);
  // The slot is the top-level field's when it's a top-level variant's: blocks fields nest, and a
  // slot's own variants are what the content model expanded the catalog's children into.
  let depth = 1;
  if (target.parent) {
    const variant = findVariant(top, target.parent.variant);
    const slot = variant?.v.fields.find((f) => f.apiId === target.parent?.slot);
    if (!variant || !slot || !blockVariants(slot)) {
      return {
        ok: false,
        code: 'not_a_slot',
        message: `"${target.parent.slot}" is not a slot of the block "${target.parent.variant}"`,
      };
    }
    field = slot;
    depth = variant.depth + 1;
    place = placeRules(contentType.apiId, slot, target.parent.variant, options.rules);
  }
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
  const array = slotSchema(contentType.apiId, field, place, depth, options);
  if (!array) {
    return { ok: false, code: 'nothing_allowed', message: 'No block can be placed here' };
  }
  return {
    ok: true,
    place,
    schema: {
      type: 'object',
      properties: {
        blocks: {
          ...array,
          ...(min ? { minItems: min } : {}),
          ...(max !== undefined ? { maxItems: max } : {}),
        },
      },
      required: ['blocks'],
      additionalProperties: false,
    },
  };
}

/**
 * The blocks field `field`'s schema as one property of a draft's: the place's bounds, without the
 * `blocks` wrapper. Undefined when the field's top level is locked or takes nothing.
 */
export function blocksFieldSchema(
  contentType: ContentType,
  field: string,
  options: BlocksSchemaOptions = {},
): JsonSchema | undefined {
  const result = blocksSchemaFor(contentType, { field }, options);
  if (!result.ok) return undefined;
  return (result.schema.properties as Record<string, JsonSchema>).blocks;
}

/** The variant `id` of the blocks field `field`, searched down its slots, with its depth. */
function findVariant(
  field: FieldDefinition,
  id: string,
  depth = 1,
): { v: ComponentVariant; depth: number } | undefined {
  const variants = blockVariants(field) ?? [];
  const hit = variants.find((v) => v.apiId === id);
  if (hit) return { v: hit, depth };
  if (depth >= MAX_COMPONENT_DEPTH) return undefined;
  for (const v of variants) {
    for (const f of v.fields) {
      if (!blockVariants(f)) continue;
      const found = findVariant(f, id, depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}

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

/** The array schema of one place, or undefined when it takes no block. */
function slotSchema(
  contentTypeApiId: string,
  field: FieldDefinition,
  place: PlaceRules,
  depth: number,
  options: BlocksSchemaOptions,
): JsonSchema | undefined {
  const variants = (blockVariants(field) ?? []).filter((v) => place.allowed.includes(v.apiId));
  const shapes = variants.map((v) => variantSchema(contentTypeApiId, v, depth, options));
  if (shapes.length === 0) return undefined;
  const describe = options.describe ?? ((f: FieldDefinition) => f.name);
  return {
    type: 'array',
    description: describe(field),
    items: shapes.length === 1 ? shapes[0] : { anyOf: shapes },
  };
}

/** One block as an object: `_type` fixed, its scalar fields, its images, its open slots. */
function variantSchema(
  contentTypeApiId: string,
  variant: ComponentVariant,
  depth: number,
  options: BlocksSchemaOptions,
): JsonSchema {
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
    const scalar = draftableFieldSchema(f, describe);
    if (scalar) {
      properties[f.apiId] = scalar;
    } else if (isAssetLink(f)) {
      properties[f.apiId] = assetRequestSchema(f, describe);
    } else if (blockVariants(f) && depth < MAX_COMPONENT_DEPTH) {
      const place = placeRules(contentTypeApiId, f, variant.apiId, options.rules);
      // A locked slot is the developer's to fill; a new block leaves it empty.
      if (place.locked) continue;
      const array = slotSchema(contentTypeApiId, f, place, depth + 1, options);
      if (!array) continue;
      properties[f.apiId] = {
        ...array,
        ...(place.min ? { minItems: place.min } : {}),
        ...(place.max !== undefined ? { maxItems: place.max } : {}),
      };
    }
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

// --- image requests ------------------------------------------------------------------------------

/** An image request the library had no answer for, by where it was asked. */
export interface UnresolvedImage {
  /** The path validation names the field by: `body[0].image`, `body[1].items[0].image`. */
  readonly path: string;
  readonly query: string;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The query of an image request, when `value` is one. */
function requestQuery(value: unknown): string | undefined {
  if (!isObject(value)) return undefined;
  const req = value[ASSET_REQUEST_KEY];
  return isObject(req) && typeof req.query === 'string' ? req.query : undefined;
}

/** Every image request's query in a generated tree, once each, in the order they appear. */
export function assetRequestsIn(value: unknown): string[] {
  const found = new Set<string>();
  const walk = (v: unknown): void => {
    const q = requestQuery(v);
    if (q !== undefined) {
      found.add(q.trim());
      return;
    }
    if (Array.isArray(v)) v.forEach(walk);
    else if (isObject(v)) Object.values(v).forEach(walk);
  };
  walk(value);
  return [...found].filter((q) => q !== '');
}

/**
 * A generated tree with each image request replaced by the asset `found` names for its query
 * (`{ id, linkType: 'Asset' }`), and the field left out where it names none, listed in
 * `unresolved` by path. `path` is where the tree sits (`body`, `body[2].items`); its blocks are
 * numbered from `offset` (the blocks the place holds already).
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
      const id = found.get(q.trim());
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
