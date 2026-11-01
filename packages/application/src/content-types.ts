import {
  ConflictError,
  type ContentType,
  type ContentTypeDraft,
  defineContentType,
  type EntryFields,
  NotFoundError,
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
  const contentType = defineContentType(draft);
  const existing = await ctx.store.contentTypes.get(scope, contentType.apiId);
  if (existing) {
    return updateContentType(ctx, scope, contentType.apiId, draft);
  }
  await ctx.store.contentTypes.save(scope, contentType);
  return contentType;
}

/** Revises an existing content type, bumping its version. */
export async function updateContentType(
  ctx: AppContext,
  scope: Scope,
  apiId: string,
  changes: Partial<Pick<ContentTypeDraft, 'name' | 'displayField' | 'fields'>>,
): Promise<ContentType> {
  const current = await ctx.store.contentTypes.get(scope, apiId);
  if (!current) throw new NotFoundError('ContentType', apiId);
  const revised = reviseContentType(current, changes);
  await assertNoRemovedVariantInUse(ctx, scope, current, revised);
  await ctx.store.contentTypes.save(scope, revised);
  return revised;
}

/** Entries read per page while looking for blocks of a removed variant. */
const VARIANT_SCAN_PAGE = 100;
/** Entry ids named per variant in the error message; the details carry them all. */
const VARIANT_SCAN_NAMED = 10;

/**
 * Refuses a revision that removes a blocks variant some entry still uses.
 *
 * Every copy of an entry that could be served or saved again is checked: its
 * current version (drafts and live entries), the trash (restorable), and the
 * published snapshot, which can differ from the current version when an entry
 * has unpublished changes. Older history versions are not: restoring one goes
 * through `updateEntry`, which validates it against the type as it is then.
 *
 * Only runs when a variant is actually removed, so ordinary edits cost no
 * reads. Keyset pages by entry id keep each read to one bounded statement
 * (the type is a single bound parameter, whatever the entry count). It reads
 * before the save rather than inside one unit with it: an entry written with
 * the removed variant in the moment between would fail its next save with a
 * message naming the variant, which is the outcome this guard exists to make
 * explicit, not a silent loss.
 */
async function assertNoRemovedVariantInUse(
  ctx: AppContext,
  scope: Scope,
  current: ContentType,
  revised: ContentType,
): Promise<void> {
  const removed = removedVariants(current.fields, revised.fields);
  if (removed.size === 0) return;

  const usedBy = new Map<string, Set<string>>();
  const check = (entryId: string, fields: EntryFields) => {
    for (const use of removedVariantUses(current.fields, fields, removed)) {
      const ids = usedBy.get(use) ?? new Set<string>();
      ids.add(entryId);
      usedBy.set(use, ids);
    }
  };
  for (const archived of [false, true]) {
    for (let after = ''; ; ) {
      const page = await ctx.store.entries.list(scope, {
        contentTypeApiId: current.apiId,
        archived,
        limit: VARIANT_SCAN_PAGE,
        afterEntryId: after,
      });
      for (const e of page) check(e.entry.id, e.fields);
      if (page.length < VARIANT_SCAN_PAGE) break;
      after = page[page.length - 1]?.entry.id ?? after;
    }
  }
  for (let after = ''; ; ) {
    const page = await ctx.store.entries.listPublished(scope, {
      contentTypeApiId: current.apiId,
      limit: VARIANT_SCAN_PAGE,
      afterEntryId: after,
    });
    for (const p of page) check(p.entryId, p.fields);
    if (page.length < VARIANT_SCAN_PAGE) break;
    after = page[page.length - 1]?.entryId ?? after;
  }
  if (usedBy.size === 0) return;

  const inUse = [...usedBy].map(([variant, ids]) => ({ variant, entries: [...ids].sort() }));
  const listed = inUse
    .map(({ variant, entries }) => {
      const named = entries.slice(0, VARIANT_SCAN_NAMED).join(', ');
      const more =
        entries.length > VARIANT_SCAN_NAMED
          ? ` and ${entries.length - VARIANT_SCAN_NAMED} more`
          : '';
      return `${variant} (${entries.length === 1 ? 'entry' : 'entries'} ${named}${more})`;
    })
    .join('; ');
  throw new ConflictError(
    `Cannot remove block variants that entries still use: ${listed}. Change or remove those blocks first.`,
    { variantsInUse: inUse },
  );
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
