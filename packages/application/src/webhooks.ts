import {
  type EventType,
  NotFoundError,
  type Scope,
  ValidationError,
  type Webhook,
} from '@contentworker/domain';
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
   * only the events of the environment it is created in (the scope's), unless that was named
   * through an alias (see {@link WebhookRequest}).
   */
  readonly allEnvironments?: boolean;
}

/** How the caller named the environment: the route's `:env`, or MCP's `environment` argument. */
export interface WebhookRequest {
  /**
   * The name as given, before alias resolution. When it differs from `scope.environmentId` it was
   * an alias (an alias never shares an environment's name). A hook is never pinned to an alias's
   * current target: the alias may be repointed, and the hook would then go quiet, and be purged
   * with the old target. So under an alias a hook is space-wide unless the caller says otherwise,
   * and `allEnvironments: false` is refused.
   */
  readonly requestedEnvironment?: string;
}

const viaAlias = (scope: Scope, request: WebhookRequest) =>
  request.requestedEnvironment !== undefined &&
  request.requestedEnvironment !== scope.environmentId;

/** The scope a hook takes from `allEnvironments` (`undefined`: no change asked for). */
function environmentFor(
  scope: Scope,
  request: WebhookRequest,
  allEnvironments: boolean | undefined,
): string | null | undefined {
  if (allEnvironments === true) return null;
  if (!viaAlias(scope, request)) return allEnvironments === false ? scope.environmentId : undefined;
  if (allEnvironments === false) {
    throw new ValidationError([
      {
        field: 'allEnvironments',
        message:
          `"${request.requestedEnvironment}" is an alias; a webhook can't be scoped to it. ` +
          'Use a concrete environment id, or allEnvironments: true',
      },
    ]);
  }
  return undefined;
}

/**
 * Partial changes to a webhook; omitted fields are left untouched. `allEnvironments: true` makes
 * the hook space-wide, `false` scopes it to the environment the update is made in (refused under an
 * alias), and omitting it keeps the hook's current scope.
 */
export type UpdateWebhookInput = Partial<CreateWebhookInput>;

/**
 * Registers a webhook subscription: scoped to the scope's environment, or space-wide with
 * `allEnvironments` or when the environment was named through an alias.
 */
export async function createWebhook(
  ctx: AppContext,
  scope: Scope,
  input: CreateWebhookInput,
  request: WebhookRequest = {},
): Promise<Webhook> {
  assertSafeExternalUrl(input.url);
  const environmentId = environmentFor(scope, request, input.allEnvironments);
  const webhook: Webhook = {
    id: ctx.ids.newId(),
    url: input.url,
    topics: input.topics,
    secret: input.secret,
    active: input.active ?? true,
    headers: input.headers,
    environmentId:
      environmentId !== undefined
        ? environmentId
        : viaAlias(scope, request)
          ? null
          : scope.environmentId,
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
  request: WebhookRequest = {},
): Promise<Webhook> {
  const current = await ctx.store.webhooks.get(scope, id);
  if (!current) throw new NotFoundError('Webhook', id);
  if (changes.url !== undefined) assertSafeExternalUrl(changes.url);
  const environmentId = environmentFor(scope, request, changes.allEnvironments);
  const updated: Webhook = {
    ...current,
    url: changes.url ?? current.url,
    topics: changes.topics ?? current.topics,
    secret: changes.secret ?? current.secret,
    active: changes.active ?? current.active,
    headers: changes.headers ?? current.headers,
    environmentId: environmentId !== undefined ? environmentId : current.environmentId,
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
