/**
 * The block config in the editors: what a slot offers once the environment's narrowings
 * (`GET …/block-config/effective`) are laid over the code, for the canvas and the entry form alike.
 *
 * The config judges new edits, not stored content (`blockConfigIssues` in the domain), and so does
 * everything here. A slot offers only the blocks its narrowed rule takes, for an insert or a
 * duplicate; a block already in it stays, visible and editable, whatever the rule says now. A lock
 * holds only a slot that was stored: one that comes into being in this edit (a block just placed,
 * a new entry, a field with no blocks yet in that locale) is filled as it comes, as the server
 * fills it. Stale parts of the config are already left out of the effective rules; nothing here
 * reads them.
 *
 * Pure: the screens fetch the rules and the stored fields, and draw what this says.
 */
import {
  BLOCK_CONFIG_ISSUE_CODES,
  BLOCK_KEY,
  type BlockCatalog,
  type BlockConfig,
  type BlockConfigIssue,
  type BlockNarrowing,
  blockConfigIssues,
  blockVariants,
  type ComponentVariant,
  type ContentType,
  type EffectiveBlockRules,
  type EffectiveSlotRules,
  type EntryFields,
  type LocaleCode,
  type SlotNarrowing,
  type TargetNarrowing,
  variantOf,
} from '@contentworker/domain';
import { ApiError } from './management';

/** Where a slot is, as the rules name it: a target's top level, or one block's slot. */
export type SlotWhere =
  | { readonly contentType: string; readonly field: string }
  | {
      /** The block's id in the catalog (its variant's apiId: an alias already followed). */
      readonly block: string;
      readonly slot: string;
    };

/** The narrowed rule for a slot, or undefined when the rules say nothing about it. */
export function ruleFor(
  rules: EffectiveBlockRules | null | undefined,
  where: SlotWhere,
): EffectiveSlotRules | undefined {
  if (!rules) return undefined;
  if ('field' in where) {
    const t = rules.targets.find(
      (t) => t.contentTypeApiId === where.contentType && t.field === where.field,
    );
    if (!t) return undefined;
    return {
      allowedChildren: t.blocks,
      ...(t.min !== undefined ? { min: t.min } : {}),
      ...(t.max !== undefined ? { max: t.max } : {}),
      locked: t.locked,
      narrowed: t.narrowed,
    };
  }
  return rules.blocks.find((b) => b.block === where.block)?.slots[where.slot];
}

/**
 * The rules, when they are over `catalog` (or the catalog isn't known yet); undefined when a push
 * landed between the two reads, so nothing is narrowed by rules made for another catalog. The
 * server still judges the save.
 */
export function rulesOver(
  rules: EffectiveBlockRules | null | undefined,
  catalog: BlockCatalog | null | undefined,
): EffectiveBlockRules | undefined {
  if (!rules) return undefined;
  if (catalog === undefined) return rules;
  return rules.catalogVersion === (catalog?.version ?? null) ? rules : undefined;
}

/** What one slot lets an edit do. */
export interface SlotPolicy {
  /** The blocks a new block here may be (an insert, a duplicate), in the field's order. */
  readonly offers: readonly ComponentVariant[];
  /** Fewest and most blocks, the field's own and the config's, whichever is tighter. */
  readonly min?: number;
  readonly max?: number;
  /** Its blocks can't be added, removed, moved or reordered in this edit. */
  readonly locked: boolean;
  /** The config narrows it (it may still be unlocked here: a slot new to this edit). */
  readonly narrowed: boolean;
}

/**
 * A slot's policy: its field's `variants` and `size` (what the code allows, as validation reads
 * it), narrowed by `rule`. `stored` says whether the slot was in the stored entry, which is what
 * makes a lock hold (see the module's note).
 */
export function slotPolicy(
  variants: readonly ComponentVariant[],
  size: { readonly min?: number; readonly max?: number } | undefined,
  rule: EffectiveSlotRules | undefined,
  stored: boolean,
): SlotPolicy {
  const allowed = rule ? new Set(rule.allowedChildren) : undefined;
  const min = tighter(size?.min, rule?.min, Math.max);
  const max = tighter(size?.max, rule?.max, Math.min);
  return {
    offers: allowed ? variants.filter((v) => allowed.has(v.apiId)) : variants,
    ...(min !== undefined ? { min } : {}),
    ...(max !== undefined ? { max } : {}),
    locked: !!rule?.locked && stored,
    narrowed: !!rule?.narrowed,
  };
}

const tighter = (
  a: number | undefined,
  b: number | undefined,
  pick: (x: number, y: number) => number,
) => (a === undefined ? b : b === undefined ? a : pick(a, b));

/** Whether a new block of `variant` (a copy of one, too) may go where `policy` holds. */
export function offers(policy: SlotPolicy, variant: ComponentVariant | undefined): boolean {
  return !!variant && policy.offers.some((v) => v.apiId === variant.apiId);
}

/** The slots of the stored entry in one locale: what a lock holds. */
export interface StoredSlots {
  /** Top-level fields holding at least one block (an empty one is filled as it comes). */
  readonly fields: ReadonlySet<string>;
  /** The keys of every stored block: each one's slots were stored with it. */
  readonly blocks: ReadonlySet<string>;
}

export const NOTHING_STORED: StoredSlots = { fields: new Set(), blocks: new Set() };

/**
 * The stored entry's slots in `locale` (a field that isn't localized is read in `defaultLocale`).
 * Undefined `stored` is a new entry: nothing was stored, so nothing is locked yet.
 */
export function storedSlots(
  contentType: Pick<ContentType, 'fields'>,
  stored: EntryFields | undefined,
  locale: string,
  defaultLocale: string,
): StoredSlots {
  if (!stored) return NOTHING_STORED;
  const fields = new Set<string>();
  const blocks = new Set<string>();
  const walk = (variants: readonly ComponentVariant[], items: unknown) => {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      const key = (item as Record<string, unknown> | null)?.[BLOCK_KEY];
      if (typeof key === 'string') blocks.add(key);
      const variant = variantOf(variants, item);
      for (const f of variant?.fields ?? []) {
        const nested = blockVariants(f);
        if (nested) walk(nested, (item as Record<string, unknown>)[f.apiId]);
      }
    }
  };
  for (const def of contentType.fields) {
    const variants = blockVariants(def);
    if (!variants) continue;
    const value = (stored[def.apiId] as Record<string, unknown> | undefined)?.[
      def.localized ? locale : defaultLocale
    ];
    if (Array.isArray(value) && value.length > 0) fields.add(def.apiId);
    walk(variants, value);
  }
  return { fields, blocks };
}

/** Whether the slot at `where` was stored: a top-level field with blocks, or a stored block's. */
export function wasStored(
  stored: StoredSlots,
  where: { readonly field: string; readonly parentKey?: string },
): boolean {
  return where.parentKey === undefined
    ? stored.fields.has(where.field)
    : stored.blocks.has(where.parentKey);
}

/**
 * A config that lays out to `rules` again: each narrowed target and slot as a narrowing. It is
 * what `blockConfigIssues` judges a save by, so an editor can say before saving what the server
 * would refuse, with the same code. Only meaningful over the catalog `rules` were made from.
 */
export function configOf(
  rules: EffectiveBlockRules,
): Pick<BlockConfig, 'version' | 'targets' | 'blocks'> {
  const narrowing = (r: Omit<EffectiveSlotRules, 'allowedChildren'>): SlotNarrowing => ({
    ...(r.min !== undefined ? { min: r.min } : {}),
    ...(r.max !== undefined ? { max: r.max } : {}),
    ...(r.locked ? { locked: true } : {}),
  });
  const targets: TargetNarrowing[] = rules.targets
    .filter((t) => t.narrowed)
    .map((t) => ({
      contentTypeApiId: t.contentTypeApiId,
      field: t.field,
      blocks: t.blocks,
      ...narrowing(t),
    }));
  const blocks: BlockNarrowing[] = rules.blocks.flatMap((b) => {
    const slots = Object.entries(b.slots).filter(([, s]) => s.narrowed);
    if (slots.length === 0) return [];
    return [
      {
        block: b.block,
        slots: Object.fromEntries(
          slots.map(([apiId, s]) => [
            apiId,
            { allowedChildren: s.allowedChildren, ...narrowing(s) },
          ]),
        ),
      },
    ];
  });
  return { version: rules.configVersion, targets, blocks };
}

/**
 * What the config refuses of a save from `before` (undefined for a create) to `after`, judged as
 * the server will. Nothing when the rules aren't over this catalog (one pushed since they were
 * read): the server still judges it.
 */
export function configIssues(
  contentType: ContentType,
  catalog: BlockCatalog | null | undefined,
  rules: EffectiveBlockRules | null | undefined,
  before: EntryFields | undefined,
  after: EntryFields,
  locales?: readonly LocaleCode[],
): BlockConfigIssue[] {
  if (!catalog || !rules || rules.catalogVersion !== catalog.version) return [];
  return blockConfigIssues(contentType, catalog, configOf(rules), before, after, locales);
}

const CODES: ReadonlySet<string> = new Set(BLOCK_CONFIG_ISSUE_CODES);

/**
 * The block config's issues in a refused save (422), read from the api's body or, through
 * Coworker, from the MCP tool's error text (the same body as JSON). Empty for any other failure,
 * and for a 422 about something else.
 */
export function configRefusal(err: unknown): BlockConfigIssue[] {
  let body: unknown;
  if (err instanceof ApiError) {
    if (err.status !== 422) return [];
    body = err.body;
  } else if (err instanceof Error && err.message.startsWith('{')) {
    try {
      body = JSON.parse(err.message);
    } catch {
      return [];
    }
  }
  const issues = (body as { error?: { issues?: unknown } } | undefined)?.error?.issues;
  if (!Array.isArray(issues)) return [];
  return issues.filter(
    (i): i is BlockConfigIssue =>
      typeof i === 'object' &&
      i !== null &&
      typeof (i as { code?: unknown }).code === 'string' &&
      CODES.has((i as { code: string }).code) &&
      typeof (i as { field?: unknown }).field === 'string' &&
      typeof (i as { message?: unknown }).message === 'string',
  );
}
