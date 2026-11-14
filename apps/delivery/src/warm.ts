/**
 * Cache warming: after an invalidation, the delivery Worker requests the hottest URLs of each
 * space:environment it touched again, through the cached entrypoint, so readers find them fresh
 * instead of being served the previous copy. Workers Caching is tiered, so one request from here refills the upper tier
 * that every colo's lower tier fills from.
 *
 * Which URLs: the cached entrypoint counts each read it renders (a miss or a revalidation; it
 * never runs on a hit) toward the space:environment's HotSetDO, batched per isolate. Best effort
 * throughout: a failure costs a reader one cold render, never a wrong answer.
 */
import type { DeliveryRefreshedEvent, Principal } from '@contentworker/domain';
import type { HotSetDO } from '@contentworker/platform/do/hot-set';
import type { EdgeEnv } from '@contentworker/platform/env';
import {
  type HotRead,
  hotSetName,
  type ProfilePrincipal,
  profilePrincipal,
} from '@contentworker/platform/hot-urls';
import { deliveryScopeTag, PURGE_REF_IDS, type PurgeRef } from '@contentworker/platform/messages';
import type { makeMetrics } from '@contentworker/platform/metrics';
import type { Drained } from '@contentworker/platform/purge';

type Counter = ReturnType<typeof makeMetrics>;

/** Requests in flight at once while warming. */
export const WARM_CONCURRENCY = 6;
/**
 * Wall-clock budget for one warm run. Short: the purge consumer runs one batch at a time, so a
 * revocation that arrives meanwhile waits for it.
 */
export const WARM_BUDGET_MS = 15_000;
/** URLs warmed per space:environment when CACHE_WARM_URLS is unset. */
export const DEFAULT_WARM_URLS = 200;
/** How often an isolate flushes the reads it saw to a space:environment's hot set. */
export const RECORD_FLUSH_MS = 60 * 1000;
/** Distinct URLs an isolate holds per space:environment between flushes; new ones past it wait. */
export const RECORD_BUFFER_URLS = 1_000;
/** Header on the warmer's own requests: they are not reads, so they are not recorded. */
export const WARM_HEADER = 'x-cw-warm';

/** Whether this deployment warms its cache. */
export const warmingEnabled = (env: EdgeEnv): boolean =>
  !!env.HOT_SET && env.CACHE_WARMING !== 'false';

const hotSet = (ns: DurableObjectNamespace<HotSetDO>, spaceId: string, environmentId: string) =>
  ns.get(ns.idFromName(hotSetName(spaceId, environmentId)));

interface Buffer {
  last: number;
  reads: Map<string, HotRead>;
}
const buffers = new Map<string, Buffer>();

/**
 * Counts one rendered read of a canonical URL toward its environment's hot set. Reads are held in
 * the isolate and flushed as one batch at most every {@link RECORD_FLUSH_MS} per space:environment
 * (a hot URL is re-rendered every minute in every colo, so one write per read would swamp the
 * object). Returns the flush to hand to `waitUntil`, or nothing when there is nothing to write yet.
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
  if (!recordable(new URL(url).pathname)) return undefined;
  const key = hotSetName(scope.spaceId, scope.environmentId);
  let buffer = buffers.get(key);
  if (!buffer) {
    buffer = { last: Number.NEGATIVE_INFINITY, reads: new Map() };
    buffers.set(key, buffer);
  }
  const held = buffer.reads.get(url);
  if (held) buffer.reads.set(url, { ...held, weight: held.weight + 1 });
  else if (buffer.reads.size < RECORD_BUFFER_URLS) {
    buffer.reads.set(url, { url, profile, principal: profilePrincipal(principal), weight: 1 });
  }
  if (now - buffer.last < RECORD_FLUSH_MS || buffer.reads.size === 0) return undefined;
  const reads = [...buffer.reads.values()];
  buffer.reads = new Map();
  buffer.last = now;
  return hotSet(env.HOT_SET, scope.spaceId, scope.environmentId)
    .recordMany(reads)
    .catch((err: unknown) => console.error('hot set record failed', String(err)));
}

/**
 * Whether a rendered read is worth recording. Not search: its URLs carry readers' query text (kept
 * out of storage) and are as many as the queries people type, so they are never hot.
 */
export function recordable(path: string): boolean {
  return !/\/search$/.test(path);
}

/**
 * The tags a drain settled that are worth warming: the invalidated ones. Never the purged ones:
 * those must stop being served, and a read replica that hasn't caught up could render them back.
 */
export const warmTargets = (drained: { invalidated: readonly string[] }): readonly string[] =>
  drained.invalidated;

/** Forgets what this isolate recorded (tests). */
export const resetRecorded = () => buffers.clear();

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
  const deadline = Date.now() + budgetMs;
  const tops = await Promise.all(
    [...scopes.values()].map((s) =>
      hotSet(ns, s.spaceId, s.environmentId)
        .top(limit)
        .catch((err: unknown) => {
          console.error('hot set read failed', String(err));
          return [];
        }),
    ),
  );
  const queue: { url: string; principal: ProfilePrincipal }[] = [];
  const seen = new Set<string>();
  for (const hot of tops.flat()) {
    if (seen.has(hot.url)) continue;
    seen.add(hot.url);
    queue.push(hot);
  }
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

/** What `delivery.refreshed` says for one space:environment, before it gets an id. */
export type RefreshedNotice = Omit<DeliveryRefreshedEvent, 'id' | 'occurredAt'>;

/**
 * The `delivery.refreshed` notices for a settled drain: one per space:environment it purged or
 * invalidated, merging what every settled message said changed there. A tag no message described
 * (an engine that predates refs) is announced as `everything`.
 */
export function refreshedNotices(drained: Drained): RefreshedNotice[] {
  const byTag = new Map<string, PurgeRef[]>();
  for (const r of drained.refs) {
    const tag = deliveryScopeTag(r.spaceId, r.environmentId);
    byTag.set(tag, [...(byTag.get(tag) ?? []), r]);
  }
  const purged = new Set(drained.purged);
  const out: RefreshedNotice[] = [];
  for (const tag of [...drained.purged, ...drained.invalidated]) {
    const scope = scopeOfTag(tag);
    if (!scope) continue;
    const refs = byTag.get(tag) ?? [];
    const entryIds = new Set(refs.flatMap((r) => r.entryIds));
    const types = new Set(refs.flatMap((r) => r.contentTypeApiIds));
    const big = entryIds.size > PURGE_REF_IDS || types.size > PURGE_REF_IDS;
    out.push({
      type: 'delivery.refreshed',
      scope,
      mode: purged.has(tag) ? 'purged' : 'refreshed',
      entryIds: big ? [] : [...entryIds],
      contentTypeApiIds: big ? [] : [...types],
      everything: big || refs.length === 0 || refs.some((r) => r.everything),
      sourceEventIds: [...new Set(refs.flatMap((r) => r.eventIds))].slice(0, PURGE_REF_IDS),
    });
  }
  return out;
}
