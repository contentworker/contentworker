/**
 * The delivery Worker: the public, read-only Content Delivery API (REST, GraphQL, search, live).
 *
 * This default entrypoint is the gateway, with no cache in front of it. Per request it:
 * 1. rate-limits by client IP (native binding, before any work),
 * 2. authenticates the CDA/CPA key with `authenticateCached` (a KV hit in the steady state, so no
 *    database read), and reduces the principal to its visibility profile,
 * 3. forwards a canonical URL (profile + path + sorted query) and nothing else to the cached
 *    `Delivery` entrypoint, so equal readers share one Workers Caching entry.
 *
 * Authorization therefore runs on every request even when the content comes from cache. A revoked
 * key or changed role is dropped from the principal cache at once (its space's tag is
 * invalidated); KV's edge propagation and the 60s principal TTL bound how long another colo may
 * still accept it. Requests that cannot be cached (the live SSE stream,
 * GraphQL POSTs) are answered here directly. Its queue consumer drains the purge queue (purges and
 * invalidations), rationed to Cloudflare's purge limits.
 */
import { InProcessAgentRuntime, makeActivities } from '@contentworker/agent-runtime';
import { authenticateCached, createHasher } from '@contentworker/application';
import type { Principal } from '@contentworker/domain';
import type { AuthDeps } from '@contentworker/http/api/auth';
import { deliveryApp, deliveryRoutes } from '@contentworker/http/api/routes/delivery';
import { liveRoutes } from '@contentworker/http/routes/live';
import { recordDeadLetters } from '@contentworker/platform/dead-letters';
import { type EdgeEnv, queueName, withJurisdiction } from '@contentworker/platform/env';
import type { PurgeMessage } from '@contentworker/platform/messages';
import { makeMetrics } from '@contentworker/platform/metrics';
import { drain } from '@contentworker/platform/purge';
import { wireEdge } from '@contentworker/platform/wire';
import { clientCacheControl } from './client-cache';
import { type Delivery, matches, PRINCIPAL_HEADER } from './delivery';
import { canonicalUrl, visibilityProfile } from './profile';
import { type Fetcher, warm, warmingEnabled } from './warm';

export { Delivery } from './delivery';

const PUBLIC = {
  'access-control-allow-origin': '*',
  'access-control-expose-headers': 'etag, cf-cache-status, x-cw-cache',
  'timing-allow-origin': '*',
  'x-content-type-options': 'nosniff',
  'strict-transport-security': 'max-age=31536000',
};

type Exports = { Delivery: Service<Delivery> };

const json = (body: unknown, status: number, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...PUBLIC, 'content-type': 'application/json', ...extra },
  });

/** The bearer token. Never read from the query string: URLs end up in logs and caches. */
function bearer(request: Request): string | undefined {
  const auth = request.headers.get('authorization') ?? '';
  return auth.replace(/^Bearer\s+/i, '').trim() || undefined;
}

export default {
  async fetch(request, rawEnv, ctx) {
    const env = withJurisdiction(rawEnv);
    const url = new URL(request.url);
    if (url.pathname === '/health') return json({ ok: true }, 200);
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          ...PUBLIC,
          'access-control-allow-methods': 'GET, HEAD, POST',
          'access-control-allow-headers': 'authorization, content-type, if-none-match',
          'access-control-max-age': '86400',
        },
      });
    }
    const isDelivery = url.pathname.startsWith('/delivery/');
    const isGraphiql = url.pathname.startsWith('/graphiql/');
    if (!isDelivery && !isGraphiql) return json({ error: 'not found' }, 404);

    const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
    if (env.RATE_LIMIT_READ && !(await env.RATE_LIMIT_READ.limit({ key: ip })).success) {
      return json({ error: 'rate limited' }, 429, { 'retry-after': '60' });
    }

    const wired = wireEdge(env, { bookmark: 'first-unconstrained' });
    const deps = (principal?: Principal): AuthDeps => ({
      ctx: wired.ctx,
      hasher: createHasher(wired.config.tokenPepper),
      // Delivery serves API keys only: no admin token, ever (not even a configured one).
      adminToken: '',
      rag: wired.rag,
      assetSearch: wired.assetSearch,
      blob: wired.blob,
      ai: wired.ai,
      bus: wired.bus,
      agents: new InProcessAgentRuntime(makeActivities({ ctx: wired.ctx, ai: wired.ai })),
      ...(principal ? { trustedPrincipal: () => principal } : {}),
    });

    // The live stream authenticates itself (same chain as the api) and is served by LiveHub.
    if (/^\/delivery\/[^/]+\/[^/]+\/live$/.test(url.pathname) && env.LIVE_HUB) {
      return deliveryApp(liveRoutes(deps(), env.LIVE_HUB)).fetch(request, env, ctx);
    }
    if (isGraphiql) {
      return deliveryApp(deliveryRoutes(deps())).fetch(request, env, ctx);
    }

    let principal: Principal;
    try {
      principal = await authenticateCached(
        wired.ctx,
        createHasher(wired.config.tokenPepper),
        bearer(request),
      );
    } catch {
      return json({ error: 'Invalid or missing API key' }, 401);
    }

    // GraphQL over POST can't be cached by URL: answered here, uncached, same routes.
    if (request.method === 'POST') {
      const res = await deliveryApp(deliveryRoutes(deps(principal))).fetch(request, env, ctx);
      const out = new Response(res.body, res);
      for (const [k, v] of Object.entries(PUBLIC)) out.headers.set(k, v);
      out.headers.set('cache-control', 'private, no-store');
      return out;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return json({ error: 'read only' }, 405, { allow: 'GET, HEAD, POST, OPTIONS' });
    }

    const profile = await visibilityProfile(principal);
    // Only the canonical URL (and the principal, which is not part of the cache key) goes to the
    // cache; conditional headers are evaluated here, against the cached response's ETag.
    const headers = new Headers({ [PRINCIPAL_HEADER]: JSON.stringify(principal) });
    const exports = (ctx as unknown as { exports: Exports }).exports;
    const upstream = await exports.Delivery.fetch(
      new Request(canonicalUrl(profile, url), { headers }),
    );
    const etag = upstream.headers.get('etag');
    const notModified =
      upstream.status === 200 &&
      etag !== null &&
      matches(request.headers.get('if-none-match'), etag);
    if (notModified) await upstream.body?.cancel();
    const response = notModified
      ? new Response(null, { status: 304, headers: upstream.headers })
      : new Response(request.method === 'HEAD' ? null : upstream.body, upstream);
    for (const [k, v] of Object.entries(PUBLIC)) response.headers.set(k, v);
    response.headers.set(
      'cache-control',
      clientCacheControl(response.status, upstream.headers.get('cache-control')),
    );
    response.headers.set('vary', 'authorization');
    return response;
  },

  async queue(batch, env, ctx) {
    if (batch.queue === queueName(env, 'contentworker-purge-dlq')) {
      // Purges that failed every retry: their responses age out on max-age (60s) plus
      // stale-while-revalidate, so nothing is served stale forever; keep a record, then drop them.
      await recordDeadLetters(batch, env.MEDIA_BUCKET, () =>
        env.METRICS?.writeDataPoint({
          blobs: ['contentworker_purge_dead_letters_total'],
          doubles: [1],
        }),
      );
      return;
    }
    const exports = (ctx as unknown as { exports: Exports }).exports;
    const drained = await drain(batch as MessageBatch<PurgeMessage>, {
      purge: (tags) => exports.Delivery.purge(tags),
      invalidate: (tags) => exports.Delivery.invalidate(tags),
    });
    // Request the hottest URLs of what was just settled again, so readers find them fresh. After
    // the messages are acked: warming is best effort and never sends a purge round again.
    const settled = [...drained.purged, ...drained.invalidated];
    if (settled.length > 0 && warmingEnabled(env)) {
      const fetcher: Fetcher = (url, principal) =>
        exports.Delivery.fetch(
          new Request(url, { headers: { [PRINCIPAL_HEADER]: JSON.stringify(principal) } }),
        );
      const outcome = await warm(withJurisdiction(env), settled, fetcher, makeMetrics(env.METRICS));
      console.log(JSON.stringify({ msg: 'cache warmed', tags: settled.length, ...outcome }));
    }
  },
} satisfies ExportedHandler<EdgeEnv>;
