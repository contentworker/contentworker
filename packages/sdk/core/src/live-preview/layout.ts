/**
 * The `layout` extension's geometry: where a page's blocks, slots and fields are, fitted to one
 * message. The canvas editor draws its seams (the places a block can go) from the gaps here.
 */
import {
  type LayoutMessage,
  type LiveGap,
  type LiveRect,
  type LiveSlotBox,
  MAX_GEOMETRY_GAPS,
  MAX_GEOMETRY_ITEMS,
} from './protocol.js';

export type LayoutBody = Omit<LayoutMessage, 'v' | 'channel' | 'kind'>;

/**
 * The geometry as it fits one message: at most `MAX_GEOMETRY_ITEMS` of each list and
 * `MAX_GEOMETRY_GAPS` seams, in at most `budget` bytes of JSON. What's on screen goes first, then
 * what's nearest it; each list keeps document order. Anything left out sets `truncated`, so the
 * admin knows boxes far from the viewport may be missing, rather than silently losing them all.
 */
export function fitGeometry(g: LayoutBody, budget: number, cut = false): LayoutBody {
  const { w, h } = g.viewport;
  const away = (r: LiveRect): number =>
    Math.max(0, -(r.x + r.w), r.x - w) + Math.max(0, -(r.y + r.h), r.y - h);
  const lists = [g.blocks, g.slots, g.fields] as const;
  const candidates = lists.flatMap((list, kind) =>
    list.map((item, index) => {
      const size = JSON.stringify(item).length + 1;
      const gaps = kind === 1 ? (item as LiveSlotBox).gaps.length : 0;
      // A slot's size without its seams, and a seam's on average, so a slot can be cut to fit.
      const bare = gaps > 0 ? JSON.stringify({ ...item, gaps: [] }).length + 1 : size;
      return {
        kind,
        index,
        away: away(item.rect),
        size,
        gaps,
        bare,
        perGap: gaps ? (size - bare) / gaps : 0,
      };
    }),
  );
  candidates.sort((a, b) => a.away - b.away || a.kind - b.kind || a.index - b.index);
  const total = candidates.length;
  const bytes = (body: LayoutBody) => new TextEncoder().encode(JSON.stringify(body)).byteLength;

  let room = budget - bytes({ ...g, blocks: [], slots: [], fields: [], truncated: true });
  for (;;) {
    const kept = [new Set<number>(), new Set<number>(), new Set<number>()];
    // A slot with more seams than are left keeps the ones that fit, rather than vanishing.
    const seams = new Map<number, number>();
    let used = 0;
    let gaps = 0;
    for (const c of candidates) {
      const set = kept[c.kind] as Set<number>;
      if (set.size >= MAX_GEOMETRY_ITEMS) continue;
      if (c.gaps === 0) {
        if (used + c.size > room) continue;
        set.add(c.index);
        used += c.size;
        continue;
      }
      if (used + c.bare > room) continue;
      const bySize = Math.floor((room - used - c.bare) / c.perGap);
      const fit = Math.min(c.gaps, MAX_GEOMETRY_GAPS - gaps, bySize);
      set.add(c.index);
      used += c.bare + Math.ceil(fit * c.perGap);
      if (fit < c.gaps) seams.set(c.index, fit);
      gaps += fit;
    }
    const pick = <T>(list: readonly T[], kind: number) =>
      list.filter((_, i) => (kept[kind] as Set<number>).has(i));
    const out: LayoutBody = {
      ...g,
      blocks: pick(g.blocks, 0),
      slots: g.slots.flatMap((slot, i) => {
        if (!kept[1]?.has(i)) return [];
        const fit = seams.get(i);
        return [fit === undefined ? slot : { ...slot, gaps: slot.gaps.slice(0, fit) }];
      }),
      fields: pick(g.fields, 2),
    };
    const truncated =
      cut || seams.size > 0 || out.blocks.length + out.slots.length + out.fields.length < total;
    const body: LayoutBody = truncated ? { ...out, truncated: true } : out;
    // Sizes were counted in UTF-16 units; keys outside ASCII take more bytes, so check and shrink.
    if (bytes(body) <= budget || room <= 0) return body;
    room = Math.floor(room * 0.75);
  }
}

export const round = (n: number): number => Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;

export function rectOf(el: Element): LiveRect {
  const r = el.getBoundingClientRect();
  return { x: round(r.left), y: round(r.top), w: round(r.width), h: round(r.height) };
}

/**
 * The seams of a slot: before its first block, between each pair, after its last; one across the
 * whole slot when it's empty. Blocks that start below the previous one's bottom run down the page
 * (`y`); otherwise side by side (`x`).
 */
export function gapsOf(
  slot: LiveRect,
  blocks: readonly { readonly key: string; readonly rect: LiveRect }[],
): LiveGap[] {
  if (blocks.length === 0) return [{ index: 0, rect: slot, axis: 'y' }];
  const axisOf = (a: LiveRect, b: LiveRect): 'x' | 'y' => (b.y >= a.y + a.h - 1 ? 'y' : 'x');
  const first = blocks[0] as (typeof blocks)[number];
  const last = blocks[blocks.length - 1] as (typeof blocks)[number];
  const axis = blocks.length > 1 ? axisOf(first.rect, (blocks[1] as typeof first).rect) : 'y';
  const gaps: LiveGap[] = [];
  gaps.push({
    index: 0,
    axis,
    before: first.key,
    rect:
      axis === 'y'
        ? { x: slot.x, y: slot.y, w: slot.w, h: round(Math.max(0, first.rect.y - slot.y)) }
        : {
            x: slot.x,
            y: first.rect.y,
            w: round(Math.max(0, first.rect.x - slot.x)),
            h: first.rect.h,
          },
  });
  for (let i = 1; i < blocks.length; i++) {
    const a = (blocks[i - 1] as typeof first).rect;
    const b = (blocks[i] as typeof first).rect;
    const along = axisOf(a, b);
    const rect: LiveRect =
      along === 'y'
        ? {
            x: Math.min(a.x, b.x),
            y: round(a.y + a.h),
            w: round(Math.max(a.x + a.w, b.x + b.w) - Math.min(a.x, b.x)),
            h: round(Math.max(0, b.y - (a.y + a.h))),
          }
        : {
            x: round(a.x + a.w),
            y: Math.min(a.y, b.y),
            w: round(Math.max(0, b.x - (a.x + a.w))),
            h: round(Math.max(a.y + a.h, b.y + b.h) - Math.min(a.y, b.y)),
          };
    gaps.push({
      index: i,
      axis: along,
      after: (blocks[i - 1] as typeof first).key,
      before: (blocks[i] as typeof first).key,
      rect,
    });
  }
  const end = last.rect;
  gaps.push({
    index: blocks.length,
    axis,
    after: last.key,
    rect:
      axis === 'y'
        ? {
            x: slot.x,
            y: round(end.y + end.h),
            w: slot.w,
            h: round(Math.max(0, slot.y + slot.h - (end.y + end.h))),
          }
        : {
            x: round(end.x + end.w),
            y: end.y,
            w: round(Math.max(0, slot.x + slot.w - (end.x + end.w))),
            h: end.h,
          },
  });
  return gaps;
}
