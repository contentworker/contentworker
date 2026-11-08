import { type FieldIssue, ValidationError } from '../errors';
import type { EntryFields, LocaleCode } from '../types';
import {
  BLOCK_CATALOG_LIMITS,
  type BlockCatalog,
  type BlockManifest,
  canonicalJson,
  utf8Length,
} from './block-catalog';
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
  const issue: Issue = (field, message) => issues.push({ field, message });
  const code = codeRules(catalog);
  const targets = checkTargetNarrowings(input.targets, code, issue);
  const blocks = checkBlockNarrowings(input.blocks, code, issue);
  if (
    issues.length === 0 &&
    utf8Length(canonicalJson({ targets, blocks })) > BLOCK_CONFIG_LIMITS.bytes
  ) {
    issue('', `The block config is larger than ${BLOCK_CONFIG_LIMITS.bytes} bytes as JSON`);
  }
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
    const narrowed: Record<string, SlotNarrowing> = {};
    for (const [apiId, s] of entries) {
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
      narrowed[apiId] = { ...(n.list ? { allowedChildren: n.list } : {}), ...bounds(n) };
    }
    if (Object.keys(narrowed).length > 0) out.push({ block: id, slots: narrowed });
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
    if (!Array.isArray(given) || given.length === 0) {
      issue(`${at}.${listKey}`, 'names at least one block id, or is left out');
    } else {
      for (const id of given) {
        if (typeof id !== 'string' || !isValidApiId(id)) {
          issue(`${at}.${listKey}`, `"${String(id)}" is not a valid block id`);
        } else if (list.includes(id)) {
          issue(`${at}.${listKey}`, `"${id}" is listed twice`);
        } else if (!code.allowed.includes(id)) {
          const renamed = rules.aliases.get(id);
          issue(
            `${at}.${listKey}`,
            renamed && code.allowed.includes(renamed)
              ? `"${id}" is a former id of "${renamed}"; name the block by its id`
              : `"${id}" is not a block the code allows here (it allows ${quoted(code.allowed)})`,
          );
        } else list.push(id);
      }
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
    for (const apiId of Object.keys(n?.slots ?? {})) {
      if (!slots.has(apiId)) {
        stale.push({
          at: `${at}.slots.${apiId}`,
          message: `"${id}" has no slot "${apiId}" any more`,
        });
      }
    }
    const out: Record<string, EffectiveSlotRules> = {};
    for (const [apiId, rules] of slots) {
      const s = n?.slots[apiId];
      out[apiId] = narrow(rules, s, s?.allowedChildren, `${at}.slots.${apiId}`, 'allowedChildren');
    }
    blocks.push({ block: id, slots: out });
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

type Item = Record<string, unknown>;

const keyOf = (item: unknown): string | undefined => {
  const key = isObject(item) ? item[BLOCK_KEY] : undefined;
  return typeof key === 'string' ? key : undefined;
};

/** A slot of one field value, in one locale: the field's top level, or one block's slot. */
const TOP = '';
const slotId = (parentKey: string, slot: string) => `${parentKey}\u0000${slot}`;

/** What a field value held before the save: each slot's child keys, and every block's key. */
interface Held {
  readonly slots: ReadonlyMap<string, readonly (string | undefined)[]>;
  readonly blocks: ReadonlySet<string>;
}

/**
 * The issues the config finds with a save of `contentType`'s entry from `before` (undefined for a
 * create) to `after`, for new edits only. Every catalog target of the type is compared, locale by
 * locale (`locales` limits which), slot by slot: a slot is the top level of the field, or one
 * block's slot, identified by that block's `_key` and the slot's apiId, so a block moved with its
 * children keeps its slots.
 *
 * - **Placement.** A block in a slot after the save but not before it (inserted, duplicated or
 *   moved in) must be one the slot's narrowed list takes. A block stored under a former id
 *   (an alias) counts as its block.
 * - **Lock.** A locked slot's sequence of keys can't change (nothing inserted, removed, moved in
 *   or out, or reordered); what's inside its blocks can. A slot that comes into being in this save
 *   (a block newly placed, or a create) is filled as it comes, under placement and counts.
 * - **Counts.** Only when the save changes a slot's number of blocks, the new number must fit the
 *   narrowed `min` and `max`, unless it moves toward them: a slot holding more than `max` (stored
 *   before the config tightened) can lose one block at a time, and one holding fewer than `min`
 *   gain one. A field the save leaves without a value in a locale isn't counted there: whether it
 *   must have one is the content model's `required`.
 *
 * So content stored before the config (or before it tightened) stays saveable as long as the save
 * leaves the slot's blocks where they are. Values the type or the catalog doesn't know are left
 * to validation, which runs first.
 */
export function blockConfigIssues(
  contentType: ContentType,
  catalog: BlockConfigCatalog | null,
  config: Pick<BlockConfig, 'version' | 'targets' | 'blocks'>,
  before: EntryFields | undefined,
  after: EntryFields,
  locales?: readonly LocaleCode[],
): BlockConfigIssue[] {
  if (!catalog) return [];
  const rules = effectiveBlockRules(catalog, config);
  const byId = new Map(catalog.blocks.map((b) => [b.id, b]));
  const aliases = codeRules(catalog).aliases;
  const blockOf = (item: unknown): BlockManifest | undefined => {
    const type = isObject(item) ? item[BLOCK_TYPE_KEY] : undefined;
    if (typeof type !== 'string') return undefined;
    return byId.get(type) ?? byId.get(aliases.get(type) ?? '');
  };
  const slotRules = new Map(rules.blocks.map((b) => [b.block, b.slots]));
  const issues: BlockConfigIssue[] = [];

  /** Every slot's child keys in one field value, and every block's key. */
  const hold = (root: unknown): Held => {
    const slots = new Map<string, (string | undefined)[]>();
    const blocks = new Set<string>();
    const walk = (items: unknown, id: string | undefined): void => {
      if (!Array.isArray(items)) return;
      // Keys are unique per array, not per tree: a key held twice keeps the first's slots.
      if (id !== undefined && !slots.has(id)) slots.set(id, items.map(keyOf));
      for (const item of items) {
        const key = keyOf(item);
        if (key !== undefined) blocks.add(key);
        for (const s of blockOf(item)?.slots ?? []) {
          walk((item as Item)[s.apiId], key === undefined ? undefined : slotId(key, s.apiId));
        }
      }
    };
    walk(root, TOP);
    return { slots, blocks };
  };

  const judge = (
    items: unknown,
    id: string | undefined,
    slot: {
      readonly allowed: readonly string[];
      readonly min?: number;
      readonly max?: number;
      readonly locked: boolean;
    },
    path: string,
    locale: LocaleCode,
    held: Held | undefined,
  ): void => {
    const list = Array.isArray(items) ? items : [];
    // A field left without a value isn't counted (see above); a block's empty slot is.
    const counted = id !== TOP || items !== undefined;
    // The slot was there before: the field of an entry being updated, or a slot of a block it held.
    const existed =
      held !== undefined &&
      id !== undefined &&
      (id === TOP || held.blocks.has(id.slice(0, id.indexOf('\u0000'))));
    const was = existed ? (held.slots.get(id) ?? []) : undefined;
    const keys = list.map(keyOf);
    list.forEach((item, i) => {
      const key = keys[i];
      const placed = was === undefined || key === undefined || !was.includes(key);
      const block = blockOf(item);
      if (placed && block && !slot.allowed.includes(block.id)) {
        issues.push({
          field: `${path}[${i}]`,
          locale,
          code: 'block_not_allowed_here',
          ...(key !== undefined ? { key } : {}),
          message: `"${block.name}" can't go here: this slot takes ${quoted(slot.allowed)}`,
        });
      }
    });
    if (
      slot.locked &&
      was !== undefined &&
      (was.length !== keys.length || was.some((k, i) => k !== keys[i]))
    ) {
      issues.push({
        field: path,
        locale,
        code: 'slot_locked',
        message:
          'This slot is locked: its blocks can’t be added, removed, moved or reordered (what’s inside them can still be edited)',
      });
    }
    // A new slot is counted as it comes; an old one only when it grew past max or shrank below min.
    const grew = counted && (was === undefined || list.length > was.length);
    const shrank = counted && (was === undefined || list.length < was.length);
    if (shrank && slot.min !== undefined && list.length < slot.min) {
      issues.push({
        field: path,
        locale,
        code: 'slot_too_few',
        message: `This slot holds at least ${slot.min} ${slot.min === 1 ? 'block' : 'blocks'}`,
      });
    }
    if (grew && slot.max !== undefined && list.length > slot.max) {
      issues.push({
        field: path,
        locale,
        code: 'slot_too_many',
        message: `This slot holds at most ${slot.max} ${slot.max === 1 ? 'block' : 'blocks'}`,
      });
    }
    list.forEach((item, i) => {
      const block = blockOf(item);
      const nested = block ? slotRules.get(block.id) : undefined;
      if (!block || !nested) return;
      const key = keys[i];
      for (const s of block.slots ?? []) {
        const r = nested[s.apiId];
        if (!r) continue;
        judge(
          (item as Item)[s.apiId],
          key === undefined ? undefined : slotId(key, s.apiId),
          { allowed: r.allowedChildren, ...r },
          `${path}[${i}].${s.apiId}`,
          locale,
          held,
        );
      }
    });
  };

  for (const target of rules.targets) {
    if (target.contentTypeApiId !== contentType.apiId) continue;
    const def = contentType.fields.find((f) => f.apiId === target.field);
    if (!def || !blockVariants(def)) continue;
    const was = before?.[def.apiId] ?? {};
    const now = after[def.apiId] ?? {};
    const inLocales = new Set([...Object.keys(was), ...Object.keys(now)]);
    for (const locale of inLocales) {
      if (locales && !locales.includes(locale)) continue;
      judge(
        now[locale],
        TOP,
        { allowed: target.blocks, ...target },
        def.apiId,
        locale,
        before === undefined ? undefined : hold(was[locale]),
      );
    }
  }
  return issues;
}
