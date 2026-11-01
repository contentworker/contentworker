import { type EventType, NotFoundError, type Scope, type Webhook } from '@contentworker/domain';
import type { AppContext } from './context';
import { assertSafeExternalUrl } from './url-safety';

export interface CreateWebhookInput {
  readonly url: string;
  readonly topics: readonly (EventType | '*')[];
  readonly secret: string;
  readonly active?: boolean;
  readonly headers?: Record<string, string>;
}

/** Partial changes to a webhook; omitted fields are left untouched. */
export type UpdateWebhookInput = Partial<CreateWebhookInput>;

/** Registers a webhook subscription for a space. */
export async function createWebhook(
  ctx: AppContext,
  scope: Scope,
  input: CreateWebhookInput,
): Promise<Webhook> {
  assertSafeExternalUrl(input.url);
  const webhook: Webhook = {
    id: ctx.ids.newId(),
    url: input.url,
    topics: input.topics,
    secret: input.secret,
    active: input.active ?? true,
    headers: input.headers,
  };
  await ctx.store.webhooks.create(scope, webhook);
  return webhook;
}

export async function listWebhooks(ctx: AppContext, scope: Scope): Promise<Webhook[]> {
  return ctx.store.webhooks.list(scope);
}

/** Applies partial changes to a webhook (404 if it doesn't exist in this space). */
export async function updateWebhook(
  ctx: AppContext,
  scope: Scope,
  id: string,
  changes: UpdateWebhookInput,
): Promise<Webhook> {
  const current = await ctx.store.webhooks.get(scope, id);
  if (!current) throw new NotFoundError('Webhook', id);
  if (changes.url !== undefined) assertSafeExternalUrl(changes.url);
  const updated: Webhook = {
    ...current,
    url: changes.url ?? current.url,
    topics: changes.topics ?? current.topics,
    secret: changes.secret ?? current.secret,
    active: changes.active ?? current.active,
    headers: changes.headers ?? current.headers,
  };
  await ctx.store.webhooks.update(scope, updated);
  return updated;
}

/** Removes a webhook subscription (404 if it doesn't exist in this space). */
export async function deleteWebhook(ctx: AppContext, scope: Scope, id: string): Promise<void> {
  const current = await ctx.store.webhooks.get(scope, id);
  if (!current) throw new NotFoundError('Webhook', id);
  await ctx.store.webhooks.delete(scope, id);
}

/** Recent delivery attempts for a webhook (404 if it doesn't exist). */
export async function listWebhookDeliveries(
  ctx: AppContext,
  scope: Scope,
  id: string,
  opts?: { limit?: number },
) {
  const current = await ctx.store.webhooks.get(scope, id);
  if (!current) throw new NotFoundError('Webhook', id);
  return ctx.store.webhooks.listDeliveries(scope, id, opts);
}
