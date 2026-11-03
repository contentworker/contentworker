import {
  ConflictError,
  type DomainEvent,
  NotFoundError,
  ValidationError,
  type WebhookResendRequestedEvent,
} from '@contentworker/domain';
import {
  FixedClock,
  InMemoryContentStore,
  RecordingWebhookSender,
  SequenceIdGenerator,
} from '@contentworker/test-kit';
import { describe, expect, it } from 'vitest';
import {
  type AppContext,
  consumeEvent,
  createWebhook,
  listWebhookDeliveries,
  resendWebhookDelivery,
  sendWebhookTest,
  updateWebhook,
  WEBHOOK_TEST_MESSAGE,
  type WebhookRetry,
} from '../src/index';

const scope = { spaceId: 'shop', environmentId: 'main' };
const staging = { spaceId: 'shop', environmentId: 'staging' };
const otherSpace = { spaceId: 'other', environmentId: 'main' };
const hook = {
  url: 'https://hook.example/cw',
  topics: ['entry.unpublished' as const],
  secret: 's',
};

function harness() {
  const store = new InMemoryContentStore();
  const clock = new FixedClock();
  const c: AppContext = { store, clock, ids: new SequenceIdGenerator('w') };
  const retries: WebhookRetry[] = [];
  const consume = (sender: RecordingWebhookSender, event: DomainEvent) =>
    consumeEvent(c, { sender, scheduleWebhookRetry: async (r) => void retries.push(r) }, event);
  /** The engine's relay: every outbox event not yet consumed, in order. */
  let relayed = 0;
  const relay = async (sender: RecordingWebhookSender) => {
    const events = store.allEvents().slice(relayed);
    relayed += events.length;
    for (const e of events) await consume(sender, e);
    return events;
  };
  return { store, clock, c, retries, consume, relay };
}

const unpublished = (id: string, s = scope): DomainEvent => ({
  id,
  type: 'entry.unpublished',
  scope: s,
  occurredAt: '2026-01-01T00:00:00.000Z',
  entryId: 'e1',
  contentTypeApiId: 'article',
});

describe('webhook test deliveries', () => {
  it('queues a webhook.test event that only that webhook receives, and logs it', async () => {
    const h = harness();
    const target = await createWebhook(h.c, scope, hook);
    const bystander = await createWebhook(h.c, scope, { ...hook, topics: ['*'] });

    const queued = await sendWebhookTest(h.c, scope, target.id);
    expect(queued).toMatchObject({ webhookId: target.id, eventType: 'webhook.test' });
    // Nothing is sent from the request: it waits in the outbox for the engine.
    const [event] = h.store.allEvents();
    expect(event).toMatchObject({
      id: queued.eventId,
      type: 'webhook.test',
      scope,
      webhookId: target.id,
      message: WEBHOOK_TEST_MESSAGE,
    });

    const sender = new RecordingWebhookSender();
    await h.relay(sender);
    // The target is not subscribed to webhook.test; a "*" hook is, and still hears nothing.
    expect(sender.sent.map((s) => s.webhook.id)).toEqual([target.id]);
    expect(await listWebhookDeliveries(h.c, scope, target.id)).toMatchObject([
      { eventId: queued.eventId, eventType: 'webhook.test', status: 'success', attempts: 1 },
    ]);
    expect(await listWebhookDeliveries(h.c, scope, bystander.id)).toEqual([]);
  });

  it('tests a paused webhook too (try it before turning it on)', async () => {
    const h = harness();
    const paused = await createWebhook(h.c, scope, { ...hook, active: false });
    await sendWebhookTest(h.c, scope, paused.id);
    const sender = new RecordingWebhookSender();
    await h.relay(sender);
    expect(sender.sent).toHaveLength(1);
  });

  it('records a failed test once and never retries it', async () => {
    const h = harness();
    const target = await createWebhook(h.c, scope, hook);
    await sendWebhookTest(h.c, scope, target.id);
    await h.relay(new RecordingWebhookSender({ delivered: false, statusCode: 503 }));
    expect(await listWebhookDeliveries(h.c, scope, target.id)).toMatchObject([
      { status: 'failed', statusCode: 503, attempts: 1 },
    ]);
    expect(h.retries).toEqual([]);
  });

  it("404s for a webhook that doesn't exist here: another environment's, another space's", async () => {
    const h = harness();
    const stagingOnly = await createWebhook(h.c, staging, hook);
    await expect(sendWebhookTest(h.c, scope, stagingOnly.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(sendWebhookTest(h.c, otherSpace, stagingOnly.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(sendWebhookTest(h.c, scope, 'nope')).rejects.toBeInstanceOf(NotFoundError);
    expect(h.store.allEvents()).toEqual([]);
  });

  it('screens the URL again, as at create, and queues nothing for an unsafe one', async () => {
    const h = harness();
    // Stored before the screen applied (or written around it): a private address.
    await h.store.webhooks.create(scope, {
      id: 'legacy',
      url: 'http://10.0.0.1/hook',
      topics: ['*'],
      secret: 's',
      active: true,
      environmentId: 'main',
    });
    await expect(sendWebhookTest(h.c, scope, 'legacy')).rejects.toBeInstanceOf(ValidationError);
    expect(h.store.allEvents()).toEqual([]);
  });

  it('sends nothing when the webhook is deleted before the engine gets to it', async () => {
    const h = harness();
    const target = await createWebhook(h.c, scope, hook);
    await sendWebhookTest(h.c, scope, target.id);
    await h.store.webhooks.delete(scope, target.id);
    const sender = new RecordingWebhookSender();
    await h.relay(sender);
    expect(sender.sent).toEqual([]);
  });
});

describe('webhook resends', () => {
  /** A real delivery: the event committed to the outbox, then dispatched by the engine. */
  async function delivered(h: ReturnType<typeof harness>, sender: RecordingWebhookSender) {
    const target = await createWebhook(h.c, scope, hook);
    await h.store.outbox.append(unpublished('evt-1'));
    await h.relay(sender);
    const [original] = await listWebhookDeliveries(h.c, scope, target.id);
    if (!original) throw new Error('no delivery');
    return { target, original };
  }

  it('re-queues the stored event through the outbox, signed afresh, linked to the original', async () => {
    const h = harness();
    const { target, original } = await delivered(
      h,
      new RecordingWebhookSender({ delivered: false, statusCode: 500 }),
    );
    expect(original).toMatchObject({ eventId: 'evt-1', eventType: 'entry.unpublished' });

    h.clock.advance(3_600_000);
    const queued = await resendWebhookDelivery(h.c, scope, target.id, original.id);
    expect(queued).toEqual({
      webhookId: target.id,
      eventId: 'evt-1',
      eventType: 'entry.unpublished',
      resendOf: original.id,
    });
    const request = h.store.allEvents().at(-1) as WebhookResendRequestedEvent;
    expect(request).toMatchObject({
      type: 'webhook.resend_requested',
      webhookId: target.id,
      deliveryId: original.id,
      event: { id: 'evt-1' },
    });

    // The engine sends it later still: the signature covers the time it is sent.
    h.clock.advance(60_000);
    const sender = new RecordingWebhookSender();
    await h.relay(sender);
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]?.event).toEqual(unpublished('evt-1'));
    expect(sender.sent[0]?.timestamp).toBe(h.clock.now().toISOString());
    const [resent] = await listWebhookDeliveries(h.c, scope, target.id);
    expect(resent).toMatchObject({
      eventId: 'evt-1',
      status: 'success',
      attempts: 1,
      resendOf: original.id,
    });
  });

  it('resends a resend: the event is still the original', async () => {
    const h = harness();
    const { target, original } = await delivered(h, new RecordingWebhookSender());
    await resendWebhookDelivery(h.c, scope, target.id, original.id);
    await h.relay(new RecordingWebhookSender());
    const [first] = await listWebhookDeliveries(h.c, scope, target.id);
    if (!first) throw new Error('no resend');
    await resendWebhookDelivery(h.c, scope, target.id, first.id);
    const sender = new RecordingWebhookSender();
    await h.relay(sender);
    expect(sender.sent.map((s) => s.event.id)).toEqual(['evt-1']);
    expect((await listWebhookDeliveries(h.c, scope, target.id))[0]?.resendOf).toBe(first.id);
  });

  it('resends a test delivery', async () => {
    const h = harness();
    const target = await createWebhook(h.c, scope, hook);
    const test = await sendWebhookTest(h.c, scope, target.id);
    await h.relay(new RecordingWebhookSender());
    const [logged] = await listWebhookDeliveries(h.c, scope, target.id);
    if (!logged) throw new Error('no delivery');
    await resendWebhookDelivery(h.c, scope, target.id, logged.id);
    const sender = new RecordingWebhookSender();
    await h.relay(sender);
    expect(sender.sent.map((s) => [s.event.id, s.event.type])).toEqual([
      [test.eventId, 'webhook.test'],
    ]);
  });

  it('never retries a failed resend (the administrator asks again)', async () => {
    const h = harness();
    const { target, original } = await delivered(h, new RecordingWebhookSender());
    await resendWebhookDelivery(h.c, scope, target.id, original.id);
    await h.relay(new RecordingWebhookSender({ delivered: false, error: 'timeout' }));
    expect(h.retries).toEqual([]);
    expect((await listWebhookDeliveries(h.c, scope, target.id))[0]).toMatchObject({
      status: 'failed',
      error: 'timeout',
      resendOf: original.id,
    });
  });

  it('sends again when the queue redelivers the request, with the same event id', async () => {
    const h = harness();
    const { target, original } = await delivered(h, new RecordingWebhookSender());
    await resendWebhookDelivery(h.c, scope, target.id, original.id);
    const request = h.store.allEvents().at(-1) as DomainEvent;
    const sender = new RecordingWebhookSender();
    await h.consume(sender, request);
    await h.consume(sender, request);
    expect(sender.sent.map((s) => s.event.id)).toEqual(['evt-1', 'evt-1']);
  });

  it("404s for another webhook's delivery, another space's, or an unknown one", async () => {
    const h = harness();
    const { target, original } = await delivered(h, new RecordingWebhookSender());
    const other = await createWebhook(h.c, scope, hook);
    await expect(resendWebhookDelivery(h.c, scope, other.id, original.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(
      resendWebhookDelivery(h.c, otherSpace, target.id, original.id),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(resendWebhookDelivery(h.c, scope, target.id, 999)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('refuses (409) once retention has swept the event', async () => {
    const h = harness();
    h.store.nowMs = () => h.clock.now().getTime();
    const { target, original } = await delivered(h, new RecordingWebhookSender());
    await h.store.outbox.markRelayed(['evt-1']);
    h.clock.advance(8 * 24 * 3_600_000);
    // The sweep takes the outbox row before it reaches the delivery record (it runs in slices).
    await h.store.outbox.deleteRelayedBefore(new Date(h.clock.now().getTime() - 1000), 10);
    await expect(resendWebhookDelivery(h.c, scope, target.id, original.id)).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect(h.store.allEvents()).toEqual([]);
  });

  it("resends a space-wide hook's delivery from another environment, in the event's own scope", async () => {
    const h = harness();
    const everywhere = await createWebhook(h.c, scope, { ...hook, allEnvironments: true });
    await h.store.outbox.append(unpublished('evt-staging', staging));
    await h.relay(new RecordingWebhookSender());
    const [original] = await listWebhookDeliveries(h.c, scope, everywhere.id);
    if (!original) throw new Error('no delivery');
    await resendWebhookDelivery(h.c, scope, everywhere.id, original.id);
    const sender = new RecordingWebhookSender();
    await h.relay(sender);
    expect(sender.sent[0]?.event.scope).toEqual(staging);
  });

  it('sends nothing when the hook is scoped away before the engine gets to it', async () => {
    const h = harness();
    const { target, original } = await delivered(h, new RecordingWebhookSender());
    await resendWebhookDelivery(h.c, scope, target.id, original.id);
    await updateWebhook(h.c, scope, target.id, { allEnvironments: true });
    await updateWebhook(h.c, staging, target.id, { allEnvironments: false });
    const sender = new RecordingWebhookSender();
    await h.relay(sender);
    expect(sender.sent).toEqual([]);
  });

  it('resends a bulk chunk to a per-entry subscriber entry by entry, as dispatch sent it', async () => {
    const h = harness();
    const target = await createWebhook(h.c, scope, hook);
    const bulk: DomainEvent = {
      id: 'bulk-1',
      type: 'entries.published_bulk',
      scope,
      occurredAt: '2026-01-01T00:00:00.000Z',
      jobId: 'job-1',
      chunkId: 'chunk-1',
      action: 'unpublish',
      entryIds: ['a', 'b'],
    };
    await h.store.outbox.append(bulk);
    await h.relay(new RecordingWebhookSender());
    const [original] = await listWebhookDeliveries(h.c, scope, target.id);
    if (!original) throw new Error('no delivery');
    expect(original.eventType).toBe('entries.published_bulk');
    await resendWebhookDelivery(h.c, scope, target.id, original.id);
    const sender = new RecordingWebhookSender();
    await h.relay(sender);
    expect(sender.sent.map((s) => [s.event.type, s.event.id])).toEqual([
      ['entry.unpublished', 'job-1:chunk-1:a'],
      ['entry.unpublished', 'job-1:chunk-1:b'],
    ]);
    expect((await listWebhookDeliveries(h.c, scope, target.id))[0]?.resendOf).toBe(original.id);
  });
});
