import { requestDeliveryRefresh } from '@contentworker/application';
import { SCOPES } from '@contentworker/domain';
import { Hono } from 'hono';
import { type AuthDeps, type AuthVars, requireScope } from '../../auth';
import { doc } from '../../docs/openapi';
import * as deliveryCacheDocs from '../../docs/schemas/delivery-cache';
import { BASE, scopeOf } from './shared';

export function deliveryCacheRoutes(deps: AuthDeps): Hono<AuthVars> {
  const { ctx } = deps;
  const app = new Hono<AuthVars>();

  // The manual counterpart of a publish: invalidate, warm, then `delivery.refreshed`.
  app.post(
    `${BASE}/delivery-cache/refresh`,
    doc('Spaces & environments', 'Refresh the Delivery cache', {
      ok: deliveryCacheDocs.deliveryRefresh,
      status: 202,
      description:
        'Refreshes every cached Delivery response in the environment, as a publish does: ' +
        'responses are marked stale (readers keep being served while they revalidate), the ' +
        'most-read ones are fetched again, and a `delivery.refreshed` webhook follows once the ' +
        'edge has settled. Returns 202; the work runs on the queues. At most once a minute per ' +
        'environment (429 if requested too soon).',
    }),
    requireScope(SCOPES.contentPublish),
    async (c) => c.json(await requestDeliveryRefresh(ctx, scopeOf(c)), 202),
  );

  return app;
}
