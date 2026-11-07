/**
 * What a click in the framed page asks the form to show: the field a `data-cw-ref` names, or the
 * blocks field (and locale) holding the block a `data-cw-block` key names.
 */
import {
  BLOCK_KEY,
  blockVariants,
  type ContentType,
  type EntryFields,
} from '@contentworker/domain';
import { parseContentRef } from '@contentworker/sdk-core';
import type { LiveTarget } from '@contentworker/sdk-core/live-preview';

/** A field to bring into view and focus, and the block in it when the pick was a block. */
export interface FieldFocus {
  readonly apiId: string;
  readonly locale?: string;
  readonly blockKey?: string;
}

export interface PickContext {
  readonly contentType: Pick<ContentType, 'fields'>;
  readonly entryId: string;
  /** The form's values, as a save would send them. */
  readonly fields: EntryFields;
  readonly locales: readonly string[];
  /** The locale tab the form is on: a block held in several locales is looked for here first. */
  readonly locale: string;
}

/**
 * The form field a pick names, or undefined when it names nothing in this entry: a ref to another
 * entry the page also shows, a field the type doesn't have, a key no block holds.
 */
export function focusForPick(target: LiveTarget, ctx: PickContext): FieldFocus | undefined {
  if (target.ref !== undefined) {
    const ref = parseContentRef(target.ref);
    if (!ref || ref.entryId !== ctx.entryId) return undefined;
    if (!ctx.contentType.fields.some((f) => f.apiId === ref.field)) return undefined;
    return {
      apiId: ref.field,
      ...(ctx.locales.includes(ref.locale) ? { locale: ref.locale } : {}),
    };
  }
  const key = target.key;
  for (const field of ctx.contentType.fields) {
    if (!blockVariants(field)) continue;
    const byLocale = ctx.fields[field.apiId] as Record<string, unknown> | undefined;
    if (!byLocale) continue;
    const order = [ctx.locale, ...Object.keys(byLocale).filter((l) => l !== ctx.locale)];
    for (const locale of order) {
      if (holdsKey(byLocale[locale], key)) return { apiId: field.apiId, locale, blockKey: key };
    }
  }
  return undefined;
}

/** Whether a block with `_key` sits anywhere in a value: a list of blocks, or the slots inside one. */
function holdsKey(value: unknown, key: string): boolean {
  if (Array.isArray(value)) return value.some((v) => holdsKey(v, key));
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record[BLOCK_KEY] === key) return true;
  return Object.values(record).some((v) => holdsKey(v, key));
}
