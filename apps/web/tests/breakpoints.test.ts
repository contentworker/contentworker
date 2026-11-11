// Per-breakpoint overrides as the admin reads them: the frame's width presets from the catalog's
// breakpoints, the breakpoint a width is in, what a prop inherits and from where, and the
// `_responsive` an edit sets (an emptied breakpoint, then an emptied map, left out).
import type { Breakpoint } from '@contentworker/domain';
import { describe, expect, it } from 'vitest';
import {
  activeBreakpoint,
  breakpointFor,
  defaultPreset,
  overrideNames,
  valueAt,
  widthPresets,
  withOverride,
} from '~/cms/lib/breakpoints';
import { frameWidth } from '~/cms/lib/live-preview/frame-channel';

const BREAKPOINTS: Breakpoint[] = [
  { id: 'md', name: 'Tablet', minWidth: 768 },
  { id: 'lg', name: 'Desktop', minWidth: 1280 },
];
const [md, lg] = BREAKPOINTS as [Breakpoint, Breakpoint];

describe('width presets', () => {
  it('keeps the three devices without breakpoints, opening on Desktop', () => {
    for (const none of [undefined, []]) {
      const presets = widthPresets(none);
      expect(presets.map((p) => [p.id, p.width])).toEqual([
        ['desktop', 1280],
        ['tablet', 768],
        ['phone', 390],
      ]);
      expect(defaultPreset(presets).id).toBe('desktop');
    }
  });

  it('is Base at 390, then one per breakpoint at its minWidth by its name, opening on the widest', () => {
    const presets = widthPresets(BREAKPOINTS);
    expect(presets).toEqual([
      { id: 'base', label: 'Base', width: 390 },
      { id: 'md', label: 'Tablet', width: 768 },
      { id: 'lg', label: 'Desktop', width: 1280 },
    ]);
    expect(defaultPreset(presets).id).toBe('lg');
  });

  it('frames Base below a first breakpoint at 390 or under, and Base always edits the bare props', () => {
    const low: Breakpoint[] = [{ id: 'xs', name: 'Small', minWidth: 375 }, ...BREAKPOINTS];
    const presets = widthPresets(low);
    expect(presets[0]).toEqual({ id: 'base', label: 'Base', width: 374 });
    expect(widthPresets([{ id: 'a', name: 'A', minWidth: 1 }])[0]?.width).toBe(1);
    expect(breakpointFor(low, { id: 'base', width: 390 })).toBeNull();
    expect(breakpointFor(low, { id: 'md', width: 768 })).toBe(md);
    // The three devices, over a field with breakpoints: by width.
    expect(breakpointFor(BREAKPOINTS, { id: 'tablet', width: 768 })).toBe(md);
    expect(breakpointFor(BREAKPOINTS, { id: 'phone', width: 390 })).toBeNull();
  });

  it('puts a width in the largest breakpoint at or below it, and Base below the first', () => {
    expect(activeBreakpoint(BREAKPOINTS, 390)).toBeNull();
    expect(activeBreakpoint(BREAKPOINTS, 767)).toBeNull();
    expect(activeBreakpoint(BREAKPOINTS, 768)).toBe(md);
    expect(activeBreakpoint(BREAKPOINTS, 1279)).toBe(md);
    expect(activeBreakpoint(BREAKPOINTS, 1280)).toBe(lg);
    expect(activeBreakpoint([], 1280)).toBeNull();
  });

  it('takes only a whole width in bounds over the frame channel', () => {
    expect(frameWidth(768)).toBe(768);
    for (const bad of [0, 10_001, 12.5, '768', undefined, null]) expect(frameWidth(bad)).toBe(1280);
  });
});

describe('what a prop is at a breakpoint', () => {
  const block = { _type: 'hero', _key: 'h', tone: 'light', _responsive: { md: { tone: 'dark' } } };

  it('is the bare prop at Base, its own override where set, else the nearest below', () => {
    expect(valueAt(block, 'tone', BREAKPOINTS, null)).toEqual({
      value: 'light',
      set: false,
      from: null,
    });
    expect(valueAt(block, 'tone', BREAKPOINTS, md)).toEqual({ value: 'dark', set: true, from: md });
    expect(valueAt(block, 'tone', BREAKPOINTS, lg)).toEqual({
      value: 'dark',
      set: false,
      from: md,
    });
    expect(valueAt(block, 'align', BREAKPOINTS, lg)).toEqual({
      value: undefined,
      set: false,
      from: null,
    });
  });

  it('names the breakpoints a block changes at, leaving out one no longer declared', () => {
    expect(overrideNames(block, BREAKPOINTS)).toEqual(['Tablet']);
    expect(
      overrideNames(
        { _responsive: { xl: { tone: 'dark' }, lg: { tone: 'x' }, md: {} } },
        BREAKPOINTS,
      ),
    ).toEqual(['Desktop']);
    expect(overrideNames({ _responsive: 'nope' }, BREAKPOINTS)).toEqual([]);
  });
});

describe('the `_responsive` an edit sets', () => {
  it('adds an override beside the others, never changing what it was given', () => {
    const raw = { md: { tone: 'dark' } };
    expect(withOverride(raw, 'lg', 'tone', 'light')).toEqual({
      md: { tone: 'dark' },
      lg: { tone: 'light' },
    });
    expect(withOverride(raw, 'md', 'size', 'xl')).toEqual({ md: { tone: 'dark', size: 'xl' } });
    expect(raw).toEqual({ md: { tone: 'dark' } });
    expect(withOverride(undefined, 'md', 'hidden', false)).toEqual({ md: { hidden: false } });
  });

  it('removes an emptied breakpoint, and the map once it is empty', () => {
    expect(withOverride({ md: { tone: 'dark', size: 'xl' } }, 'md', 'tone', undefined)).toEqual({
      md: { size: 'xl' },
    });
    expect(
      withOverride({ md: { tone: 'dark' }, lg: { tone: 'light' } }, 'md', 'tone', undefined),
    ).toEqual({ lg: { tone: 'light' } });
    expect(withOverride({ md: { tone: 'dark' } }, 'md', 'tone', undefined)).toBeUndefined();
  });
});
