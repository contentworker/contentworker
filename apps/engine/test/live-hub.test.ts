import { env } from 'cloudflare:test';
import type { DomainEvent } from '@contentworker/domain';
import { createDoEventBus } from '@contentworker/platform/do/live-hub';
import { describe, expect, it } from 'vitest';

const scope = { spaceId: 'space-1', environmentId: 'main' };

function publishedEvent(id: string): DomainEvent {
  return {
    id,
    type: 'entry.published',
    occurredAt: '2026-01-01T00:00:00.000Z',
    scope,
    entryId: `entry-${id}`,
  } as unknown as DomainEvent;
}

function unpublishedEvent(id: string): DomainEvent {
  return {
    id,
    type: 'entry.unpublished',
    occurredAt: '2026-01-01T00:00:00.000Z',
    scope,
    entryId: `entry-${id}`,
  } as unknown as DomainEvent;
}

/** Incrementally decodes an SSE byte stream into complete frames. */
function frameReader(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const pending: string[] = [];
  return {
    async next(): Promise<string> {
      for (;;) {
        const queued = pending.shift();
        if (queued !== undefined) return queued;
        const { done, value } = await reader.read();
        if (done) throw new Error('SSE stream ended unexpectedly');
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() ?? '';
        pending.push(...parts.filter((p) => p.length > 0));
      }
    },
    cancel: () => reader.cancel(),
  };
}

const hubStub = (name: string) => env.LIVE_HUB.get(env.LIVE_HUB.idFromName(name));

describe('LiveHubDO', () => {
  it('opens with a ping and fans published events out to a subscriber', async () => {
    const stub = hubStub('space-1:main');
    const res = await stub.fetch('https://hub/delivery/space-1/main/live');
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const frames = frameReader(res.body as ReadableStream<Uint8Array>);

    // Initial ping so clients observe an open stream immediately.
    expect(await frames.next()).toContain('event: ping');

    await stub.publish(publishedEvent('evt-1'));
    const frame = await frames.next();
    expect(frame).toContain('event: entry.published');
    expect(frame).toContain('id: evt-1');
    expect(frame).toContain('"entryId":"entry-evt-1"');
    await frames.cancel();
  });

  it('honors the ?types= filter', async () => {
    const stub = hubStub('space-1:filtered');
    const res = await stub.fetch('https://hub/live?types=entry.published');
    const frames = frameReader(res.body as ReadableStream<Uint8Array>);
    expect(await frames.next()).toContain('event: ping');

    // The filtered-out event must never arrive; the next frame after it is
    // the matching one.
    await stub.publish(unpublishedEvent('evt-skip'));
    await stub.publish(publishedEvent('evt-match'));
    const frame = await frames.next();
    expect(frame).toContain('event: entry.published');
    expect(frame).toContain('id: evt-match');
    await frames.cancel();
  });

  it('delivers to every connected client of the same hub', async () => {
    const stub = hubStub('space-1:multi');
    const a = frameReader(
      (await stub.fetch('https://hub/live')).body as ReadableStream<Uint8Array>,
    );
    const b = frameReader(
      (await stub.fetch('https://hub/live')).body as ReadableStream<Uint8Array>,
    );
    expect(await a.next()).toContain('event: ping');
    expect(await b.next()).toContain('event: ping');

    await stub.publish(publishedEvent('evt-both'));
    expect(await a.next()).toContain('id: evt-both');
    expect(await b.next()).toContain('id: evt-both');
    await a.cancel();
    await b.cancel();
  });
});

describe('createDoEventBus', () => {
  it('routes publish to the scope hub and rejects subscribe', async () => {
    const bus = createDoEventBus(env.LIVE_HUB);
    const stub = hubStub('space-1:main');
    const res = await stub.fetch('https://hub/live');
    const frames = frameReader(res.body as ReadableStream<Uint8Array>);
    expect(await frames.next()).toContain('event: ping');

    // The bus resolves the hub from the event's scope — same DO name the
    // live route uses (`spaceId:environmentId`).
    await bus.publish(publishedEvent('evt-bus'));
    expect(await frames.next()).toContain('id: evt-bus');
    await frames.cancel();

    expect(() => bus.subscribe('entry.*', async () => {})).toThrow(/not supported on Cloudflare/);
  });
});
