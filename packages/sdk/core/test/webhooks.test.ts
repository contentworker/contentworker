import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  entryTag,
  environmentTag,
  handleDeliveryRefreshed,
  staleTags,
  typeTag,
  verifyWebhook,
  verifyWebhookSignature,
} from '../src/webhooks.js';

const SECRET = 'whsec_test';
const NOW = Date.parse('2026-11-02T12:00:00Z');
const sign = (timestamp: string, body: string, secret = SECRET) =>
  `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;

function delivery(
  event: object,
  {
    timestamp = new Date(NOW).toISOString(),
    secret = SECRET,
    signature,
  }: { timestamp?: string; secret?: string; signature?: string } = {},
) {
  const body = JSON.stringify(event);
  return new Request('https://site.example/hooks', {
    method: 'POST',
    body,
    headers: {
      'x-contentworker-timestamp': timestamp,
      'x-contentworker-signature': signature ?? sign(timestamp, body, secret),
    },
  });
}

const event = {
  id: 'ev1',
  type: 'entry.published',
  occurredAt: new Date(NOW).toISOString(),
  entryId: 'e1',
};

describe('@contentworker/sdk-core/webhooks', () => {
  it('returns the event for a delivery signed with the secret', async () => {
    expect(await verifyWebhook(delivery(event), SECRET, { now: NOW })).toEqual(event);
  });

  it('rejects a wrong secret, a tampered body and a malformed signature', async () => {
    expect(
      await verifyWebhook(delivery(event, { secret: 'other' }), SECRET, { now: NOW }),
    ).toBeNull();
    const ts = new Date(NOW).toISOString();
    const tampered = new Request('https://site.example/hooks', {
      method: 'POST',
      body: JSON.stringify({ ...event, entryId: 'e2' }),
      headers: {
        'x-contentworker-timestamp': ts,
        'x-contentworker-signature': sign(ts, JSON.stringify(event)),
      },
    });
    expect(await verifyWebhook(tampered, SECRET, { now: NOW })).toBeNull();
    for (const signature of ['sha256=zz', 'sha1=abcd', '', 'sha256=abc']) {
      expect(await verifyWebhook(delivery(event, { signature }), SECRET, { now: NOW })).toBeNull();
    }
  });

  it('rejects stale and future timestamps outside the window, which is configurable', async () => {
    const old = new Date(NOW - 10 * 60_000).toISOString();
    expect(
      await verifyWebhook(delivery(event, { timestamp: old }), SECRET, { now: NOW }),
    ).toBeNull();
    expect(
      await verifyWebhook(delivery(event, { timestamp: old }), SECRET, {
        now: NOW,
        toleranceMs: 15 * 60_000,
      }),
    ).toEqual(event);
    expect(
      await verifyWebhook(delivery(event, { timestamp: 'not a date' }), SECRET, { now: NOW }),
    ).toBeNull();
  });

  it('verifies a raw body and headers for frameworks that parse the request', async () => {
    const ts = new Date(NOW).toISOString();
    const body = '{"id":"x","type":"asset.published","occurredAt":"t"}';
    expect(
      await verifyWebhookSignature({
        body,
        timestamp: ts,
        signature: sign(ts, body),
        secret: SECRET,
        now: NOW,
      }),
    ).toBe(true);
    expect(
      await verifyWebhookSignature({
        body,
        timestamp: ts,
        signature: sign(ts, body),
        secret: '',
        now: NOW,
      }),
    ).toBe(false);
  });
});

describe('delivery.refreshed', () => {
  const refreshed = (over: object = {}) => ({
    id: 'ev2',
    type: 'delivery.refreshed',
    occurredAt: new Date(NOW).toISOString(),
    scope: { spaceId: 's1', environmentId: 'main' },
    mode: 'refreshed',
    entryIds: ['e1', 'e2'],
    contentTypeApiIds: ['post'],
    everything: false,
    sourceEventIds: ['ev1'],
    ...over,
  });

  it('clears the tag of each entry and type it names', async () => {
    const cleared: string[] = [];
    const res = await handleDeliveryRefreshed(delivery(refreshed()), {
      secret: SECRET,
      now: NOW,
      revalidateTag: (t) => cleared.push(t),
    });
    expect(res.status).toBe(204);
    expect(cleared).toEqual([entryTag('e1'), entryTag('e2'), typeTag('post')]);
  });

  it('clears the environment’s tag when it says everything', async () => {
    const event = refreshed({ everything: true, entryIds: [], contentTypeApiIds: [] });
    expect(staleTags(event as never)).toEqual([environmentTag('s1', 'main')]);
  });

  it('refuses a bad signature and ignores other events', async () => {
    const cleared: string[] = [];
    const revalidateTag = (t: string) => cleared.push(t);
    const forged = await handleDeliveryRefreshed(delivery(refreshed(), { secret: 'wrong' }), {
      secret: SECRET,
      now: NOW,
      revalidateTag,
    });
    expect(forged.status).toBe(401);
    const other = await handleDeliveryRefreshed(delivery(event), {
      secret: SECRET,
      now: NOW,
      revalidateTag,
    });
    expect(other.status).toBe(204);
    expect(cleared).toEqual([]);
  });
});
