import { type EventType, NotFoundError, type Scope, type Webhook } from '@contentworker/domain';
import type { AppContext } from './context';
import { assertSafeExternalUrl } from './url-safety';

export interface CreateWebhookInput {
  readonly url: string;
  readonly topics: readonly (EventType | '*')[];
  readonly secret: string;
  readonly active?: boolean;
  readonly headers?: Record<string, string>;
  /**
   * `true`: receive the events of every environment in the space. Otherwise the hook receives
   * only the events of the environment it is created in (the scope's).
   */
  readonly allEnvironments?: boolean;
}

/**
 * Partial changes to a webhook; omitted fields are left untouched. `allEnvironments: true` makes
 * the hook space-wide, `false` scopes it to the environment the update is made in, and omitting it
 * keeps the hook's current scope.
 */
export type UpdateWebhookInput = Partial<CreateWebhookInput>;

/**
 * Registers a webhook subscription: scoped to the scope's environment, or space-wide with
 * `allEnvironments`.
 */
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
    environmentId: input.allEnvironments ? null : scope.environmentId,
  };
  await ctx.store.webhooks.create(scope, webhook);
  return webhook;
}

/** The hooks scoped to the scope's environment, and every space-wide hook. */
export async function listWebhooks(ctx: AppContext, scope: Scope): Promise<Webhook[]> {
  return ctx.store.webhooks.list(scope);
}

/**
 * Applies partial changes to a webhook (404 if it doesn't exist in this space, or is scoped to
 * another environment).
 */
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
    environmentId:
      changes.allEnvironments === undefined
        ? current.environmentId
        : changes.allEnvironments
          ? null
          : scope.environmentId,
  };
  await ctx.store.webhooks.update(scope, updated);
  return updated;
}

/**
 * Removes a webhook subscription (404 if it doesn't exist in this space, or is scoped to another
 * environment).
 */
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
