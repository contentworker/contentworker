/** What the on-screen keyboard rises for. */
const FIELD = 'input, textarea, select, [contenteditable="true"]';

/**
 * Brings the focused field out from behind the overlay's pinned header and footer. A browser only
 * scrolls a field into its scroller's box, which the footer stands in, and iOS does nothing at all
 * when the keyboard shrinks that box around a field that was in view.
 */
function keepFieldClear(overlay: HTMLElement) {
  const field = document.activeElement;
  if (!field?.matches(FIELD) || !overlay.contains(field)) return;
  const body = field.closest<HTMLElement>('[data-slot="dialog-body"], [data-slot="sheet-body"]');
  if (!body || !overlay.contains(body)) return;
  const edge = (slot: string) =>
    body
      .querySelector(`[data-slot="dialog-${slot}"], [data-slot="sheet-${slot}"]`)
      ?.getBoundingClientRect();
  const box = body.getBoundingClientRect();
  const top = (edge('header')?.bottom ?? box.top) + GAP;
  const bottom = Math.min(edge('footer')?.top ?? box.bottom, box.bottom) - GAP;
  const at = field.getBoundingClientRect();
  if (at.bottom > bottom) body.scrollTop += Math.min(at.bottom - bottom, at.top - top);
  else if (at.top < top) body.scrollTop -= top - at.top;
}

/** Room left between a field and the edge it clears. */
const GAP = 8;

/**
 * A ref for an overlay that holds a field: keeps `--keyboard-inset` on it, the height the on-screen
 * keyboard covers, and the focused field clear of what is pinned. iOS resizes neither the layout
 * viewport nor `dvh` for its keyboard, so an overlay capped by `dvh` alone would leave its footer
 * under the keyboard. 0 everywhere else, and while pinch-zoomed, when the visual viewport is small
 * for another reason.
 */
export function keyboardInset(el: HTMLElement | null) {
  const viewport = window.visualViewport;
  if (!el || !viewport) return;
  let inset = -1;
  const update = () => {
    const covered = window.innerHeight - viewport.height - viewport.offsetTop;
    const next = viewport.scale > 1 ? 0 : Math.max(0, covered);
    if (next === inset) return;
    inset = next;
    el.style.setProperty('--keyboard-inset', `${next}px`);
    // Only as the keyboard moves: a pan or a pinch must not pull the body back to the field.
    keepFieldClear(el);
  };
  const focused = () => keepFieldClear(el);
  update();
  viewport.addEventListener('resize', update);
  viewport.addEventListener('scroll', update);
  el.addEventListener('focusin', focused);
  return () => {
    viewport.removeEventListener('resize', update);
    viewport.removeEventListener('scroll', update);
    el.removeEventListener('focusin', focused);
  };
}
