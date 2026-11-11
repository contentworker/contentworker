import {
  createDeliveryClient,
  type DeliveredEntry,
  type DeliveryClient,
} from '@contentworker/sdk-core';
import { describe, expect, it } from 'vitest';
import { createOfflineDelivery, InMemoryStorage } from '../src/index.js';

const entry = (id: string, publishedAt: string): DeliveredEntry => ({
  id,
  contentType: 'article',
  fields: { title: id },
  publishedAt,
});

/**
 * A client over a fake API holding a mutable dataset, holding `limit` to 100 as the server does.
 * Delivery honors `since` and pages by `skip`. Preview behaves as the real list: it pages by
 * `cursor`, refuses `skip`, ignores `since` and serves no `publishedAt`.
 */
function fakeClient(data: DeliveredEntry[], o: { preview?: boolean; urls?: string[] } = {}) {
  return createDeliveryClient({
    baseUrl: 'https://cms.test',
    space: 's1',
    environment: 'main',
    token: 't',
    preview: o.preview ?? false,
    fetch: (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      o.urls?.push(url.pathname + url.search);
      const q = url.searchParams;
      if (o.preview && q.has('skip')) return Response.json({}, { status: 422 });
      const since = o.preview ? null : q.get('since');
      const type = q.get('content_type');
      const all = data
        .filter((e) => (!type || e.contentType === type) && (!since || e.publishedAt > since))
        .sort((a, b) => (a.publishedAt < b.publishedAt ? -1 : 1));
      const from = Number((o.preview ? q.get('cursor') : q.get('skip')) ?? 0);
      const limit = Math.min(Number(q.get('limit') ?? 100), 100);
      const items = all
        .slice(from, from + limit)
        .map((e) => (o.preview ? { ...e, publishedAt: undefined } : e));
      const more = o.preview && from + limit < all.length;
      return Response.json({
        items,
        total: items.length,
        ...(more ? { nextCursor: String(from + limit) } : {}),
      });
    }) as typeof fetch,
  });
}

describe('@contentworker/sdk-react-native offline delivery', () => {
  it('initial sync persists entries and sets the cursor; reads work offline', async () => {
    const data = [entry('a', '2026-01-01T00:00:00Z'), entry('b', '2026-01-02T00:00:00Z')];
    const storage = new InMemoryStorage();
    const store = createOfflineDelivery({
      client: fakeClient(data),
      storage,
      contentType: 'article',
    });

    const r = await store.sync();
    expect(r.synced).toBe(2);
    expect(r.cursor).toBe('2026-01-02T00:00:00Z');

    // Reads come from storage (the fake client is not consulted here).
    expect((await store.get('a'))?.fields.title).toBe('a');
    expect(await store.list()).toHaveLength(2);
  });

  it('delta-syncs only entries published after the cursor', async () => {
    const data = [entry('a', '2026-01-01T00:00:00Z'), entry('b', '2026-01-02T00:00:00Z')];
    const client = fakeClient(data);
    const storage = new InMemoryStorage();
    const store = createOfflineDelivery({ client, storage, contentType: 'article' });
    await store.sync(); // cursor → b's time

    // A new entry published later.
    data.push(entry('c', '2026-01-03T00:00:00Z'));
    const r2 = await store.sync();
    expect(r2.synced).toBe(1); // only 'c' came back (delta)
    expect(r2.cursor).toBe('2026-01-03T00:00:00Z');
    expect(await store.list()).toHaveLength(3);
  });

  it('paginates the sync fetch loop', async () => {
    const data = Array.from({ length: 25 }, (_, i) =>
      entry(`e${i}`, `2026-02-${String(i + 1).padStart(2, '0')}T00:00:00Z`),
    );
    const storage = new InMemoryStorage();
    const store = createOfflineDelivery({
      client: fakeClient(data),
      storage,
      contentType: 'article',
      pageSize: 10,
    });
    const r = await store.sync();
    expect(r.synced).toBe(25);
    expect(await store.list()).toHaveLength(25);
  });

  it('pages a preview client by cursor, never by skip', async () => {
    const data = Array.from({ length: 15 }, (_, i) =>
      entry(`e${i}`, `2026-02-${String(i + 1).padStart(2, '0')}T00:00:00Z`),
    );
    const urls: string[] = [];
    const store = createOfflineDelivery({
      client: fakeClient(data, { preview: true, urls }),
      storage: new InMemoryStorage(),
      contentType: 'article',
      pageSize: 10,
    });
    const r = await store.sync();
    expect(r.synced).toBe(15);
    expect(urls).toEqual([
      '/preview/s1/main/entries?content_type=article&limit=10',
      '/preview/s1/main/entries?content_type=article&limit=10&cursor=10',
    ]);
    // Preview has no `since` and no `publishedAt`: the next sync reads the whole type again.
    expect(r.cursor).toBeNull();
    expect((await store.sync()).synced).toBe(15);
    expect(await store.list()).toHaveLength(15);
  });

  it('holds pageSize to what the server serves, so no page reads as the last too early', async () => {
    const data = Array.from({ length: 230 }, (_, i) =>
      entry(`e${i}`, `2026-03-01T00:00:${String(i).padStart(3, '0')}Z`),
    );
    const store = createOfflineDelivery({
      client: fakeClient(data),
      storage: new InMemoryStorage(),
      contentType: 'article',
      pageSize: 150,
    });
    expect((await store.sync()).synced).toBe(230);
    // A size below one is one, not a loop that never ends.
    const one = createOfflineDelivery({
      client: fakeClient(data.slice(0, 3)),
      storage: new InMemoryStorage(),
      contentType: 'article',
      pageSize: 0,
    });
    expect((await one.sync()).synced).toBe(3);
  });

  it('pages a client without iterateEntries itself, by skip or by nextCursor', async () => {
    const data = Array.from({ length: 5 }, (_, i) => entry(`e${i}`, `2026-04-0${i + 1}T00:00:00Z`));
    for (const preview of [false, true]) {
      const { listEntries } = fakeClient(data, { preview });
      const store = createOfflineDelivery({
        client: { listEntries } as unknown as DeliveryClient,
        storage: new InMemoryStorage(),
        contentType: 'article',
        pageSize: 2,
      });
      expect((await store.sync()).synced).toBe(5);
    }
  });

  it('reset clears the local cache and cursor', async () => {
    const data = [entry('a', '2026-01-01T00:00:00Z')];
    const storage = new InMemoryStorage();
    const store = createOfflineDelivery({
      client: fakeClient(data),
      storage,
      contentType: 'article',
    });
    await store.sync();
    await store.reset();
    expect(await store.list()).toHaveLength(0);
    // After reset the cursor is gone → a re-sync pulls everything again.
    expect((await store.sync()).synced).toBe(1);
  });
});
