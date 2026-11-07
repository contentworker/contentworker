import { listAuditLog } from '@contentworker/application';
import { SCOPES } from '@contentworker/domain';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { DEFAULT_ENV, DEFAULT_SPACE, ok, type ToolContext, toolSchema } from './shared';

export function registerAuditLogTools(server: McpServer, t: ToolContext): void {
  const { ctx, guard } = t;
  // --- audit log (governance) --------------------------------------------
  server.registerTool(
    'audit_log_list',
    {
      description:
        'List a space’s append-only audit trail (mutating actions), newest first. Filters are ' +
        'exact matches and all apply together. Returns one page; pass nextCursor back as cursor, ' +
        'with the same filters, for the next. A row whose action saved entries carries `detail`: ' +
        'each entry’s changed field paths and locales, never a value. Older rows have none.',
      inputSchema: toolSchema('audit_log_list', () =>
        z.object({
          space: z.string().optional(),
          environment: z.string().optional(),
          actor: z.string().optional().describe('A person’s id, admin-token, or the kind of key'),
          action: z
            .string()
            .optional()
            .describe('`<METHOD> <route>` for a REST call, `MCP <tool>` for a tool call'),
          targetType: z
            .string()
            .optional()
            .describe('The kind of thing acted on (entry, release, content_type, …)'),
          targetId: z.string().optional().describe('The id of the thing acted on'),
          from: z
            .string()
            .optional()
            .describe('Earliest time, inclusive: an ISO 8601 date (UTC) or date-time'),
          to: z
            .string()
            .optional()
            .describe('Latest time, inclusive: an ISO 8601 date (to its end, UTC) or date-time'),
          limit: z.number().int().positive().optional(),
          cursor: z.string().optional().describe('nextCursor from the previous page'),
        }),
      ),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const spaceId = args.space ?? DEFAULT_SPACE;
      guard(SCOPES.spaceAdmin, { spaceId, environmentId: DEFAULT_ENV });
      const { space: _space, environment, ...query } = args;
      return ok(await listAuditLog(ctx, spaceId, { ...query, environmentId: environment }));
    },
  );
}
