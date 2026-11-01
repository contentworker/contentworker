import {
  FixedClock,
  InMemoryContentStore,
  InMemoryQueue,
  SequenceIdGenerator,
} from '@contentworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  createContentType,
  createEntry,
  createSpace,
  drainOutbox,
  pruneEventHistory,
  publishEntry,
  relayOutbox,
} from '../src/index';

const scope = { spaceId: 'shop', environmentId: 'main' };

function setup() {
  const store = new InMemoryContentStore();
  const clock = new FixedClock();
  // Retention compares the use-case clock against adapter-stamped relay
  // instants; point the fake's time source at the same clock so both advance
  // together (as database time and worker time do in production).
  store.nowMs = () => clock.now().getTime();
  const queue = new InMemoryQueue();
  const ctx: AppContext = { store, clock, ids: new SequenceIdGenerator('e') };
  return { ctx, store, clock, queue };
}

async function seedAndPublish(ctx: AppContext, n: number) {
  await createSpace(ctx, { spaceId: 'shop', name: 'Shop', defaultLocale: 'en-US' });
  await createContentType(ctx, scope, {
    apiId: 'article',
    name: 'Article',
    displayField: 'title',
    fields: [
      {
        apiId: 'title',
        name: 'Title',
        type: 'Symbol',
        localized: false,
        required: true,
        position: 0,
      },
    ],
  });
  for (let i = 0; i < n; i++) {
    const entry = await createEntry(ctx, scope, {
      contentTypeApiId: 'article',
      fields: { title: { 'en-US': `V${i}` } },
    });
    await publishEntry(ctx, scope, entry.entry.id);
  }
}

describe('event history retention', () => {
  let h: ReturnType<typeof setup>;
  beforeEach(() => {
    h = setup();
  });

  it('drainOutbox loops until the backlog is empty', async () => {
    await seedAndPublish(h.ctx, 5);
    // Force multiple iterations with a tiny batch size.
    const relayed = await drainOutbox(h.ctx, h.queue, { batchSize: 2 });
    expect(relayed).toBeGreaterThanOrEqual(5);
    expect(await relayOutbox(h.ctx, h.queue)).toBe(0); // nothing left
  });

  it('prunes relayed outbox rows past retention but keeps recent and pending ones', async () => {
    await seedAndPublish(h.ctx, 2);
    await drainOutbox(h.ctx, h.queue);

    // Nothing is old enough yet.
    const early = await pruneEventHistory(h.ctx, { retentionHours: 1 });
    expect(early.outboxDeleted).toBe(0);

    // A week later, one more publish leaves a fresh un-relayed row behind.
    h.clock.advance(7 * 24 * 3_600_000);
    const entry = await createEntry(h.ctx, scope, {
      contentTypeApiId: 'article',
      fields: { title: { 'en-US': 'fresh' } },
    });
    await publishEntry(h.ctx, scope, entry.entry.id);

    const pruned = await pruneEventHistory(h.ctx, { retentionHours: 1 });
    expect(pruned.outboxDeleted).toBeGreaterThan(0);
    // The pending (never relayed) event survived the sweep and still relays.
    expect(await relayOutbox(h.ctx, h.queue)).toBeGreaterThan(0);
  });

  it('prunes old webhook delivery records but keeps recent ones', async () => {
    await h.ctx.store.webhooks.recordDelivery(scope, {
      webhookId: 'wh-1',
      eventId: 'evt-old',
      status: 'success',
      attempts: 1,
    });
    h.clock.advance(7 * 24 * 3_600_000);
    await h.ctx.store.webhooks.recordDelivery(scope, {
      webhookId: 'wh-1',
      eventId: 'evt-new',
      status: 'success',
      attempts: 1,
    });

    const pruned = await pruneEventHistory(h.ctx, { retentionHours: 1 });
    expect(pruned.webhookDeliveriesDeleted).toBe(1);
    const remaining = await h.ctx.store.webhooks.listDeliveries(scope, 'wh-1');
    expect(remaining.map((d) => d.eventId)).toEqual(['evt-new']);
  });
});
