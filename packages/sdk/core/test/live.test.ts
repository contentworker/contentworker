import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDeliveryClient,
  createSseParser,
  DeliveryError,
  type LiveEvent,
  type LiveStatus,
  liveEventMatches,
} from '../src/index.js';
import { openLive } from '../src/live.js';

const scope = { spaceId: 's1', environmentId: 'main' };
const at = '2026-11-09T00:00:00.000Z';
const published = (entryId: string, contentTypeApiId = 'post'): LiveEvent => ({
  id: `ev-${entryId}`,
  type: 'entry.published',
  scope,
  occurredAt: at,
  entryId,
  contentTypeApiId,
  version: 2,
  fields: { title: { 'en-US': 'Hi' } },
});

describe('createSseParser', () => {
  const all = (chunks: string[]) => {
    const parser = createSseParser();
    return chunks.flatMap((c) => parser.push(c));
  };

  it.each([
    ['LF', ['event: a\ndata: 1\n\n'], [{ event: 'a', data: '1' }]],
    ['CRLF', ['event: a\r\ndata: 1\r\n\r\n'], [{ event: 'a', data: '1' }]],
    ['CR', ['event: a\rdata: 1\r\r'], [{ event: 'a', data: '1' }]],
    ['no event field is a message', ['data: x\n\n'], [{ event: 'message', data: 'x' }]],
    [
      'multi-line data joins with LF',
      ['data: a\ndata: b\n\n'],
      [{ event: 'message', data: 'a\nb' }],
    ],
    ['one leading space only is dropped', ['data:  two\n\n'], [{ event: 'message', data: ' two' }]],
    ['no space after the colon', ['data:x\n\n'], [{ event: 'message', data: 'x' }]],
    ['comments are skipped', [': hi\ndata: x\n\n'], [{ event: 'message', data: 'x' }]],
    ['an event without data is not dispatched', ['event: ping\n\n'], []],
    ['a BOM is dropped', ['﻿data: x\n\n'], [{ event: 'message', data: 'x' }]],
    ['unknown fields are ignored', ['foo: bar\ndata: x\n\n'], [{ event: 'message', data: 'x' }]],
    ['an unfinished event waits', ['data: x\n'], []],
    [
      'id carries over to later events',
      ['id: 7\ndata: a\n\ndata: b\n\n'],
      [
        { event: 'message', data: 'a', id: '7' },
        { event: 'message', data: 'b', id: '7' },
      ],
    ],
    ['an id with NUL is ignored', ['id: a\u0000b\ndata: x\n\n'], [{ event: 'message', data: 'x' }]],
    ['retry is read', ['retry: 3000\ndata: x\n\n'], [{ event: 'message', data: 'x', retry: 3000 }]],
  ])('%s', (_name, chunks, want) => {
    expect(all(chunks)).toEqual(want);
  });

  it('dispatches the same events however the stream is split, even inside a CRLF', () => {
    const stream = 'event: entry.published\r\nid: 1\r\ndata: {"a":1}\r\n\r\n: c\r\ndata: 2\r\n\r\n';
    const whole = all([stream]);
    expect(whole).toHaveLength(2);
    for (let i = 1; i < stream.length; i++) {
      expect(all([stream.slice(0, i), stream.slice(i)])).toEqual(whole);
    }
    expect(all([...stream])).toEqual(whole);
  });

  it('an empty chunk between a CR and its LF changes nothing', () => {
    const parser = createSseParser();
    expect(parser.push('data: x\r')).toEqual([]);
    expect(parser.push('')).toEqual([]);
    // The LF belongs to the CR before it: one line end, so the event isn't over yet.
    expect(parser.push('\n')).toEqual([]);
    expect(parser.push('\n')).toEqual([{ event: 'message', data: 'x' }]);
  });

  it('a CR at the end of a chunk ends the line without waiting for an LF', () => {
    const parser = createSseParser();
    expect(parser.push('data: x\r')).toEqual([]);
    expect(parser.push('\r')).toEqual([{ event: 'message', data: 'x' }]);
  });
});

describe('liveEventMatches', () => {
  const bulk: LiveEvent = {
    id: 'b',
    type: 'entries.published_bulk',
    scope,
    occurredAt: at,
    jobId: 'j',
    chunkId: 'c',
    action: 'publish',
    entryIds: ['e1', 'e2'],
  };
  const asset: LiveEvent = {
    id: 'a',
    type: 'asset.published',
    scope,
    occurredAt: at,
    assetId: 'x',
  };
  const alias: LiveEvent = {
    id: 'al',
    type: 'environment_alias.changed',
    scope,
    occurredAt: at,
    targetEnvironmentId: 'blue',
  };
  const ctype: LiveEvent = {
    id: 'ct',
    type: 'content_type.published',
    scope,
    occurredAt: at,
    contentTypeApiId: 'post',
    version: 3,
  };

  it.each([
    ['no filter passes anything', asset, {}, true],
    ['entry id matches', published('e1'), { entryIds: ['e1'] }, true],
    ['another entry does not', published('e9'), { entryIds: ['e1'] }, false],
    ['content type matches', published('e9', 'post'), { contentTypes: ['post'] }, true],
    [
      'either filter is enough',
      published('e9', 'post'),
      { entryIds: ['e1'], contentTypes: ['post'] },
      true,
    ],
    ['a bulk job naming the entry', bulk, { entryIds: ['e2'] }, true],
    ['a bulk job not naming it', bulk, { entryIds: ['e3'] }, false],
    ['a bulk job under a type filter (types unknown)', bulk, { contentTypes: ['page'] }, true],
    ['the type itself', ctype, { contentTypes: ['post'] }, true],
    ['a type under an entry filter', ctype, { entryIds: ['e1'] }, false],
    ['an asset under a filter', asset, { entryIds: ['e1'] }, false],
    ['an alias change always', alias, { entryIds: ['e1'] }, true],
  ])('%s', (_name, event, filter, want) => {
    expect(liveEventMatches(event as LiveEvent, filter)).toBe(want);
  });
});

/** A stream the test writes frames into, and ends. */
function sse() {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    response: () =>
      new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    send: (frame: string) => controller.enqueue(encoder.encode(frame)),
    event: (e: LiveEvent) =>
      controller.enqueue(
        encoder.encode(`event: ${e.type}\nid: ${e.id}\ndata: ${JSON.stringify(e)}\n\n`),
      ),
    end: () => controller.close(),
  };
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe('openLive', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function harness(responses: (() => Response | Promise<Response>)[]) {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      const next = responses.shift();
      if (!next) return new Promise<Response>(() => {});
      return next();
    }) as unknown as typeof fetch;
    const events: LiveEvent[] = [];
    const statuses: LiveStatus[] = [];
    const errors: Error[] = [];
    return {
      calls,
      events,
      statuses,
      errors,
      open: (extra: Partial<Parameters<typeof openLive>[1]> = {}) =>
        openLive(
          {
            url: 'https://cdn.test/delivery/s1/main/live',
            token: 'cda-tok',
            fetch: fetchImpl,
            toError: async (res, url) => new DeliveryError(res.status, `${res.status} ${url}`),
            random: () => 1,
          },
          {
            onEvent: (e) => events.push(e),
            onStatus: (s) => statuses.push(s),
            onError: (e) => errors.push(e),
            retry: { minMs: 100, maxMs: 1000 },
            ...extra,
          },
        ),
    };
  }

  it('connects with the bearer key, asks for the types, and delivers matching events but no pings', async () => {
    const stream = sse();
    const h = harness([stream.response]);
    const live = h.open({ types: ['entry.published'], entryIds: ['e1'] });
    await flush();
    expect(h.calls[0]?.url).toBe('https://cdn.test/delivery/s1/main/live?types=entry.published');
    const headers = h.calls[0]?.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer cda-tok');
    expect(headers.accept).toBe('text/event-stream');
    expect(live.status).toBe('open');
    stream.send('event: ping\ndata: \n\n');
    stream.event(published('e2'));
    stream.event(published('e1'));
    stream.send('event: entry.published\ndata: {not json\n\n');
    await flush();
    expect(h.events.map((e) => e.type === 'entry.published' && e.entryId)).toEqual(['e1']);
    live.close();
    expect(h.statuses).toEqual(['connecting', 'open', 'closed']);
  });

  it('reconnects after the stream ends, and after a 503, backing off and resetting once open', async () => {
    const first = sse();
    const third = sse();
    const h = harness([
      first.response,
      () => new Response('down', { status: 503 }),
      third.response,
    ]);
    const live = h.open();
    await flush();
    first.end();
    await flush();
    expect(live.status).toBe('reconnecting');
    // First retry: the floor (attempt 0's ceiling is minMs).
    await vi.advanceTimersByTimeAsync(99);
    expect(h.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(h.calls).toHaveLength(2);
    expect(h.errors[0]).toBeInstanceOf(DeliveryError);
    // Second: doubled (random() = 1 takes the top of the jitter range).
    await vi.advanceTimersByTimeAsync(199);
    expect(h.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(h.calls).toHaveLength(3);
    expect(live.status).toBe('open');
    third.event(published('e1'));
    await flush();
    expect(h.events).toHaveLength(1);
    live.close();
  });

  it.each([
    ['random() = 1: the ceiling doubles up to maxMs', 1, [100, 200, 300, 300]],
    ['random() = 0: always the floor', 0, [100, 100, 100, 100]],
  ])('backs off with full jitter (%s)', async (_name, r, waits) => {
    const times: number[] = [];
    const live = openLive(
      {
        url: 'https://cdn.test/live',
        token: 't',
        fetch: (async () => {
          times.push(Date.now());
          return new Response('', { status: 500 });
        }) as unknown as typeof fetch,
        toError: async (res) => new Error(String(res.status)),
        random: () => r as number,
      },
      { onEvent: () => {}, retry: { minMs: 100, maxMs: 300 } },
    );
    await flush();
    for (const wait of waits as number[]) {
      const before = times.length;
      await vi.advanceTimersByTimeAsync(wait - 1);
      expect(times).toHaveLength(before);
      await vi.advanceTimersByTimeAsync(1);
      await flush();
      expect(times).toHaveLength(before + 1);
    }
    live.close();
  });

  it('follows Retry-After on a 429', async () => {
    const stream = sse();
    const h = harness([
      () => new Response('slow down', { status: 429, headers: { 'retry-after': '5' } }),
      stream.response,
    ]);
    const live = h.open();
    await flush();
    await vi.advanceTimersByTimeAsync(4999);
    expect(h.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(h.calls).toHaveLength(2);
    live.close();
  });

  it.each([401, 403, 404])('stops for good on %i, without retrying', async (status) => {
    const h = harness([() => new Response(JSON.stringify({ error: 'no' }), { status })]);
    const live = h.open();
    await flush();
    expect(live.status).toBe('closed');
    expect(h.errors).toHaveLength(1);
    expect((h.errors[0] as DeliveryError).status).toBe(status);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.calls).toHaveLength(1);
  });

  it('an onEvent that throws is reported, and the stream reads on', async () => {
    const stream = sse();
    const h = harness([stream.response]);
    let first = true;
    const live = h.open({
      onEvent: (e) => {
        if (first) {
          first = false;
          throw new Error('render failed');
        }
        h.events.push(e);
      },
    });
    await flush();
    stream.send(
      `data: ${JSON.stringify(published('e1'))}\n\ndata: ${JSON.stringify(published('e2'))}\n\n`,
    );
    await flush();
    expect(h.errors.map((e) => e.message)).toEqual(['render failed']);
    expect(h.events.map((e) => e.type === 'entry.published' && e.entryId)).toEqual(['e2']);
    expect(live.status).toBe('open');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.calls).toHaveLength(1);
    live.close();
  });

  it('stops when the answer is not an event stream (a wrong base URL)', async () => {
    const h = harness([() => new Response('<html>', { headers: { 'content-type': 'text/html' } })]);
    const live = h.open();
    await flush();
    expect(live.status).toBe('closed');
    expect(h.errors[0]?.message).toContain('without an event stream');
  });

  it('retries a network failure', async () => {
    const stream = sse();
    const h = harness([() => Promise.reject(new TypeError('network down')), stream.response]);
    const live = h.open();
    await flush();
    expect(h.errors[0]?.message).toBe('network down');
    await vi.advanceTimersByTimeAsync(100);
    await flush();
    expect(live.status).toBe('open');
    live.close();
  });

  it('close() aborts the request in flight and cancels a pending retry', async () => {
    const h = harness([() => new Response('', { status: 502 })]);
    const live = h.open();
    await flush();
    expect(live.status).toBe('reconnecting');
    live.close();
    live.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.calls).toHaveLength(1);
    expect(h.statuses.filter((s) => s === 'closed')).toHaveLength(1);

    const pending = harness([]);
    const second = pending.open();
    await flush();
    const signal = pending.calls[0]?.init?.signal as AbortSignal;
    expect(signal.aborted).toBe(false);
    second.close();
    expect(signal.aborted).toBe(true);
  });

  it('closes when its signal aborts, and never starts on an aborted one', async () => {
    const stream = sse();
    const h = harness([stream.response]);
    const abort = new AbortController();
    const live = h.open({ signal: abort.signal });
    await flush();
    abort.abort();
    expect(live.status).toBe('closed');

    const again = harness([]);
    const dead = again.open({ signal: abort.signal });
    await flush();
    expect(dead.status).toBe('closed');
    expect(again.calls).toHaveLength(0);
  });
});

describe('client.live()', () => {
  it('reads the delivery stream on the client’s host, with its key, from a preview client too', async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      urls.push(String(input));
      return new Promise<Response>(() => {});
    }) as unknown as typeof fetch;
    const client = createDeliveryClient({
      baseUrl: 'https://api.test/',
      space: 's1',
      environment: 'main',
      token: 'cpa-tok',
      preview: true,
      fetch: fetchImpl,
    });
    const live = client.live({ onEvent: () => {} });
    await flush();
    expect(urls).toEqual(['https://api.test/delivery/s1/main/live']);
    live.close();
  });
});
