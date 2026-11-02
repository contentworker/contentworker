import { createRole, deleteRole, getRole, listRoles, updateRole } from '@contentworker/application';
import { SCOPES } from '@contentworker/domain';
import { Hono } from 'hono';
import { type AuthDeps, type AuthVars, requireScope } from '../../auth';
import { parseBody, roleBody } from '../../validation';

export function rolesRoutes(deps: AuthDeps): Hono<AuthVars> {
  const { ctx } = deps;
  const app = new Hono<AuthVars>();

  // --- roles (granular RBAC, admin) ----------------------------------------
  app.get('/spaces/:space/roles', requireScope(SCOPES.spaceAdmin), async (c) =>
    c.json({ items: await listRoles(ctx, c.req.param('space')) }),
  );
  app.post('/spaces/:space/roles', requireScope(SCOPES.spaceAdmin), async (c) =>
    c.json(await createRole(ctx, c.req.param('space'), await parseBody(c, roleBody)), 201),
  );
  app.get('/spaces/:space/roles/:id', requireScope(SCOPES.spaceAdmin), async (c) =>
    c.json(await getRole(ctx, c.req.param('space'), c.req.param('id'))),
  );
  app.put('/spaces/:space/roles/:id', requireScope(SCOPES.spaceAdmin), async (c) =>
    c.json(
      await updateRole(
        ctx,
        c.req.param('space'),
        c.req.param('id'),
        await parseBody(c, roleBody),
        deps.accessPolicy,
      ),
    ),
  );
  app.delete('/spaces/:space/roles/:id', requireScope(SCOPES.spaceAdmin), async (c) => {
    await deleteRole(ctx, c.req.param('space'), c.req.param('id'));
    return c.body(null, 204);
  });

  return app;
}
