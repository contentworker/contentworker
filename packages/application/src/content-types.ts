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
