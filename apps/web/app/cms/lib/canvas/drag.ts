/**
 * Moving a block to a place on the canvas: by dragging it to a seam with a fine pointer, or from
 * the inspector's Move to (the keyboard's and a finger's way to another slot). Both ask
 * `judgeDrop`, which holds a move to the same judgement the dock and the save use: the slot's
 * blocks (its variants, which a catalog push writes from `allowedChildren` and `allowedParents`)
 * narrowed by the block config (`CanvasSlot.offers`, from `/block-config/effective`), its counts,
 * its lock and the entry's locked regions. What passes is one undoable step: `configRefusal` then
 * judges the result as the save will (`blockConfigIssues`), so a rule the slot policy can't see
 * still refuses the drop before it lands.
 *
 * Within one blocks field the step is one `move` op. A block-patch `move` is its field's, so into
 * another top-level blocks field it is a `remove` from this one and an `insert` into that one,
 * carrying the block whole (its keys, its overrides, the blocks inside it). One patch applies its
 * ops all or none, and undo inverts the pair as one step; the canvas saves the whole draft in one
 * request held to `expectedVersion`, as `patchBlocks` would the pair. Another field is refused when
 * the move couldn't keep the block as it is: a field of the other kind (localized, or not), one
 * whose block of that type is another definition, one already holding one of its keys, or one
 * without the breakpoints its overrides are set at (the save would drop them).
 *
 * A move may leave the slot it came from short of its least, as a remove may: the checks say so,
 * and the save waits for it, as the API's own block patch does.
 *
 * Pure: the screen holds the pointer and the history.
 */
import type { BlockConfigIssue, BlockOp, EntryFields } from '@contentworker/domain';
import { overridesOf } from '../breakpoints';
import {
  blockPlace,
  type CanvasBlock,
  type CanvasPlace,
  type CanvasSlot,
  flattenBlocks,
  flattenSlots,
  insertOp,
  keepsPlace,
  placeLockedBy,
  removeOp,
  slotHeld,
} from './model';

export type DropVerdict =
  /**
   * It may go there: the ops that move it (one `move`, or a `remove` and an `insert` into another
   * field), applied as one step, and what it did, for the live region and undo.
   */
  | { readonly kind: 'move'; readonly ops: readonly BlockOp[]; readonly label: string }
  /** That is where it already is: dropping there changes nothing. */
  | { readonly kind: 'home' }
  /** It can't go there, in the words the canvas says it with. */
  | { readonly kind: 'refused'; readonly reason: string };

/** Whether `block` can be picked up at all: one that keeps its place, or that code removed, can't. */
export function canDrag(block: CanvasBlock): boolean {
  return !!block.variant && !keepsPlace(block);
}

/** `slots` is the whole tree, which a move into another field is judged against too. */
export function judgeDrop(
  block: CanvasBlock,
  place: CanvasPlace,
  slots: readonly CanvasSlot[],
): DropVerdict {
  const { slot, index } = place;
  const from = block.slot;
  const same = slot.path === from.path;
  const across = slot.address.field !== from.address.field;
  if (same && (index === block.index || index === block.index + 1)) return { kind: 'home' };
  if (!block.variant) {
    return { kind: 'refused', reason: `${block.name} was removed from code, so it can’t move` };
  }
  if (keepsPlace(block)) {
    return {
      kind: 'refused',
      reason: block.lock
        ? `${block.name} is locked: it keeps its place`
        : `${from.name} is locked: ${block.name} keeps its place`,
    };
  }
  if (across && slot.localized !== from.localized) {
    return {
      kind: 'refused',
      reason: slot.localized
        ? `${slot.name} is translated and ${from.name} isn’t: add a new ${block.name} there`
        : `${from.name} is translated and ${slot.name} isn’t: add a new ${block.name} there`,
    };
  }
  if (flattenSlots(block.slots).some((s) => s.path === slot.path)) {
    return { kind: 'refused', reason: `${block.name} can’t go inside itself` };
  }
  if (slotHeld(slot)) return { kind: 'refused', reason: `${slot.name} is locked` };
  if (placeLockedBy(place)) {
    return { kind: 'refused', reason: 'That place is inside a locked region' };
  }
  if (!same) {
    const variant = block.variant;
    if (!slot.variants.some((v) => v.apiId === variant.apiId)) {
      return { kind: 'refused', reason: `${slot.name} doesn’t take ${block.name}` };
    }
    if (!slot.offers.some((v) => v.apiId === variant.apiId)) {
      return {
        kind: 'refused',
        reason: `The block config doesn’t allow ${block.name} in ${slot.name}`,
      };
    }
    if (slot.full) {
      return { kind: 'refused', reason: `${slot.name} is full (${slot.max ?? 0} at most)` };
    }
  }
  const label = same
    ? `Moved ${block.name} ${index < block.index ? 'up' : 'down'}`
    : `Moved ${block.name} to ${slot.name}`;
  if (across) {
    const reason = acrossRefusal(block, slot, slots);
    if (reason) return { kind: 'refused', reason };
    // The block goes whole, every key on it and inside it kept, so undo and the page see the same
    // blocks; a remove first, so nothing of it is in two places even for an op.
    return { kind: 'move', ops: [removeOp(block), insertOp(place, { ...block.value })], label };
  }
  const op: BlockOp = {
    op: 'move',
    field: from.address.field,
    locale: from.locale,
    key: block.key,
    to: blockPlace(place),
  };
  return { kind: 'move', ops: [op], label };
}

/**
 * Why `block` can't go into `slot` of another top-level blocks field as it is, or undefined. Its
 * variant there must be the same definition as here (the same apiId can be modelled apart by
 * hand), no block of that field may hold one of its keys (an insert keeps them, and a key is
 * unique within its field), and every breakpoint it (or a block inside it) holds overrides at must
 * be one that field declares, or the save would drop them.
 */
function acrossRefusal(
  block: CanvasBlock,
  slot: CanvasSlot,
  slots: readonly CanvasSlot[],
): string | undefined {
  const variant = block.variant;
  const there = slot.variants.find((v) => v.apiId === variant?.apiId);
  if (!variant || !there || JSON.stringify(there) !== JSON.stringify(variant)) {
    return `${slot.name}’s ${block.name} is set up differently: add a new one there`;
  }
  const moved = [block, ...flattenBlocks(block.slots)];
  const root = slots.find((s) => s.address.field === slot.address.field && !s.address.parent);
  const held = new Set(root ? flattenBlocks([root]).map((b) => b.key) : []);
  if (moved.some((b) => held.has(b.key))) {
    return `${slot.name} already has a copy of this ${block.name}: add a new one there`;
  }
  const declared = new Set(slot.breakpoints.map((b) => b.id));
  const stranded = moved.some((b) =>
    Object.keys(overridesOf(b.value)).some((id) => !declared.has(id)),
  );
  if (stranded) {
    return `${slot.name} doesn’t take ${block.name}’s per-width settings: they’d be lost`;
  }
  return undefined;
}

/**
 * The places `block` may move to, one per other slot (at its end), for Move to: every slot, in its
 * blocks field or another, that `judgeDrop` lets it into. Its own slot isn't one (↑ ↓ move it there).
 */
export function moveTargets(
  slots: readonly CanvasSlot[],
  block: CanvasBlock,
): { readonly slot: CanvasSlot; readonly ops: readonly BlockOp[]; readonly label: string }[] {
  if (!canDrag(block)) return [];
  return flattenSlots(slots).flatMap((slot) => {
    if (slot.path === block.slot.path) return [];
    const verdict = judgeDrop(block, { slot, index: slot.blocks.length }, slots);
    return verdict.kind === 'move' ? [{ slot, ops: verdict.ops, label: verdict.label }] : [];
  });
}

/**
 * What the block config (or a locked region) refuses of a move that the slot policy let through:
 * an issue the moved fields raise more often than the fields before it, judged by `issuesOf` (the
 * canvas's `configIssues`, as the save is judged). Issues are told apart by code, block and locale,
 * never by path: a path is positional (`body[2].items`), so a move renames the issues it passes.
 * Undefined when it adds none.
 */
export function configRefusal(
  issuesOf: (fields: EntryFields) => readonly BlockConfigIssue[],
  before: EntryFields,
  after: EntryFields,
): BlockConfigIssue | undefined {
  const id = (i: BlockConfigIssue) => `${i.code}\u0000${i.key ?? ''}\u0000${i.locale ?? ''}`;
  const had = new Map<string, number>();
  for (const i of issuesOf(before)) had.set(id(i), (had.get(id(i)) ?? 0) + 1);
  return issuesOf(after).find((i) => {
    const left = had.get(id(i)) ?? 0;
    had.set(id(i), left - 1);
    return left <= 0;
  });
}
