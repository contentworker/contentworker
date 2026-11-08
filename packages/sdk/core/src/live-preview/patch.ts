/**
 * The page's copy of `patchBlocks`: applies the admin's edits to the fields a previewed page
 * holds, so it can re-render before anything is saved.
 *
 * Loose on purpose. The admin validated every op against the content type before sending it, and
 * the page has no content type to validate against, so this checks only what it needs to find its
 * way: keys, places, refs. A block is any object with a string `_type`; its slots are its direct
 * properties holding blocks (see `isSlot`), and nothing else under it is read or rekeyed. For ops
 * the server would accept, in the applied form, the result is the server's (a parity test runs
 * both on the same fixtures); an op it can't place refuses the whole patch, as the server's does,
 * and the page keeps the fields it had.
 *
 * The admin should send ops in the applied form `patchBlocks` answers with, every key present: a
 * key minted here is the page's own, and the admin's next op can't name it.
 *
 * Without the content type, two things can't be told apart, and the page reads them differently
 * from the server: a list of keyed, typed objects in a JSON field, or in a field a block's variant
 * no longer declares, reads here as a slot (the server skips it); and a block whose `_type` names
 * no variant is still walked here. Either only matters when a key in it is also held elsewhere,
 * where this refuses an op as ambiguous that the server applies. The admin answers a refusal by
 * sending the entry again, and a second refusal of the same patch by sending the field whole
 * (`setField` with the value the server holds), which this applies without reading it.
 */
import { clean, isRecord, isSafeName } from './protocol.js';

/** Locale-keyed field values, as the Management API returns an entry's fields. */
export type LocalizedFields = Record<string, Record<string, unknown>>;

/** Where a block goes: into a parent block's slot, or the field itself when `parent` is absent. */
export interface BlockParent {
  readonly key: string;
  readonly slot: string;
}

/** A position in a slot: before or after a sibling, at an index, or at the end when none is given. */
export interface BlockPlace {
  readonly parent?: BlockParent;
  readonly before?: string;
  readonly after?: string;
  readonly index?: number;
}

interface OpTarget {
  /** A top-level field of the entry. */
  readonly field: string;
  readonly locale: string;
}

export interface InsertBlockOp extends OpTarget, BlockPlace {
  readonly op: 'insert';
  readonly block: Readonly<Record<string, unknown>>;
  readonly ref?: string;
}
export interface UpdateBlockOp extends OpTarget {
  readonly op: 'update';
  readonly key: string;
  readonly set?: Readonly<Record<string, unknown>>;
  readonly unset?: readonly string[];
}
export interface MoveBlockOp extends OpTarget {
  readonly op: 'move';
  readonly key: string;
  readonly to: BlockPlace;
}
export interface RemoveBlockOp extends OpTarget {
  readonly op: 'remove';
  readonly key: string;
}
export interface DuplicateBlockOp extends OpTarget {
  readonly op: 'duplicate';
  readonly key: string;
  readonly ref?: string;
}

/** The block ops of `patchBlocks`, key-addressed, one field and locale each. */
export type BlockOp =
  | InsertBlockOp
  | UpdateBlockOp
  | MoveBlockOp
  | RemoveBlockOp
  | DuplicateBlockOp;

/** Replaces one locale of an ordinary field; `value` absent clears it. */
export interface SetFieldOp extends OpTarget {
  readonly op: 'setField';
  readonly value?: unknown;
}

export type LivePatchOp = BlockOp | SetFieldOp;

export type LivePatchResult =
  | { readonly ok: true; readonly fields: LocalizedFields }
  | { readonly ok: false; readonly op: number; readonly message: string };

/**
 * Applies `ops` in order to `fields`, or refuses with the first op that can't apply. `fields` is
 * never mutated; fields no op touches are shared with the result. `newKey` mints a key for a block
 * that arrives without one (a random UUID by default).
 */
export function applyLivePatch(
  fields: LocalizedFields,
  ops: readonly LivePatchOp[],
  opts: { readonly newKey?: () => string } = {},
): LivePatchResult {
  const newKey = opts.newKey ?? (() => crypto.randomUUID());
  const out: LocalizedFields = { ...fields };
  const copied = new Set<string>();
  const refs = new Map<string, PatchRef>();

  for (const [i, op] of ops.entries()) {
    try {
      if (!isRecord(op) || typeof op.op !== 'string') throw new Refused('Unknown op');
      // As the parser checks a message, for callers that apply ops they didn't parse: a value with
      // its own `__proto__` survives the copy and would reach whatever merges the fields next.
      if (!clean(op)) throw new Refused('An op may hold only plain data, with no prototype names');
      if (!isName(op.field) || !isName(op.locale)) {
        throw new Refused('field and locale must be names');
      }
      if (!copied.has(op.field)) {
        const held = fields[op.field];
        if (held !== undefined && !isRecord(held)) {
          throw new Refused(`"${op.field}" is not keyed by locale`);
        }
        out[op.field] = clone(held ?? {});
        copied.add(op.field);
      }
      const localized = out[op.field] as Record<string, unknown>;
      if (op.op === 'setField') {
        if (op.value === undefined) delete localized[op.locale];
        else localized[op.locale] = clone(op.value);
        continue;
      }
      const held = localized[op.locale];
      if (held !== undefined && !Array.isArray(held)) {
        throw new Refused(`${where(op)} holds something other than a list of blocks`);
      }
      const tree = new Tree(op, localized, refs);
      const minted = applyOne(tree, op, newKey);
      const ref = op.op === 'insert' || op.op === 'duplicate' ? op.ref : undefined;
      if (minted !== undefined && ref !== undefined) refs.set(ref, { tree: tree.id, key: minted });
    } catch (err) {
      if (err instanceof Refused) return { ok: false, op: i, message: err.message };
      throw err;
    }
  }
  return { ok: true, fields: out };
}

// --- the engine (mirrors packages/domain/src/content-type/block-patch.ts) ---------

class Refused extends Error {}

type Block = Record<string, unknown>;

interface Location {
  readonly block: Block;
  readonly slot: unknown[];
  readonly index: number;
  readonly parent?: BlockParent;
  readonly ancestors: readonly string[];
  /** It sits in a slot of a keyless block, whose place can't be named; ops on it are refused. */
  readonly orphan: boolean;
}

interface PatchRef {
  readonly tree: string;
  readonly key: string;
}

const where = (op: OpTarget): string => `${op.field} (${op.locale})`;

/** Every keyed block reachable through slots, by key; a key held twice has two locations. */
function indexTree(root: unknown[]): Map<string, Location[]> {
  const index = new Map<string, Location[]>();
  const walk = (
    slot: unknown[],
    parent: BlockParent | undefined,
    ancestors: readonly string[],
    orphan: boolean,
  ): void => {
    slot.forEach((item, i) => {
      if (!isRecord(item)) return;
      const key = keyOf(item);
      if (key !== undefined) {
        const at: Location = {
          block: item,
          slot,
          index: i,
          ...(parent ? { parent } : {}),
          ancestors,
          orphan,
        };
        index.set(key, [...(index.get(key) ?? []), at]);
      }
      if (!isBlock(item)) return;
      const below = key !== undefined ? [...ancestors, key] : ancestors;
      for (const [name, value] of Object.entries(item)) {
        if (!isSafeName(name) || !isSlot(value)) continue;
        walk(value, key !== undefined ? { key, slot: name } : undefined, below, key === undefined);
      }
    });
  };
  walk(root, undefined, [], false);
  return index;
}

class Tree {
  readonly index: Map<string, Location[]>;
  readonly id: string;
  constructor(
    readonly op: BlockOp,
    readonly localized: Record<string, unknown>,
    readonly refs: ReadonlyMap<string, PatchRef>,
  ) {
    const root = localized[op.locale];
    this.index = indexTree(Array.isArray(root) ? root : []);
    this.id = `${op.field}\u0000${op.locale}`;
  }

  resolve(key: string): string {
    const ref = this.refs.get(key);
    return ref?.tree === this.id ? ref.key : key;
  }

  find(key: string): Location {
    if (typeof key !== 'string') throw new Refused('A key must be a string');
    const found = this.index.get(this.resolve(key)) ?? [];
    if (found.length === 0) throw new Refused(`No block with _key "${key}" in ${where(this.op)}`);
    if (found.length > 1) throw new Refused(`_key "${key}" is held by ${found.length} blocks`);
    const at = found[0] as Location;
    if (at.orphan) throw new Refused(`Block "${key}" sits in a block with no _key`);
    return at;
  }

  slotOf(parent: BlockParent | undefined): unknown[] {
    if (!parent) {
      const held = this.localized[this.op.locale];
      if (Array.isArray(held)) return held;
      const slot: unknown[] = [];
      this.localized[this.op.locale] = slot;
      return slot;
    }
    const at = this.find(parent.key);
    if (!isName(parent.slot)) throw new Refused('A slot must be a name');
    const held = at.block[parent.slot];
    if (Array.isArray(held)) return held;
    if (held !== undefined) {
      throw new Refused(`"${parent.slot}" of block "${parent.key}" is not a list of blocks`);
    }
    const slot: unknown[] = [];
    at.block[parent.slot] = slot;
    return slot;
  }

  positionIn(slot: unknown[], place: BlockPlace): number {
    const given = [place.before, place.after, place.index].filter((v) => v !== undefined);
    if (given.length > 1) throw new Refused('Give at most one of before, after and index');
    if (place.index !== undefined) {
      if (!Number.isInteger(place.index) || place.index < 0 || place.index > slot.length) {
        throw new Refused(`index must be an integer from 0 to ${slot.length}`);
      }
      return place.index;
    }
    const sibling = place.before ?? place.after;
    if (sibling === undefined) return slot.length;
    const at = this.find(sibling);
    const index = slot.indexOf(at.block);
    if (at.slot !== slot || index < 0) throw new Refused(`Block "${sibling}" is not in the slot`);
    return place.before !== undefined ? index : index + 1;
  }

  taken(): Set<string> {
    return new Set([...this.index.keys(), ...this.refs.keys()]);
  }
}

/** Applies one op in place on the tree's copy; returns the key an insert or duplicate made. */
function applyOne(tree: Tree, op: BlockOp, newKey: () => string): string | undefined {
  switch (op.op) {
    case 'insert': {
      if (!isRecord(op.block)) throw new Refused('block must be an object');
      checkRef(tree, op.ref);
      const slot = tree.slotOf(op.parent && resolvedParent(tree, op.parent));
      const taken = tree.taken();
      const copy = rekeyBlock(clone(op.block), (old) => {
        if (old === undefined) return newKey();
        if (tree.refs.has(old)) throw new Refused(`_key "${old}" is a ref in this patch`);
        if (taken.has(old)) throw new Refused(`_key "${old}" is already held in ${where(op)}`);
        taken.add(old);
        return old;
      });
      slot.splice(tree.positionIn(slot, op), 0, copy);
      return copy._key as string;
    }
    case 'update': {
      const at = tree.find(op.key);
      const set = op.set ?? {};
      if (!isRecord(set)) throw new Refused('set must be an object');
      const unset = op.unset ?? [];
      const names = [...Object.keys(set), ...unset];
      if (names.length === 0) throw new Refused('Nothing to update: give set or unset');
      if (!names.every(isName)) throw new Refused('Field names must be names');
      const both = unset.find((name) => Object.hasOwn(set, name));
      if (both) throw new Refused(`"${both}" is both set and unset`);
      for (const [name, value] of Object.entries(set)) at.block[name] = clone(value);
      for (const name of unset) delete at.block[name];
      return undefined;
    }
    case 'move': {
      const at = tree.find(op.key);
      const key = tree.resolve(op.key);
      const to = isRecord(op.to) ? (op.to as BlockPlace) : {};
      for (const sibling of [to.before, to.after]) {
        if (sibling !== undefined && tree.resolve(sibling) === key) {
          throw new Refused('A block can’t be placed before or after itself');
        }
      }
      const parent = to.parent && resolvedParent(tree, to.parent);
      if (parent) {
        const holder = tree.find(parent.key);
        if (parent.key === key || holder.ancestors.includes(key)) {
          throw new Refused('A block can’t be moved into itself or a block inside it');
        }
      }
      const slot = tree.slotOf(parent);
      at.slot.splice(at.index, 1);
      slot.splice(tree.positionIn(slot, to), 0, at.block);
      return undefined;
    }
    case 'remove': {
      const at = tree.find(op.key);
      at.slot.splice(at.index, 1);
      return undefined;
    }
    case 'duplicate': {
      const at = tree.find(op.key);
      checkRef(tree, op.ref);
      const copy = rekeyBlock(clone(at.block), () => newKey());
      at.slot.splice(at.index + 1, 0, copy);
      return copy._key as string;
    }
    default:
      throw new Refused('Unknown op');
  }
}

function resolvedParent(tree: Tree, parent: BlockParent): BlockParent {
  if (!isRecord(parent) || typeof parent.key !== 'string' || typeof parent.slot !== 'string') {
    throw new Refused('parent must be { key, slot }');
  }
  return { key: tree.resolve(parent.key), slot: parent.slot };
}

function checkRef(tree: Tree, ref: string | undefined): void {
  if (ref === undefined) return;
  if (typeof ref !== 'string' || ref === '') throw new Refused('ref must be a non-empty string');
  if (tree.refs.has(ref)) throw new Refused(`ref "${ref}" is already used in this patch`);
  if (tree.index.has(ref)) throw new Refused(`ref "${ref}" is the _key of an existing block`);
}

/**
 * `block` (already a copy) with itself and every block in its slots, all the way down, keyed by
 * `mint`, which is given the key each held; `mint` runs on a block before the blocks inside it,
 * in property order. Nothing else is touched: a plain object under a block may be a component or
 * a JSON value, and only the server, holding the content type, can tell which. So blocks under a
 * plain component keep their keys in a duplicate here, where the server gives them new ones; in
 * the applied form the admin sends, every key is already given and the two agree.
 */
function rekeyBlock(block: Block, mint: (old: string | undefined) => string): Block {
  const key = mint(keyOf(block));
  const out = { ...block };
  if (isBlock(block)) {
    for (const [name, held] of Object.entries(out)) {
      if (isSafeName(name) && isSlot(held)) {
        out[name] = held.map((item) => (isRecord(item) ? rekeyBlock(item, mint) : item));
      }
    }
  }
  return { ...out, _key: key };
}

/** Field values are JSON, so a JSON round trip copies them exactly (as the server copies them). */
function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

const isBlock = (item: Block): boolean => typeof item._type === 'string' && item._type !== '';

/**
 * A slot, as far as the page can tell: a list of objects, each keyed or typed, at least one typed.
 * Stored blocks are always keyed, so one missing `_type` doesn't hide its keyed siblings (the
 * server indexes them too); a repeater's items, keyed or not, carry no `_type`.
 */
const isSlot = (value: unknown): value is unknown[] =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every((v) => isRecord(v) && (keyOf(v) !== undefined || isBlock(v))) &&
  value.some((v) => isRecord(v) && isBlock(v));

const keyOf = (item: Block): string | undefined => {
  const key = item._key;
  return typeof key === 'string' && key !== '' ? key : undefined;
};

const isName = (s: unknown): s is string => typeof s === 'string' && s !== '' && isSafeName(s);
