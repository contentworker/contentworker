/**
 * A purge queue's consumer body: cache-tag purges, rationed to Cloudflare's limit (5 purge calls
 * a minute, up to 100 tags each). Workers Caching is per Worker, so each Worker that caches drains
 * its own queue with this: delivery `contentworker-purge`, media `contentworker-media-purge`.
 */
import type { PurgeMessage, PurgeMode } from './messages';

/** Tags per purge call, and the pause after each call: Cloudflare allows 5 calls a minute. */
export const PURGE_TAGS = 100;
export const PURGE_PACE_MS = 12_000;
/**
 * Calls one batch makes before handing the rest back to the queue: 40 paced calls take 8 minutes,
 * well inside a consumer's 15. An urgent purge is never dropped for its age: a document stays
 * servable stale for a day (`stale-while-revalidate`), so a missed purge would mean the old
 * copy is served once more, perhaps hours later.
 */
export const PURGE_CALLS = 40;

/**
 * Seconds before a message handed back goes out again: `base`, doubling with each delivery, up to
 * `cap`. Every hand-back spends one of the queue's retries, so a backlog that keeps outrunning
 * the purge ration spreads out instead of reaching the dead-letter queue within minutes.
 */
export const backoff = (attempts: number, base: number, cap: number) =>
  Math.min(base * 2 ** Math.max(attempts - 1, 0), cap);

/**
 * `skipped`: nothing was purged (no Workers Caching here), so nothing was rationed either.
 * `purged`: an invalidation the Worker could only do as a purge (its runtime has no invalidate).
 */
type Purge = (tags: string[]) => Promise<{ success: boolean; skipped?: true; purged?: true }>;

/**
 * What a drain calls. `invalidate` marks responses stale instead of deleting them (Workers Cache
 * `invalidate()`): the next reader is served the stored copy while the Worker revalidates it in
 * the background. A Worker without it purges `invalidate` messages instead (stricter, never staler).
 */
export interface DrainOps {
  readonly purge: Purge;
  readonly invalidate?: Purge;
}

/** Tags a drain settled, by how; what the caller may now refresh. */
export interface Drained {
  readonly purged: readonly string[];
  readonly invalidated: readonly string[];
  /** Messages handed back to the queue (rate limited, or past the call budget). */
  readonly retried: number;
}

const modeOf = (m: Message<PurgeMessage>): PurgeMode =>
  m.body.mode === 'invalidate' ? 'invalidate' : 'purge';

/**
 * Settles a batch's tags, paced, oldest message first. One call carries one mode: whole messages of
 * the oldest message's mode, up to PURGE_TAGS tags. A tag already purged needs no invalidation; a
 * tag invalidated may still need its purge. A refused call retries what it didn't cover once the
 * bucket refills; after PURGE_CALLS calls the rest goes back to the queue. Both back off with the
 * message's attempts.
 */
export async function drain(
  batch: MessageBatch<PurgeMessage>,
  ops: Purge | DrainOps,
  wait: (ms: number) => Promise<void> = (ms) => scheduler.wait(ms),
): Promise<Drained> {
  const { purge, invalidate } =
    typeof ops === 'function' ? { purge: ops, invalidate: undefined } : ops;
  const queue = [...batch.messages].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  const done: Record<PurgeMode, Set<string>> = { purge: new Set(), invalidate: new Set() };
  // Settled by an earlier call of either mode, as far as `mode` is concerned.
  const settled = (mode: PurgeMode, t: string) =>
    done.purge.has(t) || (mode === 'invalidate' && done.invalidate.has(t));
  let retried = 0;
  const result = (): Drained => ({
    purged: [...done.purge],
    invalidated: [...done.invalidate].filter((t) => !done.purge.has(t)),
    retried,
  });
  let calls = 0;
  while (queue.length) {
    if (calls >= PURGE_CALLS) {
      for (const m of queue) m.retry({ delaySeconds: backoff(m.attempts, 12, 300) });
      retried += queue.length;
      return result();
    }
    // Whole messages of one mode, up to PURGE_TAGS tags (one larger than that goes alone, split
    // below). Without an invalidate op every message is a purge.
    const first = queue[0] as Message<PurgeMessage>;
    const mode: PurgeMode = invalidate ? modeOf(first) : 'purge';
    const call = mode === 'invalidate' && invalidate ? invalidate : purge;
    const take: Message<PurgeMessage>[] = [];
    const tags = new Set<string>();
    for (const m of queue) {
      if (invalidate && modeOf(m) !== mode) continue;
      const fresh = m.body.tags.filter((t) => !settled(mode, t) && !tags.has(t));
      if (take.length && tags.size + fresh.length > PURGE_TAGS) break;
      take.push(m);
      for (const t of fresh) tags.add(t);
    }
    for (const m of take) queue.splice(queue.indexOf(m), 1);
    const all = [...tags];
    for (let i = 0; i < all.length; i += PURGE_TAGS) {
      const chunk = all.slice(i, i + PURGE_TAGS);
      const r = await call(chunk);
      if (!r.success) {
        // Rate limited (or refused): try these again once the bucket refills.
        for (const m of [...take, ...queue])
          m.retry({ delaySeconds: backoff(m.attempts, 30, 900) });
        retried += take.length + queue.length;
        return result();
      }
      calls++;
      for (const t of chunk) done[r.purged ? 'purge' : mode].add(t);
      if (!r.skipped) await wait(PURGE_PACE_MS);
    }
    for (const m of take) m.ack();
  }
  return result();
}
