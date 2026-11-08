/**
 * What a click in the framed page asks the form to show. The page names what was clicked by its
 * content ref (`data-cw-ref`), whose field part is a path: `title`, `body[k1]`,
 * `body[k1].items[k2].label`. The form opens the path's top-level field, and focuses the innermost
 * block the path passes through, in the locale the ref names.
 *
 * Every ref is untrusted (docs/specs/live-preview-channel.md, "Untrusted input"): it is followed
 * only when it names this entry, in this space and environment, of this type, and the page said in
 * `page` that it shows the entry. The entry is the one the person has open, so they may read it.
 */
import type { ContentType } from '@contentworker/domain';
import {
  formatContentRef,
  formatFieldPath,
  parseContentRef,
  parseFieldPath,
} from '@contentworker/sdk-core';

/** A field to bring into view and focus, and the block in it when the path passes through one. */
export interface FieldFocus {
  readonly apiId: string;
  readonly locale?: string;
  readonly blockKey?: string;
}

export interface PickContext {
  readonly space: string;
  readonly environment: string;
  readonly entryId: string;
  readonly contentType: Pick<ContentType, 'apiId' | 'fields'>;
  readonly locales: readonly string[];
  /** The entries the page said it renders (`page`). */
  readonly pageEntries: readonly string[];
}

/** The form field a ref names, or undefined when it names nothing the form may show. */
export function focusForRef(ref: string, ctx: PickContext): FieldFocus | undefined {
  const parsed = parseContentRef(ref);
  if (!parsed) return undefined;
  if (parsed.entryId !== ctx.entryId || !ctx.pageEntries.includes(parsed.entryId)) return undefined;
  if (parsed.space !== ctx.space || parsed.environment !== ctx.environment) return undefined;
  if (parsed.contentType !== ctx.contentType.apiId) return undefined;
  const path = parseFieldPath(parsed.field);
  if (!path || !ctx.contentType.fields.some((f) => f.apiId === path.field)) return undefined;
  const keys = path.steps.flatMap((s) => ('key' in s ? [s.key] : []));
  const blockKey = keys.at(-1);
  return {
    apiId: path.field,
    ...(ctx.locales.includes(parsed.locale) ? { locale: parsed.locale } : {}),
    ...(blockKey !== undefined ? { blockKey } : {}),
  };
}

/**
 * The ref a form field (or a block in it) has on the page: what `select` names. A block's path is
 * found in the field's value (`value`), through every block and slot that holds it, as the page
 * writes it (`body[k1].items[k2]`); a key the value doesn't hold names the field alone.
 */
export function refForField(
  ctx: Omit<PickContext, 'pageEntries' | 'locales'>,
  locale: string,
  apiId: string,
  blockKey?: string,
  value?: unknown,
): string {
  const steps = blockKey !== undefined ? (stepsTo(value, blockKey) ?? []) : [];
  return formatContentRef({
    space: ctx.space,
    environment: ctx.environment,
    entryId: ctx.entryId,
    contentType: ctx.contentType.apiId,
    field: formatFieldPath({ field: apiId, steps }),
    locale,
  });
}

type Step = { readonly key: string } | { readonly field: string };

/** The path steps from a blocks list to the block keyed `key`, or undefined when it isn't there. */
function stepsTo(list: unknown, key: string): Step[] | undefined {
  if (!Array.isArray(list)) return undefined;
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue;
    const block = item as Record<string, unknown>;
    if (typeof block._key !== 'string') continue;
    if (block._key === key) return [{ key }];
    for (const [name, held] of Object.entries(block)) {
      const below = stepsTo(held, key);
      if (below) return [{ key: block._key }, { field: name }, ...below];
    }
  }
  return undefined;
}
