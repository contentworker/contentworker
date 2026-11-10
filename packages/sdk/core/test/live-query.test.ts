import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type DeliveryClient,
  followEntries,
  followEntry,
  type LiveEvent,
  type LiveOptions,
  type LiveState,
} from '../src/index.js';

const scope = { spaceId: 's1', environmentId: 'main' };
const base = { scope, occurredAt: '2026-11-09T00:00:00.000Z' };
const ev = {
  published: (entryId: string, contentTypeApiId = 'post'): LiveEvent => ({
    ...base,
    id: `p-${entryId}`,
    type: 'entry.published',
    entryId,
    contentTypeApiId,
    version: 2,
    fields: {},
  }),
  unpublished: (entryId: string): LiveEvent => ({
    ...base,
    id: `u-${entryId}`,
    type: 'entry.unpublished',
    entryId,
    contentTypeApiId: 'post',
  }),
  bulk: (action: 'publish' | 'unpublish', entryIds: string[]): LiveEvent => ({
    ...base,
    id: `b-${action}`,
    type: 'entries.published_bulk',
    jobId: 'j',
    chunkId: 'c',
    action,
    entryIds,
  }),
  release: (entryIds: string[]): LiveEvent => ({
    ...base,
    id: 'r',
    type: 'release.published',
    releaseId: 'r1',
    entryIds,
  }),
};

/** A client whose reads count up and whose live stream the test drives. */
function fakeClient() {
  let n = 0;
  let listener: LiveOptions | undefined;
  const reads: unknown[][] = [];
  const close = vi.fn();
  const client = {
    getEntry: vi.fn(async (id: string, o: unknown) => {
      reads.push([id, o]);
      n++;
      return { id, contentType: 'post', fields: { n }, publishedAt: `t${n}` };
    }),
    listEntries: vi.fn(async (q: unknown) => {
      reads.push([q]);
      n++;
      return { items: [], total: n };
    }),
    live: vi.fn((o: LiveOptions) => {
      listener = o;
      o.onStatus?.('connecting');
      return { close, status: 'connecting' as const };
    }),
  };
  return {
    client: client as unknown as Pick<DeliveryClient, 'live' | 'getEntry' | 'listEntries'>,
    reads,
    close,
    get options() {
      return listener;
    },
    emit: (e: LiveEvent) => listener?.onEvent(e),
    status: (s: 'open' | 'reconnecting') => listener?.onStatus?.(s),
  };
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe('followEntry', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function start(id = 'e1', delayMs = 50) {
    const f = fakeClient();
    const states: LiveState<{ fields: { n: number } }>[] = [];
    const following = followEntry(f.client, id, { locale: 'en-US', delayMs }, (s) =>
      states.push(s as never),
    );
    const last = () => states[states.length - 1];
    return { ...f, following, states, last };
  }

  it('reads once, asks the stream for this entry’s events only, and says when it is live', async () => {
    const s = start();
    await flush();
    expect(s.reads).toEqual([['e1', { locale: 'en-US', include: undefined }]]);
    expect(s.options?.entryIds).toEqual(['e1']);
    expect(s.options?.types).toContain('entry.published');
    expect(s.options?.types).not.toContain('asset.published');
    expect(s.last()).toMatchObject({ loading: false, live: false, data: { fields: { n: 1 } } });
    s.status('open');
    expect(s.last()?.live).toBe(true);
  });

  it('reads again a moment after its own publish, a release or bulk publish naming it, once per burst', async () => {
    const s = start();
    await flush();
    s.emit(ev.published('e1'));
    s.emit(ev.release(['e1', 'e2']));
    s.emit(ev.bulk('publish', ['e1']));
    await vi.advanceTimersByTimeAsync(49);
    expect(s.reads).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(s.reads).toHaveLength(2);
    expect(s.last()?.data?.fields.n).toBe(2);
  });

  it('ignores other entries', async () => {
    const s = start();
    await flush();
    s.emit(ev.published('e2'));
    s.emit(ev.release(['e2']));
    s.emit(ev.bulk('unpublish', ['e3']));
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.reads).toHaveLength(1);
    expect(s.last()?.removed).toBe(false);
  });

  it('an unpublish clears it, a read started before it can’t bring it back, and a publish does', async () => {
    const s = start();
    await flush();
    let release!: () => void;
    s.client.getEntry = vi.fn(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({ id: 'e1', contentType: 'post', fields: { n: 99 }, publishedAt: 'now' });
        }),
    ) as never;
    s.emit(ev.published('e1'));
    await vi.advanceTimersByTimeAsync(50);
    s.emit(ev.unpublished('e1'));
    expect(s.last()).toMatchObject({ removed: true, data: undefined });
    release();
    await flush();
    expect(s.last()).toMatchObject({ removed: true, data: undefined });
    s.client.getEntry = vi.fn(async () => ({ id: 'e1', fields: { n: 3 } })) as never;
    s.emit(ev.bulk('publish', ['e1']));
    await vi.advanceTimersByTimeAsync(50);
    await flush();
    expect(s.last()).toMatchObject({ removed: false, data: { fields: { n: 3 } } });
  });

  it('a bulk unpublish naming it clears it', async () => {
    const s = start();
    await flush();
    s.emit(ev.bulk('unpublish', ['e1']));
    expect(s.last()?.removed).toBe(true);
  });

  it('keeps the data it had when a refetch fails, with the error', async () => {
    const s = start();
    await flush();
    s.client.getEntry = vi.fn(async () => {
      throw new Error('boom');
    }) as never;
    s.emit(ev.published('e1'));
    await vi.advanceTimersByTimeAsync(50);
    await flush();
    expect(s.last()).toMatchObject({ error: { message: 'boom' }, data: { fields: { n: 1 } } });
  });

  it('coalesces a change that arrives while a read is in flight into one more read', async () => {
    const s = start('e1', 0);
    await flush();
    let calls = 0;
    const waits: (() => void)[] = [];
    s.client.getEntry = vi.fn(
      () =>
        new Promise((resolve) => {
          calls++;
          waits.push(() => resolve({ id: 'e1', fields: { n: calls } }));
        }),
    ) as never;
    s.emit(ev.published('e1'));
    await vi.advanceTimersByTimeAsync(0);
    s.emit(ev.published('e1'));
    await vi.advanceTimersByTimeAsync(0);
    s.emit(ev.published('e1'));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
    waits.shift()?.();
    await flush();
    expect(calls).toBe(2);
    waits.shift()?.();
    await flush();
    expect(calls).toBe(2);
  });

  it('close() stops the stream and drops what is pending', async () => {
    const s = start();
    await flush();
    const count = s.states.length;
    s.emit(ev.published('e1'));
    s.following.close();
    expect(s.close).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.reads).toHaveLength(1);
    expect(s.states).toHaveLength(count);
  });
});

describe('followEntries', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('filters the stream to the query’s type and reads the list again on a change', async () => {
    const f = fakeClient();
    const states: LiveState<unknown>[] = [];
    followEntries(f.client, { contentType: 'post', limit: 5 }, { delayMs: 10 }, (s) =>
      states.push(s),
    );
    await flush();
    expect(f.options?.contentTypes).toEqual(['post']);
    expect(f.options?.types).toContain('content_type.published');
    expect(f.reads).toEqual([[{ contentType: 'post', limit: 5 }]]);
    f.emit(ev.unpublished('e9'));
    await vi.advanceTimersByTimeAsync(10);
    await flush();
    expect(f.reads).toHaveLength(2);
    expect(states[states.length - 1]?.removed).toBe(false);
  });

  it('listens to every entry event without a type', async () => {
    const f = fakeClient();
    followEntries(f.client, {}, {}, () => {});
    expect(f.options?.contentTypes).toBeUndefined();
    expect(f.options?.entryIds).toBeUndefined();
  });
});

describe('a change-driven read', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** getEntry answers `stamps` in turn (the last one from then on), each as a publishedAt. */
  function stamped(stamps: string[]) {
    const f = fakeClient();
    const clearCache = vi.fn();
    const at: number[] = [];
    let i = 0;
    const client = Object.assign(f.client, {
      clearCache,
      getEntry: vi.fn(async (id: string) => {
        at.push(Date.now());
        const publishedAt = stamps[Math.min(i++, stamps.length - 1)];
        return { id, contentType: 'post', fields: {}, publishedAt };
      }),
    });
    const states: LiveState<{ publishedAt: string }>[] = [];
    const following = followEntry(client, 'e1', { delayMs: 100 }, (st) => states.push(st as never));
    const gaps = () => at.slice(1).map((t, k) => t - (at[k] ?? 0));
    return { ...f, client, clearCache, at, gaps, states, following };
  }

  it('reads again, doubling the wait, while Delivery still answers the old version', async () => {
    const s = stamped(['v1', 'v1', 'v1', 'v2']);
    await flush();
    s.emit(ev.published('e1'));
    await vi.advanceTimersByTimeAsync(10_000);
    // The change's read at +100 (stale), then +200 (stale), then +400: the new version, so it stops.
    expect(s.at).toHaveLength(4);
    expect(s.gaps().slice(1)).toEqual([200, 400]);
    expect(s.states[s.states.length - 1]?.data?.publishedAt).toBe('v2');
  });

  it('gives up after its budget when the version never changes, and a new change starts over', async () => {
    const s = stamped(['v1']);
    await flush();
    s.emit(ev.published('e1'));
    await vi.advanceTimersByTimeAsync(60_000);
    // The first read, the change's, then four more: 200, 400, 800 and 1600 apart.
    expect(s.at).toHaveLength(6);
    expect(s.gaps().slice(1)).toEqual([200, 400, 800, 1600]);
    s.emit(ev.published('e1'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.at).toHaveLength(11);
  });

  it('clears the client’s response cache before each change-driven read, never before the first', async () => {
    const s = stamped(['v1', 'v2']);
    await flush();
    expect(s.clearCache).not.toHaveBeenCalled();
    s.emit(ev.published('e1'));
    await vi.advanceTimersByTimeAsync(100);
    await flush();
    expect(s.clearCache).toHaveBeenCalledOnce();
    expect(s.at).toHaveLength(2);
  });

  it('puts the stream’s final error in the state, but not one it is reconnecting after', async () => {
    const s = stamped(['v1']);
    await flush();
    s.options?.onStatus?.('reconnecting');
    s.options?.onError?.(new Error('blip'));
    expect(s.states[s.states.length - 1]?.error).toBeUndefined();
    s.options?.onStatus?.('closed');
    s.options?.onError?.(new Error('Delivery request failed: 401'));
    expect(s.states[s.states.length - 1]).toMatchObject({
      live: false,
      error: { message: 'Delivery request failed: 401' },
    });
  });
});
