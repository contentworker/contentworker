import { NotFoundError } from '@contentworker/domain';
import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@contentworker/test-kit';
import { describe, expect, it } from 'vitest';
import {
  type AppContext,
  createWebhook,
  deleteWebhook,
  listWebhookDeliveries,
  listWebhooks,
  updateWebhook,
} from '../src/index';

const scope = { spaceId: 'shop', environmentId: 'main' };

function ctx(): AppContext {
  return {
    store: new InMemoryContentStore(),
    clock: new FixedClock(),
    ids: new SequenceIdGenerator('w'),
  };
}

describe('webhook management', () => {
  it('creates, updates (partial), toggles, and deletes a webhook', async () => {
    const c = ctx();
    const created = await createWebhook(c, scope, {
      url: 'https://hook.example/cw',
      topics: ['entry.published'],
      secret: 's3cr3t',
    });
    expect(created.active).toBe(true);

    // Partial update leaves untouched fields intact.
    const updated = await updateWebhook(c, scope, created.id, {
      topics: ['*'],
      active: false,
    });
    expect(updated.topics).toEqual(['*']);
    expect(updated.active).toBe(false);
    expect(updated.url).toBe('https://hook.example/cw');
    expect(updated.secret).toBe('s3cr3t');

    // Delete removes it from the list.
    await deleteWebhook(c, scope, created.id);
    expect(await listWebhooks(c, scope)).toHaveLength(0);
  });

  it('404s on update/delete of an unknown (or foreign-space) webhook', async () => {
    const c = ctx();
    await expect(updateWebhook(c, scope, 'nope', { active: false })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(deleteWebhook(c, scope, 'nope')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('lists recorded delivery attempts newest-first (404 if the webhook is gone)', async () => {
    const c = ctx();
    const wh = await createWebhook(c, scope, {
      url: 'https://hook.example/cw',
      topics: ['*'],
      secret: 's',
    });
    await c.store.webhooks.recordDelivery(scope, {
      webhookId: wh.id,
      eventId: 'e1',
      status: 'failed',
      statusCode: 500,
      attempts: 3,
      error: 'boom',
    });
    await c.store.webhooks.recordDelivery(scope, {
      webhookId: wh.id,
      eventId: 'e2',
      status: 'success',
      statusCode: 200,
      attempts: 1,
    });

    const deliveries = await listWebhookDeliveries(c, scope, wh.id);
    expect(deliveries.map((d) => d.eventId)).toEqual(['e2', 'e1']); // newest first
    expect(deliveries[0]?.status).toBe('success');
    expect(deliveries[1]?.error).toBe('boom');

    await expect(listWebhookDeliveries(c, scope, 'nope')).rejects.toBeInstanceOf(NotFoundError);
  });
});
