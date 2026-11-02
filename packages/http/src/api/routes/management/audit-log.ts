import { clampCount, listAuditLog, MAX_PAGE_LIMIT } from '@contentworker/application';
import { SCOPES } from '@contentworker/domain';
import { Hono } from 'hono';
import { type AuthDeps, type AuthVars, requireScope } from '../../auth';

export function auditLogRoutes(deps: AuthDeps): Hono<AuthVars> {
  const { ctx } = deps;
  const app = new Hono<AuthVars>();

  // --- audit log (governance, admin) -------------------------------------
  app.get('/spaces/:space/audit-log', requireScope(SCOPES.spaceAdmin), async (c) => {
    const limit = c.req.query('limit');
    const items = await listAuditLog(ctx, c.req.param('space'), {
      environmentId: c.req.query('environment'),
      limit: clampCount(limit, MAX_PAGE_LIMIT, { min: 1 }),
    });
    return c.json({ items });
  });

  return app;
}
