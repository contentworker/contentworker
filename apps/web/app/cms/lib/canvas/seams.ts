/**
 * Seams: the places a block can go, drawn between the blocks of the customer's page. The page
 * reports each slot's box and the gaps in it (`layout`, docs/specs/live-preview-channel.md,
 * Extensions); the Site frame moves them into its own coordinates (`FrameGeometry`). Here each is
 * matched to a slot of the entry, by its ref, and to a place in it, by the keys either side.
 *
 * Every ref is the page's, so untrusted: a slot is drawn only when its ref names this entry (space,
 * environment, type, entry and locale) and a slot the entry has, and a gap only where its index is
 * a place in that slot. A block ref is followed the same way.
 */
import {
  type ContentRef,
  formatFieldPath,
  parseContentRef,
  parseFieldPath,
} from '@contentworker/sdk-core';
import type { LiveRect } from '@contentworker/sdk-core/live-preview';
import type { FrameGeometry } from '../live-preview/frame-channel';
import type { GhostKind } from '../live-preview/proposals';
import {
  type CanvasPlace,
  type CanvasSlot,
  findSlot,
  flattenBlocks,
  placeLockedBy,
  slotHeld,
} from './model';

/** What a ref must name to be this entry's. */
export interface RefContext {
  readonly space: string;
  readonly environment: string;
  readonly entryId: string;
  readonly contentType: string;
  /** The locale the canvas edits; a ref in another names a value the canvas doesn't show. */
  readonly locale: string;
  /** The locale an unlocalized field's ref may name instead. */
  readonly defaultLocale: string;
}

export interface Seam extends CanvasPlace {
  /** Stable per slot and place: `body#2`. */
  readonly id: string;
  readonly rect: LiveRect;
  readonly axis: 'x' | 'y';
}

/** The field path a ref names when it is this entry's, else undefined. */
export function ownPath(ref: string, ctx: RefContext): string | undefined {
  const parsed: ContentRef | undefined = parseContentRef(ref);
  if (!parsed) return undefined;
  if (parsed.space !== ctx.space || parsed.environment !== ctx.environment) return undefined;
  if (parsed.entryId !== ctx.entryId || parsed.contentType !== ctx.contentType) return undefined;
  if (parsed.locale !== ctx.locale && parsed.locale !== ctx.defaultLocale) return undefined;
  return parseFieldPath(parsed.field) ? parsed.field : undefined;
}

/** The key of the block a ref names (its path's last key), when it is a block of this entry. */
export function blockKeyOfRef(
  ref: string,
  slots: readonly CanvasSlot[],
  ctx: RefContext,
): string | undefined {
  const path = ownPath(ref, ctx);
  const parsed = path ? parseFieldPath(path) : undefined;
  if (!parsed) return undefined;
  const keys = parsed.steps.flatMap((s) => ('key' in s ? [s.key] : []));
  const key = keys.at(-1);
  return key !== undefined && flattenBlocks(slots).some((b) => b.key === key) ? key : undefined;
}

/**
 * The seams the page's geometry draws, matched to the entry's slots; unknown ones are dropped, and
 * so is every seam of a locked slot (the config's, or one inside a locked region) and every seam
 * between two blocks of a locked run: nothing goes in there, or moves in.
 */
export function seamsFrom(
  geometry: FrameGeometry | null,
  slots: readonly CanvasSlot[],
  ctx: RefContext,
): Seam[] {
  if (!geometry) return [];
  const out: Seam[] = [];
  const seen = new Set<string>();
  for (const box of geometry.slots) {
    const path = ownPath(box.ref, ctx);
    const slot = path ? findSlot(slots, canonical(path)) : undefined;
    if (!slot || slotHeld(slot)) continue;
    for (const gap of box.gaps) {
      const index = placeOf(slot, gap);
      if (index === undefined || placeLockedBy({ slot, index })) continue;
      const id = `${slot.path}#${index}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ id, slot, index, rect: gap.rect, axis: gap.axis });
    }
  }
  return out;
}

/** The page's boxes for the entry's blocks, by key. */
export function blockRects(
  geometry: FrameGeometry | null,
  slots: readonly CanvasSlot[],
  ctx: RefContext,
): Map<string, LiveRect> {
  const out = new Map<string, LiveRect>();
  for (const box of geometry?.blocks ?? []) {
    const key = blockKeyOfRef(box.ref, slots, ctx);
    if (key !== undefined && !out.has(key)) out.set(key, box.rect);
  }
  return out;
}

/**
 * The page's boxes for Coworker's ghost blocks, by key: a block ref of this entry whose key the
 * proposal names (`ghosts`), whether or not the entry holds it yet. Matched by key alone, so a page
 * can't draw a proposal's mark on a block the proposal doesn't name.
 */
export function ghostRects(
  geometry: FrameGeometry | null,
  ghosts: ReadonlyMap<string, GhostKind>,
  ctx: RefContext,
): { key: string; kind: GhostKind; rect: LiveRect }[] {
  if (ghosts.size === 0) return [];
  const out = new Map<string, { key: string; kind: GhostKind; rect: LiveRect }>();
  for (const box of geometry?.blocks ?? []) {
    const path = ownPath(box.ref, ctx);
    const parsed = path ? parseFieldPath(path) : undefined;
    const key = parsed?.steps.flatMap((s) => ('key' in s ? [s.key] : [])).at(-1);
    const kind = key !== undefined ? ghosts.get(key) : undefined;
    if (key !== undefined && kind && !out.has(key)) out.set(key, { key, kind, rect: box.rect });
  }
  return [...out.values()];
}

/**
 * Each locked region's box on the page: around every one of its own blocks the page draws (a run's
 * blocks are neighbours, so the box is theirs alone). A region none of whose blocks is drawn has
 * none.
 */
export function regionRects(
  slots: readonly CanvasSlot[],
  rects: ReadonlyMap<string, LiveRect>,
): { id: string; rect: LiveRect }[] {
  const boxes = new Map<number, LiveRect>();
  for (const b of flattenBlocks(slots)) {
    const r = b.lock?.own ? rects.get(b.key) : undefined;
    if (!r || !b.lock) continue;
    const at = b.lock.region.index;
    const was = boxes.get(at);
    if (!was) {
      boxes.set(at, r);
      continue;
    }
    const x = Math.min(was.x, r.x);
    const y = Math.min(was.y, r.y);
    boxes.set(at, {
      x,
      y,
      w: Math.max(was.x + was.w, r.x + r.w) - x,
      h: Math.max(was.y + was.h, r.y + r.h) - y,
    });
  }
  return [...boxes].map(([index, rect]) => ({ id: `region-${index}`, rect }));
}

/**
 * The place a gap stands for: after the block keyed `after`, else before the one keyed `before`,
 * else its index when the slot is empty. The page's index alone isn't trusted (it may render
 * blocks the entry doesn't have, or not render some).
 */
function placeOf(
  slot: CanvasSlot,
  gap: { readonly index: number; readonly after?: string; readonly before?: string },
): number | undefined {
  if (gap.after !== undefined) {
    const at = slot.blocks.findIndex((b) => b.key === gap.after);
    return at >= 0 ? at + 1 : undefined;
  }
  if (gap.before !== undefined) {
    const at = slot.blocks.findIndex((b) => b.key === gap.before);
    return at >= 0 ? at : undefined;
  }
  return slot.blocks.length === 0 && gap.index === 0 ? 0 : undefined;
}

/** A path as `formatFieldPath` writes it, so two spellings of one slot compare equal. */
function canonical(path: string): string {
  const parsed = parseFieldPath(path);
  try {
    return parsed ? formatFieldPath(parsed) : path;
  } catch {
    return path;
  }
}
