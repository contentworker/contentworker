/**
 * jsdom has no layout: what Radix, React Flow and the CMS screens reach for in a real browser.
 */
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(cleanup);

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

Element.prototype.scrollIntoView ??= () => {};
// ProseMirror measures the selection (a Range) to scroll it into view after a command: jsdom's
// Range has no layout, so it reads an empty box rather than throwing outside the test.
const emptyRect = () => new DOMRect(0, 0, 0, 0);
Range.prototype.getBoundingClientRect ??= emptyRect;
Range.prototype.getClientRects ??= () =>
  Object.assign([] as DOMRect[], { item: () => null }) as unknown as DOMRectList;
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.releasePointerCapture ??= () => {};

window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
})) as typeof window.matchMedia;
