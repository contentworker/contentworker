import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DARK_OVERRIDES, FONTS, LIGHT, palette, starlightThemeCss } from '../src/tokens';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const appCss = read('../../../apps/web/app/app.css');

/** The custom properties one rule block in app.css declares, in source order. */
function declarations(selector: string): Record<string, string> {
  const start = appCss.indexOf(selector);
  if (start < 0) throw new Error(`app.css has no ${selector} block`);
  const open = appCss.indexOf('{', start);
  const body = appCss.slice(open + 1, appCss.indexOf('}', open));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/--([\w-]+):\s*([^;]+);/g)) out[m[1]!] = m[2]!.trim();
  return out;
}

describe('Ledger tokens match apps/web/app/app.css', () => {
  it('light: every `:root` token, value for value', () => {
    expect(LIGHT).toEqual(declarations(':root {'));
  });

  it('dark: every `:root[data-theme="dark"]` override, value for value', () => {
    expect(DARK_OVERRIDES).toEqual(declarations(':root[data-theme="dark"] {'));
  });

  it('faces: the `@theme` font stacks', () => {
    const theme = declarations('@theme {');
    expect({
      sans: theme['font-sans'],
      mono: theme['font-mono'],
    }).toEqual(FONTS);
  });

  it('resolves every reference in both schemes', () => {
    for (const scheme of ['light', 'dark'] as const) {
      for (const v of Object.values(palette(scheme))) expect(v).not.toMatch(/var\(/);
    }
  });
});

describe('generated docs theme', () => {
  it('apps/docs/src/styles/theme.css is current (run `pnpm sync:theme`)', () => {
    expect(read('../../../apps/docs/src/styles/theme.css')).toBe(starlightThemeCss());
  });
});

// WCAG contrast, from the tokens as the browser paints them: oklch to sRGB, an `x/N` fill
// composited over what is beneath it in sRGB, then relative luminance.
type Rgb = readonly [number, number, number];

function srgb(color: string): Rgb {
  const m = /^oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)$/.exec(color);
  if (!m) throw new Error(`Not an opaque oklch colour: ${color}`);
  const [L, C, h] = [Number(m[1]), Number(m[2]), (Number(m[3]) * Math.PI) / 180];
  const [a, b] = [C * Math.cos(h), C * Math.sin(h)];
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mm = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * s,
  ];
  return linear.map((x) => {
    const c = Math.min(1, Math.max(0, x));
    return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
  }) as unknown as Rgb;
}

const over = (top: Rgb, alpha: number, beneath: Rgb): Rgb =>
  top.map((v, i) => v * alpha + beneath[i]! * (1 - alpha)) as unknown as Rgb;

function contrast(x: Rgb, y: Rgb): number {
  const lum = (c: Rgb) => {
    const [r, g, b] = c.map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const [hi, lo] = [lum(x), lum(y)].sort((p, q) => q - p);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** The tints the shared Button's `destructive` variant paints, read from packages/ui. */
function destructiveTints() {
  const button = read('../../ui/src/button.tsx');
  const variant = /destructive:\s*'([^']+)'/.exec(button)?.[1];
  if (!variant) throw new Error('button.tsx has no destructive variant');
  const pct = (prefix: string) => {
    const m = new RegExp(`(?:^|\\s)${prefix}bg-destructive/(\\d+)(?:\\s|$)`).exec(variant);
    if (!m) throw new Error(`destructive variant has no ${prefix}bg-destructive/N`);
    return Number(m[1]) / 100;
  };
  return {
    light: { rest: pct(''), hover: pct('hover:') },
    dark: { rest: pct('dark:'), hover: pct('dark:hover:') },
  };
}

/** How much `muted` a `tile` lays over its ground (the InlineConfirm's surface). */
const tileMuted = (() => {
  const m = /@utility tile \{[^}]*var\(--muted\) (\d+)%/.exec(appCss);
  if (!m) throw new Error('app.css has no tile utility over muted');
  return Number(m[1]) / 100;
})();

describe('Ledger contrast (PRODUCT.md: text 4.5:1 in both themes)', () => {
  const tints = destructiveTints();
  for (const scheme of ['light', 'dark'] as const) {
    const p = palette(scheme);
    const red = srgb(p.destructive);
    // An inline confirm sits on the page or inside a card; in light both are white.
    for (const ground of ['paper', 'card'] as const) {
      const tile = over(srgb(p.muted), tileMuted, srgb(p[ground]));
      for (const state of ['rest', 'hover'] as const) {
        it(`${scheme}: the destructive button's words on its tint over a tile on ${ground}, ${state}`, () => {
          const fill = over(red, tints[scheme][state], tile);
          expect(contrast(red, fill)).toBeGreaterThanOrEqual(4.5);
        });
      }
      it(`${scheme}: destructive text (field errors) on ${ground}`, () => {
        expect(contrast(red, srgb(p[ground]))).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
});
