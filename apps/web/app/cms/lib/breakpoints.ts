/**
 * Per-breakpoint overrides as the admin reads them (docs/specs/breakpoint-overrides.md): the widths
 * the Site frame can show a page at, which breakpoint a width is in, and what a block's responsive
 * prop is at that breakpoint and where the value comes from.
 *
 * Breakpoints are the site's CSS, declared in code on the catalog push: the admin shows them and
 * never adds one. An override lives beside the props it overrides, in the block's `_responsive`
 * (`{ md: { size: 'xl' } }`); the bare prop is the base, below the first breakpoint. Mobile-first,
 * a breakpoint's value holds from its `minWidth` up until a later one overrides it.
 *
 * Nothing here judges an override: the domain's `undeclaredOverrides` and validation do, as the
 * save will.
 */
import { type Breakpoint, RESPONSIVE_KEY } from '@contentworker/domain';

/** The frame's widths without catalog breakpoints, in CSS pixels. */
export const DEVICE_WIDTHS = { desktop: 1280, tablet: 768, phone: 390 } as const;

/** Base's width when the catalog declares breakpoints: a phone, below any breakpoint. */
export const BASE_WIDTH = DEVICE_WIDTHS.phone;

/** What Base is called beside a catalog's breakpoints. */
export const BASE_NAME = 'Base';

/** One width the Site frame can show a page at. */
export interface WidthPreset {
  /** `desktop`, `tablet`, `phone` without breakpoints; `base` and each breakpoint's id with them. */
  readonly id: string;
  readonly label: string;
  /** CSS pixels. */
  readonly width: number;
  /** The three fixed presets show as device icons; a catalog's are named in words. */
  readonly device?: keyof typeof DEVICE_WIDTHS;
}

const DEVICE_PRESETS: readonly WidthPreset[] = [
  { id: 'desktop', label: 'Desktop', width: DEVICE_WIDTHS.desktop, device: 'desktop' },
  { id: 'tablet', label: 'Tablet', width: DEVICE_WIDTHS.tablet, device: 'tablet' },
  { id: 'phone', label: 'Phone', width: DEVICE_WIDTHS.phone, device: 'phone' },
];

/**
 * The frame's width presets: with the catalog's breakpoints, Base at 390 (or just below the first
 * breakpoint, when that starts at 390 or under) then one per breakpoint at its `minWidth`, named
 * by its name (mobile-first, as they apply); without, Desktop, Tablet, Phone.
 */
export function widthPresets(breakpoints: readonly Breakpoint[] | undefined): WidthPreset[] {
  const first = breakpoints?.[0];
  if (!breakpoints || !first) return [...DEVICE_PRESETS];
  return [
    { id: 'base', label: BASE_NAME, width: Math.max(1, Math.min(BASE_WIDTH, first.minWidth - 1)) },
    ...breakpoints.map((b) => ({ id: b.id, label: b.name, width: b.minWidth })),
  ];
}

/**
 * The preset a frame opens on: Base when the catalog declares breakpoints, so the first Look edit
 * on a fresh canvas sets the bare prop and never an override by accident (the owner's call,
 * 2026-11-10); Desktop without them.
 */
export function defaultPreset(presets: readonly WidthPreset[]): WidthPreset {
  return (
    presets.find((p) => p.id === 'base') ??
    presets.find((p) => p.device === 'desktop') ??
    (presets[0] as WidthPreset)
  );
}

/** Whether `presets` are a catalog's breakpoints (Base and one per breakpoint), not the devices. */
export const byBreakpoint = (presets: readonly WidthPreset[]): boolean =>
  presets.some((p) => p.id === 'base');

/**
 * The breakpoint the Look tab edits under preset `preset`: none (the bare props) at Base, the
 * breakpoint the preset is named for, else (the three devices) the one its width is in.
 */
export function breakpointFor(
  breakpoints: readonly Breakpoint[],
  preset: Pick<WidthPreset, 'id' | 'width'>,
): Breakpoint | null {
  if (preset.id === 'base') return null;
  return breakpoints.find((b) => b.id === preset.id) ?? activeBreakpoint(breakpoints, preset.width);
}

/**
 * The breakpoint a page `width` pixels wide is in: the one with the largest `minWidth` at or below
 * it, or null (Base) below the first.
 */
export function activeBreakpoint(
  breakpoints: readonly Breakpoint[],
  width: number,
): Breakpoint | null {
  let at: Breakpoint | null = null;
  for (const b of breakpoints) if (b.minWidth <= width) at = b;
  return at;
}

const isMap = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** A block's overrides by breakpoint id: only the breakpoints that hold a map of props. */
export function overridesOf(
  block: Readonly<Record<string, unknown>>,
): Record<string, Record<string, unknown>> {
  const raw = block[RESPONSIVE_KEY];
  if (!isMap(raw)) return {};
  const out: Record<string, Record<string, unknown>> = {};
  for (const [bp, props] of Object.entries(raw)) {
    if (isMap(props) && Object.keys(props).length > 0) out[bp] = props;
  }
  return out;
}

/**
 * What `prop` is at breakpoint `at` (null: Base), and where that comes from: `set` when `at` holds
 * an override of its own, else the nearest breakpoint below that does (`from`), else the base.
 */
export function valueAt(
  block: Readonly<Record<string, unknown>>,
  prop: string,
  breakpoints: readonly Breakpoint[],
  at: Breakpoint | null,
): { readonly value: unknown; readonly set: boolean; readonly from: Breakpoint | null } {
  if (!at) return { value: block[prop], set: false, from: null };
  const overrides = overridesOf(block);
  const own = overrides[at.id];
  if (own && Object.hasOwn(own, prop)) return { value: own[prop], set: true, from: at };
  const below = breakpoints
    .slice(
      0,
      breakpoints.findIndex((b) => b.id === at.id),
    )
    .reverse();
  for (const b of below) {
    const o = overrides[b.id];
    if (o && Object.hasOwn(o, prop)) return { value: o[prop], set: false, from: b };
  }
  return { value: block[prop], set: false, from: null };
}

/**
 * A block's `_responsive` with `prop` at breakpoint `bp` set to `value`, or removed (`undefined`,
 * so it inherits again): an emptied breakpoint goes, and an emptied map is undefined, so the
 * `update` op unsets the key. Everything else in it is kept as it was. Never mutates `raw`.
 */
export function withOverride(
  raw: unknown,
  bp: string,
  prop: string,
  value: unknown,
): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = isMap(raw) ? { ...raw } : {};
  const props: Record<string, unknown> = isMap(out[bp]) ? { ...(out[bp] as object) } : {};
  if (value === undefined) delete props[prop];
  else props[prop] = value;
  if (Object.keys(props).length > 0) out[bp] = props;
  else delete out[bp];
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * The names of the breakpoints a block holds overrides at, in the breakpoints' order. One the
 * field no longer declares isn't named: a push removed it, and the next save drops it.
 */
export function overrideNames(
  block: Readonly<Record<string, unknown>>,
  breakpoints: readonly Breakpoint[],
): string[] {
  const ids = Object.keys(overridesOf(block));
  return breakpoints.filter((b) => ids.includes(b.id)).map((b) => b.name);
}
