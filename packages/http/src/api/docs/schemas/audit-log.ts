import { z } from 'zod';

// --- audit log --------------------------------------------------------------

export const auditEntry = z.object({
  id: z.string(),
  spaceId: z.string(),
  environmentId: z.string().optional().describe('The environment acted in, when it was scoped'),
  actor: z.string().describe('A person’s id, admin-token, or the kind of key'),
  action: z.string().describe('`<METHOD> <route>` for REST, `MCP <tool>` for a tool call'),
  targetType: z
    .string()
    .optional()
    .describe('The kind of thing acted on (entry, release, content_type, …)'),
  targetId: z.string().optional(),
  status: z.number().int().describe('The action’s result status'),
  at: z.iso.datetime(),
});

export const auditLogPage = z.object({
  items: z.array(auditEntry),
  nextCursor: z
    .string()
    .optional()
    .describe('Pass back as cursor for the next page; absent on the last one'),
});
