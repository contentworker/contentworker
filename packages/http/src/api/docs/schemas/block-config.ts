import { BLOCK_CONFIG_LIMITS } from '@contentworker/domain';
import { z } from 'zod';

// --- block config (what admins allow of the block catalog) ------------------------------------------

const count = (what: string) => z.int().min(0).optional().describe(what);

export const slotNarrowing = z.object({
  allowedChildren: z
    .array(z.string())
    .optional()
    .describe('The block ids the slot takes: a non-empty subset of the code’s allowedChildren'),
  min: count('Fewest blocks: at least the code’s min'),
  max: count('Most blocks: at most the code’s max'),
  locked: z
    .boolean()
    .optional()
    .describe('Editors can’t add, remove, move or reorder its blocks; edits inside them are fine'),
});

export const targetNarrowing = z.object({
  contentTypeApiId: z.string(),
  field: z.string().describe('A catalog target: a top-level blocks field'),
  blocks: z
    .array(z.string())
    .optional()
    .describe('The blocks its top level takes: a non-empty subset of what the target takes'),
  min: count('Fewest blocks at its top level'),
  max: count('Most blocks at its top level'),
  locked: slotNarrowing.shape.locked,
});

export const blockNarrowing = z.object({
  block: z.string().describe('A block id of the catalog'),
  slots: z
    .record(z.string(), slotNarrowing)
    .describe('Narrowings by slot apiId, wherever the block is placed'),
});

export const blockConfig = z.object({
  version: z.int().describe('0 before the first set, then one more per set that changed something'),
  targets: z.array(targetNarrowing).max(BLOCK_CONFIG_LIMITS.targets),
  blocks: z.array(blockNarrowing).max(BLOCK_CONFIG_LIMITS.blocks),
  updatedAt: z.iso.datetime().nullable(),
  updatedBy: z.string().nullable(),
});

export const blockConfigSet = z.object({
  config: blockConfig,
  unchanged: z.boolean().describe('The config was already this: nothing written'),
});

const effectiveSlot = z.object({
  allowedChildren: z.array(z.string()).describe('In the catalog’s order'),
  min: z.int().optional(),
  max: z.int().optional(),
  locked: z.boolean(),
  narrowed: z.boolean().describe('The config makes it tighter than the code'),
});

export const effectiveBlockRules = z.object({
  catalogVersion: z.int().nullable().describe('null before the first catalog push'),
  configVersion: z.int(),
  targets: z.array(
    effectiveSlot.omit({ allowedChildren: true }).extend({
      contentTypeApiId: z.string(),
      field: z.string(),
      blocks: z.array(z.string()),
    }),
  ),
  blocks: z.array(z.object({ block: z.string(), slots: z.record(z.string(), effectiveSlot) })),
  stale: z
    .array(z.object({ at: z.string(), message: z.string() }))
    .describe('Parts of the config the catalog no longer has: ignored, never an error'),
});
