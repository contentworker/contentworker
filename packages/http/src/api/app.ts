import { createRemoteFetcher } from '@contentworker/adapters/http-effects';
import { structuredImportSources } from '@contentworker/adapters/import-structured';
import { InProcessAgentRuntime, makeActivities } from '@contentworker/agent-runtime';
import type { AppContext, RagDeps } from '@contentworker/application';
import { type ApiConfig, mountsRole } from '@contentworker/platform/config';
import type { AIProvider, BlobStore, EventBus } from '@contentworker/ports';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { WEB_SIGN_IN } from './access-policy.js';
import type { AuthDeps, AuthRateLimit } from './auth.js';
import { createApiHasher } from './auth.js';
import { doc, mountDocs } from './docs/openapi.js';
import { health, ready } from './docs/schemas.js';
import { onError } from './http.js';
import { oauthEnabled, oauthRoutes } from './oauth/routes.js';
import {
  InProcessRequestRateLimiter,
  type RequestRateLimit,
  rateLimitEnabled,
  requestRateLimitMiddleware,
} from './request-rate-limit.js';
import { deliveryRoutes } from './routes/delivery.js';
import { managementRoutes } from './routes/management.js';
import { previewRoutes } from './routes/preview.js';
import { teamRoutes } from './routes/team.js';

/** A bus that never emits — the Live Content API then yields only keepalives. */
const noopBus: EventBus = {
  publish: async () => {},
  subscribe: () => ({ close: async () => {} }),
};

/**
 * Builds the HTTP app. The ROLE config gates which modules mount; every module
 * resolves a Principal from the bearer token and enforces RBAC scopes per route.
 */
export function createApp(
  ctx: AppContext,
  config: ApiConfig,
  rag: RagDeps,
  blob: BlobStore,
  ai: AIProvider,
  bus: EventBus = noopBus,
  rateLimiter?: AuthRateLimit,
  signalReview?: AuthDeps['signalReview'],
  requestLimiter?: RequestRateLimit,
  /**
   * Adapters bound by the caller rather than derived from config.
   *
   * The positional parameters above cover what every deployment sets; this is
   * for the rest, and for tests that need to drive a seam without an
   * environment behind it.
   */
  overrides: Partial<AuthDeps> = {},
): Hono {
  const app = new Hono();
  app.onError(onError);

  // Baseline security headers on every response: nosniff, clickjacking and
  // MIME-sniffing protection, HSTS, and a strict referrer policy. No restrictive
  // Content-Security-Policy is set here because this app also serves the admin
  // SPA and third-party app-extension iframes in some deployments; the edge sets
  // a CSP tuned for the admin bundle.
  app.use(
    '*',
    secureHeaders({
      xFrameOptions: 'DENY',
      xContentTypeOptions: 'nosniff',
      strictTransportSecurity: 'max-age=31536000; includeSubDomains',
      referrerPolicy: 'no-referrer',
    }),
  );

  // Per-client request-rate limiting, ahead of the body reader and of the auth
  // chain: a rejected flood then costs one hash — no body buffered, no database
  // round-trip. The Worker injects the Cloudflare `ratelimit` binding; otherwise
  // the in-process sliding window applies (tests, bare `createApp` callers). Mounting is skipped entirely when no
  // class carries a budget, so the default path is unchanged.
  const budgets = config.rateLimit;
  if (budgets && rateLimitEnabled(budgets)) {
    const limiterHasher = createApiHasher(config.tokenPepper);
    app.use(
      '*',
      requestRateLimitMiddleware({
        limiter: requestLimiter ?? new InProcessRequestRateLimiter(budgets),
        hash: (value) => limiterHasher.hash(value),
        windowSeconds: budgets.windowSeconds,
        trustedProxyCount: config.trustedProxyCount,
      }),
    );
  }

  // Reject oversized request bodies before any handler reads them (DoS guard).
  app.use(
    '*',
    bodyLimit({
      maxSize: config.maxBodyBytes ?? 5 * 1024 * 1024,
      onError: (c) => c.json({ code: 'payload_too_large', message: 'Request body too large' }, 413),
    }),
  );

  app.get('/health', doc('System', 'Liveness probe', { ok: health }), (c) =>
    c.json({ status: 'ok' }),
  );
  app.get(
    '/ready',
    doc('System', 'Readiness probe (reports the mounted role)', { ok: ready }),
    (c) => c.json({ status: 'ready', role: config.role }),
  );

  const deps: AuthDeps = {
    ctx,
    hasher: createApiHasher(config.tokenPepper),
    adminToken: config.adminToken,
    webPrincipalKeys: config.principalKeys,
    rag,
    blob,
    ai,
    bus,
    // On-demand agent actions are synchronous request/response, so they always
    // run in-process; the durable Cloudflare Workflows path serves the queue
    // consumer's on-publish runs (AGENT_RUNTIME=cloudflare-workflows).
    agents: new InProcessAgentRuntime(makeActivities({ ctx, ai })),
    // Pure parsers with nothing to configure, so they are always available;
    // a source that needed credentials or a network would be env-gated here.
    importSources: structuredImportSources(),
    // Downloading a plugin package is a fetch like any other, bounded and
    // redirect-refusing; the policy that decides *whether* is config, not code.
    remoteFetcher: createRemoteFetcher(),
    pluginSources: config.pluginSources ?? {},
    rateLimiter,
    signalReview,
    trustedProxyCount: config.trustedProxyCount,
    moderateBeforePublish: config.moderateBeforePublish,
    accessPolicy: WEB_SIGN_IN,
    ...overrides,
  };

  const mountManagement = mountsRole(config, 'management');
  const mountDelivery = mountsRole(config, 'delivery');
  const mountPreview = mountsRole(config, 'preview');

  if (mountManagement) {
    // The authorization server rides with the management plane: a grant is approved by a person
    // signed in to the web app (its signed principal) and capped by their role in the space.
    if (oauthEnabled(config)) app.route('/', oauthRoutes(deps, config));
    app.route('/', managementRoutes(deps));
    // After managementRoutes: its `/spaces/*` principal + audit middleware cover these routes.
    app.route('/', teamRoutes(deps));
  }
  if (mountDelivery) app.route('/', deliveryRoutes(deps));
  if (mountPreview) app.route('/', previewRoutes(deps));

  // Last: the OpenAPI spec walks the routes mounted above, so /openapi.json
  // (and the Scalar UI at /docs) reflects exactly this deployment's ROLE.
  mountDocs(app, config);

  return app;
}
