import type { DomainEvent } from '@contentworker/domain';
import {
  FixedClock,
  InMemoryContentStore,
  RecordingWebhookSender,
  SequenceIdGenerator,
} from '@contentworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  createSpace,
  createWebhook,
  deleteWebhook,
  dispatchEvent,
  listWebhookDeliveries,
  redeliverWebhook,
  WEBHOOK_MAX_ATTEMPTS,
  type WebhookRetry,
  webhookRetryDelay,
} from '../src/index.js';

const scope = { spaceId: 'shop', environmentId: 'main' };
const event = {
  id: 'evt-1',
  type: 'entry.unpublished',
  scope,
  occurredAt: '2026-01-01T00:00:00.000Z',
  entryId: 'e1',
  contentTypeApiId: 'article',
} as DomainEvent;

let ctx: AppContext;
let webhookId: string;

beforeEach(async () => {
  ctx = {
    store: new InMemoryContentStore(),
    clock: new FixedClock(),
    ids: new SequenceIdGenerator('w'),
  };
  await createSpace(ctx, { spaceId: 'shop', name: 'Shop', defaultLocale: 'en-US' });
  webhookId = (
    await createWebhook(ctx, scope, {
      url: 'https://hooks.example.com/cw',
      topics: ['entry.unpublished'],
      secret: 's3cret',
    })
  ).id;
});

function deps(delivered: boolean) {
  const scheduled: WebhookRetry[] = [];
  return {
    sender: new RecordingWebhookSender(
      delivered ? { delivered: true, statusCode: 200 } : { delivered: false, statusCode: 503 },
    ),
    scheduleWebhookRetry: async (r: WebhookRetry) => {
      scheduled.push(r);
    },
    scheduled,
  };
}

describe('webhook delivery retries', () => {
  it('schedules a retry of the failed webhook alone, after the backoff', async () => {
    const d = deps(false);
    await dispatchEvent(ctx, d, event);
    expect(d.scheduled).toEqual([{ webhookId, event, attempt: 2, delaySeconds: 30 }]);
    const [logged] = await listWebhookDeliveries(ctx, scope, webhookId);
    expect(logged).toMatchObject({ status: 'failed', attempts: 1 });
  });

  it('records a retry by its attempt number, and stops scheduling once it is delivered', async () => {
    const d = deps(true);
    expect(await redeliverWebhook(ctx, d, { webhookId, event, attempt: 3 })).toEqual({
      delivered: true,
    });
    expect(d.scheduled).toEqual([]);
    const [logged] = await listWebhookDeliveries(ctx, scope, webhookId);
    expect(logged).toMatchObject({ status: 'success', attempts: 3 });
  });

  it('backs off longer each time, and gives up after the last attempt', async () => {
    expect([1, 2, 3, 4].map(webhookRetryDelay)).toEqual([30, 120, 480, 1920]);
    expect(webhookRetryDelay(20)).toBe(6 * 3600);
    const d = deps(false);
    await redeliverWebhook(ctx, d, { webhookId, event, attempt: WEBHOOK_MAX_ATTEMPTS - 1 });
    expect(d.scheduled.map((r) => r.attempt)).toEqual([WEBHOOK_MAX_ATTEMPTS]);
    await redeliverWebhook(ctx, d, { webhookId, event, attempt: WEBHOOK_MAX_ATTEMPTS });
    expect(d.scheduled).toHaveLength(1);
  });

  it('sends nothing to a webhook deleted since the delivery failed', async () => {
    await deleteWebhook(ctx, scope, webhookId);
    const d = deps(true);
    expect(await redeliverWebhook(ctx, d, { webhookId, event, attempt: 2 })).toBeNull();
    expect(d.sender.sent).toEqual([]);
  });
});
