/**
 * The api Worker: Management and Preview REST, the MCP server, OAuth, setup/OIDC, media and the
 * live (SSE) route. Synchronous request/response only: queue consumers, cron, Durable Objects and
 * Workflows belong to the engine Worker, bound here by script name.
 */
import { InProcessAgentRuntime, makeActivities } from '@contentworker/agent-runtime';
import { createHasher, drainOutbox } from '@contentworker/application';
import { WEB_SIGN_IN } from '@contentworker/http/api/access-policy';
import { createApp } from '@contentworker/http/api/app';
import { type AuthDeps, createApiHasher } from '@contentworker/http/api/auth';
import { validateApiSecrets } from '@contentworker/http/api/secure-secrets';
import { isAssistantPath, routeAssistant } from '@contentworker/http/assistant/gate';
import type { McpDeps } from '@contentworker/http/mcp/deps';
import { mcpRoutes } from '@contentworker/http/mcp/routes';
import { createCfRequestRateLimiter } from '@contentworker/http/rate-limit';
import { liveRoutes } from '@contentworker/http/routes/live';
import { mediaRoutes } from '@contentworker/http/routes/media';
import { mountsRole } from '@contentworker/platform/config';
import { createDoRateLimiter } from '@contentworker/platform/do/rate-limiter';
import { type EdgeEnv, withJurisdiction } from '@contentworker/platform/env';
import { makeMetrics } from '@contentworker/platform/metrics';
import { type EdgeWired, wireEdge } from '@contentworker/platform/wire';
import { sendReviewDecision } from '@contentworker/platform/workflows';
import { seedConfigFrom, seedDev } from '@contentworker/seed';
import { Hono } from 'hono';

/**
 * The D1 Sessions API bookmark, in both directions: a client echoes the value of its last
 * response so its next read is at least that fresh even when served by a read replica
 * (read-your-writes), and every response carries the bookmark after its own queries.
 */
const BOOKMARK_HEADER = 'x-cw-bookmark';
/** D1 Sessions bookmarks are hex groups joined by dashes (e.g. `00000000-00000033-…`). */
const BOOKMARK_SHAPE = /^[0-9a-f]+(?:-[0-9a-f]+){2,8}$/i;

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Idempotent dev bootstrap runs once per isolate (SEED_DEV + real database). */
let devSeeded = false;

function buildApp(wired: EdgeWired, env: EdgeEnv): Hono {
  const app = new Hono();

  // Signed R2 transfers (+ Images transforms) and Stream webhooks. Mounted on
  // every role: delivery serves downloads, management takes uploads.
  app.route(
    '/',
    mediaRoutes({
      ctx: wired.ctx,
      bucket: env.MEDIA_BUCKET,
      signer: wired.mediaSigner,
      images: env.IMAGES,
      streamWebhookSecret: env.STREAM ? env.STREAM_WEBHOOK_SECRET : undefined,
    }),
  );
  const mountManagement = mountsRole(wired.config, 'management');
  // Distributed failed-auth limiter: one DO per client IP, global across
  // isolates (the in-process default only sees its own isolate's failures).
  const rateLimiter = env.AUTH_LIMITER ? createDoRateLimiter(env.AUTH_LIMITER) : undefined;

  if (env.LIVE_HUB) {
    // Pre-mounted (first match wins): the DO-served Live Content API replaces
    // the stock in-process SSE route, with the identical auth chain.
    const authDeps: AuthDeps = {
      ctx: wired.ctx,
      hasher: createApiHasher(wired.config.tokenPepper),
      adminToken: wired.config.adminToken,
      webPrincipalKeys: wired.config.principalKeys,
      rag: wired.rag,
      blob: wired.blob,
      ai: wired.ai,
      bus: wired.bus,
      agents: new InProcessAgentRuntime(makeActivities({ ctx: wired.ctx, ai: wired.ai })),
      rateLimiter,
    };
    app.route('/', liveRoutes(authDeps, env.LIVE_HUB));
  }

  // MCP mounts only with an explicit MCP_TOKEN on persistent (production)
  // deployments — the dev fallback token would otherwise grant wildcard-space
  // admin on a public URL. Demo mode (in-memory) keeps the dev token.
  const mcpToken = env.MCP_TOKEN ?? (wired.persistent ? undefined : 'dev-mcp-token');
  if (mountManagement && mcpToken) {
    const mcpDeps: McpDeps = {
      ctx: wired.ctx,
      ai: wired.ai,
      rag: wired.rag,
      // On-demand agent actions are synchronous request/response, so they run
      // in-process (same policy as the HTTP API's createApp); the durable
      // Workflows runtime serves the queue consumer's on-publish runs.
      agents: new InProcessAgentRuntime(makeActivities({ ctx: wired.ctx, ai: wired.ai })),
      hasher: createHasher(env.TOKEN_PEPPER),
      adminToken: mcpToken,
      moderateBeforePublish: wired.config.moderateBeforePublish,
      accessPolicy: WEB_SIGN_IN,
      signalReview: env.AGENT_WF
        ? (review, decision) => sendReviewDecision(env.AGENT_WF as Workflow, review.id, decision)
        : undefined,
      ...(wired.workflowEngine ? { workflowEngine: wired.workflowEngine } : {}),
      workflowNodes: wired.workflowNodes,
    };
    const issuer = wired.config.oauthIssuer?.replace(/\/$/, '');
    app.route(
      '/',
      mcpRoutes(
        mcpDeps,
        issuer ? { issuer, resource: wired.config.oauthResource ?? `${issuer}/mcp` } : undefined,
      ),
    );
  }

  app.route(
    '/',
    createApp(
      wired.ctx,
      wired.config,
      wired.rag,
      wired.blob,
      wired.ai,
      wired.bus,
      rateLimiter,
      // Review decisions reach the durable watcher as Workflow events.
      env.AGENT_WF
        ? (review, decision) => sendReviewDecision(env.AGENT_WF as Workflow, review.id, decision)
        : undefined,
      // Native per-colo rate limiting; absent bindings leave classes unlimited.
      createCfRequestRateLimiter(env),
      // Editorial workflow runs on the EDITORIAL_WF Workflows binding.
      {
        ...(wired.workflowEngine ? { workflowEngine: wired.workflowEngine } : {}),
        workflowNodes: wired.workflowNodes,
      },
    ),
  );
  return app;
}

export default {
  /**
   * HTTP surface: management/delivery/preview APIs + MCP + the DO live route.
   * Wiring is per request and cheap (D1 is a binding). After a mutating request, an outbox
   * relay nudge runs in waitUntil — sub-second event latency without a polling
   * loop; the cron sweeper covers crashes.
   */
  async fetch(req: Request, rawEnv: EdgeEnv, exec: ExecutionContext): Promise<Response> {
    const env = withJurisdiction(rawEnv);
    // The admin's assistant: its socket (and message history) goes to the engine's
    // AssistantAgent once the signed principal names that assistant's own person. Before any
    // wiring: it needs none here, and a WebSocket's response can't be rebuilt with a bookmark.
    if (
      isAssistantPath(new URL(req.url).pathname) &&
      mountsRole({ role: env.ROLE ?? 'all' }, 'management')
    )
      return routeAssistant(req, env);
    // Writes start at the primary; reads may start at any replica unless the client brings a
    // bookmark, which pins them to at least the state it last saw.
    // A client-sent bookmark is used only when it has D1's shape; anything else would make every
    // query in the request fail, so it is ignored rather than trusted.
    const sent = req.headers.get(BOOKMARK_HEADER);
    const bookmark =
      sent && BOOKMARK_SHAPE.test(sent)
        ? sent
        : MUTATING.has(req.method)
          ? 'first-primary'
          : 'first-unconstrained';
    const wired = wireEdge(env, { bookmark });
    try {
      validateApiSecrets(wired.config, env as unknown as NodeJS.ProcessEnv);
      // The seed appends hundreds of events (thousands at a larger SEED_SCALE) in whatever
      // request runs first, often a GET; relay them now, since local dev has no cron sweep.
      let seededNow = false;
      if (wired.config.seedDev && wired.persistent && !devSeeded) {
        seededNow = true;
        await seedDev(wired.ctx, seedConfigFrom(wired.config), { blob: wired.blob });
        devSeeded = true;
      }
      const app = buildApp(wired, env);
      let res = await app.fetch(req, env, exec);
      const after = wired.bookmark();
      if (after) {
        res = new Response(res.body, res);
        res.headers.set(BOOKMARK_HEADER, after);
      }
      // A streamed reply (MCP over SSE) returns before its handler has committed: the write lands
      // while the body streams. The relay nudge waits for the body to finish, or it would find an
      // empty outbox and leave the event to the cron sweeper.
      let bodyDone: Promise<void> = Promise.resolve();
      if (res.body && MUTATING.has(req.method)) {
        const { readable, writable } = new TransformStream();
        bodyDone = res.body.pipeTo(writable).catch(() => {
          // The client went away mid-stream; whatever committed still gets relayed.
        });
        exec.waitUntil(bodyDone);
        res = new Response(readable, res);
      }
      exec.waitUntil(
        (async () => {
          const metrics = makeMetrics(env.METRICS);
          try {
            await bodyDone;
            if (wired.queue && (MUTATING.has(req.method) || seededNow)) {
              // Loop-until-drained: a bulk mutation can append far more rows
              // than one relay batch; its own nudge should clear them rather
              // than leaving the overflow to the cron sweeper.
              const relayed = await drainOutbox(wired.ctx, wired.queue, {
                routeTopic: wired.routeTopic,
              });
              if (relayed > 0) {
                metrics.count('contentworker_outbox_relayed_total', relayed, { trigger: 'nudge' });
              }
            }
          } catch (err) {
            console.error('outbox relay nudge failed', err);
            metrics.count('contentworker_relay_errors_total', 1, { trigger: 'nudge' });
          } finally {
            await wired.close();
          }
        })(),
      );
      return res;
    } catch (err) {
      exec.waitUntil(wired.close());
      throw err;
    }
  },
} satisfies ExportedHandler<EdgeEnv>;
