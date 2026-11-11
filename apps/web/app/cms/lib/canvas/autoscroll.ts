/**
 * Scrolling the framed page while a block is carried near the frame's top or bottom edge, so a drag
 * reaches a seam the page hasn't scrolled to yet. The page scrolls itself, inside its own frame:
 * the canvas only asks, and its seams follow from the `layout` the page reports after it moves.
 *
 * The live preview channel scrolls by element, not by pixels (`scroll` with `align` and `inset`),
 * so a step of `dy` pixels is said as "this block's top edge, `inset` pixels below the view's
 * top" for a block whose top is now `dy + inset` down (`scrollAnchor`). That needs no new message
 * of the customer's SDK, and an inset above 0 makes the page jump at once rather than animate
 * (`instant` from this release; an older SDK asks for `auto`, which a page whose CSS sets
 * `scroll-behavior: smooth` animates, so its steps may land short there). A box that didn't move
 * with the page's scroll between two reports (sticky or fixed) never anchors a step: scrolling
 * to it wouldn't move the page by the step.
 * Asked again before the page reports where it went, a step names the same place, so the page
 * never runs ahead of its seams.
 *
 * With motion, small steps several times a second, faster the nearer the edge; with reduced
 * motion, a jump of half the view after the pointer rests at the edge (`edgeScroll`).
 *
 * Pure: the stage holds the pointer and the timer, the Site frame the page's layout.
 */
import type { LayoutMessage } from '@contentworker/sdk-core/live-preview';

/** How near the frame's top or bottom edge the pointer scrolls the page, in the frame's pixels. */
export const EDGE = 48;
/** The most one step scrolls with motion, in the frame's pixels. */
export const STEP_MAX = 24;
/** How often a step is asked for with motion: with `STEP_MAX`, up to 600 pixels a second. */
export const STEP_MS = 40;
/**
 * With reduced motion, how long the pointer rests at the edge before a jump, and between jumps:
 * long enough that only stopping there on purpose jumps.
 */
export const REDUCED_MS = 600;

/** The most an inset may be, as the channel's `scroll` takes it (`MAX_SCROLL_INSET`). */
const MAX_INSET = 4000;

/**
 * How far to scroll the page for a pointer `y` pixels down a frame `height` pixels tall: negative
 * up, positive down, 0 away from both edges (or in a frame too short to have two). With motion it
 * grows from 1 to `STEP_MAX` as the pointer nears (or passes) the edge; with reduced motion it is
 * half the frame, so each jump keeps some of what was in view.
 */
export function edgeScroll(y: number, height: number, reduced: boolean): number {
  if (height < EDGE * 3) return 0;
  const up = EDGE - y;
  const down = y - (height - EDGE);
  const into = Math.max(up, down);
  if (into <= 0) return 0;
  const way = up > down ? -1 : 1;
  if (reduced) return way * Math.round(height / 2);
  return way * Math.max(1, Math.round((STEP_MAX * Math.min(into, EDGE)) / EDGE));
}

/**
 * The `scroll` that moves the page by `dy` of its own pixels (kept within the document), from its
 * last reported `layout`: a block (or field) whose top is `dy + inset` below the view's top, `inset`
 * between 1 and the channel's most. Undefined when the page is already at that end, or no marked
 * element is placed to say the step with.
 */
export function scrollAnchor(
  layout: Pick<LayoutMessage, 'blocks' | 'fields' | 'scroll' | 'viewport' | 'docHeight'>,
  dy: number,
  /** Refs that stay put while the page scrolls (`stuckBoxes`). */
  stuck: ReadonlySet<string> = new Set(),
): { readonly ref: string; readonly align: 'start'; readonly inset: number } | undefined {
  const bottom = Math.max(0, layout.docHeight - layout.viewport.h);
  const to = Math.min(bottom, Math.max(0, layout.scroll.y + dy));
  const by = Math.round(to - layout.scroll.y);
  if (by === 0) return undefined;
  let best: { ref: string; inset: number } | undefined;
  for (const box of [...layout.blocks, ...layout.fields]) {
    if (stuck.has(box.ref)) continue;
    const inset = Math.round(box.rect.y) - by;
    if (inset < 1 || inset > MAX_INSET) continue;
    // The nearest the view's top: the page's own offsets (a sticky header's scroll padding) count
    // the same for every element, and a box near the view is the likeliest to be laid out as told.
    if (!best || inset < best.inset) best = { ref: box.ref, inset };
  }
  return best ? { ref: best.ref, align: 'start', inset: best.inset } : undefined;
}

type Boxes = Pick<LayoutMessage, 'blocks' | 'fields' | 'scroll'>;

/**
 * The refs that stayed where they were in the view while the page scrolled between two layouts
 * (a sticky header block, a fixed banner): their place in the page moved with the scroll. Empty
 * when the page didn't scroll between them, since nothing tells them apart then.
 */
export function stuckBoxes(before: Boxes | null, after: Boxes): Set<string> {
  const out = new Set<string>();
  if (!before || before.scroll.y === after.scroll.y) return out;
  const was = new Map([...before.blocks, ...before.fields].map((b) => [b.ref, b.rect.y]));
  for (const box of [...after.blocks, ...after.fields]) {
    const y = was.get(box.ref);
    if (y === undefined) continue;
    // In the page, a box that scrolls with it keeps its place: its top moves by the scroll.
    const moved = y + before.scroll.y - (box.rect.y + after.scroll.y);
    if (Math.abs(moved) >= 1) out.add(box.ref);
  }
  return out;
}
