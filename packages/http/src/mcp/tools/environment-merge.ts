import { compareEnvironments, comparisonFor, mergeEnvironments } from '@contentworker/application';
import { SCOPES } from '@contentworker/domain';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { DEFAULT_SPACE, ok, type ToolContext, toolSchema } from './shared';

export function registerEnvironmentMergeTools(server: McpServer, t: ToolContext): void {
  const { ctx, guard, principal } = t;
  // --- branch compare/merge ----------------------------------------------
  server.registerTool(
    'environments_compare',
    {
      description:
        'Diff two environments in a space: the content types and entries that differ, and whether the block catalog and block config do (`blocks`; a merge never copies those).',
      inputSchema: toolSchema('environments_compare', () =>
        z.object({
          source: z.string(),
          target: z.string(),
          space: z.string().optional(),
        }),
      ),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const spaceId = args.space ?? DEFAULT_SPACE;
      guard(SCOPES.previewRead, { spaceId, environmentId: args.source });
      return ok(
        comparisonFor(principal, await compareEnvironments(ctx, spaceId, args.source, args.target)),
      );
    },
  );

  server.registerTool(
    'environments_merge',
    {
      description:
        "Apply selected content types/entries from a source environment into a target (additive). Merging entries takes read, write and lock on every content type with no field rules, since each is copied whole over the target's locked regions; content types alone take only content:manage. Refused before anything is written (422 on `contentTypes`, naming the type, what it removes and the entry ids) when a type removes a field or block variant entries in the target still hold, except merged entries' own current versions; change or clear those values there first, or leave the type out.",
      inputSchema: toolSchema('environments_merge', () =>
        z.object({
          source: z.string(),
          target: z.string(),
          contentTypes: z.array(z.string()).optional(),
          entries: z.array(z.string()).optional(),
          space: z.string().optional(),
        }),
      ),
    },
    async (args) => {
      const spaceId = args.space ?? DEFAULT_SPACE;
      guard(SCOPES.contentManage, { spaceId, environmentId: args.target });
      return ok(
        await mergeEnvironments(ctx, principal, spaceId, args.source, args.target, {
          contentTypes: args.contentTypes,
          entries: args.entries,
        }),
      );
    },
  );
}
