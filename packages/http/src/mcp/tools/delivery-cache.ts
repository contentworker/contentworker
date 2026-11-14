import { requestDeliveryRefresh } from '@contentworker/application';
import { SCOPES } from '@contentworker/domain';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { ok, scopeArgs, scopeOf, type ToolContext, toolSchema } from './shared';

export function registerDeliveryCacheTools(server: McpServer, t: ToolContext): void {
  const { ctx, guard } = t;
  server.registerTool(
    'delivery_cache_refresh',
    {
      description:
        'Refresh the environment’s Delivery cache, as a publish does: cached responses are marked ' +
        'stale (still served while they revalidate), the most-read ones are fetched again, and a ' +
        '`delivery.refreshed` webhook follows once the edge has settled. For when published ' +
        'content looks out of date without a publish to blame. Runs on the queues; at most once ' +
        'a minute per environment.',
      inputSchema: toolSchema('delivery_cache_refresh', () => z.object({ ...scopeArgs })),
    },
    async (args) => {
      guard(SCOPES.contentPublish, scopeOf(args));
      return ok(await requestDeliveryRefresh(ctx, scopeOf(args)));
    },
  );
}
