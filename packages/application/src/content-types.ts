import {
  type ContentType,
  type ContentTypeDraft,
  defineContentType,
  NotFoundError,
  reviseContentType,
  type Scope,
} from '@contentworker/domain';
import type { AppContext } from './context.js';

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
  await ctx.store.contentTypes.save(scope, revised);
  return revised;
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
