import { getEntryBlockLocks, setEntryBlockLocks } from '@contentworker/application';
import { SCOPES } from '@contentworker/domain';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { blockLocksSetBody } from '../../api/validation';
import { ok, READ_ONLY, scopeArgs, scopeOf, type ToolContext, toolSchema } from './shared';

/** Locked regions: the same use-cases, scopes and checks as `/entries/{id}/block-locks`. */
export function registerBlockLockTools(server: McpServer, t: ToolContext): void {
  const { ctx, guard } = t;

  server.registerTool(
    'entries_block_locks_get',
    {
      description:
        'The locked regions of an entry’s blocks: each a field, the `_key`s of one block or a run ' +
        'of neighbouring blocks in one slot, its depth (subtree: everything inside too; self: ' +
        'its own slots stay open), its freeze (structure: no add, remove, move or swap; all: ' +
        'fields frozen too), and who locked it when. stale lists locks whose blocks are gone ' +
        '(they block nothing). Read it before changing an entry’s blocks: a save that breaks a ' +
        'region is refused with region_locked or region_frozen.',
      inputSchema: toolSchema('entries_block_locks_get', () =>
        z.object({ id: z.string(), ...scopeArgs }),
      ),
      annotations: READ_ONLY,
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      return ok(await getEntryBlockLocks(ctx, t.principal, scopeOf(args), args.id));
    },
  );

  server.registerTool(
    'entries_block_locks_set',
    {
      description:
        'Replace an entry’s locked regions with locks: [{ field, keys, depth?, freeze? }] (the ' +
        'whole list; a lock left out is unlocked). keys are the `_key`s of one block, or of ' +
        'neighbouring blocks in one slot in order; a block belongs to at most one region. Needs ' +
        'the lock action on the entry’s type. Makes no version. Read entries_block_locks_get ' +
        'first and send its version as expectedVersion. Only lock or unlock when the person asks.',
      inputSchema: toolSchema('entries_block_locks_set', () =>
        blockLocksSetBody.extend({ id: z.string(), ...scopeArgs }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      const { space: _s, environment: _e, id, ...input } = args;
      return ok(await setEntryBlockLocks(ctx, t.principal, scopeOf(args), id, input));
    },
  );
}
