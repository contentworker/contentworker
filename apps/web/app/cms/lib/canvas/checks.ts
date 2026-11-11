/**
 * What stands between the canvas and a save (and so a publish): a block whose type the code no
 * longer provides, a required slot with too few blocks, every other issue validation finds in the
 * blocks fields, and what the block config refuses of the edit (a block placed where it isn't
 * allowed, a locked slot changed, a count pushed past the config's bounds) or a locked region
 * of the entry's (its blocks moved or removed, its frozen content edited), each pointed at the
 * block it falls in so a click selects it. Judged by the domain's own `validateEntryFields` and
 * `blockConfigIssues`, as the save will judge it; a refusal the server sends back anyway (a config
 * set since the canvas read it) is pointed at the same way (`configChecks`), as is a per-breakpoint
 * override the server refused (`override_undeclared`, `override_invalid`: one a push made stale
 * that no stored version holds), on the block its key names.
 */
import {
  type BlockCatalog,
  type BlockConfigIssue,
  blockAtPath,
  blockVariants,
  type ContentType,
  type EffectiveBlockRules,
  type EntryFields,
  type UndeclaredOverrideIssue,
  validateEntryFields,
} from '@contentworker/domain';
import { configIssues } from '../block-rules';
import type { EntryBlockLock } from '../management';
import { type CanvasSlot, flattenBlocks, flattenSlots } from './model';

export interface CanvasCheck {
  readonly id: string;
  readonly message: string;
  /** The block to select for it, when it falls in one. */
  readonly blockKey?: string;
  /** It is about a field the canvas doesn't edit: the form fixes it. */
  readonly inForm?: true;
}

export function canvasChecks(
  contentType: ContentType,
  fields: EntryFields,
  slots: readonly CanvasSlot[],
  config: {
    readonly locales: readonly string[];
    readonly defaultLocale: string;
    readonly locale: string;
    /** The stored fields, which a field its rules disable must keep, as the save judges it. */
    readonly previous?: EntryFields;
    /** The block config in force, over the catalog it was read with: the edit is judged by it. */
    readonly blocks?: {
      readonly catalog: BlockCatalog | null | undefined;
      readonly rules: EffectiveBlockRules | null | undefined;
    };
    /** What the server's block config (or its override check) refused of the last save, until the next edit. */
    readonly refused?: readonly RefusedIssue[];
    /** The entry's locked regions, which the save is judged against too. */
    readonly locks?: readonly EntryBlockLock[];
  },
): CanvasCheck[] {
  const out: CanvasCheck[] = [];
  const removed = new Set<string>();
  for (const b of flattenBlocks(slots)) {
    if (b.variant) continue;
    removed.add(b.key);
    out.push({
      id: `removed:${b.key}`,
      message: `${b.name} in ${b.slot.name} was removed from code: remove it to save`,
      blockKey: b.key,
    });
  }
  const shortSlots: CanvasSlot[] = [];
  for (const slot of flattenSlots(slots)) {
    // The field's own least, which every save is held to; the config's holds edits only (below).
    const min = slot.fieldMin;
    if (min === undefined || slot.blocks.length >= min) continue;
    shortSlots.push(slot);
    const need = min - slot.blocks.length;
    out.push({
      id: `min:${slot.path}`,
      message: `${slot.name} needs ${min === 1 ? 'a block' : `at least ${min} blocks`}${
        slot.blocks.length > 0 ? ` (${need} more)` : ''
      }`,
      ...(slot.address.parent ? { blockKey: slot.address.parent.key } : {}),
    });
  }
  const blocksFields = new Set(
    contentType.fields.filter((f) => blockVariants(f)).map((f) => f.apiId),
  );
  const issues = validateEntryFields(contentType, fields, {
    locales: config.locales,
    defaultLocale: config.defaultLocale,
    ...(config.previous ? { previous: config.previous } : {}),
  });
  issues.forEach((issue, i) => {
    const top = /^[A-Za-z]\w*/.exec(issue.field)?.[0] ?? '';
    const locale = issue.locale ?? config.defaultLocale;
    // Outside the blocks, or in a locale the canvas isn't showing: said, to fix in the form.
    if (!blocksFields.has(top) || (locale !== config.locale && locale !== config.defaultLocale)) {
      const name = contentType.fields.find((f) => f.apiId === top)?.name ?? top;
      out.push({
        id: `issue:${i}`,
        message: `${name}${issue.locale ? ` (${issue.locale})` : ''}: ${issue.message}`,
        inForm: true,
      });
      return;
    }
    const block = blockAtPath(contentType, fields, locale, issue.field);
    // Said once already, in words that name what to do.
    if (block && removed.has(block.key)) return;
    const at = keyAt(fields, locale, issue.field);
    if (at !== undefined && removed.has(at)) return;
    // A short slot is said above, by its name: validation's size or required line is the same.
    if (shortSlots.some((slot) => isSlotIssue(slot, issue.field, block?.key))) return;
    const where = block ? (flattenBlocks(slots).find((b) => b.key === block.key)?.name ?? '') : '';
    out.push({
      id: `issue:${i}`,
      message: where ? `${where}: ${issue.message}` : issue.message,
      ...(block ? { blockKey: block.key } : {}),
    });
  });
  const judged = config.blocks
    ? configIssues(
        contentType,
        config.blocks.catalog,
        config.blocks.rules,
        config.previous,
        fields,
        config.locales,
        config.locks,
      )
    : [];
  const seen = new Set(out.map((c) => c.id));
  for (const c of configChecks([...judged, ...(config.refused ?? [])], fields, slots, config)) {
    // A short slot is said once, by validation's line when the field itself needs more.
    if (c.id.startsWith('config:slot_too_few:') && c.slotPath && seen.has(`min:${c.slotPath}`)) {
      continue;
    }
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    out.push({
      id: c.id,
      message: c.message,
      ...(c.blockKey ? { blockKey: c.blockKey } : {}),
      ...(c.inForm ? { inForm: c.inForm } : {}),
    });
  }
  return out;
}

/**
 * The block config's issues with an edit (judged here, or a save's refusal) as checks, in the
 * canvas's words: each names the block or the slot by name and selects the block it falls in. An
 * issue in a locale the canvas isn't showing is said, to fix in the form.
 */
export function configChecks(
  issues: readonly RefusedIssue[],
  fields: EntryFields,
  slots: readonly CanvasSlot[],
  config: { readonly locale: string; readonly defaultLocale: string },
): (CanvasCheck & { readonly slotPath?: string })[] {
  const blocks = flattenBlocks(slots);
  const all = flattenSlots(slots);
  return issues.map((issue) => {
    const locale = issue.locale ?? config.defaultLocale;
    const id = `config:${issue.code}:${issue.field}:${locale}`;
    if (locale !== config.locale && locale !== config.defaultLocale) {
      return { id, message: `${issue.locale ? `${issue.locale}: ` : ''}${issue.message}`, inForm };
    }
    if (issue.code === 'override_undeclared' || issue.code === 'override_invalid') {
      // Named by its block, whose settings are where the override is reset or undone.
      const block = issue.key ? blocks.find((b) => b.key === issue.key) : undefined;
      if (!block) return { id, message: issue.message };
      return {
        id,
        message:
          issue.code === 'override_invalid'
            ? `${block.name}: ${issue.message}. Reset it at its width to save`
            : `${block.name}: ${issue.message}. Undo the change to save`,
        blockKey: block.key,
      };
    }
    if (issue.code === 'region_locked' || issue.code === 'region_frozen') {
      // Named by the region's first block, which may be gone from the edit: its name then is the
      // one it had.
      const block = issue.key ? blocks.find((b) => b.key === issue.key) : undefined;
      const name = block?.name ?? 'A locked block';
      return {
        id,
        message:
          issue.code === 'region_frozen'
            ? `${name} is locked and its content can’t be edited. Undo the change to save`
            : `${name} is locked: its blocks can’t be added, removed or moved. Undo the change to save`,
        ...(block ? { blockKey: block.key } : {}),
      };
    }
    if (issue.code === 'block_not_allowed_here') {
      const block = issue.key ? blocks.find((b) => b.key === issue.key) : undefined;
      if (!block) return { id, message: issue.message };
      return {
        id,
        message: `${block.name} can’t go in ${block.slot.name}: the block config doesn’t allow it there`,
        blockKey: block.key,
      };
    }
    const slot = slotAtPath(all, fields, locale, issue.field);
    if (!slot) return { id, message: issue.message };
    const at = {
      slotPath: slot.path,
      ...(slot.address.parent ? { blockKey: slot.address.parent.key } : {}),
    };
    switch (issue.code) {
      case 'slot_locked':
        return {
          id,
          message: `${slot.name} is locked: its blocks can’t be added, removed or moved. Undo the change to save`,
          ...at,
        };
      case 'slot_too_few':
        return {
          id,
          message: `${slot.name} needs at least ${slot.min ?? 1} ${slot.min === 1 ? 'block' : 'blocks'} here`,
          ...at,
        };
      case 'slot_too_many':
        return {
          id,
          message: `${slot.name} holds at most ${slot.max ?? 0} ${slot.max === 1 ? 'block' : 'blocks'} here`,
          ...at,
        };
      default:
        return { id, message: issue.message, ...at };
    }
  });
}

const inForm = true as const;

/** What a save can be refused for, said on the canvas: the block config's issues and overrides'. */
export type RefusedIssue = BlockConfigIssue | UndeclaredOverrideIssue;

/**
 * The slot a positional path names (`body`, `body[2].items`) among every slot of the tree: a
 * top-level field by its name, a block's slot by the key of the block the path leads to.
 */
function slotAtPath(
  all: readonly CanvasSlot[],
  fields: EntryFields,
  locale: string,
  path: string,
): CanvasSlot | undefined {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return all.find((s) => s.address.field === path && !s.address.parent);
  const parent = keyAt(fields, locale, path.slice(0, dot));
  const name = path.slice(dot + 1);
  if (parent === undefined) return undefined;
  return all.find((s) => s.address.parent?.key === parent && s.address.parent.slot === name);
}

/** Whether a validation issue at `field` (positional: `body`, `body[2].items`) is about `slot`. */
function isSlotIssue(slot: CanvasSlot, field: string, blockKey: string | undefined): boolean {
  const parent = slot.address.parent;
  if (!parent) return field === slot.address.field && blockKey === undefined;
  return blockKey === parent.key && field.endsWith(`.${parent.slot}`);
}

/** The `_key` of the value a positional path (`body[3]`) names, when it is a keyed block. */
function keyAt(fields: EntryFields, locale: string, path: string): string | undefined {
  const tokens = [...path.matchAll(/([A-Za-z]\w*)|\[(\d+)\]/g)];
  const top = tokens[0]?.[1];
  let value: unknown = top !== undefined ? fields[top]?.[locale] : undefined;
  for (const t of tokens.slice(1)) {
    if (typeof value !== 'object' || value === null) return undefined;
    value =
      t[2] !== undefined
        ? (value as unknown[])[Number(t[2])]
        : (value as Record<string, unknown>)[t[1] as string];
  }
  const key = (value as { _key?: unknown } | null | undefined)?._key;
  return typeof key === 'string' ? key : undefined;
}
