/**
 * Moving a block to a place on the canvas: by dragging it to a seam with a fine pointer, or from
 * the inspector's Move to (the keyboard's and a finger's way to another slot). Both ask
 * `judgeDrop`, which holds a move to the same judgement the dock and the save use: the slot's
 * blocks (its variants, which a catalog push writes from `allowedChildren` and `allowedParents`)
 * narrowed by the block config (`CanvasSlot.offers`, from `/block-config/effective`), its counts,
 * its lock and the entry's locked regions. What passes is one `move` block-patch op, which undo
 * inverts; `configRefusal` then judges the result as the save will (`blockConfigIssues`), so a
 * rule the slot policy can't see still refuses the drop before it lands.
 *
 * A move stays within the blocks field it started in (a block-patch `move` is the field's): a
 * place in another top-level field is refused, and says so.
 *
 * A move may leave the slot it came from short of its least, as a remove may: the checks say so,
 * and the save waits for it, as the API's own block patch does.
 *
 * Pure: the screen holds the pointer and the history.
 */
import type { BlockConfigIssue, BlockOp, EntryFields } from '@contentworker/domain';
import {
  blockPlace,
  type CanvasBlock,
  type CanvasPlace,
  type CanvasSlot,
  flattenSlots,
  keepsPlace,
  placeLockedBy,
  slotHeld,
} from './model';

export type DropVerdict =
  /** It may go there: the op that moves it, and what it did, for the live region and undo. */
  | { readonly kind: 'move'; readonly op: BlockOp; readonly label: string }
  /** That is where it already is: dropping there changes nothing. */
  | { readonly kind: 'home' }
  /** It can't go there, in the words the canvas says it with. */
  | { readonly kind: 'refused'; readonly reason: string };

/** Whether `block` can be picked up at all: one that keeps its place, or that code removed, can't. */
export function canDrag(block: CanvasBlock): boolean {
  return !!block.variant && !keepsPlace(block);
}

export function judgeDrop(block: CanvasBlock, place: CanvasPlace): DropVerdict {
  const { slot, index } = place;
  const from = block.slot;
  const same = slot.path === from.path;
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
  if (slot.address.field !== from.address.field || slot.locale !== from.locale) {
    return {
      kind: 'refused',
      reason: `${slot.name} is another field’s: a block moves only within its own field`,
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
  const op: BlockOp = {
    op: 'move',
    field: from.address.field,
    locale: from.locale,
    key: block.key,
    to: blockPlace(place),
  };
  const label = same
    ? `Moved ${block.name} ${index < block.index ? 'up' : 'down'}`
    : `Moved ${block.name} to ${slot.name}`;
  return { kind: 'move', op, label };
}

/**
 * The places `block` may move to, one per other slot (at its end), for Move to: every slot in the
 * same blocks field that `judgeDrop` lets it into. Its own slot isn't one (↑ ↓ move it there).
 */
export function moveTargets(
  slots: readonly CanvasSlot[],
  block: CanvasBlock,
): { readonly slot: CanvasSlot; readonly op: BlockOp; readonly label: string }[] {
  if (!canDrag(block)) return [];
  return flattenSlots(slots).flatMap((slot) => {
    if (slot.path === block.slot.path) return [];
    const verdict = judgeDrop(block, { slot, index: slot.blocks.length });
    return verdict.kind === 'move' ? [{ slot, op: verdict.op, label: verdict.label }] : [];
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
