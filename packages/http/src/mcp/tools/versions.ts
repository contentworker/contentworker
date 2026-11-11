import {
  diffVersions,
  getPreviewEntry,
  getVersion,
  listVersions,
  restoreVersion,
  summarizeChange,
  visibleDiff,
} from '@contentworker/application';
import {
  assertWritableFields,
  authorizeContent,
  maskDeniedFields,
  SCOPES,
  withAuthorIdsFor,
} from '@contentworker/domain';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { ok, scopeArgs, scopeOf, type ToolContext, toolSchema } from './shared';

const versionRef = z.union([z.number().int().positive(), z.enum(['draft', 'published'])]);

export function registerVersionTools(server: McpServer, t: ToolContext): void {
  const { ctx, ai, principal, guard, authorizeEntryRead } = t;
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
      const items = (await listVersions(ctx, scopeOf(args), args.id)).map((v) =>
        withAuthorIdsFor(principal, { ...v, fields: maskDeniedFields(principal, type, v.fields) }),
      );
      return ok(items);
    },
  );

  server.registerTool(
    'entries_diff_versions',
    {
      description:
        'Compare two versions of an entry (from → to). Each side is a version number, "draft" ' +
        '(the current draft) or "published". Returns every field with its kind (added, removed, ' +
        'changed, unchanged) per locale, and for a change a typed detail: word-level text ' +
        'segments, link targets by id, list elements matched by key with moves, or rich-text ' +
        'blocks with word changes inside each changed block. Fields you may not read are left out; ' +
        'hiddenChanges counts the ones that changed.',
      inputSchema: toolSchema('entries_diff_versions', () =>
        z.object({
          id: z.string(),
          from: versionRef.describe('The baseline: a version number, "draft" or "published"'),
          to: versionRef.describe('The version compared against it'),
          ...scopeArgs,
        }),
      ),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      await authorizeEntryRead(scopeOf(args), args.id);
      const diff = await diffVersions(ctx, scopeOf(args), args.id, args.from, args.to);
      return ok(visibleDiff(principal, diff));
    },
  );

  server.registerTool(
    'entries_change_summary',
    {
      description:
        'Summarize the changes between two versions of an entry (from → to, as ' +
        'entries_diff_versions takes them) in plain text: one to three sentences and up to five ' +
        'highlights, written by a model from the diff alone (fields you may not read never reach ' +
        'it). source says who wrote it: "model", or "heuristic" when it was built from the diff by ' +
        'rule (no model configured, nothing visible changed, or a bad answer). Refused with ' +
        'ai_capability_disabled when the space turned field-assist off. A repeated request is ' +
        'answered from a cache (cached: true); fresh: true asks the model again. For the exact ' +
        'changes, read entries_diff_versions: the summary is a reading aid, not the record.',
      inputSchema: toolSchema('entries_change_summary', () =>
        z.object({
          id: z.string(),
          from: versionRef.describe('The baseline: a version number, "draft" or "published"'),
          to: versionRef.describe('The version compared against it'),
          fresh: z.boolean().optional().describe('Skip the cached summary and ask again'),
          ...scopeArgs,
        }),
      ),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      return ok(
        await summarizeChange(ctx, principal, scopeOf(args), args.id, args.from, args.to, {
          ai,
          fresh: args.fresh,
        }),
      );
    },
  );

  server.registerTool(
    'entries_restore_version',
    {
      description:
        'Restore an older version by copying its fields into a new draft version. Held to the ' +
        'entry’s locked regions as they are now (refused with region_locked or region_frozen) ' +
        'unless you hold the lock action on its type; the locks themselves are never restored.',
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
          restorer: principal,
        }),
      );
    },
  );
}
