import { ValidationError } from '../errors';
import type { EntryFields, LocaleCode } from '../types';
import { canonicalJson } from './block-catalog';
import type { BlockConfigIssue } from './block-config';
import type { ContentType } from './content-type';
import {
  BLOCK_KEY,
  BLOCK_TYPE_KEY,
  blockVariants,
  type ComponentVariant,
  variantOf,
} from './field';

/**
 * Locked regions (docs/specs/locked-regions.md): part of one entry's blocks that editors can't
 * restructure. A region is one block, or a run of neighbouring blocks in one slot, named by their
 * `_key`s. The block config's `locked` is a schema rule, true of a slot on every entry of a type;
 * a region is content state, held by one entry beside its fields (never inside them, so delivery,
 * webhooks and exports never see one).
 *
 * Locks are judged like the block config: new edits are refused for what they change in a region,
 * copies are not judged. A lock holds in every locale by `_key`, wherever its run is present; a
 * locale without it is not affected, and a lock held in no locale is stale and blocks nothing.
 *
 * A slot here is what the content model says one is: a blocks field of the block's variant. So a
 * region is checked whether or not the environment has a block catalog or config.
 */

/** One locked region of an entry's blocks. */
export interface BlockLock {
  /** The blocks field (a top-level field apiId) the region is in. */
  readonly field: string;
  /** The region: one block, or a run of neighbours in one slot, in order, by `_key`. */
  readonly keys: readonly string[];
  /** `subtree`: the blocks and everything inside them. `self`: their own slots stay open. */
  readonly depth: BlockLockDepth;
  /** `structure`: no add, remove, move or swap; fields stay editable. `all`: fields frozen too. */
  readonly freeze: BlockLockFreeze;
  /** Who locked it, as the audit trail names them. */
  readonly lockedBy: string;
  readonly lockedAt: string;
}

export const BLOCK_LOCK_DEPTHS = ['subtree', 'self'] as const;
export type BlockLockDepth = (typeof BLOCK_LOCK_DEPTHS)[number];
export const BLOCK_LOCK_FREEZES = ['structure', 'all'] as const;
export type BlockLockFreeze = (typeof BLOCK_LOCK_FREEZES)[number];

export const BLOCK_LOCK_LIMITS = {
  /** Regions one entry holds: far more than a page has sections. */
  locks: 50,
  /** Blocks one region names. */
  keys: 100,
} as const;

/**
 * Why a set of locks is refused, as a stable code: a lock that isn't a lock, keys no locale holds,
 * keys that aren't neighbours in one slot in order, or a block in two regions.
 */
export const BLOCK_LOCK_ISSUE_CODES = [
  'lock_invalid',
  'lock_not_found',
  'lock_not_a_run',
  'lock_overlaps',
] as const;
export type BlockLockIssueCode = (typeof BLOCK_LOCK_ISSUE_CODES)[number];

export interface BlockLockIssue {
  readonly field: string;
  readonly code: BlockLockIssueCode;
  readonly message: string;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const keyOf = (item: unknown): string | undefined => {
  const key = isObject(item) ? item[BLOCK_KEY] : undefined;
  return typeof key === 'string' ? key : undefined;
};

/** A block's id, a former one resolved, so a save that renames `_type` to the new apiId is no swap. */
const typeOf = (variants: readonly ComponentVariant[], item: unknown): string | undefined => {
  const known = variantOf(variants, item)?.apiId;
  if (known) return known;
  const raw = isObject(item) ? item[BLOCK_TYPE_KEY] : undefined;
  return typeof raw === 'string' ? raw : undefined;
};

/** A block's slots: the blocks fields its variant declares. */
const slotsOf = (variants: readonly ComponentVariant[], item: unknown) =>
  (variantOf(variants, item)?.fields ?? []).flatMap((f) => {
    const inner = blockVariants(f);
    return inner ? [{ apiId: f.apiId, variants: inner }] : [];
  });

const own = (item: unknown, apiId: string): unknown =>
  isObject(item) && Object.hasOwn(item, apiId) ? item[apiId] : undefined;

/** Where a block is: the array holding it, its index there, and the path validation names it by. */
interface Found {
  readonly items: readonly unknown[];
  readonly index: number;
  /** The slot's path: `body`, `body[2].items`. */
  readonly path: string;
  readonly variants: readonly ComponentVariant[];
}

/**
 * The first block keyed `key` in one locale's value, depth first. Keys are unique per array, not
 * per tree; a key held at two depths is found where a reader of the page meets it first.
 */
function find(
  value: unknown,
  variants: readonly ComponentVariant[],
  path: string,
  key: string,
): Found | undefined {
  if (!Array.isArray(value)) return undefined;
  const index = value.findIndex((item) => keyOf(item) === key);
  if (index >= 0) return { items: value, index, path, variants };
  for (let i = 0; i < value.length; i++) {
    for (const s of slotsOf(variants, value[i])) {
      const hit = find(own(value[i], s.apiId), s.variants, `${path}[${i}].${s.apiId}`, key);
      if (hit) return hit;
    }
  }
  return undefined;
}

/** The lock's run in one locale's value: found, its keys neighbours in order; else undefined. */
function held(value: unknown, def: TopField, keys: readonly string[]): Found | undefined {
  const [first] = keys;
  if (first === undefined) return undefined;
  const at = find(value, def.variants, def.apiId, first);
  if (!at) return undefined;
  return keys.every((k, i) => keyOf(at.items[at.index + i]) === k) ? at : undefined;
}

/** Every key inside a block's slots, at any depth. */
function inside(item: unknown, variants: readonly ComponentVariant[], out: Set<string>): void {
  for (const s of slotsOf(variants, item)) {
    const children = own(item, s.apiId);
    if (!Array.isArray(children)) continue;
    for (const child of children) {
      const key = keyOf(child);
      if (key !== undefined) out.add(key);
      inside(child, s.variants, out);
    }
  }
}

/** A block's slots as a structure: each child's key and block, in order, all the way down. */
const shape = (item: unknown, variants: readonly ComponentVariant[]): unknown =>
  slotsOf(variants, item).map((s) => {
    const children = own(item, s.apiId);
    return [
      s.apiId,
      Array.isArray(children)
        ? children.map((c) => [
            keyOf(c) ?? null,
            typeOf(s.variants, c) ?? null,
            shape(c, s.variants),
          ])
        : null,
    ];
  });

/**
 * A block's content as a frozen region compares it: `_type` resolved, and with `self` its slots
 * left out (they stay open).
 */
function content(item: unknown, variants: readonly ComponentVariant[], slots: boolean): unknown {
  if (!isObject(item)) return item;
  const out: Record<string, unknown> = { ...item, [BLOCK_TYPE_KEY]: typeOf(variants, item) };
  for (const s of slotsOf(variants, item)) {
    const children = out[s.apiId];
    if (!slots) delete out[s.apiId];
    else if (Array.isArray(children)) {
      out[s.apiId] = children.map((c) => content(c, s.variants, true));
    }
  }
  return out;
}

interface TopField {
  readonly apiId: string;
  readonly variants: readonly ComponentVariant[];
}

/** The top-level blocks field `apiId` of the type, if it is one. */
function topField(contentType: ContentType, apiId: string): TopField | undefined {
  const def = contentType.fields.find((f) => f.apiId === apiId);
  const variants = def ? blockVariants(def) : undefined;
  return def && variants ? { apiId: def.apiId, variants } : undefined;
}

/** The locales of `fields[field]`, each with its value. */
const localesOf = (fields: EntryFields | undefined, field: string) =>
  Object.entries(fields?.[field] ?? {});

/** Whether the lock's run is held in some locale of `fields`: a lock held in none is stale. */
export function isBlockLockHeld(
  contentType: ContentType,
  fields: EntryFields,
  lock: Pick<BlockLock, 'field' | 'keys'>,
): boolean {
  const def = topField(contentType, lock.field);
  return (
    !!def && localesOf(fields, def.apiId).some(([, v]) => held(v, def, lock.keys) !== undefined)
  );
}

/**
 * The locks whose blocks no locale of `fields` holds as their run any more (a schema change removed
 * their block type, or a copy dropped them). A stale lock never blocks a save; anyone who may lock
 * can clear it.
 */
export function staleBlockLocks(
  contentType: ContentType,
  fields: EntryFields,
  locks: readonly BlockLock[],
): BlockLock[] {
  return locks.filter((l) => !isBlockLockHeld(contentType, fields, l));
}

// --- setting locks --------------------------------------------------------------------------------

/** Who sets the locks, and when: what a new lock is stamped with. */
export interface BlockLockStamp {
  readonly by: string;
  readonly at: string;
}

const identity = (l: Pick<BlockLock, 'field' | 'keys' | 'depth' | 'freeze'>) =>
  canonicalJson({ field: l.field, keys: l.keys, depth: l.depth, freeze: l.freeze });

/**
 * Checks a whole new list of locks against the entry's fields and returns it normalized: depth
 * `subtree` and freeze `structure` unless given, and each lock stamped. A lock the entry already
 * holds (same field, keys, depth and freeze) keeps its stamp and is kept even when stale, so a
 * list read, changed and sent back never fails on a stale lock it didn't touch; every other lock
 * must name keys some locale holds as neighbours in one slot, in order. A block belongs to at most
 * one region: two locks naming the same block, or a block inside another's `subtree`, overlap
 * (`lock_overlaps`). Every problem is collected before refusing (422).
 */
export function checkBlockLocks(
  contentType: ContentType,
  fields: EntryFields,
  input: unknown,
  stored: readonly BlockLock[],
  stamp: BlockLockStamp,
): BlockLock[] {
  const issues: BlockLockIssue[] = [];
  const issue = (field: string, code: BlockLockIssueCode, message: string) =>
    issues.push({ field, code, message });
  if (!Array.isArray(input)) {
    throw new ValidationError([
      {
        field: 'locks',
        code: 'lock_invalid',
        message: 'must be a list of locks',
      } as BlockLockIssue,
    ]);
  }
  if (input.length > BLOCK_LOCK_LIMITS.locks) {
    issue('locks', 'lock_invalid', `An entry holds at most ${BLOCK_LOCK_LIMITS.locks} locks`);
  }
  const kept = new Map(stored.map((l) => [identity(l), l]));
  const out: BlockLock[] = [];
  for (const [i, raw] of input.slice(0, BLOCK_LOCK_LIMITS.locks).entries()) {
    const at = `locks[${i}]`;
    if (!isObject(raw)) {
      issue(at, 'lock_invalid', 'must be an object');
      continue;
    }
    const def = typeof raw.field === 'string' ? topField(contentType, raw.field) : undefined;
    if (!def) {
      issue(`${at}.field`, 'lock_invalid', 'must be the apiId of a top-level blocks field');
      continue;
    }
    const keys = raw.keys;
    if (
      !Array.isArray(keys) ||
      keys.length === 0 ||
      keys.length > BLOCK_LOCK_LIMITS.keys ||
      keys.some((k) => typeof k !== 'string' || k === '')
    ) {
      issue(`${at}.keys`, 'lock_invalid', `must list 1 to ${BLOCK_LOCK_LIMITS.keys} block keys`);
      continue;
    }
    if (new Set(keys).size !== keys.length) {
      issue(`${at}.keys`, 'lock_invalid', 'names a block twice');
      continue;
    }
    const depth = raw.depth ?? 'subtree';
    if (!BLOCK_LOCK_DEPTHS.includes(depth as BlockLockDepth)) {
      issue(`${at}.depth`, 'lock_invalid', 'must be "subtree" or "self"');
      continue;
    }
    const freeze = raw.freeze ?? 'structure';
    if (!BLOCK_LOCK_FREEZES.includes(freeze as BlockLockFreeze)) {
      issue(`${at}.freeze`, 'lock_invalid', 'must be "structure" or "all"');
      continue;
    }
    const lock = {
      field: def.apiId,
      keys: keys as string[],
      depth: depth as BlockLockDepth,
      freeze: freeze as BlockLockFreeze,
    };
    const was = kept.get(identity(lock));
    if (!was) {
      const values = localesOf(fields, def.apiId);
      if (!values.some(([, v]) => held(v, def, lock.keys))) {
        const missing = lock.keys.filter(
          (k) => !values.some(([, v]) => find(v, def.variants, def.apiId, k)),
        );
        if (missing.length > 0) {
          issue(
            `${at}.keys`,
            'lock_not_found',
            `No block keyed ${missing
              .slice(0, 10)
              .map((k) => `"${k}"`)
              .join(', ')} in "${def.apiId}"`,
          );
          continue;
        }
        issue(
          `${at}.keys`,
          'lock_not_a_run',
          'The blocks of a region must be neighbours in one slot, in order',
        );
        continue;
      }
    }
    // Field order fixed, so the stored JSON compares as text (the store's compare-and-set).
    out.push({
      ...lock,
      lockedBy: was?.lockedBy ?? stamp.by,
      lockedAt: was?.lockedAt ?? stamp.at,
    });
  }
  if (issues.length === 0) overlaps(contentType, fields, out, issue);
  if (issues.length > 0) throw new ValidationError(issues);
  return out;
}

/** Reports each lock that shares a block with an earlier one, or sits inside one's subtree. */
function overlaps(
  contentType: ContentType,
  fields: EntryFields,
  locks: readonly BlockLock[],
  issue: (field: string, code: BlockLockIssueCode, message: string) => void,
): void {
  // Each lock's blocks, and with `subtree` every block inside them, in any locale holding it.
  const covered = locks.map((l) => {
    const keys = new Set(l.keys);
    const def = topField(contentType, l.field);
    if (!def || l.depth !== 'subtree') return keys;
    for (const [, v] of localesOf(fields, def.apiId)) {
      const at = held(v, def, l.keys);
      if (!at) continue;
      for (let i = 0; i < l.keys.length; i++) inside(at.items[at.index + i], at.variants, keys);
    }
    return keys;
  });
  locks.forEach((l, i) => {
    const other = locks.findIndex(
      (o, j) =>
        j !== i &&
        o.field === l.field &&
        (l.keys.some((k) => covered[j]?.has(k)) || o.keys.some((k) => covered[i]?.has(k))),
    );
    if (other >= 0 && other < i) {
      issue(
        `locks[${i}].keys`,
        'lock_overlaps',
        `Overlaps locks[${other}]: a block belongs to at most one locked region`,
      );
    }
  });
}

// --- judging a save -------------------------------------------------------------------------------

const LOCKED =
  'This region is locked: its blocks can’t be removed, swapped, reordered, split or have blocks inserted between them';
const LOCKED_INSIDE =
  'This region is locked: the blocks inside it can’t be added, removed or moved';
const FROZEN = 'This region is frozen: its content can’t be edited';

/**
 * The issues the entry's locks find with a save from `before` (the stored fields) to `after`, for
 * new edits only, each naming the region's first `_key`. Per lock, in each locale whose stored
 * value holds its run (`locales` limits which):
 *
 * - `region_locked`: a locked block removed or swapped for another block type, a block inserted
 *   into the run, the run reordered or split across slots; with `subtree`, any slot inside a
 *   locked block changed (a child added, removed, moved or swapped, at any depth). The run may
 *   move as a whole: a locked slot it sits in is the block config's to refuse.
 * - `region_frozen`: with `freeze: 'all'`, any field of a locked block changed (with `subtree`,
 *   inside its children too; with `self`, its own slots stay open).
 *
 * A lock no stored locale holds is stale and judges nothing. One issue per lock and locale.
 */
export function blockLockIssues(
  contentType: ContentType,
  locks: readonly BlockLock[],
  before: EntryFields | undefined,
  after: EntryFields,
  locales?: readonly LocaleCode[],
): BlockConfigIssue[] {
  if (!before || locks.length === 0) return [];
  const only = locales ? new Set(locales) : undefined;
  const issues: BlockConfigIssue[] = [];
  for (const lock of locks) {
    const def = topField(contentType, lock.field);
    if (!def) continue;
    const key = lock.keys[0] as string;
    const now = after[def.apiId] ?? {};
    for (const [locale, value] of localesOf(before, def.apiId)) {
      if (only && !only.has(locale)) continue;
      const was = held(value, def, lock.keys);
      if (!was) continue;
      const report = (code: BlockConfigIssue['code'], field: string, message: string) =>
        issues.push({ field, locale, code, key, message });
      const nowValue = Object.hasOwn(now, locale) ? now[locale] : undefined;
      const at = find(nowValue, def.variants, def.apiId, key);
      const pairs = lock.keys.map((_, i) => ({
        before: was.items[was.index + i],
        after: at?.items[at.index + i],
        path: at ? `${at.path}[${at.index + i}]` : `${was.path}[${was.index + i}]`,
      }));
      const intact =
        at !== undefined &&
        pairs.every(
          (p, i) =>
            keyOf(p.after) === lock.keys[i] &&
            typeOf(at.variants, p.after) === typeOf(was.variants, p.before),
        );
      if (!intact) {
        report('region_locked', at ? at.path : was.path, LOCKED);
        continue;
      }
      if (lock.depth === 'subtree') {
        const moved = pairs.find(
          (p) =>
            canonicalJson(shape(p.before, was.variants)) !==
            canonicalJson(shape(p.after, at.variants)),
        );
        if (moved) {
          report('region_locked', moved.path, LOCKED_INSIDE);
          continue;
        }
      }
      if (lock.freeze === 'all') {
        const slots = lock.depth === 'subtree';
        const edited = pairs.find(
          (p) =>
            canonicalJson(content(p.before, was.variants, slots)) !==
            canonicalJson(content(p.after, at.variants, slots)),
        );
        if (edited) report('region_frozen', edited.path, FROZEN);
      }
    }
  }
  return issues;
}

// --- what a set changed ---------------------------------------------------------------------------

/** One lock as the audit trail records it: where and how, never who (the row's actor is). */
export interface BlockLockSummary {
  readonly field: string;
  /** At most ten of its keys. */
  readonly keys: readonly string[];
  /** How many keys it names, when more than are listed. */
  readonly keyCount?: number;
  readonly depth: BlockLockDepth;
  readonly freeze: BlockLockFreeze;
}

/** What one set of an entry's locks changed: the regions locked and the ones unlocked. */
export interface BlockLockChange {
  readonly entryId: string;
  readonly locked: readonly BlockLockSummary[];
  readonly unlocked: readonly BlockLockSummary[];
}

const SUMMARY_KEYS = 10;
const SUMMARY_LOCKS = 10;

const summary = (l: BlockLock): BlockLockSummary => ({
  field: l.field,
  keys: l.keys.slice(0, SUMMARY_KEYS),
  ...(l.keys.length > SUMMARY_KEYS ? { keyCount: l.keys.length } : {}),
  depth: l.depth,
  freeze: l.freeze,
});

/** What `next` locks and unlocks from `previous`, at most ten of each. */
export function diffBlockLocks(
  entryId: string,
  previous: readonly BlockLock[],
  next: readonly BlockLock[],
): BlockLockChange {
  const was = new Set(previous.map(identity));
  const now = new Set(next.map(identity));
  return {
    entryId,
    locked: next
      .filter((l) => !was.has(identity(l)))
      .slice(0, SUMMARY_LOCKS)
      .map(summary),
    unlocked: previous
      .filter((l) => !now.has(identity(l)))
      .slice(0, SUMMARY_LOCKS)
      .map(summary),
  };
}

/** Whether two lists hold the same locks, in the same order. */
export const sameBlockLocks = (a: readonly BlockLock[], b: readonly BlockLock[]): boolean =>
  canonicalJson(a.map(identity)) === canonicalJson(b.map(identity));
