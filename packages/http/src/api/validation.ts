import { AGENT_WORKFLOWS, BULK_JOB_MAX_ITEMS, MAX_ASSET_MOVE } from '@contentworker/application';
import { SPACE_ID_PATTERN, ValidationError } from '@contentworker/domain';
import { STARTERS } from '@contentworker/seed';
import type { Context } from 'hono';
import { z } from 'zod';

/**
 * Parses a request JSON body against a zod schema, throwing a domain
 * ValidationError (→ 422) on mismatch so every route reports invalid input
 * uniformly instead of leaking a 500. Unknown keys are stripped by zod's default
 * object behaviour, which structurally prevents mass-assignment (a body field
 * can never override a value the handler sets itself).
 */
export async function parseBody<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  // Missing/invalid JSON coerces to {} so optional-body routes validate cleanly;
  // required fields then surface as normal validation issues.
  const raw = await c.req.json().catch(() => ({}));
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new ValidationError(
      result.error.issues.map((i) => ({
        field: i.path.length ? i.path.join('.') : '(body)',
        message: i.message,
      })),
    );
  }
  return result.data;
}

// ---- reusable primitives --------------------------------------------------

/** A stable identifier (apiId / id): non-empty, bounded. */
export const zId = z.string().min(1).max(128);
/** A short human string (names, labels). */
export const zShort = z.string().max(256);
/** A locale code. */
export const zLocale = z.string().min(2).max(35);

/**
 * A localized value map (`locale -> value`). Values are opaque here — the domain
 * validators enforce per-field-type semantics; this only bounds the shape.
 */
export const zLocalized = z.record(zLocale, z.unknown());
/** Entry field values: `apiId -> localized value`. */
export const zFieldValues = z.record(zId, zLocalized);
/** A bounded list of ids (bulk operations). */
export const zIdList = z.array(zId).max(1000);
/** A model tier. */
export const zTier = z.enum(['flagship', 'balanced', 'fast']);
/** Free-form prompt/prose text, bounded to keep prompts sane. */
export const zText = z.string().max(100_000);

// ---- request schemas (one per mutating route) -----------------------------
// Deeply nested content (field values, content-type field arrays, workflow
// steps) is bounded here but validated for semantics by the domain layer, so
// these schemas stay at the "shape + bounds + strip unknown keys" altitude.

export const createSpaceBody = z.object({
  spaceId: z
    .string()
    .regex(SPACE_ID_PATTERN, 'letters, digits, ".", "_" or "-", starting with a letter or digit')
    .describe('1–64 letters, digits, ".", "_" or "-", starting with a letter or digit'),
  name: zShort,
  defaultLocale: zLocale,
  locales: z.array(zLocale).max(200).optional(),
  fallbacks: z.record(zLocale, zLocale.nullable()).optional(),
  environments: z.array(zId).max(100).optional(),
  starter: z
    .enum(STARTERS)
    .optional()
    .describe(
      '`sample` installs sample content into the first environment: a content model covering ' +
        'every field type, a few dozen entries, taxonomy, sample images and documents, and one ' +
        'open release. `empty` (the default) creates the space with nothing in it.',
    ),
});
export const createEnvironmentBody = z.object({ id: zId, name: zShort.optional() });
export const setAliasBody = z.object({ targetEnvironmentId: zId });
export const mergeBody = z.object({
  source: zId,
  target: zId,
  contentTypes: z.array(zId).max(1000).optional(),
  entries: zIdList.optional(),
});
export const promotionBody = z.object({
  source: zId,
  target: zId,
  contentTypes: z.array(zId).max(1000).optional(),
  entries: zIdList.optional(),
});
export const createApiKeyBody = z.object({
  kind: z.enum(['cma', 'cda', 'cpa']),
  name: zShort.optional(),
  scopes: z.array(z.string().max(64)).max(64).optional(),
  roleId: zId.optional(),
});
export const revokeConnectionBody = z.object({
  clientId: zId,
  // An identity string from the IdP, not an id — email-shaped, so sized generously.
  subject: z.string().min(1).max(320),
});
// The snapshot's inner shape is validated by the domain on replay; this only
// guards the envelope so a malformed body fails before any writing starts.
export const snapshotBody = z.object({
  snapshotVersion: z.number().int(),
  exportedAt: z.string().optional(),
  source: z.object({ spaceId: z.string(), environmentId: z.string() }).optional(),
  contentTypes: z.array(z.any()).max(1000),
  entries: z.array(z.any()).max(100_000),
  assets: z.array(z.any()).max(100_000).optional(),
  assetFolders: z.array(z.any()).max(10_000).optional(),
  taxonomy: z
    .object({
      schemes: z.array(z.any()).max(1000),
      concepts: z.array(z.any()).max(10_000),
      tags: z.array(z.any()).max(10_000),
    })
    .optional(),
  workflows: z.array(z.any()).max(1000).optional(),
});
export const cloneBody = z.object({
  targetSpaceId: zId.optional(),
  targetEnvironmentId: zId,
  publish: z.boolean().optional(),
});
// The manifest's inner shape is validated by the domain, which rejects rather
// than repairs — this only guards the envelope and bounds the bundle size.
export const installPluginBody = z.object({
  manifest: z.object({}).loose(),
  bundle: z.string().min(1).max(2_000_000),
  approvedCapabilities: z.array(z.string().max(64)).max(32),
});
export const pluginEnabledBody = z.object({ enabled: z.boolean() });
export const pluginCapabilitiesBody = z.object({
  approvedCapabilities: z.array(z.string().max(64)).max(32),
});
const zSha256 = z.string().regex(/^[a-fA-F0-9]{64}$/, 'must be a hex SHA-256');
export const installPluginFromUrlBody = z.object({
  packageUrl: z.string().url().max(2048),
  expectedChecksum: zSha256.optional(),
  expectedId: z.string().max(128).optional(),
  expectedVersion: z.string().max(64).optional(),
  approvedCapabilities: z.array(z.string().max(64)).max(32),
  minimumReleaseAgeHours: z.number().int().min(0).max(8760).optional(),
});
export const upgradePluginFromUrlBody = installPluginFromUrlBody.partial({
  approvedCapabilities: true,
});
export const inspectPluginBody = installPluginFromUrlBody.omit({ approvedCapabilities: true });
export const importBody = z.object({
  source: z.string().min(1).max(64),
  // Bounded by the app's own body limit long before this; the cap is here so a
  // non-HTTP caller gets the same answer.
  payload: z.string().min(1).max(20_000_000),
  mapping: z.object({
    contentTypeApiId: zId,
    fields: z.record(zId, z.string().max(256)),
    identityField: zId.optional(),
    locale: zLocale.optional(),
  }),
  sourceOptions: z.record(z.string().max(64), z.unknown()).optional(),
  conflicts: z.enum(['skip', 'update', 'fail']).optional(),
});
export const createPatBody = z.object({
  name: zShort,
  scopes: z.array(z.string().max(64)).min(1).max(64),
  // Capped at a year: a token with no expiry at all is opt-in by omission, but
  // an absurd finite lifetime is more likely a typo than an intention.
  expiresInDays: z.number().int().min(1).max(365).optional(),
});
const contentGrant = z.object({
  contentTypeApiId: z.string().max(128),
  actions: z.array(z.enum(['read', 'write', 'publish'])).max(3),
  deniedFields: z.array(zId).max(500).optional(),
  readOnlyFields: z.array(zId).max(500).optional(),
});
export const roleBody = z.object({
  name: zShort,
  description: zShort.optional(),
  scopes: z.array(z.string().max(64)).max(64),
  contentGrants: z.array(contentGrant).max(500).optional(),
});
const fieldDef = z.object({}).loose(); // deep field shape validated by the domain
export const contentTypeBody = z.object({
  apiId: zId,
  name: zShort,
  displayField: zId,
  description: zShort.optional(),
  fields: z.array(fieldDef).max(500),
});
export const createEntryBody = z.object({
  contentTypeApiId: zId,
  fields: zFieldValues.optional(),
});
export const draftEntryBody = z.object({
  contentTypeApiId: zId,
  prompt: zText,
  tier: zTier.optional(),
});
export const canvasBody = z.object({
  contentTypeApiId: zId,
  prose: zText,
  tier: zTier.optional(),
});
export const previewLinkBody = z.object({
  ttlHours: z.number().positive().max(8760).optional(),
  previewBaseUrl: z.string().url().max(2048).optional(),
});
export const updateEntryBody = z.object({ fields: zFieldValues });
export const translateBody = z.object({
  targetLocale: zLocale,
  sourceLocale: zLocale.optional(),
  apply: z.boolean().optional(),
  tier: zTier.optional(),
});
export const summarizeBody = z.object({
  locale: zLocale.optional(),
  maxWords: z.number().int().positive().max(10_000).optional(),
  targetField: zId.optional(),
  apply: z.boolean().optional(),
  tier: zTier.optional(),
});
export const autofillBody = z.object({
  field: zId,
  locale: zLocale.optional(),
  instructions: zText.optional(),
  apply: z.boolean().optional(),
  tier: zTier.optional(),
});
export const tierOnlyBody = z.object({ apply: z.boolean().optional(), tier: zTier.optional() });
export const applyTagsBody = z.object({
  tagIds: z.array(zId).max(1000).optional(),
  newTags: z.array(zShort).max(100).optional(),
});
export const createFunctionBody = z.object({
  name: zShort,
  eventPattern: z.string().max(256),
  url: z.string().max(2048),
  active: z.boolean().optional(),
});
export const appExtensionBody = z.object({
  name: zShort,
  target: z.enum(['field-editor', 'sidebar']),
  entryUrl: z.string().max(2048),
  fieldTypes: z.array(z.string().max(64)).max(64).optional(),
  active: z.boolean().optional(),
});
export const bulkEntriesBody = z.object({ items: z.array(createEntryBody).max(1000).optional() });
export const idsBody = z.object({ ids: zIdList.optional() });
// Durable bulk jobs accept far larger id sets than the synchronous bulk
// routes (the practical ceiling is the request body limit, then chunked
// server-side); the shared application cap keeps both surfaces in lockstep.
export const bulkJobBody = z.object({
  action: z.enum(['publish', 'unpublish']),
  entryIds: z.array(zId).min(1).max(BULK_JOB_MAX_ITEMS),
});
export const auditBody = z.object({
  createTasks: z.boolean().optional(),
  taskSeverity: z.enum(['error', 'warning', 'info']).optional(),
  assignee: zShort.optional(),
  tier: zTier.optional(),
});
export const reindexBody = z.object({ contentTypeApiId: zId.optional() });
export const createAssetBody = z.object({
  fileName: z.string().min(1).max(1024),
  contentType: z.string().min(1).max(256),
  title: zLocalized.optional(),
  description: zLocalized.optional(),
  folderId: zId.optional().describe('File it in this folder (absent: the library root)'),
});
export const moveAssetsBody = z.object({
  ids: z.array(zId).min(1).max(MAX_ASSET_MOVE),
  folderId: zId.nullable().describe('The folder to file them in; null takes them to the root'),
});
export const assetFolderBody = z.object({
  name: z.string().min(1).max(128),
  parentId: zId.nullable().optional().describe('The folder to create it in (absent: the root)'),
});
export const assetFolderPatchBody = z.object({
  name: z.string().min(1).max(128).optional(),
  parentId: zId.nullable().optional().describe('Move it here; null moves it to the root'),
});
const renditionSpec = {
  width: z.int().min(1).max(4096).optional(),
  height: z.int().min(1).max(4096).optional(),
  fit: z.enum(['clip', 'crop', 'fill', 'max', 'scale']).optional(),
  format: z.enum(['auto', 'jpg', 'png', 'webp', 'avif']).optional(),
  quality: z.int().min(1).max(100).optional(),
};
export const assetRenditionBody = z.object({
  name: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,39}$/)
    .describe('Lowercase letters, digits and dashes; its URL segment is r-<name>'),
  ...renditionSpec,
});
export const assetRenditionPatchBody = z.object(renditionSpec);
export const createVideoAssetBody = z.object({
  fileName: z.string().min(1).max(1024),
  contentType: z.string().min(1).max(256),
  title: zLocalized.optional(),
  description: zLocalized.optional(),
  maxDurationSeconds: z.int().positive().optional(),
});
export const assetMetadataBody = z.object({}).loose(); // partial patch; domain applies known keys
export const altTextBody = z.object({
  locale: zLocale.optional(),
  context: zText.optional(),
  apply: z.boolean().optional(),
  tier: zTier.optional(),
});
export const createAiActionBody = z.object({
  name: zShort,
  description: zShort.optional(),
  promptTemplate: zText,
  targetField: zId.optional(),
  tier: zTier.optional(),
});
export const runAiActionBody = z.object({
  variables: z.record(z.string().max(128), z.string().max(10_000)).optional(),
  entryId: zId.optional(),
  locale: zLocale.optional(),
  apply: z.boolean().optional(),
});
export const webhookBody = z.object({
  url: z.string().max(2048),
  topics: z.array(z.string().max(64)).max(64),
  secret: z.string().min(1).max(512),
  active: z.boolean().optional(),
  headers: z.record(z.string().max(128), z.string().max(2048)).optional(),
  allEnvironments: z
    .boolean()
    .optional()
    .describe(
      "true: receive every environment's events. Otherwise only the events of the environment " +
        'in the path; under an alias the hook is space-wide and false is refused. On update, ' +
        "false scopes the hook to the path's environment and omitting it keeps the current scope.",
    ),
});
export const updateWebhookBody = webhookBody.partial();
export const createReleaseBody = z.object({ title: zShort, description: zShort.optional() });
export const releaseItemBody = z.object({
  entityId: zId,
  action: z.enum(['publish', 'unpublish']).optional(),
});
export const scheduleBody = z.object({
  action: z.enum(['publish', 'unpublish']),
  entityType: z.enum(['entry', 'release']),
  entityId: zId,
  scheduledFor: z.string().min(1).max(64),
});
export const agentScheduleBody = z.object({
  workflow: z.enum(AGENT_WORKFLOWS),
  // 5-field cron, UTC; the domain validates the expression itself.
  cron: z.string().min(9).max(100),
  contentTypeApiId: zId.optional(),
  enabled: z.boolean().optional(),
  autoApply: z.boolean().optional(),
});
export const agentSchedulePatchBody = z.object({
  cron: z.string().min(9).max(100).optional(),
  enabled: z.boolean().optional(),
  autoApply: z.boolean().optional(),
  // null clears the content-type restriction.
  contentTypeApiId: zId.nullable().optional(),
});
export const commentBody = z.object({
  body: z.string().min(1).max(20_000),
  author: zShort.optional(),
  parentId: zId.optional(),
});
export const createTaskBody = z.object({
  body: z.string().min(1).max(20_000),
  assignee: zShort.optional(),
});
export const updateTaskBody = z.object({
  status: z.enum(['open', 'resolved']).optional(),
  assignee: zShort.nullable().optional(),
});
const workflowStep = z.object({
  id: zId,
  name: zShort,
  requiredScope: z.string().max(64),
});
export const workflowBody = z.object({ name: zShort, steps: z.array(workflowStep).max(100) });
// Graph workflows. The graph itself is shape-checked by the use-case (parseWorkflowGraph plus
// node/edge bounds), so it stays opaque here; the body limit bounds its size.
const workflowDraftFields = {
  description: z.string().max(2000).optional(),
  contentTypes: z.array(zId).max(100).optional(),
  graph: z.unknown().optional(),
  gatesPublish: z.boolean().optional(),
};
export const workflowDraftBody = z.object({ name: zShort.optional(), ...workflowDraftFields });
/** `POST /workflows`: legacy `{name, steps}` (published as v1) or a graph draft. */
export const createWorkflowBody = z.union([
  workflowBody,
  z.object({ name: zShort, ...workflowDraftFields }),
]);
export const validateWorkflowBody = z.object({ graph: z.unknown() });
export const workflowCopilotBody = z.object({
  prompt: z.string().min(1).max(4000),
  graph: z.unknown().optional(),
  contentTypes: z.array(zId).max(20).optional(),
});
const zJsonObject = z.record(z.string().max(128), z.unknown());
export const startWorkflowRunBody = z.object({
  workflowId: zId,
  version: z.number().int().positive().optional(),
  input: zJsonObject.optional(),
  vars: zJsonObject.optional(),
});
export const cancelWorkflowRunBody = z.object({ reason: z.string().max(500).optional() });
export const workflowEventBody = z.object({
  event: z.string().min(1).max(100),
  payload: zJsonObject.optional(),
});
export const decideWorkflowTaskBody = z.object({
  decision: z.enum(['approved', 'rejected']),
  note: z.string().max(2000).optional(),
});
export const workflowSettingsBody = z.object({ separateDuties: z.boolean() });
export const transitionBody = z.object({ workflowId: zId, toStepId: zId });
export const schemeBody = z.object({ name: zShort });
export const conceptBody = z.object({
  schemeId: zId,
  prefLabel: zShort,
  broaderId: zId.nullable().optional(),
});
export const broaderBody = z.object({ broaderId: zId.nullable().optional() });
export const tagBody = z.object({ name: zShort });
export const entryMetadataBody = z.object({
  tags: z.array(zId).max(1000).optional(),
  concepts: z.array(zId).max(1000).optional(),
});
