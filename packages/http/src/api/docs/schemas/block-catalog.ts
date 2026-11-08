import { BLOCK_CATALOG_LIMITS } from '@contentworker/domain';
import { z } from 'zod';

// --- block catalog (blocks from code) -------------------------------------------------------------

/**
 * A block's props are field definitions, recursive like a content type's, so they are described as
 * open objects: the domain checks every depth with the content model's own rules.
 */
const blockFields = z
  .array(z.object({}).loose())
  .describe(
    'Props, as content type field definitions (apiId, name, type, validations, …). A style prop ' +
      'is a token: a Symbol with validations.in. JSON props are refused.',
  );

export const blockSlot = z.object({
  apiId: z.string().describe('The nested blocks field the slot becomes'),
  name: z.string(),
  help: z.string().optional(),
  allowedChildren: z.array(z.string()).describe('The block ids the slot takes; at least one'),
  min: z.int().min(0).optional().describe('Fewest blocks; above 0 makes the slot required'),
  max: z.int().min(1).optional(),
});

export const blockThumbnail = z
  .union([
    z.object({ assetId: z.string().describe('An asset in this environment') }),
    z.object({ url: z.string().describe('An https image URL') }),
  ])
  .describe('The picture the editor’s dock shows: an asset, or an https URL');

export const blockManifest = z.object({
  id: z
    .string()
    .describe('Stable id, stored on each block as `_type`; never reused for another block'),
  name: z.string().describe('What editors see'),
  group: z.string().optional().describe('The dock heading it sits under'),
  description: z.string().optional(),
  thumbnail: blockThumbnail.optional(),
  aliases: z
    .array(z.string())
    .optional()
    .describe('Ids it had before: blocks stored under one read as this block'),
  fields: blockFields,
  slots: z.array(blockSlot).optional(),
  allowedParents: z
    .array(z.string())
    .optional()
    .describe('Only these blocks’ slots may hold it (and never the top level)'),
});

export const blockCatalogTarget = z.object({
  contentTypeApiId: z.string(),
  field: z.string().describe('A top-level blocks field: its variants become the catalog’s'),
  blocks: z
    .array(z.string())
    .optional()
    .describe('The blocks its top level takes; default every block without allowedParents'),
});

export const blockCatalogChanges = z.object({
  added: z.array(z.string()),
  changed: z.array(z.string()),
  removed: z.array(z.string()),
  renamed: z.array(z.object({ from: z.string(), to: z.string() })),
});

const versionFields = {
  version: z.int().describe('1 for the first push, then one more per push that changed something'),
  hash: z.string().describe('SHA-256 of the canonical blocks and targets'),
  targets: z.array(blockCatalogTarget),
  changes: blockCatalogChanges.describe('What this version changed from the one before'),
  pushedAt: z.iso.datetime(),
  pushedBy: z.string().nullable(),
};

export const blockCatalog = z.object({
  ...versionFields,
  blocks: z.array(blockManifest).max(BLOCK_CATALOG_LIMITS.blocks),
});

export const blockCatalogVersions = z.object({
  items: z.array(z.object({ ...versionFields, blockCount: z.int() })),
});

const blockFieldChange = z.object({
  field: z.string(),
  added: z.array(z.string()),
  changed: z.array(z.string()),
  removed: z.array(z.string()),
  renamed: z.array(z.object({ from: z.string(), to: z.string() })),
});

export const blockCatalogPush = z.object({
  dryRun: z.boolean(),
  applied: z.boolean().describe('A new version was written'),
  unchanged: z.boolean().describe('The catalog and its types already match: nothing to write'),
  previousVersion: z.int(),
  version: z.int().describe('The version in force after the push (or that would be)'),
  hash: z.string(),
  changes: blockCatalogChanges,
  contentTypes: z.array(
    z.object({
      contentTypeApiId: z.string(),
      fields: z.array(blockFieldChange),
      destructive: z.boolean(),
      version: z.int(),
      published: z.boolean(),
    }),
  ),
  destructive: z.boolean().describe('Removes blocks or block props from a content type'),
  inUse: z
    .array(
      z.object({
        contentTypeApiId: z.string(),
        at: z.string(),
        kind: z.enum(['variant', 'field']),
        entries: z.array(z.string()),
      }),
    )
    .describe('What it would remove that entries still hold: a push with any is refused'),
  warnings: z.array(z.object({ field: z.string(), entries: z.int(), message: z.string() })),
});

export const blockCatalogUsage = z.object({
  version: z.int().nullable(),
  blocks: z.array(
    z.object({
      id: z.string(),
      entries: z.int(),
      contentTypes: z.array(z.object({ contentTypeApiId: z.string(), entries: z.int() })),
    }),
  ),
  scanned: z.int().describe('Entries read'),
  complete: z.boolean().describe('False when a type had more entries than the scan reads'),
});
