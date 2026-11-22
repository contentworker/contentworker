import type { DeliveredEntry, DeliveryClient, EntryQuery, Fields } from '@contentworker/sdk-core';

/**
 * Key-value persistence the offline client writes through. Matches React
 * Native's `AsyncStorage` (async) and MMKV (sync) — both satisfy this, so apps
 * inject their store of choice; tests use `InMemoryStorage`.
 */
export interface Storage {
  getItem(key: string): Promise<string | null> | string | null;
  setItem(key: string, value: string): Promise<void> | void;
  removeItem(key: string): Promise<void> | void;
}

export class InMemoryStorage implements Storage {
  private readonly m = new Map<string, string>();
  getItem(key: string) {
    return this.m.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.m.set(key, value);
  }
  removeItem(key: string) {
    this.m.delete(key);
  }
}

export interface OfflineOptions {
  readonly client: DeliveryClient;
  readonly storage: Storage;
  readonly contentType: string;
  readonly locale?: string;
  /** Page size for the sync fetch loop, held to 1..100 as the server holds it. */
  readonly pageSize?: number;
  /** A stable reader/audience identifier. Required for custom clients without a feed URL. */
  readonly namespace?: string;
  /** Milliseconds between full reconciliations. Defaults to one day; zero reconciles every sync. */
  readonly reconcileIntervalMs?: number;
}

export interface SyncResult {
  readonly synced: number;
  readonly cursor: string | null;
}

interface Manifest {
  entries: [id: string, slot: number][];
  cursor: string | null;
  reconciledAt: number;
}

// Serialize operations on the same physical store and feed, including separate hook instances.
const pending = new WeakMap<Storage, Map<string, Promise<unknown>>>();

/** Persist one feed and periodically reconcile the complete set to remove withdrawn entries. */
export function createOfflineDelivery<F extends Fields = Fields>(opts: OfflineOptions) {
  const { client, storage, contentType, locale } = opts;
  if (!client.feedUrl && !opts.namespace) {
    throw new Error('Offline delivery requires a namespace for a custom client without feedUrl');
  }
  const interval = opts.reconcileIntervalMs ?? 86_400_000;
  if (!Number.isFinite(interval) || interval < 0) throw new Error('Invalid reconcileIntervalMs');
  const pageSize = Math.min(Math.max(1, Math.trunc(opts.pageSize ?? 100)), 100);
  const prefix = `contentworker:offline:v2:${JSON.stringify([client.feedUrl, opts.namespace, contentType, locale])}`;
  const indexKey = `${prefix}:index`;
  const entryKey = (id: string, slot: number) => `${prefix}:entry:${slot}:${id}`;

  function serialized<T>(work: () => Promise<T>): Promise<T> {
    const queue = pending.get(storage) ?? new Map<string, Promise<unknown>>();
    pending.set(storage, queue);
    const task = (queue.get(prefix) ?? Promise.resolve()).then(work, work);
    queue.set(prefix, task);
    return task.finally(() => {
      if (queue.get(prefix) === task) queue.delete(prefix);
    });
  }

  async function manifest(): Promise<Manifest> {
    const raw = await storage.getItem(indexKey);
    return raw ? JSON.parse(raw) : { entries: [], cursor: null, reconciledAt: 0 };
  }

  async function read(id: string, slot: number): Promise<DeliveredEntry<F> | null> {
    const raw = await storage.getItem(entryKey(id, slot));
    return raw ? JSON.parse(raw) : null;
  }

  return {
    sync(options: { reconcile?: boolean } = {}): Promise<SyncResult> {
      return serialized(async () => {
        const previous = await manifest();
        const now = Date.now();
        const full =
          options.reconcile || !previous.cursor || now - previous.reconciledAt >= interval;
        const since = full ? undefined : (previous.cursor ?? undefined);
        const old = new Map(previous.entries);
        const next = new Map(full ? [] : previous.entries);
        let cursor = since ?? null;
        let synced = 0;
        for await (const entry of entries<F>(client, {
          contentType,
          locale,
          since,
          limit: pageSize,
        })) {
          const slot = old.get(entry.id) === 0 ? 1 : 0;
          await storage.setItem(entryKey(entry.id, slot), JSON.stringify(entry));
          next.set(entry.id, slot);
          synced++;
          if (entry.publishedAt && (!cursor || cursor < entry.publishedAt))
            cursor = entry.publishedAt;
        }
        // Flip the manifest only when every new value is durable. A failed page leaves the prior
        // snapshot readable. A retry overwrites staged slots without advancing the cursor.
        await storage.setItem(
          indexKey,
          JSON.stringify({
            entries: [...next],
            cursor,
            reconciledAt: full ? now : previous.reconciledAt,
          }),
        );
        for (const [id, slot] of old) {
          if (next.get(id) !== slot) await storage.removeItem(entryKey(id, slot));
        }
        return { synced, cursor };
      });
    },

    get(id: string) {
      return serialized(async () => {
        const slot = new Map((await manifest()).entries).get(id);
        return slot === undefined ? null : read(id, slot);
      });
    },

    list(): Promise<DeliveredEntry<F>[]> {
      return serialized(async () => {
        const out: DeliveredEntry<F>[] = [];
        for (const [id, slot] of (await manifest()).entries) {
          const entry = await read(id, slot);
          if (entry) out.push(entry);
        }
        return out;
      });
    },

    reset(): Promise<void> {
      return serialized(async () => {
        const previous = await manifest();
        await storage.removeItem(indexKey);
        for (const [id, slot] of previous.entries) await storage.removeItem(entryKey(id, slot));
      });
    },
  };
}

export type OfflineDelivery<F extends Fields = Fields> = ReturnType<
  typeof createOfflineDelivery<F>
>;

/**
 * Every entry the query matches. Delivery pages by offset, a preview client by cursor, and the
 * client knows which; a client without `iterateEntries` (hand-written, or older) is paged here,
 * following `nextCursor` when it answers one and `skip` otherwise.
 */
async function* entries<F extends Fields>(
  client: DeliveryClient,
  q: EntryQuery & { limit: number },
): AsyncGenerator<DeliveredEntry<F>, void, undefined> {
  if (client.iterateEntries) {
    yield* client.iterateEntries<F>(q);
    return;
  }
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let skip = 0; ; ) {
    const page = await client.listEntries<F>(cursor ? { ...q, cursor } : { ...q, skip });
    yield* page.items;
    if (page.nextCursor) {
      if (seen.has(page.nextCursor)) throw new Error(`Cursor ${page.nextCursor} came back twice`);
      seen.add(page.nextCursor);
      cursor = page.nextCursor;
    } else if (cursor || page.items.length < q.limit) {
      return;
    } else {
      skip += q.limit;
    }
  }
}
