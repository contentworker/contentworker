/**
 * A ref for an overlay that holds a field: keeps `--keyboard-inset` on it, the height the on-screen
 * keyboard covers. iOS resizes neither the layout viewport nor `dvh` for its keyboard, so an overlay
 * capped by `dvh` alone would leave its footer under the keyboard. 0 everywhere else, and while
 * pinch-zoomed, when the visual viewport is small for another reason.
 */
export function keyboardInset(el: HTMLElement | null) {
  const viewport = window.visualViewport;
  if (!el || !viewport) return;
  const update = () => {
    const covered = window.innerHeight - viewport.height - viewport.offsetTop;
    el.style.setProperty('--keyboard-inset', `${viewport.scale > 1 ? 0 : Math.max(0, covered)}px`);
  };
  update();
  viewport.addEventListener('resize', update);
  viewport.addEventListener('scroll', update);
  return () => {
    viewport.removeEventListener('resize', update);
    viewport.removeEventListener('scroll', update);
  };
}
