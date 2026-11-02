import {
  duplicateEntry,
  listPreviewEntries,
  purgeEntry,
  restoreEntry,
  trashEntry,
} from '@contentworker/application';
import { authorizeContent, canAccessContentType, SCOPES } from '@contentworker/domain';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { ok, scopeArgs, scopeOf, type ToolContext, toolSchema } from './shared';

export function registerTrashTools(server: McpServer, t: ToolContext): void {
  const { deps, ctx, principal, guard, guardEntry } = t;
  // --- trash lifecycle ----------------------------------------------------
  server.registerTool(
    'entries_trash',
    {
      description:
        'Move an entry to the trash. Unpublishes it first when it is live, so ' +
        'delivery stops serving it. Recoverable with entries_restore.',
      inputSchema: toolSchema('entries_trash', () => z.object({ id: z.string(), ...scopeArgs })),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      await guardEntry(scopeOf(args), args.id, 'write');
      return ok(await trashEntry(ctx, scopeOf(args), args.id));
    },
  );

  server.registerTool(
    'entries_list_trashed',
    {
      description: 'List the entries currently in the trash.',
      inputSchema: toolSchema('entries_list_trashed', () =>
        z.object({
          contentType: z.string().optional(),
          limit: z.number().int().positive().optional(),
          ...scopeArgs,
        }),
      ),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      const items = await listPreviewEntries(ctx, scopeOf(args), {
        contentTypeApiId: args.contentType,
        limit: args.limit,
        archived: true,
      });
      return ok(items.filter((e) => canAccessContentType(principal, 'read', e.contentType)));
    },
  );

  server.registerTool(
    'entries_restore',
    {
      description:
        'Bring an entry back from the trash as a draft. Publishing it again is a ' +
        'separate action.',
      inputSchema: toolSchema('entries_restore', () => z.object({ id: z.string(), ...scopeArgs })),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      await guardEntry(scopeOf(args), args.id, 'write');
      return ok(await restoreEntry(ctx, scopeOf(args), args.id));
    },
  );

  server.registerTool(
    'entries_purge',
    {
      description:
        'Permanently delete a trashed entry and every version of it. IRREVERSIBLE. ' +
        'Refuses while published entries still link to it unless force is true.',
      inputSchema: toolSchema('entries_purge', () =>
        z.object({ id: z.string(), force: z.boolean().optional(), ...scopeArgs }),
      ),
    },
    async (args) => {
      // Gated on content:publish, not content:write: this is the only entry
      // action that cannot be undone.
      guard(SCOPES.contentPublish, scopeOf(args));
      await guardEntry(scopeOf(args), args.id, 'publish');
      await purgeEntry(ctx, scopeOf(args), args.id, {
        force: args.force,
        ...(deps.blob ? { blob: deps.blob } : {}),
      });
      return ok({ purged: args.id });
    },
  );

  server.registerTool(
    'entries_duplicate',
    {
      description: 'Copy an entry, with its taxonomy metadata, into a new draft.',
      inputSchema: toolSchema('entries_duplicate', () =>
        z.object({ id: z.string(), ...scopeArgs }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      await guardEntry(scopeOf(args), args.id, 'read');
      const created = await duplicateEntry(ctx, scopeOf(args), args.id);
      authorizeContent(principal, 'write', created.entry.contentTypeApiId);
      return ok(created);
    },
  );
}
