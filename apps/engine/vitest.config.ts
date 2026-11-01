import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Runs inside workerd so the Durable Objects and the editorial Workflow execute for real
// (storage, alarms, RPC, Miniflare's Workflows engine). The fixture worker exports only the
// classes under test, keeping the test module graph free of the queue/AI adapters.
export default defineConfig({
  test: {
    name: 'workers',
    include: ['test/**/*.test.ts'],
  },
  plugins: [
    cloudflareTest({
      main: './test/fixtures/worker.ts',
      miniflare: {
        // Production's date (apps/engine/wrangler.jsonc).
        compatibilityDate: '2026-10-01',
        compatibilityFlags: ['nodejs_compat'],
        // No `workerLoaders` binding, though the compatibility date now allows
        // one. The pool proxies bindings into the test isolate, and an
        // entrypoint to a dynamically-loaded worker cannot cross a Worker
        // boundary — "the system does not know how to reload this Worker from
        // scratch". Loading from the fixture worker's own handler does not help,
        // because that handler is reached through the same proxy. So the plugin
        // sandbox's isolation properties stay verified against a real
        // `wrangler dev` worker by hand, and the adapter's unit tests pin the
        // configuration it asks for. Revisit when the pool exposes an
        // in-isolate binding.
        durableObjects: {
          LIVE_HUB: 'LiveHubDO',
          AUTH_LIMITER: 'RateLimiterDO',
          AI_BUDGET: 'CostGuardDO',
          SEARCH: { className: 'SearchShardDO', useSQLite: true },
        },
        // The editorial workflow host, run by miniflare's real Workflows engine over the
        // fixture's in-memory context (test/fixtures/editorial.ts).
        workflows: {
          EDITORIAL_WF: {
            name: 'contentworker-editorial-test',
            className: 'EditorialTestWorkflow',
          },
        },
        bindings: {
          AUTH_RATE_LIMIT_MAX: '3',
          AUTH_RATE_LIMIT_WINDOW_MS: '300',
          AI_MAX_REQUESTS_PER_WINDOW: '2',
          AI_MAX_TOKENS_PER_WINDOW: '100',
          // Wide enough that a test's sequential RPCs can't straddle a
          // window roll on a slow runner; only the lapse test sleeps it out.
          AI_BUDGET_WINDOW_SECONDS: '2',
          // Background (`agent:`) windows enforce the stricter agent ceiling.
          AI_AGENT_MAX_REQUESTS_PER_WINDOW: '1',
        },
      },
    }),
  ],
});
