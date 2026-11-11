/**
 * The canvas editor's model of an entry (ROADMAP M6 "Canvas editor"): its blocks fields in one
 * locale as a tree of slots and blocks, and the block-patch ops (`block-patch.ts` in the domain)
 * that change it. A slot is a place blocks go: a top-level blocks field, or a blocks field a
 * block's variant declares (a slot from the block catalog). What a slot takes is its field's
 * variants, and how many its `validations.size`, exactly as validation reads them, narrowed by the
 * environment's block config (`cms/lib/block-rules.ts`) when it is given, so the canvas never
 * offers a block a save would refuse. A block already in a slot stays on it, whatever the config
 * says now: the config judges new placements, not stored content.
 *
 * Pure: the screen holds the fields and the history; this reads them and builds ops.
 */
import {
  BLOCK_KEY,
  BLOCK_TYPE_KEY,
  type BlockOp,
  type BlockPlace,
  type Breakpoint,
  blockVariants,
  type ComponentVariant,
  type ContentType,
  type EffectiveBlockRules,
  type EntryFields,
  type FieldDefinition,
  RESPONSIVE_KEY,
  variantOf,
} from '@contentworker/domain';
import { type FieldPathStep, formatFieldPath } from '@contentworker/sdk-core';
import {
  type BlockLockMark,
  inLongRun,
  type LockRegion,
  type LockView,
  lockView,
  sameRun,
} from '../block-locks';
import { ruleFor, type StoredSlots, slotPolicy, storedSlots, wasStored } from '../block-rules';
import { withOverride } from '../breakpoints';
import type { EntryBlockLock } from '../management';

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
  /** The blocks it holds by: every block the code lets the slot take, stored ones included. */
  readonly variants: readonly ComponentVariant[];
  /** The blocks a new one may be (the dock, a duplicate): `variants`, narrowed by the config. */
  readonly offers: readonly ComponentVariant[];
  /** Fewest and most, the field's own and the config's, whichever is tighter. */
  readonly min?: number;
  readonly max?: number;
  /** The field's own least, which validation holds every save to (the config's only edits). */
  readonly fieldMin?: number;
  readonly blocks: readonly CanvasBlock[];
  /** Holds as many as it may: nothing more goes in. */
  readonly full: boolean;
  /** The config locks it: no block goes in or out, and none moves (inside them is editable). */
  readonly locked: boolean;
  /**
   * The locked region it is inside (a block of it, locked with everything inside): as `locked`,
   * no block goes in or out and none moves, but it is the entry's lock, not the config's.
   */
  readonly sealedBy?: LockRegion;
  /**
   * The breakpoints its blocks' `responsive` props take overrides at: its field's own (a catalog
   * target's), else those of the slot holding its block; none, and its blocks take no overrides.
   */
  readonly breakpoints: readonly Breakpoint[];
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
  /** The locked region it is in or inside, when it is (`cms/lib/block-locks.ts`). */
  readonly lock?: BlockLockMark;
}

const LABEL_LENGTH = 48;

/** The block config a tree is drawn under: the rules in force, and the entry as it is stored. */
export interface CanvasRules {
  readonly rules: EffectiveBlockRules | null | undefined;
  /** The stored fields (undefined for an entry not yet saved): a lock holds only what's stored. */
  readonly stored: EntryFields | undefined;
  /** The entry's locked regions: their blocks keep their place, and nothing goes between them. */
  readonly locks?: readonly EntryBlockLock[];
}

/** What a slot is built under: the type, the config, and the stored slots in the locale. */
interface Under {
  readonly contentType: string;
  readonly rules: EffectiveBlockRules | null | undefined;
  readonly stored: StoredSlots;
  readonly locks: LockView;
}

/**
 * Every top-level blocks field of `contentType` as a slot tree, from `fields` in `locale` (a field
 * that isn't localized is read, and addressed, in `defaultLocale`). A block without a string `_key`
 * can't be addressed by an op, so it isn't on the canvas; a save keys it. Without `config`, every
 * slot takes what its field does and none is locked.
 */
export function canvasTree(
  contentType: Pick<ContentType, 'apiId' | 'fields'>,
  fields: EntryFields,
  locale: string,
  defaultLocale: string,
  config?: CanvasRules,
): CanvasSlot[] {
  const under: Under = {
    contentType: contentType.apiId,
    rules: config?.rules,
    stored: storedSlots(contentType, config?.stored, locale, defaultLocale),
    locks: lockView(contentType, config?.locks, fields, locale, defaultLocale),
  };
  return contentType.fields.flatMap((def) => {
    const variants = blockVariants(def);
    if (!variants) return [];
    const at = def.localized ? locale : defaultLocale;
    const value = (fields[def.apiId] as Record<string, unknown> | undefined)?.[at];
    return [
      buildSlot(
        def,
        variants,
        value,
        { field: def.apiId },
        def.apiId,
        [],
        at,
        0,
        under,
        [],
        undefined,
      ),
    ];
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
  under: Under,
  /** The breakpoints of the slot holding this one's block: what a field without its own takes. */
  inherited: readonly Breakpoint[],
  /** The catalog block holding this slot: its variant's apiId. */
  holder: string | undefined,
): CanvasSlot {
  const items = Array.isArray(value) ? value : [];
  const size = def.validations?.size;
  const rule = ruleFor(
    under.rules,
    address.parent && holder
      ? { block: holder, slot: address.parent.slot }
      : { contentType: under.contentType, field: address.field },
  );
  const policy = slotPolicy(
    variants,
    size,
    // A slot of a block the catalog doesn't place (a field modelled by hand) has no rule.
    address.parent && !holder ? undefined : rule,
    wasStored(under.stored, {
      field: address.field,
      ...(address.parent ? { parentKey: address.parent.key } : {}),
    }),
  );
  const blocks: CanvasBlock[] = [];
  const parentLock = address.parent ? under.locks.marks.get(address.parent.key) : undefined;
  const slot: CanvasSlot = {
    address,
    path: formatFieldPath({ field, steps }),
    name: def.name,
    ...(def.help ? { help: def.help } : {}),
    locale,
    variants,
    offers: policy.offers,
    ...(policy.min !== undefined ? { min: policy.min } : {}),
    ...(policy.max !== undefined ? { max: policy.max } : {}),
    ...(size?.min !== undefined ? { fieldMin: size.min } : {}),
    blocks,
    full: policy.max !== undefined && items.length >= policy.max,
    locked: policy.locked,
    ...(parentLock?.sealed ? { sealedBy: parentLock.region } : {}),
    breakpoints: Array.isArray(def.items?.breakpoints) ? def.items.breakpoints : inherited,
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
          under,
          slot.breakpoints,
          variant?.apiId,
        ),
      ];
    });
    const label = variant ? labelOf(variant, block) : undefined;
    const lock = under.locks.marks.get(key);
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
      ...(lock ? { lock } : {}),
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

/**
 * How full a slot is, in words: "0 of 2–4" when it takes a range, "3 of 8" with a most only,
 * "full, 8 of 8" at its most, "1 block, needs 2" with a least only, "3 blocks" with neither.
 */
export function slotCount(slot: CanvasSlot): string {
  const n = slot.blocks.length;
  const { min, max } = slot;
  if (slot.full) return `full, ${n} of ${max}`;
  if (max !== undefined) {
    return min !== undefined && min > 0 && min !== max ? `${n} of ${min}–${max}` : `${n} of ${max}`;
  }
  const blocks = `${n} ${n === 1 ? 'block' : 'blocks'}`;
  return min !== undefined && n < min ? `${blocks}, needs ${min}` : blocks;
}

/**
 * A seam's (and a slot's) words: the slot's name and how full it is ("Main · 3 of 8"), and
 * "locked" when the config locks it or it is inside a locked region ("Main · 3 of 8 · locked").
 */
export function slotFill(slot: CanvasSlot): string {
  return `${slot.name} · ${slotCount(slot)}${slotHeld(slot) ? ' · locked' : ''}`;
}

/** Whether no block goes in or out of `slot`, and none moves: the config's lock, or a region's. */
export const slotHeld = (slot: CanvasSlot): boolean => slot.locked || !!slot.sealedBy;

/** Whether `block` keeps its place: in a held slot, or one of a locked region's own blocks. */
export const keepsPlace = (block: CanvasBlock): boolean =>
  slotHeld(block.slot) || !!block.lock?.own;

/**
 * Whether `block` can move by one place in its slot: not at that end, not keeping its place, and
 * not past a block of a locked run of more than one (it would land inside the run).
 */
export function canMove(block: CanvasBlock, by: -1 | 1): boolean {
  const sibling = block.slot.blocks[block.index + by];
  if (!sibling || keepsPlace(block)) return false;
  return !inLongRun(lockOf(block.slot), sibling.key);
}

/** Whether `block` can leave its slot (a remove): not one that keeps its place. */
export function canRemove(block: CanvasBlock): boolean {
  return !keepsPlace(block);
}

/**
 * Whether `block` can be duplicated: it doesn't keep its place, its slot isn't full, and a new
 * block of its kind may go there (a copy is placed, so the config judges it as an insert).
 */
export function canDuplicate(block: CanvasBlock): boolean {
  const { slot, variant } = block;
  return (
    !!variant &&
    !keepsPlace(block) &&
    !slot.full &&
    slot.offers.some((v) => v.apiId === variant.apiId)
  );
}

/** The blocks of a slot as a lock view, for asking whether two neighbours are of one run. */
const lockOf = (slot: CanvasSlot): LockView => ({
  regions: [],
  marks: new Map(slot.blocks.flatMap((b) => (b.lock ? [[b.key, b.lock] as const] : []))),
});

/**
 * The locked region a new block at `place` would break into: the slot's own (inside a region
 * locked with everything inside), or the run either side of it. Undefined when a block may go.
 */
export function placeLockedBy(place: CanvasPlace): LockRegion | undefined {
  const { slot, index } = place;
  if (slot.sealedBy) return slot.sealedBy;
  const before = slot.blocks[index - 1];
  const after = slot.blocks[index];
  return sameRun(lockOf(slot), before?.key, after?.key) ? before?.lock?.region : undefined;
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

/**
 * An `update` op giving `prop` its own value at breakpoint `bp` (or, with `value` undefined,
 * taking it away so it inherits again). It sets `_responsive` whole, as an `update` must: an
 * emptied breakpoint is left out, and an emptied map unsets the key.
 */
export function setOverrideOp(
  block: CanvasBlock,
  bp: string,
  prop: string,
  value: unknown,
): BlockOp {
  return setPropOp(
    block,
    RESPONSIVE_KEY,
    withOverride(block.value[RESPONSIVE_KEY], bp, prop, value),
  );
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

/**
 * The blocks from `anchor` to `focus`, in page order, when both are in one slot: a run to lock
 * (shift-click, or Shift with ↑ ↓). Otherwise the focused block alone.
 */
export function runBetween(
  slots: readonly CanvasSlot[],
  anchor: string | null,
  focus: string | null,
): CanvasBlock[] {
  const to = focus ? findBlock(slots, focus) : undefined;
  if (!to) return [];
  const from = anchor ? findBlock(slots, anchor) : undefined;
  if (!from || from.slot.path !== to.slot.path) return [to];
  const [lo, hi] = from.index <= to.index ? [from.index, to.index] : [to.index, from.index];
  return to.slot.blocks.slice(lo, hi + 1);
}
