import {
  createEnvironment,
  deleteEnvironment,
  listEnvironments,
  listSpacesFor,
} from '@contentworker/application';
import { SCOPES } from '@contentworker/domain';
import { createSpaceWithStarter } from '@contentworker/seed';
import { Hono } from 'hono';
import { type AuthDeps, type AuthVars, requireScope } from '../../auth';
import { doc } from '../../docs/openapi';
import * as spaceDocs from '../../docs/schemas/spaces';
import { createEnvironmentBody, createSpaceBody, parseBody } from '../../validation';

export function provisioningRoutes(deps: AuthDeps): Hono<AuthVars> {
  const { ctx, blob } = deps;
  const app = new Hono<AuthVars>();

  // --- provisioning (admin) ----------------------------------------------
  // Authenticated principals see the spaces they can reach: admin → all, a signed-in member →
  // their teams, a scoped key → just its own. (No requireScope: there is no :space here.)
  app.get('/spaces', async (c) => {
    const items = await listSpacesFor(ctx, c.get('principal'));
    return c.json({ items: items.map((s) => ({ id: s.spaceId, name: s.name })) });
  });
  app.post(
    '/spaces',
    doc('Spaces & environments', 'Create a space', {
      description:
        'Creates a space with its locales and environments (`main` by default), optionally with ' +
        'sample content (`starter: "sample"`), installed before the response returns. Deployment ' +
        'administrators only: the admin token, or a person signed in to the admin as a ' +
        "deployment admin. A space's own API keys can't create spaces. Creating a space whose id " +
        'exists updates its name and locales; repeating a `sample` create finishes an install ' +
        'that failed part-way without duplicating anything.',
      body: createSpaceBody,
      ok: spaceDocs.createdSpace,
      status: 201,
    }),
    requireScope(SCOPES.spaceAdmin),
    async (c) => {
      const body = await parseBody(c, createSpaceBody);
      const created = await createSpaceWithStarter(ctx, body, { blob });
      return c.json(
        {
          id: created.space.spaceId,
          name: created.space.name,
          starter: created.starter,
          ...(created.installed ? { installed: created.installed } : {}),
        },
        201,
      );
    },
  );

  app.get('/spaces/:space/environments', requireScope(SCOPES.previewRead), async (c) =>
    c.json({ items: await listEnvironments(ctx, c.req.param('space')) }),
  );
  app.post('/spaces/:space/environments', requireScope(SCOPES.spaceAdmin), async (c) => {
    const body = await parseBody(c, createEnvironmentBody);
    await createEnvironment(ctx, c.req.param('space'), body.id, body.name);
    return c.json({ id: body.id }, 201);
  });
  app.delete(
    '/spaces/:space/environments/:env',
    doc('Spaces & environments', 'Delete an environment and everything in it', {
      query: { confirm: 'The environment id again (required: deleting is irreversible)' },
      description:
        'Removes the environment, its content model, entries, versions, assets, releases, ' +
        'workflows and the rest (its audit history stays); search documents, vectors and the ' +
        'delivery cache are cleaned up asynchronously. Refuses `main` and any environment an ' +
        'alias points at (409).',
    }),
    requireScope(SCOPES.spaceAdmin),
    async (c) =>
      c.json(
        await deleteEnvironment(ctx, c.req.param('space'), c.req.param('env'), {
          confirm: c.req.query('confirm'),
          principal: c.get('principal'),
        }),
      ),
  );

  return app;
}
