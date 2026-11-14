import { NotFoundError, RateLimitedError } from '@contentworker/domain';
import {
  FixedClock,
  InMemoryCache,
  InMemoryContentStore,
  SequenceIdGenerator,
} from '@contentworker/test-kit';
import { describe, expect, it } from 'vitest';
import {
  type AppContext,
  createSpace,
  requestDeliveryRefresh,
  setEnvironmentAlias,
} from '../src/index';

/**
 * A manual Delivery cache refresh: the counterpart of a publish, through the outbox (the engine
 * invalidates the environment's tag, delivery warms it), once a minute per environment.
 */
async function setup() {
  const clock = new FixedClock();
  const store = new InMemoryContentStore();
  const ctx: AppContext = {
    store,
    clock,
    ids: new SequenceIdGenerator('r'),
    cache: new InMemoryCache(clock),
  };
  await createSpace(ctx, { spaceId: 'blog', name: 'Blog', defaultLocale: 'en-US' });
  return { ctx, store, clock };
}

describe('delivery cache refresh', () => {
  it('records the request in the outbox for the environment', async () => {
    const { ctx, store } = await setup();
    const before = store.allEvents().length;
    const out = await requestDeliveryRefresh(ctx, { spaceId: 'blog', environmentId: 'main' });
    expect(out).toEqual({ enqueued: true, environmentId: 'main' });
    expect(store.allEvents().slice(before)).toMatchObject([
      { type: 'delivery.refresh_requested', scope: { spaceId: 'blog', environmentId: 'main' } },
    ]);
  });

  it('refreshes the environment an alias points at', async () => {
    const { ctx } = await setup();
    await setEnvironmentAlias(ctx, 'blog', 'live', 'main');
    const out = await requestDeliveryRefresh(ctx, { spaceId: 'blog', environmentId: 'live' });
    expect(out.environmentId).toBe('main');
  });

  it('refuses a second refresh within the cooldown, and allows one after', async () => {
    const { ctx, clock } = await setup();
    const scope = { spaceId: 'blog', environmentId: 'main' };
    await requestDeliveryRefresh(ctx, scope);
    await expect(requestDeliveryRefresh(ctx, scope)).rejects.toBeInstanceOf(RateLimitedError);
    clock.advance(61_000);
    await expect(requestDeliveryRefresh(ctx, scope)).resolves.toMatchObject({ enqueued: true });
  });

  it('refuses an environment that does not exist', async () => {
    const { ctx } = await setup();
    await expect(
      requestDeliveryRefresh(ctx, { spaceId: 'blog', environmentId: 'nope' }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
