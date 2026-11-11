import { z } from 'zod';

// --- audit log --------------------------------------------------------------

const entryChange = z.object({
  entryId: z.string(),
  contentType: z.string().describe('The content type’s api id'),
  kind: z.enum(['created', 'updated']),
  version: z.number().int().describe('The version the write made'),
  paths: z
    .array(z.string())
    .describe(
      'The content model’s paths that changed: `fields.title`, `fields.hero.alt`, ' +
        '`fields.sections[].heading` for an element of a list. Rich text and JSON stop at the field',
    ),
  locales: z.array(z.string()).describe('The space’s locales the change touched'),
  undeclaredFields: z
    .number()
    .int()
    .optional()
    .describe('How many fields the type no longer declares changed; they are not named'),
});

const parts = z.array(z.string());

const blockConfigChange = z.object({
  from: z.number().int().describe('The version it replaced'),
  to: z.number().int().describe('The version it wrote'),
  added: parts.describe('Targets and slots newly narrowed (`blocks[grid].slots.items`)'),
  removed: parts.describe('Targets and slots no longer narrowed'),
  loosened: parts.describe('Narrowed still, but less than before'),
  unlocked: parts.describe('Locks taken off'),
});

const blockLockSummary = z.object({
  field: z.string(),
  keys: parts.describe('At most ten of the region’s block `_key`s'),
  keyCount: z.int().optional().describe('How many keys it names, when more than are listed'),
  depth: z.enum(['subtree', 'self']),
  freeze: z.enum(['structure', 'all']),
});

const blockLockChange = z.object({
  entryId: z.string(),
  locked: z.array(blockLockSummary).describe('Regions locked, at most ten'),
  unlocked: z.array(blockLockSummary).describe('Regions unlocked, at most ten'),
});

const aiSettingsChange = z.object({
  from: z.number().int().describe('The version it replaced'),
  to: z.number().int().describe('The version it wrote'),
  changed: parts.describe(
    '`<capability>.enabled`, `.tier` or `.guidance`; never the guidance text',
  ),
});

const auditDetail = z.object({
  entries: z.array(entryChange).describe('The entries the action saved'),
  blockConfig: blockConfigChange
    .optional()
    .describe('What a block config set changed: parts named, at most ten per list'),
  blockLocks: blockLockChange
    .optional()
    .describe('What a set of an entry’s locked regions locked and unlocked'),
  aiSettings: aiSettingsChange
    .optional()
    .describe('What a set of the space’s AI settings changed: parts named, never guidance'),
  truncated: z
    .literal(true)
    .optional()
    .describe('Some of what changed is not listed: the row reached its size or entry cap'),
});

export const auditEntry = z.object({
  id: z.string(),
  spaceId: z.string(),
  environmentId: z.string().optional().describe('The environment acted in, when it was scoped'),
  actor: z.string().describe('A person’s id, admin-token, or the kind of key'),
  action: z.string().describe('`<METHOD> <route>` for REST, `MCP <tool>` for a tool call'),
  targetType: z
    .string()
    .optional()
    .describe('The kind of thing acted on (entry, release, content_type, …)'),
  targetId: z.string().optional(),
  status: z.number().int().describe('The action’s result status'),
  at: z.iso.datetime(),
  detail: auditDetail
    .optional()
    .describe('What the action changed: paths and never values. Older rows have none'),
});

export const auditLogPage = z.object({
  items: z.array(auditEntry),
  nextCursor: z
    .string()
    .optional()
    .describe('Pass back as cursor for the next page; absent on the last one'),
});

/** An entry's activity: the audit log's page, its rows the ones about that entry. */
export const entryActivityPage = auditLogPage;
