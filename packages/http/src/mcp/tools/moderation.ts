import {
  getModerationHold,
  keepHeldEntryUnpublished,
  listModerationHolds,
} from '@contentworker/application';
import { authorizeContent, SCOPES, type Scope } from '@contentworker/domain';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { ok, READ_ONLY, scopeArgs, scopeOf, type ToolContext, toolSchema } from './shared';

/**
 * Moderation holds: the MCP half of `routes/management/moderation.ts`, on the same use-cases.
 *
 * A deliberate exception to "every capability on both surfaces": there is no republish tool.
 * Overriding moderation is for a person signed in to the admin (`republishHeldEntry` refuses
 * every token), and every MCP caller is a token, so a tool could only ever refuse.
 */
export function registerModerationTools(server: McpServer, t: ToolContext): void {
  const { ctx, principal, guard } = t;

  // As the HTTP API: deciding a hold needs publish on the held entry's type, either way.
  const guardDecision = async (s: Scope, id: string) => {
    if (!principal.contentGrants) return;
    authorizeContent(principal, 'publish', (await getModerationHold(ctx, s, id)).contentTypeApiId);
  };
  const decisionArgs = () =>
    z.object({
      id: z.string(),
      note: z
        .string()
        .trim()
        .max(2000)
        .optional()
        .describe('Why, kept with the hold and in the agent ledger'),
      ...scopeArgs,
    });

  server.registerTool(
    'moderation_hold_list',
    {
      description:
        'List entries the moderation agent unpublished after a publish, newest first. ' +
        'status "open" lists those waiting on a decision (as Approvals does); each names the ' +
        'categories moderation flagged. Holds on types you can’t read are left out. Only a ' +
        'person signed in to the admin can republish one; tell the user so rather than looking ' +
        'for another way.',
      inputSchema: toolSchema('moderation_hold_list', () =>
        z.object({
          status: z.enum(['open', 'republished', 'kept', 'cleared']).optional(),
          entryId: z.string().optional(),
          ...scopeArgs,
        }),
      ),
      annotations: READ_ONLY,
    },
    async (args) => {
      const s = scopeOf(args);
      guard(SCOPES.previewRead, s);
      return ok({
        items: await listModerationHolds(
          ctx,
          s,
          { status: args.status, entryId: args.entryId },
          principal,
        ),
      });
    },
  );

  server.registerTool(
    'moderation_hold_keep',
    {
      description:
        'Agree with moderation: close a hold and keep its entry unpublished. Refused when the ' +
        'hold was already decided, or the entry was published again since. Needs publish on the ' +
        'type.',
      inputSchema: toolSchema('moderation_hold_keep', decisionArgs),
    },
    async (args) => {
      const s = scopeOf(args);
      guard(SCOPES.contentPublish, s);
      await guardDecision(s, args.id);
      return ok(
        await keepHeldEntryUnpublished(ctx, s, args.id, {
          principal,
          ...(args.note ? { note: args.note } : {}),
        }),
      );
    },
  );
}
