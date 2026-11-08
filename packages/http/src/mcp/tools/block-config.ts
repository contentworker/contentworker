import { getBlockConfig, getEffectiveBlockRules, setBlockConfig } from '@contentworker/application';
import { SCOPES } from '@contentworker/domain';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { blockConfigSetBody } from '../../api/validation';
import { ok, READ_ONLY, scopeArgs, scopeOf, type ToolContext, toolSchema } from './shared';

/** The block config: the same use-cases, scopes and checks as `/block-config`. */
export function registerBlockConfigTools(server: McpServer, t: ToolContext): void {
  const { ctx, guard } = t;

  server.registerTool(
    'blocks_config_get',
    {
      description:
        'The block config in force: how admins narrow what the block catalog allows, per target ' +
        '(the top level of a blocks field: blocks, min, max, locked) and per block slot ' +
        '(allowedChildren, min, max, locked), with its version and who set it. Version 0 and ' +
        'empty before the first set. For the rules a save is held to, use blocks_config_effective.',
      inputSchema: toolSchema('blocks_config_get', () => z.object({ ...scopeArgs })),
      annotations: READ_ONLY,
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      return ok(await getBlockConfig(ctx, scopeOf(args)));
    },
  );

  server.registerTool(
    'blocks_config_effective',
    {
      description:
        'The block rules in force: every catalog target and block slot with the config laid over ' +
        'the code — the blocks it takes, min and max, and whether it is locked (its blocks can’t ' +
        'be added, removed, moved or reordered; edits inside them are fine). Check it before ' +
        'placing or moving blocks: a save that breaks it is refused. stale lists config parts ' +
        'the catalog no longer has (ignored).',
      inputSchema: toolSchema('blocks_config_effective', () => z.object({ ...scopeArgs })),
      annotations: READ_ONLY,
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      return ok(await getEffectiveBlockRules(ctx, scopeOf(args)));
    },
  );

  server.registerTool(
    'blocks_config_set',
    {
      description:
        'Replace the block config: narrowings of what the block catalog allows, never wider. ' +
        'targets narrow a catalog target ({ contentTypeApiId, field, blocks?, min?, max?, ' +
        'locked? }); blocks narrow a block’s slots wherever it is placed ({ block, slots: { ' +
        '<slot>: { allowedChildren?, min?, max?, locked? } } }). Read blocks_config_get first ' +
        'and send its version as expectedVersion; the whole config is replaced. Show the person ' +
        'the change before setting it.',
      inputSchema: toolSchema('blocks_config_set', () =>
        blockConfigSetBody.extend({ ...scopeArgs }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentManage, scopeOf(args));
      const { space: _s, environment: _e, ...input } = args;
      return ok(await setBlockConfig(ctx, t.principal, scopeOf(args), input));
    },
  );
}
