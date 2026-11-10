import { BLOCK_LOCK_DEPTHS, BLOCK_LOCK_FREEZES, BLOCK_LOCK_LIMITS } from '@contentworker/domain';
import { z } from 'zod';

// --- locked regions (an entry's blocks editors can't restructure) ----------------------------------

const keys = z
  .array(z.string().min(1).max(100))
  .min(1)
  .max(BLOCK_LOCK_LIMITS.keys)
  .describe('The region: one block, or a run of neighbours in one slot, in order, by `_key`');
const depth = z
  .enum(BLOCK_LOCK_DEPTHS)
  .describe('`subtree`: the blocks and everything inside them. `self`: their own slots stay open');
const freeze = z
  .enum(BLOCK_LOCK_FREEZES)
  .describe(
    '`structure`: no add, remove, move or swap; fields stay editable. `all`: fields frozen too',
  );

/** A lock as a set sends it: who and when are the server's. */
export const blockLockInput = z.object({
  field: z.string().describe('The blocks field (a top-level field apiId) the region is in'),
  keys,
  depth: depth.optional().describe('Default `subtree`'),
  freeze: freeze.optional().describe('Default `structure`'),
});

export const blockLock = z.object({
  field: z.string(),
  keys,
  depth,
  freeze,
  lockedBy: z.string().describe('Who locked it: a person id, admin-token or a key kind'),
  lockedAt: z.iso.datetime(),
});

export const entryBlockLocks = z.object({
  entryId: z.string(),
  contentTypeApiId: z.string(),
  version: z.int().describe('The entry’s currentVersion: send it back as expectedVersion'),
  locks: z.array(blockLock).max(BLOCK_LOCK_LIMITS.locks),
  stale: z
    .array(blockLock)
    .describe('Locks whose blocks no locale holds any more: shown, never blocking a save'),
});

export const entryBlockLocksSet = entryBlockLocks.extend({
  unchanged: z.boolean().describe('The entry already held these locks: nothing written'),
});
