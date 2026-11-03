import {
  ConflictError,
  type ContentType,
  type ContentTypeDraft,
  defineContentType,
  type EntryFields,
  NotFoundError,
  removedFields,
  removedFieldUses,
  removedVariants,
  removedVariantUses,
  reviseContentType,
  type Scope,
} from '@contentworker/domain';
import type { AppContext } from './context';

/** Creates a new content type definition (status "draft", version 1). */
export async function createContentType(
  ctx: AppContext,
  scope: Scope,
  draft: ContentTypeDraft,
): Promise<ContentType> {
  // An existing type is revised, not defined afresh: a revision is checked against what is
  // stored, so a definition saved before a check existed can still be edited.
  const existing = await ctx.store.contentTypes.get(scope, draft.apiId);
  if (existing) {
    return updateContentType(ctx, scope, draft.apiId, draft);
  }
  const contentType = defineContentType(draft);
  await ctx.store.contentTypes.save(scope, contentType);
  return contentType;
}

/** Revises an existing content type, bumping its version. */
export async function updateContentType(
  ctx: AppContext,
  scope: Scope,
  apiId: string,
  changes: Partial<Pick<ContentTypeDraft, 'name' | 'displayField' | 'fields' | 'urlPattern'>>,
): Promise<ContentType> {
  const current = await ctx.store.contentTypes.get(scope, apiId);
  if (!current) throw new NotFoundError('ContentType', apiId);
  const revised = reviseContentType(current, changes);
  await assertNoRemovedContentInUse(ctx, scope, current, revised);
  await ctx.store.contentTypes.save(scope, revised);
  return revised;
}

/** Entries read per page while looking for content a revision would strand. */
const REMOVAL_SCAN_PAGE = 100;
/** Entry ids named per location in the error message; the details carry them all. */
const REMOVAL_SCAN_NAMED = 10;

/** What a revision removes that entries in `scope` still hold, by kind. */
export interface RemovedContentInUse {
  readonly variantsInUse: readonly { variant: string; entries: readonly string[] }[];
  readonly fieldsInUse: readonly { field: string; entries: readonly string[] }[];
}

/**
 * The block variants and fields `revised` removes from `current` that entries in `scope` still
 * hold: a block of a removed variant, or a value (anything but absent or null) for a removed
 * field, at any depth.
 *
 * Every copy of an entry that could be served or saved again is checked: its current version
 * (drafts and live entries), the trash (restorable), and the published snapshot, which can differ
 * from the current version when an entry has unpublished changes. Older history versions are
 * not: restoring one goes through `updateEntry`, which validates it against the type as it is
 * then.
 *
 * Only reads when something is actually removed, so ordinary edits cost nothing. Keyset pages by
 * entry id keep each read to one bounded statement (the type is a single bound parameter,
 * whatever the entry count).
 */
export async function removedContentInUse(
  ctx: AppContext,
  scope: Scope,
  current: ContentType,
  revised: Pick<ContentType, 'fields'>,
): Promise<RemovedContentInUse> {
  const variants = removedVariants(current.fields, revised.fields);
  const fields = removedFields(current.fields, revised.fields);
  if (variants.size === 0 && fields.size === 0) return { variantsInUse: [], fieldsInUse: [] };

  const variantUses = new Map<string, Set<string>>();
  const fieldUses = new Map<string, Set<string>>();
  const note = (into: Map<string, Set<string>>, key: string, entryId: string) => {
    const ids = into.get(key) ?? new Set<string>();
    ids.add(entryId);
    into.set(key, ids);
  };
  const check = (entryId: string, values: EntryFields) => {
    for (const use of removedVariantUses(current.fields, values, variants))
      note(variantUses, use, entryId);
    for (const use of removedFieldUses(current.fields, values, fields))
      note(fieldUses, use, entryId);
  };
  for (const archived of [false, true]) {
    for (let after = ''; ; ) {
      const page = await ctx.store.entries.list(scope, {
        contentTypeApiId: current.apiId,
        archived,
        limit: REMOVAL_SCAN_PAGE,
        afterEntryId: after,
      });
      for (const e of page) check(e.entry.id, e.fields);
      if (page.length < REMOVAL_SCAN_PAGE) break;
      after = page[page.length - 1]?.entry.id ?? after;
    }
  }
  for (let after = ''; ; ) {
    const page = await ctx.store.entries.listPublished(scope, {
      contentTypeApiId: current.apiId,
      limit: REMOVAL_SCAN_PAGE,
      afterEntryId: after,
    });
    for (const p of page) check(p.entryId, p.fields);
    if (page.length < REMOVAL_SCAN_PAGE) break;
    after = page[page.length - 1]?.entryId ?? after;
  }
  const sorted = (m: Map<string, Set<string>>) =>
    [...m].map(([at, ids]) => [at, [...ids].sort()] as const);
  return {
    variantsInUse: sorted(variantUses).map(([variant, entries]) => ({ variant, entries })),
    fieldsInUse: sorted(fieldUses).map(([field, entries]) => ({ field, entries })),
  };
}

/** `location (entries a, b and 3 more)`, for a refusal or a risk reason. */
export function describeRemovedInUse(at: string, entries: readonly string[]): string {
  const named = entries.slice(0, REMOVAL_SCAN_NAMED).join(', ');
  const more =
    entries.length > REMOVAL_SCAN_NAMED ? ` and ${entries.length - REMOVAL_SCAN_NAMED} more` : '';
  return `${at} (${entries.length === 1 ? 'entry' : 'entries'} ${named}${more})`;
}

/**
 * Refuses a revision that removes a blocks variant some entry still uses, or a field some entry
 * still holds a value for (`removedContentInUse`), naming each and its entries. There is no
 * override: change or clear those values first (and republish an entry whose published snapshot
 * holds them, or purge it from the trash).
 *
 * It reads before the save rather than inside one unit with it: an entry written with the removed
 * content in the moment between would fail its next save with a message naming it, which is the
 * outcome this guard exists to make explicit, not a silent loss.
 */
async function assertNoRemovedContentInUse(
  ctx: AppContext,
  scope: Scope,
  current: ContentType,
  revised: ContentType,
): Promise<void> {
  const { variantsInUse, fieldsInUse } = await removedContentInUse(ctx, scope, current, revised);
  if (variantsInUse.length === 0 && fieldsInUse.length === 0) return;
  const parts: string[] = [];
  if (variantsInUse.length) {
    const listed = variantsInUse.map((v) => describeRemovedInUse(v.variant, v.entries));
    parts.push(`Cannot remove block variants that entries still use: ${listed.join('; ')}.`);
  }
  if (fieldsInUse.length) {
    const listed = fieldsInUse.map((f) => describeRemovedInUse(f.field, f.entries));
    parts.push(`Cannot remove fields that entries still hold values for: ${listed.join('; ')}.`);
  }
  parts.push('Change or clear those values first.');
  throw new ConflictError(parts.join(' '), {
    ...(variantsInUse.length ? { variantsInUse } : {}),
    ...(fieldsInUse.length ? { fieldsInUse } : {}),
  });
}

export async function getContentType(
  ctx: AppContext,
  scope: Scope,
  apiId: string,
): Promise<ContentType> {
  const ct = await ctx.store.contentTypes.get(scope, apiId);
  if (!ct) throw new NotFoundError('ContentType', apiId);
  return ct;
}

export async function listContentTypes(ctx: AppContext, scope: Scope): Promise<ContentType[]> {
  return ctx.store.contentTypes.list(scope);
}

/** How many entries a content type holds, by status. `total` counts the live ones (not the trash). */
export interface ContentTypeEntryCounts {
  readonly contentType: string;
  readonly total: number;
  readonly draft: number;
  readonly changed: number;
  readonly published: number;
  readonly archived: number;
}

/**
 * Entry counts for every content type in the scope, from one grouped count: what the content
 * overview shows beside each type. A type with no entries reads as zeros, so every defined type is
 * listed, in the content model's order.
 */
export async function countEntriesByContentType(
  ctx: AppContext,
  scope: Scope,
): Promise<ContentTypeEntryCounts[]> {
  const [types, groups] = await Promise.all([
    ctx.store.contentTypes.list(scope),
    ctx.store.entries.countByStatus(scope),
  ]);
  const zero = (contentType: string) => ({
    contentType,
    total: 0,
    draft: 0,
    changed: 0,
    published: 0,
    archived: 0,
  });
  const byType = new Map(types.map((t) => [t.apiId, zero(t.apiId)]));
  for (const g of groups) {
    const row = byType.get(g.contentType);
    // Entries of a type that no longer exists have nowhere to be shown.
    if (!row) continue;
    row[g.status] += g.count;
    if (g.status !== 'archived') row.total += g.count;
  }
  return [...byType.values()];
}

/** Marks a content type published and emits a content_type.published event. */
export async function publishContentType(
  ctx: AppContext,
  scope: Scope,
  apiId: string,
): Promise<ContentType> {
  return ctx.store.withTransaction(async (tx) => {
    const current = await tx.contentTypes.get(scope, apiId);
    if (!current) throw new NotFoundError('ContentType', apiId);
    const published: ContentType = { ...current, status: 'published' };
    await tx.contentTypes.save(scope, published);
    await tx.outbox.append({
      id: ctx.ids.newId(),
      type: 'content_type.published',
      scope,
      occurredAt: ctx.clock.now().toISOString(),
      contentTypeApiId: apiId,
      version: published.version,
    });
    return published;
  });
}
