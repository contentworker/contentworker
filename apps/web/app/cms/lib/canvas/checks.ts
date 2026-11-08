/**
 * What stands between the canvas and a save (and so a publish): a block whose type the code no
 * longer provides, a required slot with too few blocks, and every other issue validation finds in
 * the blocks fields, each pointed at the block it falls in so a click selects it. Judged by the
 * domain's own `validateEntryFields`, as the save will judge it.
 */
import {
  blockAtPath,
  blockVariants,
  type ContentType,
  type EntryFields,
  validateEntryFields,
} from '@contentworker/domain';
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
    if (slot.min === undefined || slot.blocks.length >= slot.min) continue;
    shortSlots.push(slot);
    const need = slot.min - slot.blocks.length;
    out.push({
      id: `min:${slot.path}`,
      message: `${slot.name} needs ${slot.min === 1 ? 'a block' : `at least ${slot.min} blocks`}${
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
  return out;
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
