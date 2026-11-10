/**
 * "Ask Coworker to fill this": a seam as Coworker is asked about it, and Coworker's proposal as the
 * canvas shows it. The ask names the slot, the place in it, the blocks the dock would offer there
 * (the slot's blocks narrowed by the block config, as `dockGroups` reads them) and its bounds; a
 * place the dock offers nothing at (a full slot, a locked one, inside a locked region) is never
 * asked about. The blocks around it go by the names Layers gives them: content, which the agent
 * quotes to the model as such.
 */

import type { BlockCatalog } from '@contentworker/domain';
import { type AssistantFill, type BlockOp, FILL_LIMITS } from '@contentworker/domain';
import type { GhostKind } from '../live-preview/proposals';
import { dockGroups } from './dock';
import { type CanvasPlace, type CanvasSlot, findBlock, flattenSlots, placeLockedBy } from './model';

/** The text fields a proposal may fill in: short and long text, said plainly. */
const TEXT_TYPES = new Set(['Symbol', 'Text']);

const named = (b: { readonly name: string; readonly label?: string }) =>
  b.label ? `${b.name} “${b.label}”` : b.name;

/** The slot as a person reads it: "Body", or "Section “Features” › Items" inside a block. */
export function slotTitle(slots: readonly CanvasSlot[], slot: CanvasSlot): string {
  const parent = slot.address.parent ? findBlock(slots, slot.address.parent.key) : undefined;
  return parent ? `${named(parent)} › ${slot.name}` : slot.name;
}

/**
 * What Coworker is asked to fill at `place`, or null when the dock offers nothing there: the
 * same blocks, so Coworker is never asked for what a person couldn't add by hand.
 */
export function fillFor(
  slots: readonly CanvasSlot[],
  place: CanvasPlace,
  catalog: BlockCatalog | null | undefined,
): AssistantFill | null {
  const { slot, index } = place;
  if (placeLockedBy(place)) return null;
  const items = dockGroups(slot, catalog).flatMap((g) => g.items);
  if (items.length === 0) return null;
  const before = slot.blocks[index - 1];
  const after = slot.blocks[index];
  return {
    field: slot.address.field,
    locale: slot.locale,
    ...(slot.address.parent ? { parent: slot.address.parent } : {}),
    // Both neighbours: an insert at either edge of the place is at it, and nowhere else is.
    ...(before ? { after: before.key } : {}),
    ...(after ? { before: after.key } : {}),
    slot: slotTitle(slots, slot),
    blocks: items.slice(0, FILL_LIMITS.blocks).map((item) => ({
      type: item.variant.apiId,
      name: item.name,
      fields: item.variant.fields
        .filter((f) => TEXT_TYPES.has(f.type))
        .slice(0, FILL_LIMITS.fields)
        .map((f) => ({ apiId: f.apiId, name: f.name })),
    })),
    count: slot.blocks.length,
    ...(slot.min !== undefined ? { min: slot.min } : {}),
    ...(slot.max !== undefined ? { max: slot.max } : {}),
    around: slot.blocks.slice(0, FILL_LIMITS.around).map(named),
  };
}

/**
 * What the ask says in the conversation: "Fill Body after Hero", "Fill Section › Items". Schema
 * names only, never a block's label: this is the person's own message, unquoted, and a label is
 * content anyone who writes the entry chose (the quoted `fill` carries the labels).
 */
export function fillAsk(slots: readonly CanvasSlot[], place: CanvasPlace): string {
  const { slot, index } = place;
  const before = slot.blocks[index - 1];
  const after = slot.blocks[index];
  const parent = slot.address.parent ? findBlock(slots, slot.address.parent.key) : undefined;
  const where = before ? ` after ${before.name}` : after ? ` before ${after.name}` : '';
  return `Fill ${parent ? `${parent.name} › ${slot.name}` : slot.name}${where}`;
}

/** A block Coworker proposes to put in, as Layers lists it under its slot. */
export interface ProposedLayer {
  readonly key: string;
  readonly name: string;
  readonly label?: string;
  /** The block it goes after, by name, when there is one. */
  readonly after?: string;
}

const LABEL_LENGTH = 48;

/**
 * Coworker's proposal as Layers shows it: the blocks it would put in, under the slot each goes in
 * (by path), and what it would do to the blocks already there, by key.
 */
export function proposedLayers(
  slots: readonly CanvasSlot[],
  ops: readonly BlockOp[],
): { inserted: Map<string, ProposedLayer[]>; marked: Map<string, GhostKind> } {
  const inserted = new Map<string, ProposedLayer[]>();
  const marked = new Map<string, GhostKind>();
  const all = flattenSlots(slots);
  for (const op of ops) {
    if (op.op !== 'insert') {
      if (op.op === 'remove') marked.set(op.key, 'removed');
      else if (!marked.has(op.key)) marked.set(op.key, 'changed');
      continue;
    }
    const key = op.block._key;
    if (typeof key !== 'string') continue;
    const slot = all.find(
      (s) =>
        s.address.field === op.field &&
        s.locale === op.locale &&
        s.address.parent?.key === op.parent?.key &&
        s.address.parent?.slot === op.parent?.slot,
    );
    if (!slot) continue;
    const type = op.block._type;
    const variant = slot.variants.find((v) => v.apiId === type);
    const label = Object.entries(op.block).find(
      ([name, value]) => !name.startsWith('_') && typeof value === 'string' && value.trim(),
    )?.[1] as string | undefined;
    const at = typeof op.index === 'number' ? op.index : undefined;
    const prev = op.after
      ? findBlock(slots, op.after)
      : at !== undefined && at > 0
        ? slot.blocks[at - 1]
        : undefined;
    const list = inserted.get(slot.path) ?? [];
    list.push({
      key,
      name: variant?.name ?? (typeof type === 'string' ? type : 'Block'),
      ...(label
        ? {
            label:
              label.length > LABEL_LENGTH
                ? `${label.slice(0, LABEL_LENGTH - 1).trimEnd()}…`
                : label,
          }
        : {}),
      ...(prev ? { after: prev.name } : {}),
    });
    inserted.set(slot.path, list);
  }
  return { inserted, marked };
}
