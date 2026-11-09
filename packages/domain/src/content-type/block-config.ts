import { type FieldIssue, ValidationError } from '../errors';
import type { EntryFields, LocaleCode } from '../types';
import {
  BLOCK_CATALOG_LIMITS,
  type BlockCatalog,
  type BlockManifest,
  canonicalJson,
  utf8Length,
} from './block-catalog';
import { type BlockLock, blockLockIssues } from './block-locks';
import type { ContentType } from './content-type';
import { BLOCK_KEY, BLOCK_TYPE_KEY, blockVariants, isValidApiId } from './field';

/**
 * The block config: what an environment's admins allow of the blocks the code provides. The block
 * catalog (see `block-catalog.ts`) says what the site can render: which blocks a slot takes, how
 * many, which go at the top of a page. The config only ever narrows that, per target and per slot:
 * fewer blocks, a tighter count, or a locked slot whose blocks editors can't add, remove or
 * reorder (they still edit inside them). It never widens: a block the code doesn't allow in a slot
 * can't be allowed there by config.
 *
 * A config is checked against the catalog in force when it is set (`checkBlockConfig`), but a
 * catalog push is never checked against the config: code moves first, and the parts of a config
 * naming something the catalog no longer has are reported as `stale` and ignored
 * (`effectiveBlockRules`), never an error. A narrowing a new catalog makes impossible falls back
 * to what the code allows.
 *
 * The config judges edits, not content (`blockConfigIssues`): a save is refused for what it
 * changes in a slot (a block placed there, the slot's order under a lock, its count), so an entry
 * holding what the config wouldn't allow today stays saveable as long as the save leaves that
 * slot's blocks as they are.
 */

/** How a config narrows a slot: each key optional, each one only ever tighter than the code. */
export interface SlotNarrowing {
  /** The block ids the slot takes: a non-empty subset of the slot's `allowedChildren`. */
  readonly allowedChildren?: readonly string[];
  /** Fewest blocks the slot holds: at least the code's `min`. */
  readonly min?: number;
  /** Most blocks the slot holds: at most the code's `max`. */
  readonly max?: number;
  /** Editors can't add, remove, move or reorder the slot's blocks; edits inside them are fine. */
  readonly locked?: boolean;
}

/** How a config narrows a catalog target: the top level of a content type's blocks field. */
export interface TargetNarrowing {
  readonly contentTypeApiId: string;
  readonly field: string;
  /** The blocks the field takes at its top level: a non-empty subset of the target's blocks. */
  readonly blocks?: readonly string[];
  readonly min?: number;
  readonly max?: number;
  readonly locked?: boolean;
}

/** How a config narrows the slots of one block, wherever that block is placed. */
export interface BlockNarrowing {
  /** The block's id in the catalog. */
  readonly block: string;
  /** Narrowings by slot apiId. */
  readonly slots: Readonly<Record<string, SlotNarrowing>>;
}

/** An environment's block config. Version 0, with nothing in it, before the first set. */
export interface BlockConfig {
  /** 0 before the first set, then one more for each set that changed something. */
  readonly version: number;
  readonly targets: readonly TargetNarrowing[];
  readonly blocks: readonly BlockNarrowing[];
  readonly updatedAt: string | null;
  /** Who set it, as the audit trail names them. */
  readonly updatedBy: string | null;
}

/** The config of an environment no one has configured. */
export const EMPTY_BLOCK_CONFIG: BlockConfig = {
  version: 0,
  targets: [],
  blocks: [],
  updatedAt: null,
  updatedBy: null,
};

export const BLOCK_CONFIG_LIMITS = {
  targets: BLOCK_CATALOG_LIMITS.targets,
  blocks: BLOCK_CATALOG_LIMITS.blocks,
  slots: BLOCK_CATALOG_LIMITS.slots,
  /** The config as JSON, UTF-8 bytes: one D1 row, far below its limit. */
  bytes: 200_000,
  /** Issues one refusal names, or one save reports, before the rest are only counted. */
  issues: 100,
} as const;

/** What a set sends, before it is checked. */
export interface BlockConfigInput {
  readonly targets: unknown;
  readonly blocks: unknown;
}

/** The parts of a catalog a config is judged against. */
export type BlockConfigCatalog = Pick<BlockCatalog, 'version' | 'blocks' | 'targets'>;

type Issue = (field: string, message: string) => void;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const quoted = (ids: readonly string[]) => ids.map((id) => `"${id}"`).join(', ');
/** At most ten ids, quoted, then how many more. */
const quotedSome = (ids: readonly string[]) =>
  ids.length > 10 ? `${quoted(ids.slice(0, 10))} and ${ids.length - 10} more` : quoted(ids);

/** What one slot or target takes, as the code (or, once narrowed, the config) says. */
interface Rules {
  readonly allowed: readonly string[];
  readonly min?: number;
  readonly max?: number;
}

/** The catalog's own rules, by target (`type.field`) and by block and slot. */
interface CodeRules {
  readonly targets: ReadonlyMap<string, Rules>;
  readonly slots: ReadonlyMap<string, ReadonlyMap<string, Rules>>;
  readonly ids: ReadonlySet<string>;
  /** Former id → the block that lists it in `aliases`. */
  readonly aliases: ReadonlyMap<string, string>;
}

const targetKey = (contentTypeApiId: string, field: string) => `${contentTypeApiId}.${field}`;

function codeRules(catalog: BlockConfigCatalog | null): CodeRules {
  const blocks = catalog?.blocks ?? [];
  const targets = new Map<string, Rules>();
  for (const t of catalog?.targets ?? []) {
    // As `catalogVariants` resolves a target's top level.
    const allowed = t.blocks ?? blocks.filter((b) => !b.allowedParents).map((b) => b.id);
    targets.set(targetKey(t.contentTypeApiId, t.field), { allowed });
  }
  const slots = new Map<string, Map<string, Rules>>();
  const aliases = new Map<string, string>();
  for (const b of blocks) {
    if (b.slots?.length) {
      slots.set(
        b.id,
        new Map(
          b.slots.map((s) => [
            s.apiId,
            {
              allowed: s.allowedChildren,
              ...(s.min !== undefined ? { min: s.min } : {}),
              ...(s.max !== undefined ? { max: s.max } : {}),
            },
          ]),
        ),
      );
    }
    for (const a of b.aliases ?? []) aliases.set(a, b.id);
  }
  return { targets, slots, ids: new Set(blocks.map((b) => b.id)), aliases };
}

// --- checking a config --------------------------------------------------------------------------

/**
 * Checks a config against the catalog in force (null before the first push, when only an empty
 * config is valid) and returns it normalized: unknown keys dropped, `locked` kept only when true,
 * and a narrowing that narrows nothing left out. Collects every problem before refusing, as a
 * `ValidationError` whose issues name the part (`blocks[grid].slots.items.max`), so a whole
 * config is fixed in one pass. Refuses anything that would widen what the code allows.
 */
export function checkBlockConfig(
  input: BlockConfigInput,
  catalog: BlockConfigCatalog | null,
): { targets: TargetNarrowing[]; blocks: BlockNarrowing[] } {
  const issues: FieldIssue[] = [];
  let more = 0;
  // A refusal stays small whatever was sent: past the cap, issues are only counted.
  const issue: Issue = (field, message) => {
    if (issues.length < BLOCK_CONFIG_LIMITS.issues) issues.push({ field, message });
    else more += 1;
  };
  const code = codeRules(catalog);
  const targets = checkTargetNarrowings(input.targets, code, issue);
  const blocks = checkBlockNarrowings(input.blocks, code, issue);
  if (
    issues.length === 0 &&
    utf8Length(canonicalJson({ targets, blocks })) > BLOCK_CONFIG_LIMITS.bytes
  ) {
    issue('', `The block config is larger than ${BLOCK_CONFIG_LIMITS.bytes} bytes as JSON`);
  }
  if (more > 0) issues.push({ field: '', message: `…and ${more} more` });
  if (issues.length > 0) throw new ValidationError(issues);
  return { targets, blocks };
}

function checkTargetNarrowings(raw: unknown, code: CodeRules, issue: Issue): TargetNarrowing[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    issue('targets', 'must be a list of { contentTypeApiId, field } narrowings');
    return [];
  }
  if (raw.length > BLOCK_CONFIG_LIMITS.targets) {
    issue('targets', `A config narrows at most ${BLOCK_CONFIG_LIMITS.targets} targets`);
  }
  const out: TargetNarrowing[] = [];
  const seen = new Set<string>();
  raw.forEach((t, i) => {
    if (!isObject(t)) {
      issue(`targets[${i}]`, 'must be an object');
      return;
    }
    const { contentTypeApiId: type, field } = t;
    if (typeof type !== 'string' || !isValidApiId(type)) {
      issue(`targets[${i}].contentTypeApiId`, 'must be a content type apiId');
      return;
    }
    if (typeof field !== 'string' || !isValidApiId(field)) {
      issue(`targets[${i}].field`, 'must be the apiId of a top-level blocks field');
      return;
    }
    const key = targetKey(type, field);
    const at = `targets[${key}]`;
    if (seen.has(key)) {
      issue(at, `${key} is narrowed twice`);
      return;
    }
    seen.add(key);
    const rules = code.targets.get(key);
    if (!rules) {
      issue(at, `${key} is not a target of the block catalog`);
      return;
    }
    const n = checkNarrowing(t, 'blocks', rules, at, code, issue);
    if (n.list === undefined && n.min === undefined && n.max === undefined && !n.locked) return;
    out.push({
      contentTypeApiId: type,
      field,
      ...(n.list ? { blocks: n.list } : {}),
      ...bounds(n),
    });
  });
  return out;
}

function checkBlockNarrowings(raw: unknown, code: CodeRules, issue: Issue): BlockNarrowing[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    issue('blocks', 'must be a list of { block, slots } narrowings');
    return [];
  }
  if (raw.length > BLOCK_CONFIG_LIMITS.blocks) {
    issue('blocks', `A config narrows at most ${BLOCK_CONFIG_LIMITS.blocks} blocks`);
  }
  const out: BlockNarrowing[] = [];
  const seen = new Set<string>();
  raw.forEach((b, i) => {
    if (!isObject(b)) {
      issue(`blocks[${i}]`, 'must be an object');
      return;
    }
    const id = b.block;
    if (typeof id !== 'string' || !isValidApiId(id)) {
      issue(`blocks[${i}].block`, 'must be a block id');
      return;
    }
    const at = `blocks[${id}]`;
    if (seen.has(id)) {
      issue(at, `"${id}" is narrowed twice`);
      return;
    }
    seen.add(id);
    if (!code.ids.has(id)) {
      const renamed = code.aliases.get(id);
      issue(
        at,
        renamed
          ? `"${id}" is a former id of "${renamed}"; name the block by its id`
          : `No block "${id}" in the catalog`,
      );
      return;
    }
    const slots = code.slots.get(id);
    if (!slots) {
      issue(at, `"${id}" has no slots to narrow`);
      return;
    }
    if (!isObject(b.slots)) {
      issue(`${at}.slots`, 'must be an object of narrowings by slot apiId');
      return;
    }
    const entries = Object.entries(b.slots);
    if (entries.length > BLOCK_CONFIG_LIMITS.slots) {
      issue(`${at}.slots`, `A block has at most ${BLOCK_CONFIG_LIMITS.slots} slots`);
    }
    // Built as entries: a slot apiId is author data, never a key to assign on a plain object.
    const narrowed: [string, SlotNarrowing][] = [];
    for (const [apiId, s] of entries.slice(0, BLOCK_CONFIG_LIMITS.slots)) {
      const where = `${at}.slots.${apiId}`;
      const rules = slots.get(apiId);
      if (!rules) {
        issue(where, `"${id}" has no slot "${apiId}" (its slots: ${quoted([...slots.keys()])})`);
        continue;
      }
      if (!isObject(s)) {
        issue(where, 'must be an object');
        continue;
      }
      const n = checkNarrowing(s, 'allowedChildren', rules, where, code, issue);
      if (n.list === undefined && n.min === undefined && n.max === undefined && !n.locked) continue;
      narrowed.push([apiId, { ...(n.list ? { allowedChildren: n.list } : {}), ...bounds(n) }]);
    }
    if (narrowed.length > 0) out.push({ block: id, slots: Object.fromEntries(narrowed) });
  });
  return out;
}

interface Narrowed {
  readonly list?: string[];
  readonly min?: number;
  readonly max?: number;
  readonly locked?: boolean;
}

const bounds = (n: Narrowed) => ({
  ...(n.min !== undefined ? { min: n.min } : {}),
  ...(n.max !== undefined ? { max: n.max } : {}),
  ...(n.locked ? { locked: true } : {}),
});

/** One slot's or target's narrowing, checked against what the code allows there. */
function checkNarrowing(
  raw: Record<string, unknown>,
  listKey: 'blocks' | 'allowedChildren',
  code: Rules,
  at: string,
  rules: CodeRules,
  issue: Issue,
): Narrowed {
  let list: string[] | undefined;
  const given = raw[listKey];
  if (given !== undefined) {
    list = [];
    const where = `${at}.${listKey}`;
    if (!Array.isArray(given) || given.length === 0) {
      issue(where, 'names at least one block id, or is left out');
    } else if (given.length > code.allowed.length) {
      issue(where, `names more blocks than the code allows here (${code.allowed.length})`);
    } else {
      const allowed = new Set(code.allowed);
      const kept = new Set<string>();
      // Each kind of problem once per list, naming the ids it applies to.
      const invalid: string[] = [];
      const twice: string[] = [];
      const wider: string[] = [];
      for (const id of given) {
        if (typeof id !== 'string' || !isValidApiId(id)) invalid.push(String(id));
        else if (kept.has(id)) twice.push(id);
        else if (!allowed.has(id)) {
          const renamed = rules.aliases.get(id);
          if (renamed && allowed.has(renamed)) {
            issue(where, `"${id}" is a former id of "${renamed}"; name the block by its id`);
          } else wider.push(id);
        } else kept.add(id);
      }
      if (invalid.length > 0)
        issue(
          where,
          `${quotedSome(invalid)} ${invalid.length === 1 ? 'is not a valid block id' : 'are not valid block ids'}`,
        );
      if (twice.length > 0)
        issue(where, `${quotedSome(twice)} ${twice.length === 1 ? 'is' : 'are'} listed twice`);
      if (wider.length > 0) {
        issue(
          where,
          `${quotedSome(wider)} ${wider.length === 1 ? 'is not a block' : 'are not blocks'} the code allows here (it allows ${quoted(code.allowed)})`,
        );
      }
      list = [...kept];
    }
  }
  const count = (key: 'min' | 'max'): number | undefined => {
    const v = raw[key];
    if (v === undefined) return undefined;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
      issue(`${at}.${key}`, 'must be a whole number');
      return undefined;
    }
    return v;
  };
  const min = count('min');
  const max = count('max');
  if (max === 0) issue(`${at}.max`, 'must be at least 1');
  if (min !== undefined && code.min !== undefined && min < code.min) {
    issue(`${at}.min`, `cannot be below the code's min of ${code.min}`);
  }
  if (max !== undefined && code.max !== undefined && max > code.max) {
    issue(`${at}.max`, `cannot be above the code's max of ${code.max}`);
  }
  const lo = min ?? code.min ?? 0;
  const hi = max ?? code.max;
  if ((min !== undefined || max !== undefined) && hi !== undefined && lo > hi) {
    issue(at, `min (${lo}) is more than max (${hi})`);
  }
  const locked = raw.locked;
  if (locked !== undefined && typeof locked !== 'boolean') {
    issue(`${at}.locked`, 'must be true or false');
  }
  return {
    ...(list !== undefined ? { list } : {}),
    ...(min !== undefined ? { min } : {}),
    ...(max !== undefined ? { max } : {}),
    ...(locked === true ? { locked: true } : {}),
  };
}

// --- the rules in force -------------------------------------------------------------------------

/** What a slot (or a target's top level) takes once the config is laid over the code. */
export interface EffectiveSlotRules {
  /** The block ids it takes, in the catalog's order. */
  readonly allowedChildren: readonly string[];
  readonly min?: number;
  readonly max?: number;
  readonly locked: boolean;
  /** The config narrows it: some of the above is tighter than the code. */
  readonly narrowed: boolean;
}

export interface EffectiveTargetRules extends Omit<EffectiveSlotRules, 'allowedChildren'> {
  readonly contentTypeApiId: string;
  readonly field: string;
  /** The block ids its top level takes, in the catalog's order. */
  readonly blocks: readonly string[];
}

/** A part of the config the catalog in force no longer has, ignored until the config drops it. */
export interface StaleNarrowing {
  /** Where it is in the config, as `checkBlockConfig` names parts: `blocks[grid].slots.items`. */
  readonly at: string;
  readonly message: string;
}

/** The rules every target and slot of the catalog in force follows, the config laid over them. */
export interface EffectiveBlockRules {
  /** The catalog version the rules are from; null before the first push. */
  readonly catalogVersion: number | null;
  readonly configVersion: number;
  /** Every target of the catalog. */
  readonly targets: readonly EffectiveTargetRules[];
  /** Every block of the catalog that has slots, with each slot's rules. */
  readonly blocks: readonly {
    readonly block: string;
    readonly slots: Readonly<Record<string, EffectiveSlotRules>>;
  }[];
  readonly stale: readonly StaleNarrowing[];
}

/**
 * The narrowed view of every target and slot: what the canvas and the dock offer, and what
 * `blockConfigIssues` holds a save to. The config is laid over the catalog in force, never the
 * other way round, so nothing here is wider than the code.
 *
 * A config set against an older catalog may name what this one no longer has: a target, a block,
 * a slot, a block in a list. Those parts are `stale`: listed and ignored. A block renamed since
 * (its old id now in the new one's `aliases`) is followed to its new id, not stale. A narrowing
 * this catalog leaves nothing of (none of its blocks allowed any more, bounds the code's own no
 * longer fit) is stale as a whole, and the code's rule applies.
 */
export function effectiveBlockRules(
  catalog: BlockConfigCatalog | null,
  config: Pick<BlockConfig, 'version' | 'targets' | 'blocks'>,
): EffectiveBlockRules {
  const code = codeRules(catalog);
  const stale: StaleNarrowing[] = [];
  const current = (id: string) => (code.ids.has(id) ? id : code.aliases.get(id));

  const byTarget = new Map<string, TargetNarrowing>();
  for (const t of config.targets) {
    const key = targetKey(t.contentTypeApiId, t.field);
    if (code.targets.has(key)) byTarget.set(key, t);
    else stale.push({ at: `targets[${key}]`, message: `${key} is no longer a catalog target` });
  }
  const byBlock = new Map<string, BlockNarrowing>();
  for (const b of config.blocks) {
    const id = current(b.block);
    if (id === undefined) {
      stale.push({ at: `blocks[${b.block}]`, message: `No block "${b.block}" in the catalog` });
    } else if (!code.slots.has(id)) {
      stale.push({ at: `blocks[${b.block}]`, message: `"${id}" has no slots any more` });
    } else byBlock.set(id, b);
  }

  /** `n` laid over `rules`, recording what of it no longer applies. */
  const narrow = (
    rules: Rules,
    n: SlotNarrowing | undefined,
    list: readonly string[] | undefined,
    at: string,
    listKey: string,
  ): EffectiveSlotRules => {
    let allowed = rules.allowed;
    let narrowed = false;
    if (list) {
      const named = new Set(list.map((id) => current(id) ?? id));
      const gone = [...named].filter((id) => !rules.allowed.includes(id));
      if (gone.length > 0) {
        stale.push({
          at: `${at}.${listKey}`,
          message: `The catalog no longer allows ${quoted(gone)} here`,
        });
      }
      const kept = rules.allowed.filter((id) => named.has(id));
      if (kept.length === 0) {
        stale.push({
          at: `${at}.${listKey}`,
          message:
            'None of the blocks it names are allowed here any more, so the code’s list applies',
        });
      } else if (kept.length < rules.allowed.length) {
        allowed = kept;
        narrowed = true;
      }
    }
    let min = rules.min;
    let max = rules.max;
    if (n?.min !== undefined || n?.max !== undefined) {
      const lo = Math.max(rules.min ?? 0, n.min ?? 0);
      const hi =
        n.max === undefined
          ? rules.max
          : rules.max === undefined
            ? n.max
            : Math.min(rules.max, n.max);
      if (hi !== undefined && lo > hi) {
        stale.push({
          at,
          message: 'Its min and max no longer fit the code’s, so the code’s apply',
        });
      } else {
        if (lo !== (rules.min ?? 0)) {
          min = lo;
          narrowed = true;
        }
        if (hi !== rules.max) {
          max = hi;
          narrowed = true;
        }
      }
    }
    const locked = n?.locked === true;
    return {
      allowedChildren: allowed,
      ...(min !== undefined ? { min } : {}),
      ...(max !== undefined ? { max } : {}),
      locked,
      narrowed: narrowed || locked,
    };
  };

  const targets: EffectiveTargetRules[] = [];
  for (const t of catalog?.targets ?? []) {
    const key = targetKey(t.contentTypeApiId, t.field);
    const n = byTarget.get(key);
    const { allowedChildren, ...rest } = narrow(
      code.targets.get(key) as Rules,
      n,
      n?.blocks,
      `targets[${key}]`,
      'blocks',
    );
    targets.push({
      contentTypeApiId: t.contentTypeApiId,
      field: t.field,
      blocks: allowedChildren,
      ...rest,
    });
  }
  const blocks: EffectiveBlockRules['blocks'][number][] = [];
  for (const [id, slots] of code.slots) {
    const n = byBlock.get(id);
    const at = `blocks[${n?.block ?? id}]`;
    const given = new Map(Object.entries(n?.slots ?? {}));
    for (const apiId of given.keys()) {
      if (!slots.has(apiId)) {
        stale.push({
          at: `${at}.slots.${apiId}`,
          message: `"${id}" has no slot "${apiId}" any more`,
        });
      }
    }
    const out: [string, EffectiveSlotRules][] = [];
    for (const [apiId, rules] of slots) {
      const s = given.get(apiId);
      out.push([
        apiId,
        narrow(rules, s, s?.allowedChildren, `${at}.slots.${apiId}`, 'allowedChildren'),
      ]);
    }
    blocks.push({ block: id, slots: Object.fromEntries(out) });
  }
  return {
    catalogVersion: catalog?.version ?? null,
    configVersion: config.version,
    targets,
    blocks,
    stale,
  };
}

// --- judging a save ------------------------------------------------------------------------------

/**
 * Why a save breaks the block config, as a stable code a client can act on without reading the
 * message, as `BLOCK_PATCH_ISSUE_CODES` are.
 */
export const BLOCK_CONFIG_ISSUE_CODES = [
  'block_not_allowed_here',
  'slot_locked',
  'slot_too_few',
  'slot_too_many',
  /** A locked region's blocks removed, swapped, reordered, split or inserted into (`block-locks.ts`). */
  'region_locked',
  /** A frozen region's content changed (`freeze: 'all'`). */
  'region_frozen',
  /** The save broke more than `BLOCK_CONFIG_LIMITS.issues` rules: this one counts the rest. */
  'more_issues',
] as const;
export type BlockConfigIssueCode = (typeof BLOCK_CONFIG_ISSUE_CODES)[number];

/**
 * A save the config refuses. `field` is the path validation names values by (`body[2].items` for
 * a slot, `body[2].items[0]` for a block in it), positions as the save leaves them.
 */
export interface BlockConfigIssue extends FieldIssue {
  readonly code: BlockConfigIssueCode;
  /** The block placed where it can't go, by its `_key`. */
  readonly key?: string;
}

const keyOf = (item: unknown): string | undefined => {
  const key = isObject(item) ? item[BLOCK_KEY] : undefined;
  return typeof key === 'string' ? key : undefined;
};

/** A block's own value under `apiId`: never something its prototype answers for. */
const own = (item: unknown, apiId: string): unknown =>
  isObject(item) && Object.hasOwn(item, apiId) ? item[apiId] : undefined;

/** One slot's blocks as the save found them. */
interface HeldSlot {
  readonly keys: readonly (string | undefined)[];
  /** Each block's id, an alias resolved, in the same order. */
  readonly types: readonly (string | undefined)[];
  /** Key → block id, of every keyed block in the slot. */
  readonly members: ReadonlyMap<string, string | undefined>;
  /** Its block's key is held by more than one stored block: see `hold`. */
  readonly ambiguous: boolean;
}

const NO_SLOT: HeldSlot = { keys: [], types: [], members: new Map(), ambiguous: false };

/** What one field value held in one locale before the save. */
interface Held {
  /** The field's top level; undefined when it held no blocks there (no value, or none). */
  readonly top: HeldSlot | undefined;
  /** Each block's slots, by the block's key, then the slot's apiId. */
  readonly slots: ReadonlyMap<string, ReadonlyMap<string, HeldSlot>>;
  readonly blocks: ReadonlySet<string>;
}

/** Where a slot is: the field's top level, or one block's slot (by that block's key, if any). */
type SlotAt =
  | { readonly top: true }
  | { readonly parent: string | undefined; readonly slot: string };
const TOP_LEVEL: SlotAt = { top: true };

/** The rules one slot is judged by. */
interface SlotRules {
  readonly allowed: ReadonlySet<string>;
  readonly list: readonly string[];
  readonly min?: number;
  readonly max?: number;
  readonly locked: boolean;
}

/**
 * The issues the config finds with a save of `contentType`'s entry from `before` (undefined for a
 * create) to `after`, for new edits only. Every catalog target of the type is compared, locale by
 * locale (`locales` limits which), slot by slot: a slot is the top level of the field, or one
 * block's slot, identified by that block's `_key` and the slot's apiId, so a block moved with its
 * children keeps its slots.
 *
 * - **Placement.** A block in a slot after the save but not before it (inserted, duplicated or
 *   moved in), or one whose key stayed while its `_type` changed, must be one the slot's narrowed
 *   list takes. A block stored under a former id (an alias) counts as its block.
 * - **Lock.** A locked slot's sequence of blocks (key and block, in order) can't change: nothing
 *   inserted, removed, moved in or out, reordered or swapped for another block; what's inside its
 *   blocks can. A slot that comes into being in this save (a block newly placed, a create, or a
 *   target with no blocks yet in that locale) is filled as it comes, under placement and counts.
 * - **Counts.** Only when the save changes a slot's number of blocks, the new number must fit the
 *   narrowed `min` and `max`, unless it moves toward them: a slot holding more than `max` (stored
 *   before the config tightened) can lose one block at a time, and one holding fewer than `min`
 *   gain one. A field the save leaves without a value in a locale isn't counted there: whether it
 *   must have one is the content model's `required`.
 *
 * So content stored before the config (or before it tightened) stays saveable as long as the save
 * leaves the slot's blocks where they are. Values the type or the catalog doesn't know are left
 * to validation, which runs first. At most `BLOCK_CONFIG_LIMITS.issues` are listed, then one
 * `more_issues` counting the rest; the work is linear in the blocks.
 *
 * `locks` are the locked regions the stored entry holds (`block-locks.ts`), judged on the same
 * save as `region_locked` and `region_frozen`, with or without a catalog: a region is the
 * entry's, not the config's.
 */
export function blockConfigIssues(
  contentType: ContentType,
  catalog: BlockConfigCatalog | null,
  config: Pick<BlockConfig, 'version' | 'targets' | 'blocks'>,
  before: EntryFields | undefined,
  after: EntryFields,
  locales?: readonly LocaleCode[],
  locks: readonly BlockLock[] = [],
): BlockConfigIssue[] {
  if (!catalog) return capped(blockLockIssues(contentType, locks, before, after, locales));
  const rules = effectiveBlockRules(catalog, config);
  const byId = new Map(catalog.blocks.map((b) => [b.id, b]));
  const aliases = codeRules(catalog).aliases;
  const blockOf = (item: unknown): BlockManifest | undefined => {
    const type = isObject(item) ? item[BLOCK_TYPE_KEY] : undefined;
    if (typeof type !== 'string') return undefined;
    return byId.get(type) ?? byId.get(aliases.get(type) ?? '');
  };
  const asRules = (r: Omit<EffectiveSlotRules, 'allowedChildren'>, list: readonly string[]) => ({
    allowed: new Set(list),
    list,
    ...(r.min !== undefined ? { min: r.min } : {}),
    ...(r.max !== undefined ? { max: r.max } : {}),
    locked: r.locked,
  });
  const slotRules = new Map(
    rules.blocks.map((b) => [
      b.block,
      new Map(Object.entries(b.slots).map(([apiId, r]) => [apiId, asRules(r, r.allowedChildren)])),
    ]),
  );
  const issues: BlockConfigIssue[] = [];
  let more = 0;
  const report = (issue: BlockConfigIssue) => {
    if (issues.length < BLOCK_CONFIG_LIMITS.issues) issues.push(issue);
    else more += 1;
  };
  for (const issue of blockLockIssues(contentType, locks, before, after, locales)) report(issue);

  /**
   * Every slot's blocks in one stored field value. Keys are unique per array, not per tree: a key
   * held by blocks at two depths can't say which block's slots a later save means, so those
   * slots are `ambiguous`, holding every one of those blocks' children. Of the two ways out, this
   * is the one that never refuses an unchanged save and never lets an edit through unjudged:
   * placement is still judged (a child new to all of them, or changed, is placed), only the lock
   * and the counts, which need the one sequence, are left alone.
   */
  const hold = (root: unknown): Held => {
    const counts = new Map<string, number>();
    const count = (items: unknown): void => {
      if (!Array.isArray(items)) return;
      for (const item of items) {
        const key = keyOf(item);
        if (key !== undefined) counts.set(key, (counts.get(key) ?? 0) + 1);
        for (const s of blockOf(item)?.slots ?? []) count(own(item, s.apiId));
      }
    };
    count(root);
    const slots = new Map<string, Map<string, HeldSlot>>();
    const read = (items: unknown[]): HeldSlot => {
      const keys = items.map(keyOf);
      const types = items.map((item) => blockOf(item)?.id);
      const members = new Map<string, string | undefined>();
      keys.forEach((k, i) => {
        if (k !== undefined) members.set(k, types[i]);
      });
      return { keys, types, members, ambiguous: false };
    };
    const walk = (items: unknown): void => {
      if (!Array.isArray(items)) return;
      for (const item of items) {
        const key = keyOf(item);
        for (const s of blockOf(item)?.slots ?? []) {
          const value = own(item, s.apiId);
          if (key !== undefined) {
            const bySlot = slots.get(key) ?? new Map<string, HeldSlot>();
            slots.set(key, bySlot);
            const found = read(Array.isArray(value) ? value : []);
            const seen = bySlot.get(s.apiId);
            const ambiguous = (counts.get(key) ?? 0) > 1;
            bySlot.set(
              s.apiId,
              seen
                ? { ...seen, members: new Map([...seen.members, ...found.members]), ambiguous }
                : { ...found, ambiguous },
            );
          }
          walk(value);
        }
      }
    };
    walk(root);
    const top = Array.isArray(root) && root.length > 0 ? read(root) : undefined;
    return { top, slots, blocks: new Set(counts.keys()) };
  };

  const judge = (
    items: unknown,
    at: SlotAt,
    slot: SlotRules,
    path: string,
    locale: LocaleCode,
    held: Held | undefined,
  ): void => {
    const list = Array.isArray(items) ? items : [];
    // A field left without a value isn't counted (see above); a block's empty slot is.
    const counted = !('top' in at) || items !== undefined;
    // The slot as it was: the field's top level when it held blocks, or a slot of a block it held.
    let was: HeldSlot | undefined;
    if (held) {
      if ('top' in at) was = held.top;
      else if (at.parent !== undefined && held.blocks.has(at.parent)) {
        was = held.slots.get(at.parent)?.get(at.slot) ?? NO_SLOT;
      }
    }
    const keys = list.map(keyOf);
    const blocks = list.map(blockOf);
    list.forEach((_, i) => {
      const key = keys[i];
      const block = blocks[i];
      const placed =
        was === undefined ||
        key === undefined ||
        !was.members.has(key) ||
        was.members.get(key) !== block?.id;
      if (placed && block && !slot.allowed.has(block.id)) {
        report({
          field: `${path}[${i}]`,
          locale,
          code: 'block_not_allowed_here',
          ...(key !== undefined ? { key } : {}),
          message: `"${block.name}" can't go here: this slot takes ${quotedSome(slot.list)}`,
        });
      }
    });
    if (
      slot.locked &&
      was !== undefined &&
      !was.ambiguous &&
      (was.keys.length !== keys.length ||
        was.keys.some((k, i) => k !== keys[i] || was.types[i] !== blocks[i]?.id))
    ) {
      report({
        field: path,
        locale,
        code: 'slot_locked',
        message:
          'This slot is locked: its blocks can’t be added, removed, moved, reordered or swapped (what’s inside them can still be edited)',
      });
    }
    // A new slot is counted as it comes; an old one only when it grew past max or shrank below min.
    const before = was?.ambiguous ? list.length : was?.keys.length;
    const grew = counted && (before === undefined || list.length > before);
    const shrank = counted && (before === undefined || list.length < before);
    if (shrank && slot.min !== undefined && list.length < slot.min) {
      report({
        field: path,
        locale,
        code: 'slot_too_few',
        message: `This slot holds at least ${slot.min} ${slot.min === 1 ? 'block' : 'blocks'}`,
      });
    }
    if (grew && slot.max !== undefined && list.length > slot.max) {
      report({
        field: path,
        locale,
        code: 'slot_too_many',
        message: `This slot holds at most ${slot.max} ${slot.max === 1 ? 'block' : 'blocks'}`,
      });
    }
    list.forEach((item, i) => {
      const block = blocks[i];
      const nested = block ? slotRules.get(block.id) : undefined;
      if (!block || !nested) return;
      for (const s of block.slots ?? []) {
        const r = nested.get(s.apiId);
        if (!r) continue;
        judge(
          own(item, s.apiId),
          { parent: keys[i], slot: s.apiId },
          r,
          `${path}[${i}].${s.apiId}`,
          locale,
          held,
        );
      }
    });
  };

  const only = locales ? new Set(locales) : undefined;
  for (const target of rules.targets) {
    if (target.contentTypeApiId !== contentType.apiId) continue;
    const def = contentType.fields.find((f) => f.apiId === target.field);
    if (!def || !blockVariants(def)) continue;
    const was = before?.[def.apiId] ?? {};
    const now = after[def.apiId] ?? {};
    const inLocales = new Set([...Object.keys(was), ...Object.keys(now)]);
    for (const locale of inLocales) {
      if (only && !only.has(locale)) continue;
      judge(
        Object.hasOwn(now, locale) ? now[locale] : undefined,
        TOP_LEVEL,
        asRules(target, target.blocks),
        def.apiId,
        locale,
        before === undefined
          ? undefined
          : hold(Object.hasOwn(was, locale) ? was[locale] : undefined),
      );
    }
  }
  if (more > 0) {
    issues.push({
      field: '',
      code: 'more_issues',
      message: `…and ${more} more the block config refuses`,
    });
  }
  return issues;
}

/** `issues` within `BLOCK_CONFIG_LIMITS.issues`, then one `more_issues` counting the rest. */
function capped(issues: BlockConfigIssue[]): BlockConfigIssue[] {
  if (issues.length <= BLOCK_CONFIG_LIMITS.issues) return issues;
  return [
    ...issues.slice(0, BLOCK_CONFIG_LIMITS.issues),
    {
      field: '',
      code: 'more_issues',
      message: `…and ${issues.length - BLOCK_CONFIG_LIMITS.issues} more the block config refuses`,
    },
  ];
}

// --- what a set changed --------------------------------------------------------------------------

/** What one set of the config changed, for the audit trail: parts named as `checkBlockConfig` does. */
export interface BlockConfigChange {
  readonly from: number;
  readonly to: number;
  /** Targets and slots narrowed that weren't before. */
  readonly added: readonly string[];
  /** Targets and slots no longer narrowed at all. */
  readonly removed: readonly string[];
  /** Narrowed before and still, but less: more blocks, a lower min, a higher max, or unlocked. */
  readonly loosened: readonly string[];
  /** Locks taken off, whether the part is still narrowed or not. */
  readonly unlocked: readonly string[];
}

/** Lists in a change hold at most this many parts each. */
const CHANGE_PARTS = 10;

/** What `next` changes from `previous`, part by part. */
export function diffBlockConfigs(
  previous: Pick<BlockConfig, 'version' | 'targets' | 'blocks'>,
  next: Pick<BlockConfig, 'version' | 'targets' | 'blocks'>,
): BlockConfigChange {
  const parts = (c: Pick<BlockConfig, 'targets' | 'blocks'>) => {
    const out = new Map<string, SlotNarrowing>();
    for (const t of c.targets) {
      out.set(`targets[${targetKey(t.contentTypeApiId, t.field)}]`, {
        ...(t.blocks ? { allowedChildren: t.blocks } : {}),
        ...bounds({ ...t, locked: t.locked === true }),
      });
    }
    for (const b of c.blocks) {
      for (const [apiId, s] of Object.entries(b.slots))
        out.set(`blocks[${b.block}].slots.${apiId}`, s);
    }
    return out;
  };
  const was = parts(previous);
  const now = parts(next);
  const added = [...now.keys()].filter((k) => !was.has(k));
  const removed = [...was.keys()].filter((k) => !now.has(k));
  const loosened: string[] = [];
  const unlocked: string[] = [];
  for (const [k, a] of was) {
    const b = now.get(k);
    if (a.locked && !b?.locked) unlocked.push(k);
    if (!b) continue;
    const wider =
      (a.allowedChildren !== undefined &&
        (b.allowedChildren === undefined ||
          b.allowedChildren.some((id) => !a.allowedChildren?.includes(id)))) ||
      (a.min !== undefined && (b.min ?? 0) < a.min) ||
      (a.max !== undefined && (b.max === undefined || b.max > a.max)) ||
      (a.locked === true && !b.locked);
    if (wider) loosened.push(k);
  }
  const cap = (list: string[]) => list.slice(0, CHANGE_PARTS);
  return {
    from: previous.version,
    to: next.version,
    added: cap(added),
    removed: cap(removed),
    loosened: cap(loosened),
    unlocked: cap(unlocked),
  };
}
