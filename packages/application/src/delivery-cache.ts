import { RateLimitedError, type Scope } from '@contentworker/domain';
import type { AppContext } from './context';
import { resolveWritableEnvironment } from './spaces';

/** Seconds between two refreshes of one environment's Delivery cache. */
export const DELIVERY_REFRESH_COOLDOWN_SECONDS = 60;

export interface DeliveryRefreshResult {
  /** Always true when accepted: the refresh runs on the queues. */
  readonly enqueued: true;
  /** The environment refreshed (an alias resolves to the one it points at). */
  readonly environmentId: string;
}

/**
 * Refreshes an environment's Delivery cache, the manual counterpart of a publish: its responses
 * are invalidated (kept, and served while they revalidate), its most-read responses are requested
 * again, and `delivery.refreshed` follows once the edge has settled. Through the outbox, so it
 * rides the same path a publish does. At most once per environment per
 * {@link DELIVERY_REFRESH_COOLDOWN_SECONDS} (RateLimitedError, 429): purge calls are rationed.
 */
export async function requestDeliveryRefresh(
  ctx: AppContext,
  scope: Scope,
): Promise<DeliveryRefreshResult> {
  const environmentId = await resolveWritableEnvironment(ctx, scope.spaceId, scope.environmentId);
  const key = `contentworker:delivery-refresh:${scope.spaceId}:${environmentId}`;
  // The time of the last refresh, checked here too: a cache's TTL is a garbage-collection bound.
  const last = await ctx.cache?.get(key);
  const now = ctx.clock.now();
  if (last && now.getTime() - Date.parse(last) < DELIVERY_REFRESH_COOLDOWN_SECONDS * 1000) {
    throw new RateLimitedError(
      'This environment’s Delivery cache was refreshed recently; retry after the cooldown.',
      DELIVERY_REFRESH_COOLDOWN_SECONDS,
    );
  }
  await ctx.cache?.set(key, now.toISOString(), {
    ttlSeconds: DELIVERY_REFRESH_COOLDOWN_SECONDS,
  });
  await ctx.store.outbox.append({
    id: ctx.ids.newId(),
    type: 'delivery.refresh_requested',
    scope: { spaceId: scope.spaceId, environmentId },
    occurredAt: ctx.clock.now().toISOString(),
  });
  return { enqueued: true, environmentId };
}
