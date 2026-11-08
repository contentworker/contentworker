import {
  getBlockCatalog,
  getBlockUsage,
  listBlockCatalogVersions,
  MAX_BLOCK_CATALOG_VERSIONS_PAGE,
  MAX_BLOCK_USAGE_SCAN,
  pushBlockCatalog,
} from '@contentworker/application';
import { SCOPES } from '@contentworker/domain';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { blockCatalogPushBody } from '../../api/validation';
import { ok, READ_ONLY, scopeArgs, scopeOf, type ToolContext, toolSchema } from './shared';

/** Blocks from code: the same use-cases, scopes and checks as `/block-catalog`. */
export function registerBlockCatalogTools(server: McpServer, t: ToolContext): void {
  const { ctx, guard } = t;

  server.registerTool(
    'blocks_catalog_get',
    {
      description:
        'The block catalog in force (or one version of it): each block a page can be composed ' +
        'from, with its id (stored on blocks as _type), name, group, props (field definitions), ' +
        'slots and the blocks each slot allows, allowedParents and aliases (former ids); the ' +
        'blocks fields it provides; and who pushed it when. Not found before the first push.',
      inputSchema: toolSchema('blocks_catalog_get', () =>
        z.object({
          version: z.int().min(1).optional().describe('A past version; default the one in force'),
          ...scopeArgs,
        }),
      ),
      annotations: READ_ONLY,
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      return ok(await getBlockCatalog(ctx, scopeOf(args), args.version));
    },
  );

  server.registerTool(
    'blocks_catalog_versions',
    {
      description: 'The block catalog’s pushed versions, newest first, without their blocks.',
      inputSchema: toolSchema('blocks_catalog_versions', () =>
        z.object({
          limit: z.int().min(1).max(MAX_BLOCK_CATALOG_VERSIONS_PAGE).optional(),
          before: z.int().min(1).optional().describe('Only versions below this one'),
          ...scopeArgs,
        }),
      ),
      annotations: READ_ONLY,
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      const items = await listBlockCatalogVersions(ctx, scopeOf(args), {
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
        ...(args.before !== undefined ? { before: args.before } : {}),
      });
      return ok({ items });
    },
  );

  server.registerTool(
    'blocks_catalog_push',
    {
      description:
        'Push component manifests as the block catalog: the target blocks fields take exactly ' +
        'these blocks as variants (slots become nested blocks fields), each changed content type ' +
        'is revised and published (publish: false leaves drafts), and a new version is stored. ' +
        'Run with dryRun: true first and show the result: blocks added, changed, removed and ' +
        'renamed, the types it changes, and inUse (what it would remove that entries hold, which ' +
        'refuses the push). Then push with expectedVersion set to the dry run’s previousVersion. ' +
        'A removal also needs allowDestructive. To rename a block id, keep the old id in the ' +
        'new block’s aliases. Style props are tokens (a Symbol with validations.in); never CSS.',
      inputSchema: toolSchema('blocks_catalog_push', () =>
        blockCatalogPushBody.extend({ ...scopeArgs }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentManage, scopeOf(args));
      const { space: _s, environment: _e, ...input } = args;
      return ok(await pushBlockCatalog(ctx, t.principal, scopeOf(args), input));
    },
  );

  server.registerTool(
    'blocks_usage',
    {
      description:
        'How many entries use each block of the catalog in force, in all and per content type ' +
        `(current versions outside the trash, once per entry). Reads up to ${MAX_BLOCK_USAGE_SCAN} ` +
        'entries per type; complete: false means the counts are a lower bound. Check it before ' +
        'removing a block.',
      inputSchema: toolSchema('blocks_usage', () => z.object({ ...scopeArgs })),
      annotations: READ_ONLY,
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      return ok(await getBlockUsage(ctx, t.principal, scopeOf(args)));
    },
  );
}
