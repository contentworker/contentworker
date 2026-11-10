/**
 * Locked regions in the editors (docs/specs/locked-regions.md): part of one entry's blocks that
 * editors can't restructure, one block and everything inside it, or a run of neighbours in one
 * slot. The locks are the entry's (`GET …/entries/:id/block-locks`); this says, for the canvas and
 * the entry form alike, what they mean for each block on screen, and builds the list a Lock or an
 * Unlock sends back.
 *
 * Presentation only. The server judges every save against the locks it holds
 * (`region_locked`, `region_frozen`) and every lock set (`lock_not_a_run`, `lock_overlaps`, …);
 * here the screens only stop offering what it would refuse. A lock holds in every locale by
 * `_key`, wherever its run is present, so a view is per locale: a locale without the run isn't
 * affected.
 *
 * Pure: the screens fetch the locks and hold the fields, and draw what this says.
 */
import {
  BLOCK_KEY,
  type BlockConfigIssue,
  type BlockLockDepth,
  type BlockLockFreeze,
  blockVariants,
  type ComponentVariant,
  type ContentType,
  type EntryFields,
  SCOPES,
  variantOf,
} from '@contentworker/domain';
import { type ActorDirectory, actorLabel } from './authorship';
import {
  ApiError,
  type BlockLockInput,
  type EntryBlockLock,
  type PrincipalInfo,
} from './management';

/** One region on screen: its lock, and where it is in the entry's list. */
export interface LockRegion {
  readonly lock: EntryBlockLock;
  /** Its place in the entry's locks: stable for one read of them. */
  readonly index: number;
}

/** What a lock means for one block. */
export interface BlockLockMark {
  readonly region: LockRegion;
  /** One of the region's own blocks (its lock names it); else inside one locked with `subtree`. */
  readonly own: boolean;
  /** Its own fields can't be edited (`freeze: 'all'`). */
  readonly frozen: boolean;
  /** Its slots take no block in or out, and none moves (`subtree`). */
  readonly sealed: boolean;
}

/** The entry's locks in one locale, by block. */
export interface LockView {
  /** The regions held in this locale, in the entry's order. */
  readonly regions: readonly LockRegion[];
  readonly marks: ReadonlyMap<string, BlockLockMark>;
}

export const NO_LOCKS: LockView = { regions: [], marks: new Map() };

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const keyOf = (item: unknown): string | undefined => {
  const key = isObject(item) ? item[BLOCK_KEY] : undefined;
  return typeof key === 'string' ? key : undefined;
};

/** A block's slots: its variant's blocks fields. */
const slotsOf = (variants: readonly ComponentVariant[], item: unknown) =>
  (variantOf(variants, item)?.fields ?? []).flatMap((f) => {
    const inner = blockVariants(f);
    return inner && isObject(item) ? [{ value: item[f.apiId], variants: inner }] : [];
  });

interface Found {
  readonly items: readonly unknown[];
  readonly index: number;
  readonly variants: readonly ComponentVariant[];
}

/** The block keyed `key`, found as the domain finds it (this array first, then each slot). */
function find(
  value: unknown,
  variants: readonly ComponentVariant[],
  key: string,
): Found | undefined {
  if (!Array.isArray(value)) return undefined;
  const index = value.findIndex((item) => keyOf(item) === key);
  if (index >= 0) return { items: value, index, variants };
  for (const item of value) {
    for (const s of slotsOf(variants, item)) {
      const hit = find(s.value, s.variants, key);
      if (hit) return hit;
    }
  }
  return undefined;
}

/** Every block inside a block's slots, at any depth, by key. */
function eachInside(
  item: unknown,
  variants: readonly ComponentVariant[],
  on: (key: string) => void,
) {
  for (const s of slotsOf(variants, item)) {
    if (!Array.isArray(s.value)) continue;
    for (const child of s.value) {
      const key = keyOf(child);
      if (key !== undefined) on(key);
      eachInside(child, s.variants, on);
    }
  }
}

/**
 * The entry's locks in `locale` (a field that isn't localized is read in `defaultLocale`), from
 * the fields as they are now: each lock whose run is there, its blocks and, with `subtree`, every
 * block inside them. A lock whose run isn't there (stale, or another locale's) marks nothing.
 */
export function lockView(
  contentType: Pick<ContentType, 'fields'>,
  locks: readonly EntryBlockLock[] | undefined,
  fields: EntryFields,
  locale: string,
  defaultLocale: string,
): LockView {
  if (!locks || locks.length === 0) return NO_LOCKS;
  const regions: LockRegion[] = [];
  const marks = new Map<string, BlockLockMark>();
  locks.forEach((lock, index) => {
    const def = contentType.fields.find((f) => f.apiId === lock.field);
    const variants = def ? blockVariants(def) : undefined;
    const [first] = lock.keys;
    if (!def || !variants || first === undefined) return;
    const value = fields[def.apiId]?.[def.localized ? locale : defaultLocale];
    const at = find(value, variants, first);
    if (!at || !lock.keys.every((k, i) => keyOf(at.items[at.index + i]) === k)) return;
    const region: LockRegion = { lock, index };
    regions.push(region);
    const frozen = lock.freeze === 'all';
    const sealed = lock.depth === 'subtree';
    lock.keys.forEach((key, i) => {
      marks.set(key, { region, own: true, frozen, sealed });
      if (!sealed) return;
      eachInside(at.items[at.index + i], at.variants, (inner) => {
        if (!marks.has(inner)) marks.set(inner, { region, own: false, frozen, sealed: true });
      });
    });
  });
  return regions.length === 0 ? NO_LOCKS : { regions, marks };
}

/** Whether two neighbouring blocks are of one run: nothing may go between them. */
export function sameRun(view: LockView, before: string | undefined, after: string | undefined) {
  if (before === undefined || after === undefined) return false;
  const a = view.marks.get(before);
  const b = view.marks.get(after);
  return !!a?.own && !!b?.own && a.region === b.region;
}

/** Whether `key` is one of a run of more than one block: a neighbour moving past it lands inside. */
export function inLongRun(view: LockView, key: string | undefined): boolean {
  const mark = key === undefined ? undefined : view.marks.get(key);
  return !!mark?.own && mark.region.lock.keys.length > 1;
}

// --- who may lock ---------------------------------------------------------------------------------

/**
 * Whether the signed-in person may lock and unlock regions on entries of `contentType`: the
 * `lock` action there, as the api resolves their grants (`contentActions` on the space's
 * `auth/me`), and `content:write`, which the set's route takes. Unknown until both are read.
 */
export function canLock(access: PrincipalInfo | undefined, contentType: string): boolean {
  const actions = access?.contentActions;
  if (!access || !actions || !access.scopes.includes(SCOPES.contentWrite)) return false;
  // Own keys only: a type named `constructor` mustn't read the object's prototype.
  const held = Object.hasOwn(actions.types, contentType)
    ? actions.types[contentType]
    : actions.others;
  return !!held?.includes('lock');
}

// --- what a lock or an unlock sends ---------------------------------------------------------------

/** A lock as a set sends it back: who and when stay the server's (a held lock keeps its stamp). */
const input = (l: EntryBlockLock | BlockLockInput): BlockLockInput => ({
  field: l.field,
  keys: l.keys,
  depth: l.depth,
  freeze: l.freeze,
});

/** The list with `lock` added: what Lock sends. */
export function withLock(locks: readonly EntryBlockLock[], lock: BlockLockInput): BlockLockInput[] {
  return [...locks.map(input), input(lock)];
}

/** The list without `lock`: what Unlock (or Clear, for a stale one) sends. */
export function withoutLock(
  locks: readonly EntryBlockLock[],
  lock: EntryBlockLock,
): BlockLockInput[] {
  const id = lockId(lock);
  return locks.filter((l) => lockId(l) !== id).map(input);
}

/** A lock's identity, as the server matches one it holds: field, keys, depth and freeze. */
export const lockId = (l: Pick<EntryBlockLock, 'field' | 'keys' | 'depth' | 'freeze'>): string =>
  JSON.stringify([l.field, l.keys, l.depth, l.freeze]);

/** The lock a new one from the canvas would be: `subtree` and `structure` unless chosen. */
export function newLock(
  field: string,
  keys: readonly string[],
  depth: BlockLockDepth = 'subtree',
  freeze: BlockLockFreeze = 'structure',
): BlockLockInput {
  return { field, keys, depth, freeze };
}

// --- words ----------------------------------------------------------------------------------------

/** "Locked by You · Nov 9, 2026"; "Locked · Nov 9, 2026" when who isn't shown to this reader. */
export function lockedLine(lock: EntryBlockLock, directory: ActorDirectory = {}): string {
  const at = Date.parse(lock.lockedAt);
  const when = Number.isNaN(at)
    ? ''
    : ` · ${new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(at)}`;
  return lock.lockedBy
    ? `Locked by ${actorLabel(lock.lockedBy, directory, 'inSentence')}${when}`
    : `Locked${when}`;
}

/** What a region keeps, in a sentence: the block config's lock line, in a region's words. */
export function lockSays(mark: BlockLockMark, name: string): string {
  if (!mark.own) {
    return mark.frozen
      ? `${name} is inside a locked region: it keeps its place, and its content can’t be edited.`
      : `${name} is inside a locked region: it keeps its place. Its settings can still be edited.`;
  }
  const { depth, freeze } = mark.region.lock;
  const inside = depth === 'subtree' ? ', and so does everything inside it' : '';
  return freeze === 'all'
    ? `${name} is locked: it keeps its place${inside}, and its content can’t be edited.`
    : `${name} is locked: it keeps its place${inside}. Its settings can still be edited.`;
}

/** Why a lock set was refused (422), in the inspector's words; empty for any other failure. */
export function lockRefusal(err: unknown): string[] {
  if (!(err instanceof ApiError) || err.status !== 422) return [];
  const issues = (err.body as { error?: { issues?: unknown } } | undefined)?.error?.issues;
  if (!Array.isArray(issues)) return [];
  return issues.flatMap((i) => {
    const code = isObject(i) ? i.code : undefined;
    const message = isObject(i) && typeof i.message === 'string' ? i.message : undefined;
    switch (code) {
      case 'lock_not_a_run':
        return ['These blocks aren’t neighbours in one slot any more. Select them again.'];
      case 'lock_overlaps':
        return ['Part of this is already in a locked region. Unlock that first.'];
      case 'lock_not_found':
        return ['Some of these blocks aren’t saved yet. Save the draft, then lock them.'];
      case 'lock_ambiguous':
        return [
          'Another block has the same key as one of these, so the lock can’t tell them apart.',
        ];
      case 'lock_invalid':
        return message ? [message] : [];
      default:
        return [];
    }
  });
}

/** Whether a refused save's issues are all a locked region's (not the block config's). */
export const regionRefusal = (issues: readonly BlockConfigIssue[]): boolean =>
  issues.length > 0 &&
  issues.every((i) => i.code === 'region_locked' || i.code === 'region_frozen');
