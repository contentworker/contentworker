/**
 * The canvas editor's model of an entry (ROADMAP M6 "Canvas editor"): its blocks fields in one
 * locale as a tree of slots and blocks, and the block-patch ops (`block-patch.ts` in the domain)
 * that change it. A slot is a place blocks go: a top-level blocks field, or a blocks field a
 * block's variant declares (a slot from the block catalog). What a slot takes is its field's
 * variants, and how many its `validations.size`, exactly as validation reads them, so the canvas
 * never offers a block a save would refuse.
 *
 * Pure: the screen holds the fields and the history; this reads them and builds ops.
 */
import {
  BLOCK_KEY,
  BLOCK_TYPE_KEY,
  type BlockOp,
  type BlockPlace,
  blockVariants,
  type ComponentVariant,
  type ContentType,
  type EntryFields,
  type FieldDefinition,
  variantOf,
} from '@contentworker/domain';
import { type FieldPathStep, formatFieldPath } from '@contentworker/sdk-core';

/** Where a slot is: a top-level blocks field, or a slot of the block keyed `parent.key`. */
export interface SlotAddress {
  readonly field: string;
  readonly parent?: { readonly key: string; readonly slot: string };
}

export interface CanvasSlot {
  readonly address: SlotAddress;
  /** Its field path, as a ref writes it: `body`, `body[k1].items`. */
  readonly path: string;
  /** The field's (or the catalog slot's) name. */
  readonly name: string;
  readonly help?: string;
  /** The locale its ops address: the edited one when the top-level field is localized. */
  readonly locale: string;
  /** The blocks it takes. */
  readonly variants: readonly ComponentVariant[];
  readonly min?: number;
  readonly max?: number;
  readonly blocks: readonly CanvasBlock[];
  /** Holds as many as it may: nothing more goes in. */
  readonly full: boolean;
}

export interface CanvasBlock {
  readonly key: string;
  readonly type: string;
  /** Its variant's name, or its `_type` when the slot no longer has that block. */
  readonly name: string;
  /** Its first non-empty text, shortened: what an editor calls it. */
  readonly label?: string;
  /** Its variant; absent when the block was removed from the slot's blocks (from code). */
  readonly variant?: ComponentVariant;
  readonly slot: CanvasSlot;
  readonly index: number;
  /** 0 at the top level. */
  readonly depth: number;
  readonly value: Readonly<Record<string, unknown>>;
  /** Its own slots, in the variant's order. */
  readonly slots: readonly CanvasSlot[];
}

const LABEL_LENGTH = 48;

/**
 * Every top-level blocks field of `contentType` as a slot tree, from `fields` in `locale` (a field
 * that isn't localized is read, and addressed, in `defaultLocale`). A block without a string `_key`
 * can't be addressed by an op, so it isn't on the canvas; a save keys it.
 */
export function canvasTree(
  contentType: Pick<ContentType, 'fields'>,
  fields: EntryFields,
  locale: string,
  defaultLocale: string,
): CanvasSlot[] {
  return contentType.fields.flatMap((def) => {
    const variants = blockVariants(def);
    if (!variants) return [];
    const at = def.localized ? locale : defaultLocale;
    const value = (fields[def.apiId] as Record<string, unknown> | undefined)?.[at];
    return [buildSlot(def, variants, value, { field: def.apiId }, def.apiId, [], at, 0)];
  });
}

function buildSlot(
  def: FieldDefinition,
  variants: readonly ComponentVariant[],
  value: unknown,
  address: SlotAddress,
  field: string,
  steps: readonly FieldPathStep[],
  locale: string,
  depth: number,
): CanvasSlot {
  const items = Array.isArray(value) ? value : [];
  const size = def.validations?.size;
  const blocks: CanvasBlock[] = [];
  const slot: CanvasSlot = {
    address,
    path: formatFieldPath({ field, steps }),
    name: def.name,
    ...(def.help ? { help: def.help } : {}),
    locale,
    variants,
    ...(size?.min !== undefined ? { min: size.min } : {}),
    ...(size?.max !== undefined ? { max: size.max } : {}),
    blocks,
    full: size?.max !== undefined && items.length >= size.max,
  };
  items.forEach((item) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return;
    const block = item as Record<string, unknown>;
    const key = block[BLOCK_KEY];
    if (typeof key !== 'string' || key === '') return;
    const type = typeof block[BLOCK_TYPE_KEY] === 'string' ? String(block[BLOCK_TYPE_KEY]) : '';
    const variant = variantOf(variants, block);
    const own = [...steps, { key }];
    const slots = (variant?.fields ?? []).flatMap((f) => {
      const nested = blockVariants(f);
      if (!nested) return [];
      return [
        buildSlot(
          f,
          nested,
          block[f.apiId],
          { field: address.field, parent: { key, slot: f.apiId } },
          field,
          [...own, { field: f.apiId }],
          locale,
          depth + 1,
        ),
      ];
    });
    const label = variant ? labelOf(variant, block) : undefined;
    blocks.push({
      key,
      type,
      name: variant?.name ?? (type || 'Block'),
      ...(label ? { label } : {}),
      ...(variant ? { variant } : {}),
      slot,
      index: blocks.length,
      depth,
      value: block,
      slots,
    });
  });
  return slot;
}

function labelOf(variant: ComponentVariant, block: Record<string, unknown>): string | undefined {
  for (const f of variant.fields) {
    if (f.type !== 'Symbol' && f.type !== 'Text') continue;
    const value = block[f.apiId];
    if (typeof value !== 'string' || value.trim() === '') continue;
    const text = value.trim().replace(/\s+/g, ' ');
    return text.length > LABEL_LENGTH ? `${text.slice(0, LABEL_LENGTH - 1)}…` : text;
  }
  return undefined;
}

/** Every block in the tree, depth first in page order: the order arrows move through. */
export function flattenBlocks(slots: readonly CanvasSlot[]): CanvasBlock[] {
  const out: CanvasBlock[] = [];
  const walk = (slot: CanvasSlot) => {
    for (const b of slot.blocks) {
      out.push(b);
      b.slots.forEach(walk);
    }
  };
  slots.forEach(walk);
  return out;
}

/** Every slot in the tree, top-level first then each block's, in page order. */
export function flattenSlots(slots: readonly CanvasSlot[]): CanvasSlot[] {
  const out: CanvasSlot[] = [];
  const walk = (slot: CanvasSlot) => {
    out.push(slot);
    for (const b of slot.blocks) b.slots.forEach(walk);
  };
  slots.forEach(walk);
  return out;
}

export function findBlock(slots: readonly CanvasSlot[], key: string): CanvasBlock | undefined {
  return flattenBlocks(slots).find((b) => b.key === key);
}

export function findSlot(slots: readonly CanvasSlot[], path: string): CanvasSlot | undefined {
  return flattenSlots(slots).find((s) => s.path === path);
}

/** The block holding `block` in one of its slots, or undefined at the top level. */
export function parentBlock(
  slots: readonly CanvasSlot[],
  block: CanvasBlock,
): CanvasBlock | undefined {
  const key = block.slot.address.parent?.key;
  return key ? findBlock(slots, key) : undefined;
}

/** "Main · 3 of 8", "Main · 3 blocks", or "Main · full, 8 of 8": a seam's words. */
export function slotFill(slot: CanvasSlot): string {
  const n = slot.blocks.length;
  if (slot.max !== undefined) {
    return slot.full
      ? `${slot.name} · full, ${n} of ${slot.max}`
      : `${slot.name} · ${n} of ${slot.max}`;
  }
  return `${slot.name} · ${n} ${n === 1 ? 'block' : 'blocks'}`;
}

/** A place in a slot: where a seam is (before or after a block by key, or an index). */
export interface CanvasPlace {
  readonly slot: CanvasSlot;
  /** The index a new block takes: 0 before the first, `blocks.length` after the last. */
  readonly index: number;
}

/** The place right after `block`, or the end of the first slot when nothing is selected. */
export function placeAfter(
  slots: readonly CanvasSlot[],
  block: CanvasBlock | undefined,
): CanvasPlace | undefined {
  if (block) return { slot: block.slot, index: block.index + 1 };
  const first = slots[0];
  return first ? { slot: first, index: first.blocks.length } : undefined;
}

/** The op's position for `place`, by the neighbours' keys (a key stays put when others move). */
export function blockPlace(place: CanvasPlace): BlockPlace {
  const { slot, index } = place;
  const parent = slot.address.parent ? { parent: slot.address.parent } : {};
  const before = slot.blocks[index - 1];
  if (before) return { ...parent, after: before.key };
  const next = slot.blocks[index];
  if (next) return { ...parent, before: next.key };
  return { ...parent, index: 0 };
}

/**
 * A new block of `variant`, starting from its fields' defaults, keyed here so the page addresses
 * it before it is saved (a save keeps a key it is given).
 */
export function newBlock(variant: ComponentVariant, newKey: () => string): Record<string, unknown> {
  const block: Record<string, unknown> = {
    [BLOCK_TYPE_KEY]: variant.apiId,
    [BLOCK_KEY]: newKey(),
  };
  for (const f of variant.fields) {
    if (f.defaultValue !== undefined) block[f.apiId] = f.defaultValue;
  }
  return block;
}

export function insertOp(place: CanvasPlace, block: Record<string, unknown>): BlockOp {
  return {
    op: 'insert',
    field: place.slot.address.field,
    locale: place.slot.locale,
    block,
    ...blockPlace(place),
  };
}

/** Moves `block` one place up or down in its slot; undefined at that end. */
export function moveOp(block: CanvasBlock, by: -1 | 1): BlockOp | undefined {
  const sibling = block.slot.blocks[block.index + by];
  if (!sibling) return undefined;
  const parent = block.slot.address.parent ? { parent: block.slot.address.parent } : {};
  return {
    op: 'move',
    field: block.slot.address.field,
    locale: block.slot.locale,
    key: block.key,
    to: by < 0 ? { ...parent, before: sibling.key } : { ...parent, after: sibling.key },
  };
}

export function removeOp(block: CanvasBlock): BlockOp {
  return {
    op: 'remove',
    field: block.slot.address.field,
    locale: block.slot.locale,
    key: block.key,
  };
}

export function duplicateOp(block: CanvasBlock): BlockOp {
  return {
    op: 'duplicate',
    field: block.slot.address.field,
    locale: block.slot.locale,
    key: block.key,
  };
}

/** Sets one prop of `block` (`undefined` clears it). */
export function setPropOp(block: CanvasBlock, prop: string, value: unknown): BlockOp {
  return {
    op: 'update',
    field: block.slot.address.field,
    locale: block.slot.locale,
    key: block.key,
    ...(value === undefined ? { unset: [prop] } : { set: { [prop]: value } }),
  };
}

/** Whether a type can open on the canvas: it frames the type's preview URL and edits its blocks. */
export function canvasAvailable(
  contentType: Pick<ContentType, 'fields' | 'preview'> | undefined,
): boolean {
  return (
    !!contentType?.preview?.urlTemplate &&
    contentType.fields.some((f) => blockVariants(f) !== undefined)
  );
}
