// Test-only worker entry: exports the Durable Object classes under test with a
// minimal fetch handler, so the vitest-pool-workers runtime can bind them
// without pulling src/index.ts's full adapter graph into the test bundle.
export { CostGuardDO } from '@contentworker/platform/do/cost-guard';
export { LiveHubDO } from '@contentworker/platform/do/live-hub';
export { RateLimiterDO } from '@contentworker/platform/do/rate-limiter';
export { SearchShardDO } from '@contentworker/platform/do/search-shard';
export { EditorialTestWorkflow } from './editorial.js';

export default {
  fetch(): Response {
    return new Response('test fixture');
  },
};
