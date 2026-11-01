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
 * Authorization therefore runs on every request even when the content comes from cache; caching
 * never extends a revoked key's access. Requests that cannot be cached (the live SSE stream,
 * GraphQL POSTs) are answered here directly. Its queue consumer drains the purge queue, rationed
 * to Cloudflare's purge limits.
 */
import { InProcessAgentRuntime, makeActivities } from '@contentworker/agent-runtime';
import { authenticateCached, createHasher } from '@contentworker/application';
import type { Principal } from '@contentworker/domain';
import type { AuthDeps } from '@contentworker/http/api/auth';
import { deliveryRoutes } from '@contentworker/http/api/routes/delivery';
import { liveRoutes } from '@contentworker/http/routes/live';
import { type EdgeEnv, withJurisdiction } from '@contentworker/platform/env';
import type { PurgeMessage } from '@contentworker/platform/messages';
import { wireEdge } from '@contentworker/platform/wire';
import { Hono } from 'hono';
import { type Delivery, PRINCIPAL_HEADER } from './delivery.js';
import { canonicalUrl, visibilityProfile } from './profile.js';
import { drain } from './purge.js';

export { Delivery } from './delivery.js';

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
      adminToken: wired.config.adminToken,
      rag: wired.rag,
      blob: wired.blob,
      ai: wired.ai,
      bus: wired.bus,
      agents: new InProcessAgentRuntime(makeActivities({ ctx: wired.ctx, ai: wired.ai })),
      ...(principal ? { trustedPrincipal: () => principal } : {}),
    });

    // The live stream authenticates itself (same chain as the api) and is served by LiveHub.
    if (/^\/delivery\/[^/]+\/[^/]+\/live$/.test(url.pathname) && env.LIVE_HUB) {
      return new Hono().route('/', liveRoutes(deps(), env.LIVE_HUB)).fetch(request, env, ctx);
    }
    if (isGraphiql) {
      return new Hono().route('/', deliveryRoutes(deps())).fetch(request, env, ctx);
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
      const res = await new Hono()
        .route('/', deliveryRoutes(deps(principal)))
        .fetch(request, env, ctx);
      const out = new Response(res.body, res);
      for (const [k, v] of Object.entries(PUBLIC)) out.headers.set(k, v);
      out.headers.set('cache-control', 'private, no-store');
      return out;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return json({ error: 'read only' }, 405, { allow: 'GET, HEAD, POST, OPTIONS' });
    }

    const profile = await visibilityProfile(principal);
    const headers = new Headers({ [PRINCIPAL_HEADER]: JSON.stringify(principal) });
    const inm = request.headers.get('if-none-match');
    if (inm) headers.set('if-none-match', inm);
    const exports = (ctx as unknown as { exports: Exports }).exports;
    const upstream = await exports.Delivery.fetch(
      new Request(canonicalUrl(profile, url), { headers }),
    );
    const response = new Response(request.method === 'HEAD' ? null : upstream.body, upstream);
    for (const [k, v] of Object.entries(PUBLIC)) response.headers.set(k, v);
    // Shared caches downstream must not reuse an authorized response for another caller.
    response.headers.set('vary', 'authorization');
    return response;
  },

  async queue(batch, _env, ctx) {
    const exports = (ctx as unknown as { exports: Exports }).exports;
    await drain(batch as MessageBatch<PurgeMessage>, (tags) => exports.Delivery.purge(tags));
  },
} satisfies ExportedHandler<EdgeEnv>;
