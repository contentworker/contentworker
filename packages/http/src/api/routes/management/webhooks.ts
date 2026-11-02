import {
  clampCount,
  createWebhook,
  deleteWebhook,
  listWebhookDeliveries,
  listWebhooks,
  MAX_PAGE_LIMIT,
  updateWebhook,
} from '@contentworker/application';
import { SCOPES } from '@contentworker/domain';
import { Hono } from 'hono';
import { type AuthDeps, type AuthVars, requireScope } from '../../auth';
import { doc } from '../../docs/openapi';
import * as webhookDocs from '../../docs/schemas/webhooks';
import { parseBody, updateWebhookBody, webhookBody } from '../../validation';
import { BASE, scopeOf, webhookSummary } from './shared';

export function webhooksRoutes(deps: AuthDeps): Hono<AuthVars> {
  const { ctx } = deps;
  const app = new Hono<AuthVars>();

  // --- webhooks (admin) ---------------------------------------------------
  // A hook is scoped to one environment (`environmentId`) or space-wide (`null`). Under an
  // environment, every route sees that environment's hooks and the space-wide ones; a hook scoped to
  // another environment is a 404 here. The raw `:env` goes to the use-case so a hook is never pinned
  // to an alias's current target.
  app.get(
    `${BASE}/webhooks`,
    doc('Webhooks', 'List webhooks', {
      description:
        "The environment's own webhooks and every space-wide one (`environmentId: null`). " +
        'Signing secrets and headers are never returned.',
      ok: webhookDocs.webhookList,
    }),
    requireScope(SCOPES.spaceAdmin),
    async (c) => {
      const hooks = await listWebhooks(ctx, scopeOf(c));
      return c.json({ items: hooks.map(webhookSummary) });
    },
  );
  app.post(
    `${BASE}/webhooks`,
    doc('Webhooks', 'Create a webhook', {
      description:
        "Receives only the path environment's events, or every environment's with " +
        '`allEnvironments: true`. Under an alias it is space-wide, and `allEnvironments: false` is ' +
        'refused (422). The URL must be http(s) and not a loopback, link-local or private address.',
      body: webhookBody,
      ok: webhookDocs.webhook,
      status: 201,
    }),
    requireScope(SCOPES.spaceAdmin),
    async (c) =>
      c.json(
        webhookSummary(
          await createWebhook(
            ctx,
            scopeOf(c),
            (await parseBody(c, webhookBody)) as Parameters<typeof createWebhook>[2],
            { requestedEnvironment: c.req.param('env') },
          ),
        ),
        201,
      ),
  );
  app.put(
    `${BASE}/webhooks/:id`,
    doc('Webhooks', 'Update a webhook', {
      description:
        'Omitted fields are kept. `allEnvironments: true` makes the hook space-wide, `false` ' +
        "scopes it to the path's environment (422 under an alias); omitted, its scope is unchanged.",
      body: updateWebhookBody,
      ok: webhookDocs.webhook,
    }),
    requireScope(SCOPES.spaceAdmin),
    async (c) =>
      c.json(
        webhookSummary(
          await updateWebhook(
            ctx,
            scopeOf(c),
            c.req.param('id'),
            (await parseBody(c, updateWebhookBody)) as Parameters<typeof updateWebhook>[3],
            { requestedEnvironment: c.req.param('env') },
          ),
        ),
      ),
  );
  app.delete(`${BASE}/webhooks/:id`, requireScope(SCOPES.spaceAdmin), async (c) => {
    await deleteWebhook(ctx, scopeOf(c), c.req.param('id'));
    return c.body(null, 204);
  });
  app.get(`${BASE}/webhooks/:id/deliveries`, requireScope(SCOPES.spaceAdmin), async (c) => {
    const limit = c.req.query('limit');
    const items = await listWebhookDeliveries(ctx, scopeOf(c), c.req.param('id'), {
      limit: clampCount(limit, MAX_PAGE_LIMIT, { min: 1 }),
    });
    return c.json({ items });
  });

  return app;
}
