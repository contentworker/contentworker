/**
 * Cache warming: after a purge or invalidation, the delivery Worker requests the hottest URLs of
 * each space:environment it touched again, through the cached entrypoint, so readers find them
 * fresh instead of waiting on a cold render (a purged URL) or being served the previous copy (an
 * invalidated one). Workers Caching is tiered, so one request from here refills the upper tier
 * that every colo's lower tier fills from.
 *
 * Which URLs: the cached entrypoint records each read it renders (a miss or a revalidation; it
 * never runs on a hit) in the space:environment's HotSetDO, throttled per isolate. Best effort
 * throughout: a failure costs a reader one cold render, never a wrong answer.
 */
import type { Principal } from '@contentworker/domain';
import type { HotSetDO } from '@contentworker/platform/do/hot-set';
import type { EdgeEnv } from '@contentworker/platform/env';
import {
  hotSetName,
  type ProfilePrincipal,
  profilePrincipal,
} from '@contentworker/platform/hot-urls';
import type { makeMetrics } from '@contentworker/platform/metrics';

type Counter = ReturnType<typeof makeMetrics>;

/** Requests in flight at once while warming. */
export const WARM_CONCURRENCY = 6;
/** Wall-clock budget for one warm run (the purge consumer's batch runs for up to 15 minutes). */
export const WARM_BUDGET_MS = 60_000;
/** URLs warmed per space:environment when CACHE_WARM_URLS is unset. */
export const DEFAULT_WARM_URLS = 200;
/** How long an isolate waits before recording the same URL again. */
export const RECORD_THROTTLE_MS = 5 * 60 * 1000;
const RECORD_MEMORY = 5_000;

/** Whether this deployment warms its cache. */
export const warmingEnabled = (env: EdgeEnv): boolean =>
  !!env.HOT_SET && env.CACHE_WARMING !== 'false';

const hotSet = (ns: DurableObjectNamespace<HotSetDO>, spaceId: string, environmentId: string) =>
  ns.get(ns.idFromName(hotSetName(spaceId, environmentId)));

const recent = new Map<string, number>();

/**
 * Records one rendered read of a canonical URL in its environment's hot set, at most once per
 * {@link RECORD_THROTTLE_MS} per isolate (a hot URL is re-rendered every minute in every colo).
 * Returns the write to hand to `waitUntil`, or nothing when there is nothing to write.
 */
export function recordRead(
  env: EdgeEnv,
  scope: { spaceId: string; environmentId: string },
  url: string,
  profile: string,
  principal: Principal,
  now = Date.now(),
): Promise<void> | undefined {
  if (!env.HOT_SET || !warmingEnabled(env)) return undefined;
  const last = recent.get(url);
  if (last !== undefined && now - last < RECORD_THROTTLE_MS) return undefined;
  recent.delete(url);
  recent.set(url, now);
  // Oldest first in insertion order: forget the coldest memory beyond the cap.
  while (recent.size > RECORD_MEMORY) recent.delete(recent.keys().next().value as string);
  return hotSet(env.HOT_SET, scope.spaceId, scope.environmentId)
    .record(url, profile, profilePrincipal(principal))
    .catch((err: unknown) => console.error('hot set record failed', String(err)));
}

/** Forgets what this isolate recorded (tests). */
export const resetRecorded = () => recent.clear();

/** The space:environment a delivery scope tag (`cw:<space>:<environment>`) names. */
export function scopeOfTag(tag: string): { spaceId: string; environmentId: string } | null {
  const m = /^cw:([^:]+):([^:]+)$/.exec(tag);
  return m ? { spaceId: m[1] as string, environmentId: m[2] as string } : null;
}

export type Fetcher = (url: string, principal: ProfilePrincipal) => Promise<Response>;

export interface WarmOutcome {
  readonly requested: number;
  readonly failed: number;
  /** URLs left unrequested when the budget ran out. */
  readonly skipped: number;
}

/**
 * Requests the hottest URLs of every space:environment named by `tags` again, hottest first, at
 * most {@link WARM_CONCURRENCY} at once and within `budgetMs`.
 */
export async function warm(
  env: EdgeEnv,
  tags: readonly string[],
  fetcher: Fetcher,
  metrics: Counter,
  budgetMs = WARM_BUDGET_MS,
): Promise<WarmOutcome> {
  if (!env.HOT_SET || !warmingEnabled(env)) return { requested: 0, failed: 0, skipped: 0 };
  const ns = env.HOT_SET;
  const limit = Number(env.CACHE_WARM_URLS ?? DEFAULT_WARM_URLS) || DEFAULT_WARM_URLS;
  const scopes = new Map<string, { spaceId: string; environmentId: string }>();
  for (const t of tags) {
    const s = scopeOfTag(t);
    if (s) scopes.set(`${s.spaceId}:${s.environmentId}`, s);
  }
  const queue: { url: string; principal: ProfilePrincipal; space: string }[] = [];
  const seen = new Set<string>();
  for (const s of scopes.values()) {
    try {
      for (const hot of await hotSet(ns, s.spaceId, s.environmentId).top(limit)) {
        if (seen.has(hot.url)) continue;
        seen.add(hot.url);
        queue.push({ ...hot, space: s.spaceId });
      }
    } catch (err) {
      console.error('hot set read failed', String(err));
    }
  }
  const deadline = Date.now() + budgetMs;
  let requested = 0;
  let failed = 0;
  let next = 0;
  const worker = async () => {
    while (next < queue.length && Date.now() < deadline) {
      const item = queue[next++] as (typeof queue)[number];
      requested++;
      let outcome: string;
      try {
        const res = await fetcher(item.url, item.principal);
        // Read to the end: the cache stores the response as it streams through.
        await res.arrayBuffer();
        outcome = res.headers.get('cf-cache-status')?.toLowerCase() ?? String(res.status);
        if (res.status >= 500) failed++;
      } catch (err) {
        failed++;
        outcome = 'error';
        console.error('warm request failed', String(err));
      }
      metrics.count('contentworker_cache_warm_requests_total', 1, { outcome });
    }
  };
  await Promise.all(Array.from({ length: Math.min(WARM_CONCURRENCY, queue.length) }, worker));
  const skipped = queue.length - requested;
  if (skipped > 0) metrics.count('contentworker_cache_warm_skipped_total', skipped);
  return { requested, failed, skipped };
}
