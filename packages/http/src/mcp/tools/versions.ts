import {
  diffVersions,
  getPreviewEntry,
  getVersion,
  listVersions,
  restoreVersion,
} from '@contentworker/application';
import {
  assertWritableFields,
  authorizeContent,
  maskDeniedFields,
  SCOPES,
} from '@contentworker/domain';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { ok, scopeArgs, scopeOf, type ToolContext, toolSchema } from './shared';

export function registerVersionTools(server: McpServer, t: ToolContext): void {
  const { ctx, principal, guard, authorizeEntryRead } = t;
  // --- entry version history ---------------------------------------------
  server.registerTool(
    'entries_list_versions',
    {
      description: 'List every saved version of an entry, newest first.',
      inputSchema: toolSchema('entries_list_versions', () =>
        z.object({ id: z.string(), ...scopeArgs }),
      ),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      const type = await authorizeEntryRead(scopeOf(args), args.id);
      const items = (await listVersions(ctx, scopeOf(args), args.id)).map((v) => ({
        ...v,
        fields: maskDeniedFields(principal, type, v.fields),
      }));
      return ok(items);
    },
  );

  server.registerTool(
    'entries_diff_versions',
    {
      description: 'Diff two versions of an entry field-by-field (from → to).',
      inputSchema: toolSchema('entries_diff_versions', () =>
        z.object({ id: z.string(), from: z.number(), to: z.number(), ...scopeArgs }),
      ),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      const type = await authorizeEntryRead(scopeOf(args), args.id);
      const diff = await diffVersions(ctx, scopeOf(args), args.id, args.from, args.to);
      const allowed = maskDeniedFields(
        principal,
        type,
        Object.fromEntries(diff.changes.map((ch) => [ch.field, ch])),
      );
      return ok({ ...diff, changes: Object.values(allowed) });
    },
  );

  server.registerTool(
    'entries_restore_version',
    {
      description: 'Restore an older version by copying its fields into a new draft version.',
      inputSchema: toolSchema('entries_restore_version', () =>
        z.object({
          id: z.string(),
          version: z.number(),
          expectedVersion: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("The entry's currentVersion as you read it; refused if it has changed since"),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      const entry = await getPreviewEntry(ctx, scopeOf(args), args.id);
      authorizeContent(principal, 'write', entry.contentType);
      const target = await getVersion(ctx, scopeOf(args), args.id, args.version);
      assertWritableFields(principal, entry.contentType, target.fields);
      return ok(
        await restoreVersion(ctx, scopeOf(args), args.id, args.version, {
          expectedVersion: args.expectedVersion,
        }),
      );
    },
  );
}
