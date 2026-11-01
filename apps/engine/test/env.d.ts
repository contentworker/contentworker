import type { CostGuardDO } from '@contentworker/platform/do/cost-guard';
import type { LiveHubDO } from '@contentworker/platform/do/live-hub';
import type { RateLimiterDO } from '@contentworker/platform/do/rate-limiter';
import type { SearchShardDO } from '@contentworker/platform/do/search-shard';

// Bindings provided by vitest.config.ts (miniflare section), typed as
// required — unlike EdgeEnv, where every binding is optional.
//
// Augments `Cloudflare.Env` rather than the pool's old `ProvidedEnv`: the newer
// pool types `env` as the same global namespace wrangler generates, so test and
// production bindings are described in one place instead of two that can drift.
declare global {
  namespace Cloudflare {
    interface Env {
      readonly LIVE_HUB: DurableObjectNamespace<LiveHubDO>;
      readonly AUTH_LIMITER: DurableObjectNamespace<RateLimiterDO>;
      readonly AI_BUDGET: DurableObjectNamespace<CostGuardDO>;
      readonly SEARCH: DurableObjectNamespace<SearchShardDO>;
      readonly EDITORIAL_WF: Workflow;
    }
  }
}
