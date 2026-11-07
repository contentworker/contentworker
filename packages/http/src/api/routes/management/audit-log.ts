import { clampCount, listAuditLog, MAX_PAGE_LIMIT } from '@contentworker/application';
import { SCOPES } from '@contentworker/domain';
import { Hono } from 'hono';
import { type AuthDeps, type AuthVars, requireScope } from '../../auth';
import { doc } from '../../docs/openapi';
import * as auditLogDocs from '../../docs/schemas/audit-log';

export function auditLogRoutes(deps: AuthDeps): Hono<AuthVars> {
  const { ctx } = deps;
  const app = new Hono<AuthVars>();

  // --- audit log (governance, admin) -------------------------------------
  app.get(
    '/spaces/:space/audit-log',
    doc('Auth', 'List the space’s audit log (filtered, cursor-paged)', {
      ok: auditLogDocs.auditLogPage,
      description:
        'Every mutating action in the space, newest first. Filters are exact matches and all ' +
        'apply together. Walk the log by passing back the response’s nextCursor, with the same ' +
        'filters. A from or to that is not an ISO 8601 date or a date-time with an offset, a ' +
        'from after to, and a cursor it cannot read are each a 422. A row whose action saved ' +
        'entries carries `detail`: each entry’s changed field paths and locales, never a value. ' +
        'Older rows have none.',
      query: {
        environment: 'The environment acted in, by its name as recorded (never an alias)',
        actor: 'Who acted: a person’s id, admin-token, or the kind of key',
        action: 'What happened: `<METHOD> <route>`, or `MCP <tool>` for a tool call',
        targetType: 'The kind of thing acted on (entry, release, content_type, …)',
        targetId: 'The id of the thing acted on',
        from: 'Earliest time, inclusive: a date (from its start, UTC) or a date-time',
        to: 'Latest time, inclusive: a date (to its end, UTC) or a date-time',
        limit: `Page size, at most ${MAX_PAGE_LIMIT}`,
        cursor: 'nextCursor from the previous page',
      },
    }),
    requireScope(SCOPES.spaceAdmin),
    async (c) => {
      const q = (name: string) => c.req.query(name);
      return c.json(
        await listAuditLog(ctx, c.req.param('space'), {
          environmentId: q('environment'),
          actor: q('actor'),
          action: q('action'),
          targetType: q('targetType'),
          targetId: q('targetId'),
          from: q('from'),
          to: q('to'),
          limit: clampCount(q('limit'), MAX_PAGE_LIMIT, { min: 1 }),
          cursor: q('cursor'),
        }),
      );
    },
  );

  return app;
}
