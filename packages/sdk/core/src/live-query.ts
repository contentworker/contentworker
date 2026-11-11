/**
 * A read that stays current: fetch once, then fetch again whenever the live stream says the
 * content changed. The framework hooks (`useLiveEntry`, `useLiveEntries`) are thin wrappers over
 * these; call them directly from any other framework.
 */
import type { DeliveredEntry, DeliveryClient, EntryPage, EntryQuery, Fields } from './index.js';
import type { LiveEvent, LiveEventType } from './live.js';

/** Where a followed read stands. */
export interface LiveState<T> {
  /** The latest value read; kept while a refetch runs, so nothing flashes empty. */
  readonly data?: T;
  /** The last read's failure, cleared by the next one that succeeds. */
  readonly error?: Error;
  /** True until the first read settles. */
  readonly loading: boolean;
  /** The live stream is open: changes arrive as they happen. */
  readonly live: boolean;
  /** The entry was unpublished (`data` is cleared); a later publish brings it back. */
  readonly removed: boolean;
}

export interface FollowOptions {
  /**
   * How long to wait after a change before reading, ms (default 1000). Delivery's cache is
   * purged a moment after a publish is announced, so an immediate read could get the old
   * version; a burst of changes (a release, a bulk publish) is read once.
   */
  readonly delayMs?: number;
}

export interface Following {
  /** Stops listening; a read in flight is dropped. */
  close(): void;
}

const DELAY_MS = 1000;
/**
 * Reads again, doubling the wait, while a change-driven read still answers what it answered
 * before: Delivery purges its cache in batches, up to some seconds after the change is announced.
 * After the first read at `delayMs`, at most this many more (with the default, until ~31 s).
 */
const STALE_RETRIES = 4;

/** Entry-level facts: what a followed entry or list listens for (filtered by the server). */
const ENTRY_TYPES: readonly LiveEventType[] = [
  'entry.published',
  'entry.unpublished',
  'entries.published_bulk',
  'release.published',
  'environment_alias.changed',
];

type Change = 'refresh' | 'removed' | undefined;

/** What a follower reads with: the client's own response cache is cleared before each change. */
type FollowClient = Pick<DeliveryClient, 'live'> & Partial<Pick<DeliveryClient, 'clearCache'>>;

function follow<T>(
  client: FollowClient,
  read: () => Promise<T>,
  /** The same version of the content, so a read that answers it is still stale. */
  same: (before: T, after: T) => boolean,
  listen: {
    types: readonly LiveEventType[];
    entryIds?: readonly string[];
    contentTypes?: readonly string[];
  },
  change: (event: LiveEvent) => Change,
  o: FollowOptions,
  onState: (state: LiveState<T>) => void,
): Following {
  let state: LiveState<T> = { loading: true, live: false, removed: false };
  let closed = false;
  let running = false;
  let again = false;
  /** Bumped by an unpublish: a read that started before it must not bring the entry back. */
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** Change-driven reads since the last change that answered the old version. */
  let stale = 0;
  /** The stream closed for good (a refused key): its error is the state's. */
  let ended = false;
  const delay = Math.max(0, o.delayMs ?? DELAY_MS);

  const set = (next: Partial<LiveState<T>>) => {
    if (closed) return;
    state = { ...state, ...next };
    onState(state);
  };

  const schedule = (wait: number) => {
    clearTimeout(timer);
    timer = setTimeout(() => void load(true), wait);
  };

  /** `changed`: read because the stream said so, so an unchanged answer is a stale one. */
  const load = async (changed: boolean): Promise<void> => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    const started = generation;
    // A response cache (`cacheTtlMs`) would answer with what the change made stale.
    if (changed) client.clearCache?.();
    try {
      const data = await read();
      if (started === generation) {
        const before = state.data;
        set({ data, error: undefined, loading: false, removed: false });
        if (changed && before !== undefined && same(before, data) && stale < STALE_RETRIES) {
          stale++;
          schedule(Math.max(delay, 1) * 2 ** stale);
        }
      }
    } catch (err) {
      if (started === generation) {
        set({ error: err instanceof Error ? err : new Error(String(err)), loading: false });
      }
    } finally {
      running = false;
      if (again && !closed) {
        again = false;
        void load(true);
      }
    }
  };

  const subscription = client.live({
    ...listen,
    onStatus: (status) => {
      if (status === 'closed') ended = true;
      set({ live: status === 'open' });
    },
    // Only the final failure: while it reconnects, the content read is still good.
    onError: (err) => {
      if (ended) set({ error: err });
    },
    onEvent: (event) => {
      const what = change(event);
      if (!what) return;
      clearTimeout(timer);
      if (what === 'removed') {
        generation++;
        again = false;
        set({ data: undefined, error: undefined, loading: false, removed: true });
        return;
      }
      stale = 0;
      schedule(delay);
    },
  });
  onState(state);
  void load(false);

  return {
    close() {
      closed = true;
      clearTimeout(timer);
      subscription.close();
    },
  };
}

/** Which way an event moves one entry: read it again, or it left Delivery. */
function entryChange(event: LiveEvent, id: string): Change {
  switch (event.type) {
    case 'entry.published':
      return event.entryId === id ? 'refresh' : undefined;
    case 'entry.unpublished':
      return event.entryId === id ? 'removed' : undefined;
    case 'entries.published_bulk':
      if (!event.entryIds.includes(id)) return undefined;
      return event.action === 'unpublish' ? 'removed' : 'refresh';
    case 'release.published':
      return event.entryIds.includes(id) ? 'refresh' : undefined;
    case 'environment_alias.changed':
      return 'refresh';
    default:
      return undefined;
  }
}

/**
 * Reads one entry (`client.getEntry`) and reads it again each time it is published, or after a
 * release or bulk job that includes it; an unpublish clears it (`removed`). From a Preview client
 * the reads are the entry as it is now, but only publishes trigger them.
 */
export function followEntry<F extends Fields = Fields>(
  client: FollowClient & Pick<DeliveryClient, 'getEntry'>,
  id: string,
  o: FollowOptions & { readonly locale?: string; readonly include?: number },
  onState: (state: LiveState<DeliveredEntry<F>>) => void,
): Following {
  return follow(
    client,
    () => client.getEntry<F>(id, { locale: o.locale, include: o.include }),
    // Each publish stamps a new publishedAt.
    (before, after) => before.publishedAt === after.publishedAt,
    { types: ENTRY_TYPES, entryIds: [id] },
    (event) => entryChange(event, id),
    o,
    onState,
  );
}

/**
 * Lists entries (`client.listEntries`) and lists them again whenever an entry of
 * `query.contentType` (any type, without one) is published or unpublished, or a release or bulk
 * job ships, or the type itself is republished.
 */
export function followEntries<F extends Fields = Fields>(
  client: FollowClient & Pick<DeliveryClient, 'listEntries'>,
  query: EntryQuery,
  o: FollowOptions,
  onState: (state: LiveState<EntryPage<F>>) => void,
): Following {
  const type = query.contentType;
  return follow(
    client,
    () => client.listEntries<F>(query),
    (before, after) => JSON.stringify(before) === JSON.stringify(after),
    type
      ? { types: [...ENTRY_TYPES, 'content_type.published'], contentTypes: [type] }
      : { types: ENTRY_TYPES },
    // The stream already filtered by type; a list never "goes away", it is read again.
    () => 'refresh',
    o,
    onState,
  );
}
