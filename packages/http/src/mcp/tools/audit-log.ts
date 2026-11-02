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
      description: 'List a space’s append-only audit trail (mutating actions), newest first.',
      inputSchema: toolSchema('audit_log_list', () =>
        z.object({
          space: z.string().optional(),
          environment: z.string().optional(),
          limit: z.number().int().positive().optional(),
        }),
      ),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const spaceId = args.space ?? DEFAULT_SPACE;
      guard(SCOPES.spaceAdmin, { spaceId, environmentId: DEFAULT_ENV });
      return ok(
        await listAuditLog(ctx, spaceId, { environmentId: args.environment, limit: args.limit }),
      );
    },
  );
}
