/**
 * The page scrolling under a block carried near the canvas frame's edge, without a screen: how far
 * a pointer at the edge asks to scroll (in steps with motion, half the view with reduced motion,
 * nothing away from the edges), and the element-anchored `scroll` the Site frame says that with,
 * kept within the document and the channel's inset, never anchored on a box that stays put while
 * the page scrolls (a sticky header block).
 */
import { describe, expect, it } from 'vitest';
import { EDGE, edgeScroll, STEP_MAX, scrollAnchor, stuckBoxes } from '~/cms/lib/canvas/autoscroll';

describe('how far the edge scrolls', () => {
  it('asks nothing away from the edges, or in a frame too short for two', () => {
    expect(edgeScroll(300, 600, false)).toBe(0);
    expect(edgeScroll(EDGE, 600, false)).toBe(0);
    expect(edgeScroll(600 - EDGE, 600, false)).toBe(0);
    expect(edgeScroll(5, EDGE * 2, false)).toBe(0);
  });

  it('steps faster the nearer the edge, up near the top and down near the bottom', () => {
    expect(edgeScroll(EDGE - 1, 600, false)).toBe(-1);
    expect(edgeScroll(EDGE / 2, 600, false)).toBe(-STEP_MAX / 2);
    expect(edgeScroll(0, 600, false)).toBe(-STEP_MAX);
    expect(edgeScroll(600 - EDGE / 2, 600, false)).toBe(STEP_MAX / 2);
    // Past the edge (the pointer is held outside the frame): as fast as it goes, no faster.
    expect(edgeScroll(-200, 600, false)).toBe(-STEP_MAX);
    expect(edgeScroll(900, 600, false)).toBe(STEP_MAX);
  });

  it('jumps half the view with reduced motion, wherever in the edge the pointer is', () => {
    expect(edgeScroll(EDGE - 1, 600, true)).toBe(-300);
    expect(edgeScroll(599, 600, true)).toBe(300);
    expect(edgeScroll(300, 600, true)).toBe(0);
  });
});

describe('the scroll that says a step', () => {
  /** Scrolled `y` down; the boxes are in the view's coordinates, as the page reports them. */
  const layout = (y: number) => ({
    blocks: [
      { ref: 'a', rect: { x: 0, y: -400, w: 10, h: 300 } },
      { ref: 'b', rect: { x: 0, y: 100, w: 10, h: 300 } },
      { ref: 'c', rect: { x: 0, y: 900, w: 10, h: 300 } },
    ],
    fields: [],
    scroll: { x: 0, y },
    viewport: { w: 1280, h: 800 },
    docHeight: 3000,
  });

  it('names the element whose top is the step plus the inset below the view, the nearest first', () => {
    // b is 100 below the top: scrolled to 30 below the top of the view, the page moves 70.
    expect(scrollAnchor(layout(500), 70)).toEqual({ ref: 'b', align: 'start', inset: 30 });
    // Up: a block above the view still anchors it, its top landing below the view's.
    expect(scrollAnchor(layout(500), -200)).toEqual({ ref: 'b', align: 'start', inset: 300 });
  });

  it('keeps within the document, and asks nothing at its end', () => {
    // 100 from the top: up by 300 is up by 100, b's top landing 200 below the view's.
    expect(scrollAnchor(layout(100), -300)).toMatchObject({ ref: 'b', inset: 200 });
    expect(scrollAnchor(layout(0), -24)).toBeUndefined();
    expect(scrollAnchor(layout(2200), 24)).toBeUndefined();
  });

  it('asks nothing without an element placed to anchor it', () => {
    const far = { ...layout(500), blocks: [{ ref: 'z', rect: { x: 0, y: 9000, w: 1, h: 1 } }] };
    expect(scrollAnchor(far, 24)).toBeUndefined();
    expect(scrollAnchor({ ...layout(500), blocks: [] }, 24)).toBeUndefined();
  });

  it('never anchors on a box that stayed put through the last scroll', () => {
    const before = {
      blocks: [
        { ref: 'head', rect: { x: 0, y: 0, w: 10, h: 60 } },
        { ref: 'b', rect: { x: 0, y: 300, w: 10, h: 300 } },
      ],
      fields: [],
      scroll: { x: 0, y: 500 },
    };
    // Scrolled 100 further: b moved up with the page; the sticky header didn't.
    const after = {
      ...before,
      blocks: [
        { ref: 'head', rect: { x: 0, y: 0, w: 10, h: 60 } },
        { ref: 'b', rect: { x: 0, y: 200, w: 10, h: 300 } },
      ],
      scroll: { x: 0, y: 600 },
    };
    const stuck = stuckBoxes(before, after);
    expect([...stuck]).toEqual(['head']);
    const layout = { ...after, viewport: { w: 1280, h: 800 }, docHeight: 3000 };
    // Up 24: the header would be nearest (inset 24) but can't move the page; b anchors it.
    expect(scrollAnchor(layout, -24)).toMatchObject({ ref: 'head' });
    expect(scrollAnchor(layout, -24, stuck)).toEqual({ ref: 'b', align: 'start', inset: 224 });
    // Nothing tells them apart without a scroll between the two.
    expect(stuckBoxes(after, after).size).toBe(0);
    expect(stuckBoxes(null, after).size).toBe(0);
  });
});
