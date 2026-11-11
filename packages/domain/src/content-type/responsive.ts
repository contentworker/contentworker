import type { EntryFields } from '../types';
import {
  type Breakpoint,
  blockVariants,
  type ComponentVariant,
  type FieldDefinition,
  isValidApiId,
  RESPONSIVE_KEY,
  variantNamed,
  variantOf,
} from './field';

/**
 * Per-breakpoint overrides (docs/specs/breakpoint-overrides.md): a block's token prop taking a
 * different value from some screen width up, stored beside the props it overrides:
 *
 * ```json
 * { "_type": "hero", "_key": "…", "size": "md", "_responsive": { "lg": { "size": "xl" } } }
 * ```
 *
 * The bare prop is the base and stays what it was, so a frontend that knows nothing of
 * breakpoints renders the base and keeps working. Breakpoints are the site's CSS, declared in code
 * on the catalog push and written onto each target blocks field (`items.breakpoints`); the blocks
 * fields inside its blocks take the same ones. A block opts props in with `responsive` on its
 * variant. So validation needs only the content type, never the catalog.
 *
 * An override is stale when its breakpoint is no longer declared, or its prop no longer listed in
 * `responsive`: a later push removed it. A stale override never fails a save: validation passes
 * over it, the save drops it (`cleanOverrides`, in `assignBlockKeys`, the step that rewrites an
 * aliased `_type`), and reads serve it as stored until then.
 */

/** What the bare props are called beside the breakpoints: never a breakpoint's id. */
export const BASE_BREAKPOINT = 'base';

export const BREAKPOINT_LIMITS = {
  /** Breakpoints one catalog declares. */
  count: 6,
  minWidth: 1,
  /** CSS pixels. */
  maxWidth: 10_000,
  name: 100,
} as const;

type Issue = (field: string, message: string) => void;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Checks a breakpoints list and returns it normalized (unknown keys dropped); absent is none.
 * Each id is a letter, then letters, digits or `_`, never `base`, used once; each `minWidth` a
 * whole number of CSS pixels from 1 to 10,000, strictly increasing in list order; at most
 * {@link BREAKPOINT_LIMITS}.count. Issues name the place in the file (`breakpoints[1].minWidth`).
 */
export function checkBreakpoints(raw: unknown, at: string, issue: Issue): Breakpoint[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    issue(at, 'must be a list of { id, name, minWidth }');
    return [];
  }
  if (raw.length > BREAKPOINT_LIMITS.count) {
    issue(at, `A catalog declares at most ${BREAKPOINT_LIMITS.count} breakpoints`);
  }
  const out: Breakpoint[] = [];
  raw.forEach((b, i) => {
    const where = `${at}[${i}]`;
    if (!isObject(b)) {
      issue(where, 'must be an object');
      return;
    }
    const id = b.id;
    if (typeof id !== 'string' || !isValidApiId(id)) {
      issue(
        `${where}.id`,
        `"${String(id)}" is not a valid id (a letter, then letters, digits or _)`,
      );
      return;
    }
    if (id === BASE_BREAKPOINT) {
      issue(`${where}.id`, '"base" names the bare props, so it is never a breakpoint id');
      return;
    }
    if (out.some((o) => o.id === id)) issue(`${where}.id`, `Breakpoint "${id}" is declared twice`);
    const name = b.name;
    if (typeof name !== 'string' || name.trim() === '') {
      issue(`${where}.name`, 'must be a non-empty string');
      return;
    }
    if (name.length > BREAKPOINT_LIMITS.name) {
      issue(`${where}.name`, `must be at most ${BREAKPOINT_LIMITS.name} characters`);
    }
    const minWidth = b.minWidth;
    if (
      typeof minWidth !== 'number' ||
      !Number.isInteger(minWidth) ||
      minWidth < BREAKPOINT_LIMITS.minWidth ||
      minWidth > BREAKPOINT_LIMITS.maxWidth
    ) {
      issue(
        `${where}.minWidth`,
        `must be a whole number of CSS pixels from ${BREAKPOINT_LIMITS.minWidth} to ${BREAKPOINT_LIMITS.maxWidth}`,
      );
      return;
    }
    const previous = out[out.length - 1];
    if (previous && minWidth <= previous.minWidth) {
      issue(
        `${where}.minWidth`,
        `must be more than the breakpoint before it ("${previous.id}", ${previous.minWidth}): breakpoints are listed mobile-first`,
      );
    }
    out.push({ id, name, minWidth });
  });
  return out;
}

/**
 * Why `field` can't take overrides, or null when it can: a token (a Symbol, Integer or Number
 * with `validations.in`) or a Boolean. Text, numbers without `in`, links, assets and slots can't.
 */
export function responsivePropProblem(field: FieldDefinition | undefined): string | null {
  if (!field) return 'is not a top-level prop of the block';
  if (field.type === 'Boolean') return null;
  const tokens = Array.isArray(field.validations?.in) && field.validations.in.length > 0;
  if ((field.type === 'Symbol' || field.type === 'Integer' || field.type === 'Number') && tokens) {
    return null;
  }
  return 'must be a token (a Symbol, Integer or Number with validations.in) or a Boolean';
}

/**
 * Checks a block's `responsive` list against its fields: each a top-level prop that can take
 * overrides, listed once. Undefined when absent or empty (the block takes none). Issues name the
 * entry (`blocks[hero].responsive[1]`).
 */
export function checkResponsive(
  raw: unknown,
  fields: readonly FieldDefinition[],
  at: string,
  issue: Issue,
): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    issue(at, 'must be a list of the prop apiIds that take overrides');
    return undefined;
  }
  const out: string[] = [];
  raw.forEach((name, i) => {
    const where = `${at}[${i}]`;
    if (typeof name !== 'string') {
      issue(where, 'must be a prop apiId');
      return;
    }
    if (out.includes(name)) {
      issue(where, `"${name}" is listed twice`);
      return;
    }
    const problem = responsivePropProblem(fields.find((f) => f.apiId === name));
    if (problem) issue(where, `"${name}" ${problem}`);
    else out.push(name);
  });
  return out.length > 0 ? out : undefined;
}

/**
 * The breakpoint ids a blocks field takes overrides at: its own, else those of the blocks field
 * it sits under (`inherited`; none at an entry's top level).
 */
export function breakpointIdsOf(
  field: FieldDefinition,
  inherited: readonly string[] = [],
): readonly string[] {
  const own = field.items?.breakpoints;
  return Array.isArray(own) ? own.map((b) => b.id) : inherited;
}

/** The breakpoints a blocks field declares, in order; none when it declares none. */
export function breakpointsOf(field: FieldDefinition): readonly Breakpoint[] {
  const own = field.items?.breakpoints;
  return Array.isArray(own) ? own : [];
}

/** The props of `variant` that take overrides. */
export const responsivePropsOf = (variant: ComponentVariant | undefined): readonly string[] =>
  Array.isArray(variant?.responsive) ? variant.responsive : [];

/**
 * A block's `_responsive` as a save stores it: stale overrides dropped (a breakpoint `breakpoints`
 * doesn't declare, a prop `variant` doesn't list), then empty breakpoints, and undefined when
 * nothing is left. An override whose value is not a map is kept for validation to refuse; a map
 * that isn't an object is returned as it is, for the same reason. Never mutates `raw`.
 */
export function cleanOverrides(
  variant: ComponentVariant,
  raw: unknown,
  breakpoints: readonly string[],
): unknown {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) return raw;
  const props = responsivePropsOf(variant);
  const out: Record<string, unknown> = {};
  for (const [bp, overrides] of Object.entries(raw)) {
    if (!breakpoints.includes(bp)) continue;
    if (!isObject(overrides)) {
      out[bp] = overrides;
      continue;
    }
    const kept = Object.entries(overrides).filter(([prop]) => props.includes(prop));
    if (kept.length > 0) out[bp] = Object.fromEntries(kept);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** One block whose override a revision makes stale: what the catalog push reports. */
export interface StaleOverrideUse {
  /** The block's id (its variant's apiId, as the type had it). */
  readonly block: string;
  readonly breakpoint: string;
  readonly prop: string;
}

/**
 * True when `after` drops a breakpoint from a blocks field `before` declared, or a prop from a
 * surviving variant's `responsive`: only then can a revision make a stored override stale.
 */
export function narrowsOverrides(
  before: readonly FieldDefinition[],
  after: readonly FieldDefinition[],
): boolean {
  const walk = (
    prev: readonly FieldDefinition[] | undefined,
    next: readonly FieldDefinition[] | undefined,
    bpPrev: readonly string[],
    bpNext: readonly string[],
  ): boolean => {
    for (const f of prev ?? []) {
      const g = next?.find((n) => n.apiId === f.apiId);
      if (!g) continue;
      const variants = blockVariants(f);
      if (variants) {
        const ownPrev = breakpointIdsOf(f, bpPrev);
        const ownNext = breakpointIdsOf(g, bpNext);
        const kept = blockVariants(g) ?? [];
        for (const v of variants) {
          const survivor = variantNamed(kept, v.apiId);
          if (!survivor) continue;
          const props = responsivePropsOf(v);
          if (props.length > 0 && ownPrev.some((bp) => !ownNext.includes(bp))) return true;
          if (props.some((p) => !responsivePropsOf(survivor).includes(p))) return true;
          if (walk(v.fields, survivor.fields, ownPrev, ownNext)) return true;
        }
      } else if (f.type === 'Component') {
        if (walk(f.fields, g.fields, bpPrev, bpNext)) return true;
      } else if (f.type === 'Array' && f.items?.type === 'Component') {
        if (walk(f.items.fields, g.items?.fields, bpPrev, bpNext)) return true;
      }
    }
    return false;
  };
  return walk(before, after, [], []);
}

/**
 * The overrides in `values` that are in force under `before` (the definitions they were written
 * against) and stale under `after`, one per block, breakpoint and prop, every locale. A block
 * whose variant `after` removes is left out: the push reports (and refuses) that removal itself.
 */
export function staleOverrideUses(
  before: readonly FieldDefinition[],
  after: readonly FieldDefinition[],
  values: EntryFields,
): StaleOverrideUse[] {
  const uses: StaleOverrideUse[] = [];
  const visit = (
    f: FieldDefinition,
    g: FieldDefinition | undefined,
    value: unknown,
    bpPrev: readonly string[],
    bpNext: readonly string[],
  ): void => {
    if (value === undefined || value === null) return;
    const variants = blockVariants(f);
    if (variants) {
      if (!Array.isArray(value)) return;
      const ownPrev = breakpointIdsOf(f, bpPrev);
      const ownNext = g ? breakpointIdsOf(g, bpNext) : [];
      const kept = g ? (blockVariants(g) ?? []) : [];
      for (const item of value) {
        const variant = variantOf(variants, item);
        if (!variant || !isObject(item)) continue;
        const survivor = variantNamed(kept, variant.apiId);
        if (!survivor) continue;
        const raw = item[RESPONSIVE_KEY];
        if (isObject(raw)) {
          for (const [bp, overrides] of Object.entries(raw)) {
            if (!ownPrev.includes(bp) || !isObject(overrides)) continue;
            for (const prop of Object.keys(overrides)) {
              if (!responsivePropsOf(variant).includes(prop)) continue;
              if (!ownNext.includes(bp) || !responsivePropsOf(survivor).includes(prop)) {
                uses.push({ block: variant.apiId, breakpoint: bp, prop });
              }
            }
          }
        }
        visitObject(variant.fields, survivor.fields, item, ownPrev, ownNext);
      }
    } else if (f.type === 'Component') {
      visitObject(f.fields ?? [], g?.fields, value, bpPrev, bpNext);
    } else if (f.type === 'Array' && f.items?.type === 'Component' && Array.isArray(value)) {
      for (const item of value)
        visitObject(f.items.fields ?? [], g?.items?.fields, item, bpPrev, bpNext);
    }
  };
  const visitObject = (
    prev: readonly FieldDefinition[],
    next: readonly FieldDefinition[] | undefined,
    value: unknown,
    bpPrev: readonly string[],
    bpNext: readonly string[],
  ): void => {
    if (!isObject(value)) return;
    for (const f of prev) {
      visit(
        f,
        next?.find((n) => n.apiId === f.apiId),
        value[f.apiId],
        bpPrev,
        bpNext,
      );
    }
  };
  for (const f of before) {
    const g = after.find((n) => n.apiId === f.apiId);
    for (const value of Object.values(values[f.apiId] ?? {})) visit(f, g, value, [], []);
  }
  return uses;
}
