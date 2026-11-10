/**
 * What the dock offers at a seam: exactly the blocks the slot takes for a new block (its field's
 * variants, which a catalog push writes from each slot's `allowedChildren` and each target's
 * blocks, narrowed by the block config: `CanvasSlot.offers`), named, grouped and described as the
 * block catalog has them. A slot that is full, or locked (by the config or a locked region),
 * offers nothing. Blocks a slot takes that
 * the catalog doesn't describe (a field modelled by hand) are listed by their variant's name alone.
 */
import type { BlockCatalog, ComponentVariant } from '@contentworker/domain';
import { type CanvasSlot, slotHeld } from './model';

export interface DockItem {
  readonly variant: ComponentVariant;
  readonly name: string;
  readonly description?: string;
}

export interface DockGroup {
  /** The catalog's group, or undefined for blocks without one. */
  readonly group?: string;
  readonly items: readonly DockItem[];
}

export function dockGroups(
  slot: CanvasSlot,
  catalog: BlockCatalog | null | undefined,
): DockGroup[] {
  if (slot.full || slotHeld(slot)) return [];
  const byId = new Map((catalog?.blocks ?? []).map((b) => [b.id, b]));
  const groups = new Map<string, DockItem[]>();
  for (const variant of slot.offers) {
    const manifest = byId.get(variant.apiId);
    const group = manifest?.group ?? '';
    const item: DockItem = {
      variant,
      name: manifest?.name ?? variant.name,
      ...(manifest?.description ? { description: manifest.description } : {}),
    };
    groups.set(group, [...(groups.get(group) ?? []), item]);
  }
  // Ungrouped first, then each group in the order the catalog first names it.
  const ungrouped = groups.get('');
  return [
    ...(ungrouped ? [{ items: ungrouped }] : []),
    ...[...groups.entries()]
      .filter(([group]) => group !== '')
      .map(([group, items]) => ({ group, items })),
  ];
}
