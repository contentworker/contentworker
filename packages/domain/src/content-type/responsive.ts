import type { FieldIssue } from '../errors';
import type { EntryFields } from '../types';
import {
  type Breakpoint,
  blockVariants,
  type ComponentVariant,
  type FieldDefinition,
  isValidApiId,
  optionValue,
  RESPONSIVE_KEY,
  ruleMessage,
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
 * Why `value` can't be an override of `field` (a token or a Boolean), or null when it can: the
 * prop's type and its `in` list, as validation checks the prop itself.
 */
export function overrideValueProblem(field: FieldDefinition, value: unknown): string | null {
  if (value === undefined || value === null) {
    return 'An override needs a value: leave the prop out to inherit';
  }
  switch (field.type) {
    case 'Boolean':
      return typeof value === 'boolean' ? null : 'Expected a boolean';
    case 'Symbol':
      if (typeof value !== 'string') return 'Expected a string';
      break;
    case 'Integer':
      if (typeof value !== 'number' || !Number.isInteger(value)) return 'Expected an integer';
      break;
    case 'Number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return 'Expected a number';
      break;
    default:
      return `A ${field.type} prop takes no overrides`;
  }
  const v = field.validations;
  if (!Array.isArray(v?.in)) return null;
  const allowed = v.in.map(optionValue);
  return allowed.includes(value as string | number)
    ? null
    : (ruleMessage(v, 'in') ?? `Value must be one of: ${allowed.join(', ')}`);
}

/** The variant's field for a prop that takes overrides, if `prop` is one. */
const responsiveField = (variant: ComponentVariant, prop: string): FieldDefinition | undefined =>
  responsivePropsOf(variant).includes(prop)
    ? variant.fields.find((f) => f.apiId === prop)
    : undefined;

/**
 * A block's `_responsive` as a save stores it: stale overrides dropped (a breakpoint `breakpoints`
 * doesn't declare, a prop `variant` doesn't list, a value its prop no longer takes since a push
 * narrowed its `in` or retyped it), then empty breakpoints, and undefined when nothing is left.
 * A new edit's overrides were judged before this runs (`undeclaredOverrides`), so all it drops is
 * what a block carried. A breakpoint whose value is not a map is kept for validation to refuse; a
 * `_responsive` that isn't an object is returned as it is, for the same reason. Never mutates
 * `raw`.
 */
export function cleanOverrides(
  variant: ComponentVariant,
  raw: unknown,
  breakpoints: readonly string[],
): unknown {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) return raw;
  const out: Record<string, unknown> = {};
  for (const [bp, overrides] of Object.entries(raw)) {
    if (!breakpoints.includes(bp)) continue;
    if (!isObject(overrides)) {
      out[bp] = overrides;
      continue;
    }
    const kept = Object.entries(overrides).filter(([prop, value]) => {
      const field = responsiveField(variant, prop);
      return field !== undefined && overrideValueProblem(field, value) === null;
    });
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
  /** Which block: its place in the walk of these values (every locale), from 0. */
  readonly site: number;
}

/**
 * True when `after` drops a breakpoint from a blocks field `before` declared, drops a prop from a
 * surviving variant's `responsive`, or changes such a prop's type or `in` list: only then can a
 * revision make a stored override stale.
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
          // The type and the set of values it takes: relabelling or reordering options moves no
          // override, so it scans nothing.
          const shape = (f: FieldDefinition | undefined) =>
            JSON.stringify([
              f?.type,
              Array.isArray(f?.validations?.in)
                ? [...new Set(f.validations.in.map((o) => JSON.stringify(optionValue(o))))].sort()
                : null,
            ]);
          for (const p of props) {
            const was = v.fields.find((f) => f.apiId === p);
            if (shape(was) !== shape(survivor.fields.find((f) => f.apiId === p))) return true;
          }
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
 * against) and stale under `after` (breakpoint or prop removed, or a value the prop no longer
 * takes), one per block, breakpoint and prop, every locale. A block whose variant `after` removes
 * is left out: the push reports (and refuses) that removal itself.
 */
export function staleOverrideUses(
  before: readonly FieldDefinition[],
  after: readonly FieldDefinition[],
  values: EntryFields,
): StaleOverrideUse[] {
  const uses: StaleOverrideUse[] = [];
  let sites = 0;
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
        const site = sites++;
        if (isObject(raw)) {
          for (const [bp, overrides] of Object.entries(raw)) {
            if (!ownPrev.includes(bp) || !isObject(overrides)) continue;
            for (const [prop, value] of Object.entries(overrides)) {
              const was = responsiveField(variant, prop);
              if (!was || overrideValueProblem(was, value) !== null) continue;
              const now = ownNext.includes(bp) ? responsiveField(survivor, prop) : undefined;
              if (!now || overrideValueProblem(now, value) !== null) {
                uses.push({ block: variant.apiId, breakpoint: bp, prop, site });
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

/** An override a new edit sends that can't be one: a typo or a bad value, never a stale one. */
export interface UndeclaredOverrideIssue extends FieldIssue {
  /** `override_undeclared`: no such breakpoint or responsive prop. `override_invalid`: a value its prop doesn't take. */
  readonly code: 'override_undeclared' | 'override_invalid';
  /** The block it is on, by `_key`, when it has one. */
  readonly key?: string;
}

/**
 * The overrides a new edit sends that can't be kept: `base` or a malformed breakpoint id, a
 * breakpoint the field doesn't declare, a prop the block's variant doesn't list in `responsive`
 * (each `override_undeclared`, at the block and breakpoint: `body[0]._responsive.xl`), and a
 * value its prop doesn't take (`override_invalid`, at the prop). Each is a mistake in what was
 * sent, so a write refuses it; the save would otherwise drop it unsaid (`cleanOverrides`).
 *
 * Unless it is stale: an override of the same block type, breakpoint and prop (and, for a value,
 * the same value) that the version the edit replaces (`before`) holds anywhere, in any field and
 * locale. That one came from stored content (a block moved, duplicated, re-inserted by an undo,
 * copied to another locale, carried back by a client), so it passes and the save drops it.
 * `after` is the edit as sent, before that drop; a `_responsive` or breakpoint value that isn't a
 * map is validation's to refuse.
 */
export function undeclaredOverrides(
  contentType: { readonly fields: readonly FieldDefinition[] },
  after: EntryFields,
  before: EntryFields | undefined,
): UndeclaredOverrideIssue[] {
  const issues: UndeclaredOverrideIssue[] = [];
  const carried = carriedOverrides(contentType, before);
  for (const top of contentType.fields) {
    for (const [locale, value] of Object.entries(after[top.apiId] ?? {})) {
      walkBlocks(top, value, top.apiId, [], (variant, item, at, breakpoints) => {
        const raw = item[RESPONSIVE_KEY];
        if (!isObject(raw)) return;
        const key = typeof item._key === 'string' && item._key !== '' ? item._key : undefined;
        const props = responsivePropsOf(variant);
        const tag = { locale, ...(key !== undefined ? { key } : {}) };
        for (const [bp, overrides] of Object.entries(raw)) {
          const malformed = bp === BASE_BREAKPOINT || !isValidApiId(bp);
          const why = () =>
            malformed
              ? `"${bp}" is not a breakpoint id: the bare props are the base`
              : breakpoints.length === 0
                ? `"${variant.apiId}" blocks here take no per-breakpoint overrides: this field has no breakpoints`
                : `No breakpoint "${bp}" (one of: ${breakpoints.join(', ')})`;
          if (!isObject(overrides)) {
            // At a declared breakpoint, validation refuses it; anywhere else the save would drop
            // it unsaid, so it is refused here unless the stored entry held it.
            if (
              (malformed || !breakpoints.includes(bp)) &&
              !carried.has(carriedKey(variant.apiId, bp, ''))
            ) {
              issues.push({
                field: `${at}.${RESPONSIVE_KEY}.${bp}`,
                ...tag,
                code: 'override_undeclared',
                message: why(),
              });
            }
            continue;
          }
          const unknown: string[] = [];
          for (const [prop, v] of Object.entries(overrides)) {
            const pair = carriedKey(variant.apiId, bp, prop);
            const field = breakpoints.includes(bp) ? responsiveField(variant, prop) : undefined;
            if (!field) {
              if (!carried.has(pair)) unknown.push(prop);
              continue;
            }
            const problem = overrideValueProblem(field, v);
            if (problem && !carried.has(`${pair}\u0000${JSON.stringify(v)}`)) {
              issues.push({
                field: `${at}.${RESPONSIVE_KEY}.${bp}.${prop}`,
                ...tag,
                code: 'override_invalid',
                message: problem,
              });
            }
          }
          if (unknown.length === 0) continue;
          const named = unknown.map((p) => `"${p}"`).join(', ');
          issues.push({
            field: `${at}.${RESPONSIVE_KEY}.${bp}`,
            ...tag,
            code: 'override_undeclared',
            message:
              malformed || !breakpoints.includes(bp)
                ? why()
                : `${named} ${unknown.length === 1 ? 'is' : 'are'} not responsive on "${variant.apiId}" blocks${props.length ? ` (one of: ${props.join(', ')})` : ''}`,
          });
        }
      });
    }
  }
  return issues;
}

const carriedKey = (block: string, bp: string, prop: string) => `${block}\u0000${bp}\u0000${prop}`;

/**
 * Every override the stored entry holds, anywhere: block type (its current id), breakpoint and
 * prop, and the same with the value, for telling a stale override from a new one.
 */
function carriedOverrides(
  contentType: { readonly fields: readonly FieldDefinition[] },
  before: EntryFields | undefined,
): Set<string> {
  const carried = new Set<string>();
  if (!before) return carried;
  for (const top of contentType.fields) {
    for (const value of Object.values(before[top.apiId] ?? {})) {
      walkBlocks(top, value, top.apiId, [], (variant, item) => {
        const raw = item[RESPONSIVE_KEY];
        if (!isObject(raw)) return;
        for (const [bp, overrides] of Object.entries(raw)) {
          if (!isObject(overrides)) {
            carried.add(carriedKey(variant.apiId, bp, ''));
            continue;
          }
          for (const [prop, v] of Object.entries(overrides)) {
            const pair = carriedKey(variant.apiId, bp, prop);
            carried.add(pair);
            carried.add(`${pair}\u0000${JSON.stringify(v)}`);
          }
        }
      });
    }
  }
  return carried;
}

/**
 * Calls `visit` on every block under `field`'s value with its variant, its path (as validation
 * names it) and the breakpoint ids its blocks field takes; blocks naming no variant are skipped.
 */
function walkBlocks(
  field: FieldDefinition,
  value: unknown,
  at: string,
  inherited: readonly string[],
  visit: (
    variant: ComponentVariant,
    item: Record<string, unknown>,
    at: string,
    breakpoints: readonly string[],
  ) => void,
): void {
  if (value === undefined || value === null) return;
  const variants = blockVariants(field);
  const visitObject = (
    fields: readonly FieldDefinition[],
    v: unknown,
    path: string,
    bps: readonly string[],
  ) => {
    if (!isObject(v)) return;
    for (const f of fields) walkBlocks(f, v[f.apiId], `${path}.${f.apiId}`, bps, visit);
  };
  if (variants) {
    if (!Array.isArray(value)) return;
    const own = breakpointIdsOf(field, inherited);
    value.forEach((item, i) => {
      const variant = variantOf(variants, item);
      if (!variant || !isObject(item)) return;
      visit(variant, item, `${at}[${i}]`, own);
      visitObject(variant.fields, item, `${at}[${i}]`, own);
    });
  } else if (field.type === 'Component') {
    visitObject(field.fields ?? [], value, at, inherited);
  } else if (field.type === 'Array' && field.items?.type === 'Component' && Array.isArray(value)) {
    value.forEach((item, i) => {
      visitObject(field.items?.fields ?? [], item, `${at}[${i}]`, inherited);
    });
  }
}
