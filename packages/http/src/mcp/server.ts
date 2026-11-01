import {
  AGENT_WORKFLOWS,
  addComment,
  addEntryToRelease,
  analyzeImport,
  applyEntryTags,
  approvePluginCapabilities,
  approvePromotion,
  archiveAsset,
  assignRolePreset,
  auditEntry,
  autofillField,
  autoTagAsset,
  BULK_JOB_MAX_ITEMS,
  bulkEntryAction,
  cancelBulkJob,
  cancelWorkflowRun,
  canvasToEntry,
  compareEnvironments,
  countEntriesByContentType,
  createAgentSchedule,
  createAIAction,
  createAppExtension,
  createAssetFolder,
  createAssetRendition,
  createConcept,
  createContentType,
  createEntry,
  createFunction,
  createRelease,
  createRole,
  createScheme,
  createTag,
  createTask,
  createVideoAsset,
  createWebhook,
  createWorkflowDraft,
  decideAgentReview,
  decideWorkflowTask,
  deleteAgentSchedule,
  deleteAppExtension,
  deleteAsset,
  deleteAssetFolder,
  deleteAssetRendition,
  deleteEnvironment,
  deleteEnvironmentAlias,
  deleteFunction,
  deleteRole,
  deleteWebhook,
  deliverWorkflowEvent,
  diffVersions,
  draftEntry,
  draftWorkflowGraph,
  duplicateEntry,
  type EnvironmentSnapshot,
  executeImport,
  exportSnapshot,
  findDuplicates,
  generateAltText,
  getAgentReview,
  getAssetUsage,
  getBulkJob,
  getBulkJobReport,
  getContentType,
  getPreviewAsset,
  getPreviewEntry,
  getPromotion,
  getRelease,
  getVersion,
  getWorkflowRun,
  getWorkflowRunTimeline,
  getWorkflowSettings,
  getWorkflowVersion,
  hybridSearch,
  importSnapshot,
  listAgentReviews,
  listAgentSchedules,
  listAIActions,
  listAppExtensions,
  listAssetFolders,
  listAssetRenditions,
  listAssets,
  listAuditLog,
  listBulkJobs,
  listComments,
  listConcepts,
  listConnectedApps,
  listContentTypes,
  listEnvironmentAliases,
  listFunctions,
  listPlugins,
  listPreviewAssets,
  listPreviewEntries,
  listPromotions,
  listReleases,
  listRolePresets,
  listRoles,
  listSpacesFor,
  listTags,
  listTasks,
  listTeam,
  listVersions,
  listWebhookDeliveries,
  listWebhooks,
  listWorkflowNodeRuns,
  listWorkflowRuns,
  listWorkflows,
  listWorkflowTasks,
  listWorkflowVersions,
  MAX_ASSET_MOVE,
  mergeEnvironments,
  moderateEntry,
  moveAssets,
  publishContentType,
  publishEntry,
  publishRelease,
  publishWorkflowVersion,
  purgeEntry,
  refreshVideoAsset,
  rejectPromotion,
  relatedEntries,
  requestPromotion,
  requestReindex,
  resolveEnvironment,
  resolveTask,
  resolveWritableEnvironment,
  restoreAsset,
  restoreEntry,
  restoreVersion,
  revokeConnectedApp,
  runAIAction,
  saveWorkflowDraft,
  scheduleAction,
  searchIndexHealth,
  semanticSearch,
  setAssetMetadata,
  setEntryMetadata,
  setEnvironmentAlias,
  setPluginEnabled,
  setWorkflowSeparationDefault,
  startBulkJob,
  startEnvironmentClone,
  startSnapshotImport,
  startWorkflowRun,
  suggestEntries,
  suggestEntryTags,
  summarizeEntry,
  transformAssetUrl,
  transitionEntry,
  translateEntry,
  trashEntry,
  unpublishEntry,
  updateAgentSchedule,
  updateAssetFolder,
  updateAssetRendition,
  updateEntry,
  updateRole,
  updateWebhook,
  validateWorkflowGraph,
  visibleSearchHits,
  withReadUrl,
  workflowRunView,
} from '@contentworker/application';
import { listDocs, readDoc, searchDocs } from '@contentworker/docs';
import {
  ASSET_KINDS,
  type Asset,
  AssetInUseError,
  assertQueryRespectsFieldRules,
  assertWritableFields,
  authorize,
  authorizeContent,
  type ContentAction,
  canAccessContentType,
  describeDiff,
  type EntryFields,
  FIELD_TYPES,
  ForbiddenError,
  inScope,
  MAX_PROMOTION_CONTENT_TYPES,
  MAX_PROMOTION_ENTRIES,
  maskDeniedFields,
  NotConfiguredError,
  NotFoundError,
  type PermissionScope,
  PROMOTION_STATUSES,
  type Principal,
  principalActorId,
  type RenditionFit,
  type RenditionFormat,
  ROLE_PRESETS,
  SCOPES,
  type Scope,
  SPACE_ID_PATTERN,
  ValidationError,
  type Webhook,
  WORKFLOW_RUN_STATUSES,
  type WorkflowRunStatus,
} from '@contentworker/domain';
import { redactCredentials } from '@contentworker/redaction';
import { generateTypes } from '@contentworker/sdk-codegen';
import { createSpaceWithStarter, STARTERS } from '@contentworker/seed';
import { McpServer } from '@modelcontextprotocol/server';
import type { SkillsExtension } from '@modelcontextprotocol/server/ext/skills';
import { z } from 'zod';
import { toHttpError } from '../api/http';
import { MAX_PAGE_LIMIT } from '../api/query';
import { snapshotBody, updateWebhookBody, webhookBody } from '../api/validation';
import type { McpDeps } from './deps';

/**
 * What a tool call that failed inside the server says, in place of the failure, as REST does: a
 * domain error (not found, forbidden, invalid, a conflict, not configured) keeps its own words,
 * which REST shows too; anything else (a database's, a binding's error) is REST's
 * "Internal server error", and its words never reach the caller.
 */
export const INTERNAL_TOOL_ERROR = 'Internal server error';

/** A tool handler's failure as the caller may see it; internal ones are logged here instead. */
function toolFailure(tool: string, err: unknown): unknown {
  if ((toHttpError(err).body as { error?: { code?: string } }).error?.code !== 'internal')
    return err;
  console.error(JSON.stringify({ msg: 'mcp: tool failed', tool, error: redactCredentials(err) }));
  return new Error(INTERNAL_TOOL_ERROR);
}

const DEFAULT_SPACE = process.env.SEED_SPACE_ID ?? 'space-1';
const DEFAULT_ENV = process.env.SEED_ENV_ID ?? 'main';

const scopeArgs = {
  space: z.string().optional().describe('Space id (defaults to the server default).'),
  environment: z.string().optional().describe('Environment id (defaults to "main").'),
};
const scopeOf = (a: { space?: string; environment?: string }): Scope => ({
  spaceId: a.space ?? DEFAULT_SPACE,
  environmentId: a.environment ?? DEFAULT_ENV,
});

const ok = (data: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
});

const fieldSchema = z.object({
  apiId: z.string(),
  name: z.string(),
  type: z.enum(FIELD_TYPES as unknown as [string, ...string[]]),
  localized: z.boolean().default(false),
  required: z.boolean().default(false),
  position: z.number().int(),
  // Listed explicitly: this schema strips unknown keys, so an omitted
  // attribute would be silently dropped rather than rejected.
  unique: z.boolean().optional().describe('no two entries may share a value (per locale)'),
  defaultValue: z.any().optional().describe('applied on create when the field is omitted'),
  validations: z.record(z.string(), z.any()).optional(),
  linkType: z.enum(['Entry', 'Asset']).optional(),
  items: z.record(z.string(), z.any()).optional(),
});
const entryFields = z
  .record(z.string(), z.record(z.string(), z.any()))
  .describe('fieldApiId -> { locale: value }');

const grantShape = z.object({
  contentTypeApiId: z.string().describe("content type apiId, or '*' for all"),
  actions: z.array(z.enum(['read', 'write', 'publish'])),
  deniedFields: z.array(z.string()).optional(),
  readOnlyFields: z.array(z.string()).optional(),
});

const importMapping = {
  contentTypeApiId: z.string(),
  fields: z.record(z.string(), z.string()).describe('target field apiId -> source field name'),
  identityField: z
    .string()
    .optional()
    .describe('target field holding the source id; without it a re-run duplicates everything'),
  locale: z.string().optional(),
  conflicts: z.enum(['skip', 'update', 'fail']).optional().describe('default skip'),
  sourceOptions: z
    .record(z.string().max(64), z.unknown())
    .optional()
    .describe('per-source options, e.g. { postType: "page" } for wxr'),
};
const importArgs = { source: z.string(), payload: z.string(), ...importMapping, ...scopeArgs };

/**
 * Tool input schemas, built once per process and reused by every request.
 * buildServer runs per request (the transport is stateless), and constructing
 * ~100 Zod schemas — then converting each to JSON Schema on every tools/list —
 * was nearly all of its cost; registering prebuilt schemas is ~50x cheaper.
 * A schema must therefore never depend on the principal or deps.
 */
const schemaCache = new Map<string, z.ZodType>();
function toolSchema<T extends z.ZodType>(tool: string, build: () => T): T {
  let schema = schemaCache.get(tool) as T | undefined;
  if (!schema) {
    schema = memoizeJsonSchema(build());
    schemaCache.set(tool, schema);
  }
  return schema;
}

/**
 * Memoizes a schema's Standard JSON Schema conversion, which the SDK otherwise
 * repeats on every tools/list. Results are deep-frozen because every request
 * now shares them.
 */
function memoizeJsonSchema<T extends z.ZodType>(schema: T): T {
  const std = schema['~standard'];
  const convert = std.jsonSchema;
  if (!convert) return schema;
  const memo = new Map<string, Record<string, unknown>>();
  const cached =
    (io: 'input' | 'output') =>
    (options: Parameters<typeof convert.input>[0]): Record<string, unknown> => {
      const key = `${io}:${options.target}`;
      let json = memo.get(key);
      if (!json) {
        json = deepFreeze(convert[io](options));
        memo.set(key, json);
      }
      return json;
    };
  Object.defineProperty(schema, '~standard', {
    value: { ...std, jsonSchema: { input: cached('input'), output: cached('output') } },
    configurable: true,
  });
  return schema;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * 2026-07-28 clients cache list results for `ttlMs`, saving a round trip per
 * call. The tool set only changes on deploy, so a few minutes of staleness is
 * the whole cost. `private`: every request is authenticated.
 */
const CACHE_HINTS = {
  'tools/list': { ttlMs: 5 * 60_000, cacheScope: 'private' },
  'server/discover': { ttlMs: 5 * 60_000, cacheScope: 'private' },
} as const;

/**
 * Builds the MCP server for a resolved principal. Each tool authorizes the
 * caller's scopes against the target space before delegating to a core
 * use-case — so MCP enforces the SAME RBAC as the HTTP API.
 *
 * `skills` is the process-wide catalog from `loadSkillCatalog()`. Like the docs
 * tools, skills describe the product rather than any space's content, so
 * being authenticated is the only gate.
 */
export function buildServer(
  deps: McpDeps,
  principal: Principal,
  skills?: SkillsExtension,
): McpServer {
  const { ctx, ai, rag, agents } = deps;
  const server = new McpServer(
    { name: 'contentworker', version: '0.1.0' },
    { cacheHints: CACHE_HINTS },
  );
  // Every tool's failures pass through `toolFailure`, so no handler can leak an internal error.
  // And every tool's `environment` argument resolves the way an HTTP `:env` does: an alias names
  // its target, and a name that is neither an alias nor an environment is refused
  // (`NotFoundError`), so a typo'd or deleted environment never collects rows. Two tools take the
  // name as given: deleting refuses an alias name itself, and a deleted environment's audit
  // history stays readable.
  const LITERAL_ENVIRONMENT = new Set(['environment_delete', 'audit_log_list']);
  // The `environment` each call named, before resolution, keyed by the resolved args object: a tool
  // that must not pin anything to an alias's current target (the webhook tools) reads it back.
  const requestedEnvironment = new WeakMap<object, string>();
  const register = server.registerTool.bind(server);
  server.registerTool = ((name: string, config: unknown, handler: (...a: unknown[]) => unknown) =>
    register(
      name,
      config as never,
      (async (args: unknown, ...rest: unknown[]) => {
        try {
          const a = args as { space?: unknown; environment?: unknown } | undefined;
          if (!LITERAL_ENVIRONMENT.has(name) && a && typeof a.environment === 'string') {
            const spaceId = typeof a.space === 'string' ? a.space : DEFAULT_SPACE;
            // Checked only for a caller who may act in the space, so nobody else learns which
            // environments exist there: the tool's own guard refuses them first.
            const environment = inScope(principal, spaceId)
              ? await resolveWritableEnvironment(ctx, spaceId, a.environment)
              : await resolveEnvironment(ctx, spaceId, a.environment, { refusePurging: false });
            args = { ...a, environment };
            requestedEnvironment.set(args as object, a.environment);
          }
          return await handler(args, ...rest);
        } catch (err) {
          throw toolFailure(name, err);
        }
      }) as never,
    )) as typeof server.registerTool;
  const guard = (scope: PermissionScope, s: Scope) => authorize(principal, scope, s.spaceId);
  // Granular RBAC: content-level check for role-bound principals (unrestricted
  // principals short-circuit inside the domain helpers). Same enforcement as
  // the HTTP API, resolving the entry's content type when needed.
  const guardEntry = async (s: Scope, id: string, action: ContentAction) => {
    if (!principal.contentGrants) return;
    const entry = await getPreviewEntry(ctx, s, id);
    authorizeContent(principal, action, entry.contentType);
  };
  // Authorizes read on an entry and returns its content type, so version/history
  // tools can mask denied fields — mirrors the HTTP API's authorizeEntryRead.
  const authorizeEntryRead = async (s: Scope, id: string): Promise<string> => {
    const entry = await getPreviewEntry(ctx, s, id);
    authorizeContent(principal, 'read', entry.contentType);
    return entry.contentType;
  };

  // --- documentation ------------------------------------------------------
  // No scope guard and no space: these serve the product's own published
  // documentation, which is identical for every space and discloses nothing
  // about anyone's content. Being authenticated at all is the gate.
  server.registerTool(
    'docs_list',
    {
      description:
        "List contentworker's documentation pages with their headings and sizes. Start here to " +
        'find which page covers a topic, then docs_read that page or one section of it. ' +
        'Use these tools before guessing at conventions: scopes, ids, locales and the ' +
        'publish model all have specific rules that the docs state exactly.',
      inputSchema: toolSchema('docs_list', () => z.object({})),
    },
    async () => ok(listDocs()),
  );

  server.registerTool(
    'docs_read',
    {
      description:
        'Read one documentation page, or one section of it. `section` takes a heading slug from ' +
        'docs_list and returns that heading down to the next one of the same level — prefer it ' +
        'for the larger pages rather than reading tens of KB into context.',
      inputSchema: toolSchema('docs_read', () =>
        z.object({ path: z.string(), section: z.string().optional() }),
      ),
    },
    async (args) => {
      const body = readDoc(args.path, { section: args.section });
      if (body === undefined) {
        throw new NotFoundError('Documentation page', args.section ?? args.path);
      }
      return ok({ path: args.path, section: args.section, body });
    },
  );

  server.registerTool(
    'docs_search',
    {
      description:
        'Full-text search across the documentation. Every term must appear on the same line. ' +
        'Returns the page, the nearest heading above the match, and the matching line, so a ' +
        'hit can be followed with docs_read on just that section.',
      inputSchema: toolSchema('docs_search', () =>
        z.object({
          query: z.string(),
          path: z.string().optional(),
          limit: z.number().int().positive().optional(),
        }),
      ),
    },
    async (args) => ok(searchDocs(args.query, { path: args.path, limit: args.limit })),
  );

  // --- read / query / search ---------------------------------------------
  server.registerTool(
    'model_list_content_types',
    {
      description: 'List the content types defined in a space/environment.',
      inputSchema: toolSchema('model_list_content_types', () => z.object(scopeArgs)),
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      return ok(await listContentTypes(ctx, scopeOf(args)));
    },
  );

  server.registerTool(
    'model_get_content_type',
    {
      description: 'Get a single content type definition by its apiId.',
      inputSchema: toolSchema('model_get_content_type', () =>
        z.object({ apiId: z.string(), ...scopeArgs }),
      ),
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      return ok(await getContentType(ctx, scopeOf(args), args.apiId));
    },
  );

  server.registerTool(
    'model_entry_counts',
    {
      description:
        'How many entries each content type holds, by status (draft, changed, published, and ' +
        'archived for the trash); `total` is the live entries. One grouped count, so use it ' +
        'instead of paging entries_query to size a type.',
      inputSchema: toolSchema('model_entry_counts', () => z.object(scopeArgs)),
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      const counts = await countEntriesByContentType(ctx, scopeOf(args));
      return ok(counts.filter((n) => canAccessContentType(principal, 'read', n.contentType)));
    },
  );

  server.registerTool(
    'model_typescript',
    {
      description:
        'The content model as a TypeScript module: one type per content type, in both the ' +
        'delivery (locale-flattened) and management (locale-keyed) shapes, plus lookup maps. ' +
        'Generated from the live model, so an agent writing code against this space can type ' +
        'it correctly without installing anything or guessing field names.',
      inputSchema: toolSchema('model_typescript', () => z.object(scopeArgs)),
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      const types = await listContentTypes(ctx, scopeOf(args));
      const scope = scopeOf(args);
      // Text, not JSON: the value is source a caller pastes into a file, and
      // wrapping it in a JSON string only makes it something to unescape.
      return {
        content: [
          {
            type: 'text' as const,
            text: generateTypes(types as unknown as Parameters<typeof generateTypes>[0], {
              banner: `Generated from ${scope.spaceId}/${scope.environmentId}. Do not edit by hand.`,
            }),
          },
        ],
      };
    },
  );

  server.registerTool(
    'entries_suggest',
    {
      description:
        'Find entries by what you would type to look for one: matches each content type on its ' +
        'display field and returns id, title, type and status. Use this to resolve a name to an ' +
        'id — listing entries and filtering the result misses everything past the first page.',
      inputSchema: toolSchema('entries_suggest', () =>
        z.object({
          q: z
            .string()
            .optional()
            .describe('what has been typed so far; empty returns recent entries'),
          contentTypeApiId: z.string().optional(),
          locale: z.string().optional(),
          limit: z.number().int().positive().optional(),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      return ok(
        await suggestEntries(ctx, scopeOf(args), {
          ...(args.q ? { q: args.q } : {}),
          ...(args.contentTypeApiId ? { contentTypeApiId: args.contentTypeApiId } : {}),
          ...(args.locale ? { locale: args.locale } : {}),
          ...(args.limit ? { limit: args.limit } : {}),
        }),
      );
    },
  );

  server.registerTool(
    'entries_query',
    {
      description:
        'List entries (current/draft versions) with optional field-level filters, ' +
        'ordering, projection, and full-text search.',
      inputSchema: toolSchema('entries_query', () =>
        z.object({
          contentType: z.string().optional(),
          limit: z.number().int().positive().optional(),
          skip: z.number().int().nonnegative().optional(),
          locale: z.string().optional(),
          filters: z
            .array(
              z.object({
                field: z.string().describe('field apiId or a sys.* pseudo-field'),
                op: z.enum(['eq', 'ne', 'in', 'nin', 'gt', 'gte', 'lt', 'lte', 'exists', 'match']),
                value: z.any().optional(),
              }),
            )
            .optional(),
          order: z
            .array(z.object({ field: z.string(), direction: z.enum(['asc', 'desc']) }))
            .optional(),
          select: z.array(z.string()).optional().describe('field apiIds to return'),
          search: z.string().optional(),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      assertQueryRespectsFieldRules(principal, {
        contentTypeApiId: args.contentType,
        filters: args.filters,
        order: args.order,
        select: args.select,
        search: args.search,
      });
      const items = await listPreviewEntries(ctx, scopeOf(args), {
        contentTypeApiId: args.contentType,
        limit: args.limit,
        skip: args.skip,
        locale: args.locale,
        filters: args.filters,
        order: args.order,
        select: args.select,
        search: args.search,
      });
      // Granular RBAC: drop entries of ungranted types, mask denied fields.
      return ok(
        items
          .filter((e) => canAccessContentType(principal, 'read', e.contentType))
          .map((e) => ({ ...e, fields: maskDeniedFields(principal, e.contentType, e.fields) })),
      );
    },
  );

  server.registerTool(
    'entries_get',
    {
      description: 'Get a single entry (current/draft version) by id.',
      inputSchema: toolSchema('entries_get', () => z.object({ id: z.string(), ...scopeArgs })),
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      const entry = await getPreviewEntry(ctx, scopeOf(args), args.id);
      authorizeContent(principal, 'read', entry.contentType);
      return ok({
        ...entry,
        fields: maskDeniedFields(principal, entry.contentType, entry.fields),
      });
    },
  );

  server.registerTool(
    'content_search',
    {
      description:
        'Search published content: hybrid semantic (vector) + full-text, fused ' +
        'with Reciprocal Rank Fusion. Preferred for general queries.',
      inputSchema: toolSchema('content_search', () =>
        z.object({
          query: z.string(),
          topK: z.number().int().positive().optional(),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.searchRead, scopeOf(args));
      const hits = await hybridSearch(rag, ctx, scopeOf(args), args.query, { topK: args.topK });
      return ok(await visibleSearchHits(ctx, scopeOf(args), principal, hits));
    },
  );

  server.registerTool(
    'content_semantic_search',
    {
      description:
        'Semantic search over published content using vector embeddings only ' +
        '(prefer content_search for general queries).',
      inputSchema: toolSchema('content_semantic_search', () =>
        z.object({
          query: z.string(),
          topK: z.number().int().positive().optional(),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.searchRead, scopeOf(args));
      const hits = await semanticSearch(rag, scopeOf(args), args.query, { topK: args.topK });
      return ok(await visibleSearchHits(ctx, scopeOf(args), principal, hits));
    },
  );

  server.registerTool(
    'content_related',
    {
      description: 'Find entries semantically related to a given entry (vector similarity).',
      inputSchema: toolSchema('content_related', () =>
        z.object({
          id: z.string(),
          topK: z.number().int().positive().optional(),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.searchRead, scopeOf(args));
      return ok(await relatedEntries(rag, ctx, scopeOf(args), args.id, { topK: args.topK }));
    },
  );

  server.registerTool(
    'content_duplicates',
    {
      description: 'Detect near-duplicate entries for a given entry (high similarity threshold).',
      inputSchema: toolSchema('content_duplicates', () =>
        z.object({
          id: z.string(),
          threshold: z.number().min(0).max(1).optional(),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.searchRead, scopeOf(args));
      return ok(
        await findDuplicates(rag, ctx, scopeOf(args), args.id, { threshold: args.threshold }),
      );
    },
  );

  server.registerTool(
    'search_index_health',
    {
      description:
        'Report whether the lexical search index is in step with published content: how many ' +
        'documents it holds for the environment versus how many entries are published. ' +
        '`bound: false` means the SearchShard index is not bound and lexical search runs on ' +
        "the store's built-in term matching. Negative drift means published entries are missing " +
        'from the index and ' +
        'searches will not find them; positive drift means it holds documents for entries that ' +
        'are no longer published. Read-only; the remedy for drift is content_reindex_embeddings.',
      inputSchema: toolSchema('search_index_health', () =>
        z.object({ contentType: z.string().optional(), ...scopeArgs }),
      ),
    },
    async (args) => {
      // content:manage: operational posture, not content. See the API route.
      guard(SCOPES.contentManage, scopeOf(args));
      return ok(
        await searchIndexHealth(ctx, scopeOf(args), rag?.searchIndex, {
          contentType: args.contentType,
        }),
      );
    },
  );

  server.registerTool(
    'content_reindex_embeddings',
    {
      description:
        'Request a background reindex that re-embeds every published entry in the environment ' +
        '(optionally one content type) so content published before an embeddings change ' +
        'becomes semantically searchable. Enqueued via the outbox and run on the worker; ' +
        'rate-limited per scope. Idempotent per entry.',
      inputSchema: toolSchema('content_reindex_embeddings', () =>
        z.object({ contentTypeApiId: z.string().optional(), ...scopeArgs }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentManage, scopeOf(args));
      return ok(
        await requestReindex(ctx, scopeOf(args), { contentTypeApiId: args.contentTypeApiId }),
      );
    },
  );

  server.registerTool(
    'generate_draft',
    {
      description:
        'Generate draft field values for a content type from a prompt. Validated against ' +
        'the content model before being returned. Pair with entries_create to author it.',
      inputSchema: toolSchema('generate_draft', () =>
        z.object({
          contentType: z.string(),
          prompt: z.string(),
          tier: z.enum(['flagship', 'balanced', 'fast']).optional(),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      return ok(
        await draftEntry(ctx, ai, scopeOf(args), {
          contentTypeApiId: args.contentType,
          prompt: args.prompt,
          tier: args.tier,
        }),
      );
    },
  );

  server.registerTool(
    'entry_from_canvas',
    {
      description:
        'Map free-form prose into structured field values for a content type (Canvas authoring). ' +
        'Extracts/structures the prose into the model; validated before returning. Pair with entries_create.',
      inputSchema: toolSchema('entry_from_canvas', () =>
        z.object({
          contentType: z.string(),
          prose: z.string(),
          tier: z.enum(['flagship', 'balanced', 'fast']).optional(),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      return ok(
        await canvasToEntry(ctx, ai, scopeOf(args), {
          contentTypeApiId: args.contentType,
          prose: args.prose,
          tier: args.tier,
        }),
      );
    },
  );

  // --- AI content operations over an entry -------------------------------
  server.registerTool(
    'entry_translate',
    {
      description:
        'Translate an entry’s localized text fields into a target locale; ' +
        'apply=true saves a new draft version.',
      inputSchema: toolSchema('entry_translate', () =>
        z.object({
          id: z.string(),
          targetLocale: z.string(),
          sourceLocale: z.string().optional(),
          apply: z.boolean().optional(),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      return ok(
        await translateEntry(ctx, ai, scopeOf(args), args.id, {
          targetLocale: args.targetLocale,
          sourceLocale: args.sourceLocale,
          apply: args.apply,
        }),
      );
    },
  );

  server.registerTool(
    'entry_summarize',
    {
      description: 'Summarize an entry’s text content; apply=true writes it to targetField.',
      inputSchema: toolSchema('entry_summarize', () =>
        z.object({
          id: z.string(),
          locale: z.string().optional(),
          maxWords: z.number().int().positive().optional(),
          targetField: z.string().optional(),
          apply: z.boolean().optional(),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      return ok(
        await summarizeEntry(ctx, ai, scopeOf(args), args.id, {
          locale: args.locale,
          maxWords: args.maxWords,
          targetField: args.targetField,
          apply: args.apply,
        }),
      );
    },
  );

  server.registerTool(
    'entry_autofill_field',
    {
      description:
        'Generate a value for one scalar field from the entry’s other fields; ' +
        'apply=true saves it. Validated against the content model.',
      inputSchema: toolSchema('entry_autofill_field', () =>
        z.object({
          id: z.string(),
          field: z.string(),
          locale: z.string().optional(),
          instructions: z.string().optional(),
          apply: z.boolean().optional(),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      return ok(
        await autofillField(ctx, ai, scopeOf(args), args.id, {
          field: args.field,
          locale: args.locale,
          instructions: args.instructions,
          apply: args.apply,
        }),
      );
    },
  );

  server.registerTool(
    'entry_suggest_tags',
    {
      description:
        'Suggest taxonomy tags for an entry (matching the vocabulary, proposing ' +
        'new names); apply=true creates + assigns them.',
      inputSchema: toolSchema('entry_suggest_tags', () =>
        z.object({ id: z.string(), apply: z.boolean().optional(), ...scopeArgs }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      return ok(await suggestEntryTags(ctx, ai, scopeOf(args), args.id, { apply: args.apply }));
    },
  );

  server.registerTool(
    'entry_apply_tags',
    {
      description:
        'Persist a reviewed tag suggestion exactly as approved: assigns the given ' +
        'existing-tag ids and creates the given new tag names (no model re-run).',
      inputSchema: toolSchema('entry_apply_tags', () =>
        z.object({
          id: z.string(),
          tagIds: z.array(z.string().max(128)).max(1000).optional(),
          newTags: z.array(z.string().max(256)).max(100).optional(),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      return ok(
        await applyEntryTags(ctx, scopeOf(args), args.id, {
          tagIds: args.tagIds,
          newTags: args.newTags,
        }),
      );
    },
  );

  server.registerTool(
    'entry_audit',
    {
      description:
        'Audit an entry for gaps/inconsistencies/quality issues. createTasks=true ' +
        'emits a work-package task per finding at/above taskSeverity.',
      inputSchema: toolSchema('entry_audit', () =>
        z.object({
          id: z.string(),
          createTasks: z.boolean().optional(),
          taskSeverity: z.enum(['info', 'warning', 'error']).optional(),
          assignee: z.string().optional(),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      return ok(
        await auditEntry(ctx, ai, scopeOf(args), args.id, {
          createTasks: args.createTasks,
          taskSeverity: args.taskSeverity,
          assignee: args.assignee,
        }),
      );
    },
  );

  server.registerTool(
    'entry_moderate',
    {
      description:
        'Run the moderation agent against an entry: classifies its text and ' +
        'records a hold when flagged (flagged=true); no state change is made.',
      inputSchema: toolSchema('entry_moderate', () => z.object({ id: z.string(), ...scopeArgs })),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      return ok(await moderateEntry(ctx, agents, scopeOf(args), args.id));
    },
  );

  server.registerTool(
    'entries_bulk_action',
    {
      description:
        'Publish or unpublish many entries in one call; returns a per-item summary (an entry a gated workflow covers fails as its own item).',
      inputSchema: toolSchema('entries_bulk_action', () =>
        z.object({
          action: z.enum(['publish', 'unpublish']),
          ids: z.array(z.string()),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentPublish, scopeOf(args));
      for (const id of args.ids) await guardEntry(scopeOf(args), id, 'publish');
      return ok(await bulkEntryAction(ctx, scopeOf(args), args.action, args.ids));
    },
  );

  // Start/cancel/report demand an ungranted principal: per-item RBAC guards
  // are impractical at bulk cardinality, and reports expose entry ids across
  // all content types. Mirrors the API routes' policy exactly.
  const guardBulkJobs = () => {
    if (principal.contentGrants) {
      throw new ForbiddenError('bulk jobs (unrestricted content:publish role required)');
    }
  };

  server.registerTool(
    'bulk_job_start',
    {
      description:
        'Start a durable bulk publish/unpublish job for a large entry-id set. ' +
        'Processed in chunked transactions on the queue; poll bulk_job_status ' +
        'for progress and bulk_job_report for the per-item compliance report.',
      inputSchema: toolSchema('bulk_job_start', () =>
        z.object({
          action: z.enum(['publish', 'unpublish']),
          entryIds: z.array(z.string()).min(1).max(BULK_JOB_MAX_ITEMS),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentPublish, scopeOf(args));
      guardBulkJobs();
      return ok(
        await startBulkJob(ctx, scopeOf(args), {
          action: args.action,
          entryIds: args.entryIds,
        }),
      );
    },
  );

  server.registerTool(
    'bulk_job_status',
    {
      description:
        'Get a bulk job (status, chunk progress, succeeded/failed counts), or list recent jobs when no id is given.',
      inputSchema: toolSchema('bulk_job_status', () =>
        z.object({ id: z.string().optional(), ...scopeArgs }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentPublish, scopeOf(args));
      return ok(
        args.id
          ? await getBulkJob(ctx, scopeOf(args), args.id)
          : await listBulkJobs(ctx, scopeOf(args)),
      );
    },
  );

  server.registerTool(
    'bulk_job_report',
    {
      description:
        'Per-chunk completion report for a bulk job, including every per-item failure (compliance evidence).',
      inputSchema: toolSchema('bulk_job_report', () => z.object({ id: z.string(), ...scopeArgs })),
    },
    async (args) => {
      guard(SCOPES.contentPublish, scopeOf(args));
      guardBulkJobs();
      return ok(await getBulkJobReport(ctx, scopeOf(args), args.id));
    },
  );

  server.registerTool(
    'bulk_job_cancel',
    {
      description:
        'Cancel a running bulk job: pending chunks are skipped; in-flight chunks finish. Idempotent.',
      inputSchema: toolSchema('bulk_job_cancel', () => z.object({ id: z.string(), ...scopeArgs })),
    },
    async (args) => {
      guard(SCOPES.contentPublish, scopeOf(args));
      guardBulkJobs();
      return ok(
        await cancelBulkJob(ctx, scopeOf(args), args.id, deps.blob ? { blob: deps.blob } : {}),
      );
    },
  );

  // --- roles (granular RBAC, admin) ----------------------------------------

  server.registerTool(
    'roles_list',
    {
      description: 'List the custom roles (granular RBAC) defined in a space.',
      inputSchema: toolSchema('roles_list', () => z.object(scopeArgs)),
    },
    async (args) => {
      guard(SCOPES.spaceAdmin, scopeOf(args));
      return ok(await listRoles(ctx, scopeOf(args).spaceId));
    },
  );

  server.registerTool(
    'role_create',
    {
      description:
        'Create a custom role: a scope set plus per-content-type grants with ' +
        'optional per-field deny/read-only rules. Assign it via api_key roleId.',
      inputSchema: toolSchema('role_create', () =>
        z.object({
          name: z.string(),
          description: z.string().optional(),
          scopes: z.array(z.string()).describe('permission scopes, e.g. content:write'),
          contentGrants: z.array(grantShape).optional(),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.spaceAdmin, scopeOf(args));
      return ok(
        await createRole(ctx, scopeOf(args).spaceId, {
          name: args.name,
          description: args.description,
          scopes: args.scopes,
          contentGrants: args.contentGrants,
        }),
      );
    },
  );

  server.registerTool(
    'role_update',
    {
      description: 'Replace a role definition; keys bound to it pick the change up live.',
      inputSchema: toolSchema('role_update', () =>
        z.object({
          id: z.string(),
          name: z.string(),
          description: z.string().optional(),
          scopes: z.array(z.string()),
          contentGrants: z.array(grantShape).optional(),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.spaceAdmin, scopeOf(args));
      return ok(
        await updateRole(
          ctx,
          scopeOf(args).spaceId,
          args.id,
          {
            name: args.name,
            description: args.description,
            scopes: args.scopes,
            contentGrants: args.contentGrants,
          },
          deps.accessPolicy,
        ),
      );
    },
  );

  server.registerTool(
    'role_delete',
    {
      description: 'Delete a role (refused while any active API key still references it).',
      inputSchema: toolSchema('role_delete', () => z.object({ id: z.string(), ...scopeArgs })),
    },
    async (args) => {
      guard(SCOPES.spaceAdmin, scopeOf(args));
      await deleteRole(ctx, scopeOf(args).spaceId, args.id);
      return ok({ deleted: args.id });
    },
  );

  // --- role presets + team (admin; same use-cases as /spaces/:space/{role-presets,team}) ------
  // First-run setup is deliberately not a tool: it is a person with a setup code, over HTTP.
  const accessPolicy = deps.accessPolicy ?? { sso: false };

  server.registerTool(
    'role_presets_list',
    {
      description:
        'List the built-in role presets (Viewer, Approver, Editor, Manager, Administrator) with ' +
        'the role id each is seeded as in the space and its live scopes. Each preset includes ' +
        'everything the one before it can do.',
      inputSchema: toolSchema('role_presets_list', () => z.object(scopeArgs)),
    },
    async (args) => {
      guard(SCOPES.spaceAdmin, scopeOf(args));
      return ok(await listRolePresets(ctx, scopeOf(args).spaceId));
    },
  );

  server.registerTool(
    'team_list',
    {
      description:
        'List the team: people (SSO sign-in) and long-lived API keys with their roles, which of ' +
        'them are administrators, and the admin count (the last admin cannot be demoted).',
      inputSchema: toolSchema('team_list', () => z.object(scopeArgs)),
    },
    async (args) => {
      guard(SCOPES.spaceAdmin, scopeOf(args));
      return ok(await listTeam(ctx, scopeOf(args).spaceId, accessPolicy));
    },
  );

  server.registerTool(
    'role_preset_assign',
    {
      description:
        'Give an API key (keyId) or a person (memberId) one of the role presets. Refused when it ' +
        'would leave the space with no administrator.',
      inputSchema: toolSchema('role_preset_assign', () =>
        z.object({
          preset: z.enum(ROLE_PRESETS),
          keyId: z.string().optional(),
          memberId: z.string().optional(),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.spaceAdmin, scopeOf(args));
      if (!args.keyId === !args.memberId) {
        throw new ValidationError([
          { field: 'keyId', message: 'Give exactly one of keyId or memberId' },
        ]);
      }
      const target = args.keyId ? { keyId: args.keyId } : { memberId: args.memberId as string };
      return ok(
        await assignRolePreset(ctx, scopeOf(args).spaceId, target, args.preset, accessPolicy),
      );
    },
  );

  // --- plugins -------------------------------------------------------------
  // Read and lifecycle only. Installing is deliberately absent: uploading code
  // that runs on the write path is a human act behind a consent screen, not
  // something an agent should be able to do on its own authority.
  server.registerTool(
    'plugins_list',
    {
      description:
        'List the plugins installed in a space, with the capabilities each was ' +
        'granted and whether it is enabled.',
      inputSchema: toolSchema('plugins_list', () => z.object(scopeArgs)),
    },
    async (args) => {
      guard(SCOPES.spaceAdmin, scopeOf(args));
      return ok(await listPlugins(ctx, scopeOf(args).spaceId));
    },
  );

  // No install-from-URL tool, deliberately. Installing a plugin introduces new
  // executable code and turns on a consent screen a human is meant to read;
  // an agent that could do it could grant itself capabilities its own
  // principal was never given. Listing and toggling what a human already
  // approved is the line.
  server.registerTool(
    'plugin_set_enabled',
    {
      description: 'Turn an installed plugin on or off. Does not change what it was granted.',
      inputSchema: toolSchema('plugin_set_enabled', () =>
        z.object({ id: z.string(), enabled: z.boolean(), ...scopeArgs }),
      ),
    },
    async (args) => {
      guard(SCOPES.spaceAdmin, scopeOf(args));
      return ok(await setPluginEnabled(ctx, scopeOf(args).spaceId, args.id, args.enabled));
    },
  );

  // The same capability-approval use-case as the admin's approve step, in
  // narrow-only mode: an agent may confirm what a human granted (clearing a
  // legacy plugin's re-approval flag) or reduce it, never widen it — granting
  // authority to code stays a human decision on the consent screen.
  server.registerTool(
    'plugin_approve_capabilities',
    {
      description:
        'Confirm or narrow the capabilities an installed plugin is granted. Can re-approve a ' +
        'plugin flagged needsReapproval or drop capabilities; cannot grant anything beyond the ' +
        'current grant (that needs a human in the admin).',
      inputSchema: toolSchema('plugin_approve_capabilities', () =>
        z.object({
          id: z.string(),
          approvedCapabilities: z.array(z.string()).max(32),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.spaceAdmin, scopeOf(args));
      return ok(
        await approvePluginCapabilities(
          ctx,
          principal,
          scopeOf(args).spaceId,
          args.id,
          args.approvedCapabilities as never,
          { narrowOnly: true },
        ),
      );
    },
  );

  // --- importing content from elsewhere -------------------------------------
  const toImport = (args: Record<string, unknown>) => ({
    payload: args.payload as string,
    mapping: {
      contentTypeApiId: args.contentTypeApiId as string,
      fields: args.fields as Record<string, string>,
      ...(args.identityField ? { identityField: args.identityField as string } : {}),
      ...(args.locale ? { locale: args.locale as string } : {}),
    },
    ...(args.sourceOptions ? { sourceOptions: args.sourceOptions as Record<string, unknown> } : {}),
  });
  const importSource = (id: string) => {
    const found = deps.importSources?.[id];
    if (!found) {
      const known = Object.keys(deps.importSources ?? {}).join(', ') || 'none';
      throw new Error(`Unknown import source "${id}". Available: ${known}`);
    }
    return found;
  };

  server.registerTool(
    'import_sources',
    {
      description: 'List the external content formats this deployment can read.',
      inputSchema: toolSchema('import_sources', () => z.object({})),
    },
    async () =>
      ok(Object.values(deps.importSources ?? {}).map((s) => ({ id: s.id, name: s.name }))),
  );

  server.registerTool(
    'import_analyze',
    {
      description:
        'Report what importing a payload would create, update and skip — including the ' +
        'source fields nothing maps to and the records that would fail. Writes nothing. ' +
        'Run this before import_execute; it is the same computation without the commit.',
      inputSchema: toolSchema('import_analyze', () => z.object(importArgs)),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      return ok(
        await analyzeImport(ctx, scopeOf(args), importSource(args.source), toImport(args), {
          ...(args.conflicts ? { conflicts: args.conflicts } : {}),
        }),
      );
    },
  );

  server.registerTool(
    'import_execute',
    {
      description:
        'Import a payload. Entries are created through the same use-cases as any other ' +
        'write, arrive as drafts, and a record that fails validation is skipped and reported ' +
        'rather than aborting the run.',
      inputSchema: toolSchema('import_execute', () => z.object(importArgs)),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      return ok(
        await executeImport(ctx, scopeOf(args), importSource(args.source), toImport(args), {
          ...(args.conflicts ? { conflicts: args.conflicts } : {}),
        }),
      );
    },
  );

  // --- environment snapshots ----------------------------------------------
  server.registerTool(
    'environment_export',
    {
      description:
        'Export an environment as a portable snapshot: content model, entries, ' +
        'taxonomy and workflows. Never includes credentials or asset binaries.',
      inputSchema: toolSchema('environment_export', () =>
        z.object({ limit: z.number().int().positive().optional(), ...scopeArgs }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentManage, scopeOf(args));
      return ok(await exportSnapshot(ctx, scopeOf(args), { limit: args.limit }));
    },
  );

  server.registerTool(
    'environment_import',
    {
      description:
        'Import a snapshot (as environment_export returns it) into this environment, which ' +
        'must exist and have no content types. Every entry is checked first, and nothing is ' +
        'written if anything would fail. Set dryRun to see the report only. Otherwise the ' +
        'content model is written and the entries and assets are written by a job: the ' +
        'result is `{ report, job, publishJobId }`; follow `job` with bulk_job_status in this ' +
        'environment, then `publishJobId`, which starts once `job` completes with no failures.',
      inputSchema: toolSchema('environment_import', () =>
        z.object({
          snapshot: snapshotBody,
          publish: z.boolean().optional().describe('republish what was published (default true)'),
          dryRun: z.boolean().optional(),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      const target = scopeOf(args);
      guard(SCOPES.contentManage, target);
      const snapshot = args.snapshot as unknown as EnvironmentSnapshot;
      const options = { dryRun: args.dryRun, publish: args.publish };
      if (args.dryRun || !deps.blob)
        return ok(await importSnapshot(ctx, target, snapshot, options));
      return ok(await startSnapshotImport(ctx, deps.blob, target, snapshot, options));
    },
  );

  server.registerTool(
    'environment_clone',
    {
      description:
        'Copy this environment into another (which may be in another space). The ' +
        'target must exist and have no content types. Set dryRun to see the report first. ' +
        'Otherwise it runs entirely as jobs: the result is `{ job, createJobId, publishJobId }`. ' +
        '`job` exports the source and checks it (a refused snapshot fails it; bulk_job_report ' +
        'names the problems), then starts `createJobId`, whose clean completion starts ' +
        '`publishJobId` (when anything is published). All belong to the TARGET: follow them ' +
        'with bulk_job_status passing `space`=targetSpace and `environment`=targetEnvironment.',
      inputSchema: toolSchema('environment_clone', () =>
        z.object({
          targetSpace: z.string().optional().describe('defaults to the source space'),
          targetEnvironment: z.string(),
          publish: z.boolean().optional().describe('republish what was published (default true)'),
          dryRun: z.boolean().optional(),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      const from = scopeOf(args);
      guard(SCOPES.contentManage, from);
      const to = {
        spaceId: args.targetSpace ?? from.spaceId,
        environmentId: args.targetEnvironment,
      };
      // Authorized separately: cloning into a space the caller cannot manage
      // would be a tenancy hole.
      guard(SCOPES.contentManage, to);
      const options = { dryRun: args.dryRun, publish: args.publish };
      if (args.dryRun || !deps.blob) {
        return ok(await importSnapshot(ctx, to, await exportSnapshot(ctx, from), options));
      }
      return ok(await startEnvironmentClone(ctx, from, to, options));
    },
  );

  // --- connected OAuth applications --------------------------------------
  // Minting a personal access token is deliberately absent here: a delegated
  // token that expires in an hour must not be able to issue itself one that
  // never does. That stays an HTTP-only, human-initiated action.
  server.registerTool(
    'oauth_connections_list',
    {
      description:
        'List the applications currently holding OAuth access to a space, with the ' +
        'person who approved each and the scopes it was granted.',
      inputSchema: toolSchema('oauth_connections_list', () => z.object(scopeArgs)),
    },
    async (args) => {
      guard(SCOPES.spaceAdmin, scopeOf(args));
      return ok(await listConnectedApps(ctx, scopeOf(args).spaceId));
    },
  );

  server.registerTool(
    'oauth_connection_revoke',
    {
      description:
        'Disconnect an application: revokes every access token it holds for that ' +
        'person and the grants behind them, so it cannot refresh back in.',
      inputSchema: toolSchema('oauth_connection_revoke', () =>
        z.object({
          clientId: z.string(),
          subject: z.string().describe('the identity that approved the connection'),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.spaceAdmin, scopeOf(args));
      return ok(await revokeConnectedApp(ctx, scopeOf(args).spaceId, args.clientId, args.subject));
    },
  );

  // --- webhooks (admin) ----------------------------------------------------
  // The REST routes' twins: the same use-cases, the same space-admin check, the same body schemas,
  // and the same projection (never the signing secret or the headers, which may carry credentials).
  // A hook is scoped to one environment or, with allEnvironments, space-wide (environmentId null).
  const webhookView = (h: Webhook) => ({
    id: h.id,
    url: h.url,
    topics: h.topics,
    active: h.active,
    environmentId: h.environmentId,
  });

  server.registerTool(
    'webhooks_list',
    {
      description:
        "List an environment's webhooks and every space-wide one (environmentId null). " +
        'Secrets and headers are never returned.',
      inputSchema: toolSchema('webhooks_list', () => z.object(scopeArgs)),
    },
    async (args) => {
      guard(SCOPES.spaceAdmin, scopeOf(args));
      return ok({ items: (await listWebhooks(ctx, scopeOf(args))).map(webhookView) });
    },
  );

  server.registerTool(
    'webhook_create',
    {
      description:
        'Register a webhook: signed POSTs of the events matching topics ("*" for all) to url. ' +
        "It receives only the given environment's events, or every environment's with " +
        'allEnvironments: true. Named through an alias it is space-wide (allEnvironments: false is ' +
        'refused). secret is yours to choose and is never returned.',
      inputSchema: toolSchema('webhook_create', () => webhookBody.extend(scopeArgs)),
    },
    async (args) => {
      guard(SCOPES.spaceAdmin, scopeOf(args));
      const { space: _s, environment: _e, ...input } = args;
      return ok(
        webhookView(
          await createWebhook(ctx, scopeOf(args), input as Parameters<typeof createWebhook>[2], {
            requestedEnvironment: requestedEnvironment.get(args),
          }),
        ),
      );
    },
  );

  server.registerTool(
    'webhook_update',
    {
      description:
        'Change a webhook; omitted fields are kept. allEnvironments: true makes it space-wide, ' +
        'false scopes it to the given environment (refused for an alias); omitted, its scope is ' +
        'unchanged.',
      inputSchema: toolSchema('webhook_update', () =>
        updateWebhookBody.extend({ id: z.string(), ...scopeArgs }),
      ),
    },
    async (args) => {
      guard(SCOPES.spaceAdmin, scopeOf(args));
      const { id, space: _s, environment: _e, ...changes } = args;
      return ok(
        webhookView(
          await updateWebhook(
            ctx,
            scopeOf(args),
            id,
            changes as Parameters<typeof updateWebhook>[3],
            { requestedEnvironment: requestedEnvironment.get(args) },
          ),
        ),
      );
    },
  );

  server.registerTool(
    'webhook_delete',
    {
      description: 'Delete a webhook by id.',
      inputSchema: toolSchema('webhook_delete', () => z.object({ id: z.string(), ...scopeArgs })),
    },
    async (args) => {
      guard(SCOPES.spaceAdmin, scopeOf(args));
      await deleteWebhook(ctx, scopeOf(args), args.id);
      return ok({ deleted: args.id });
    },
  );

  server.registerTool(
    'webhook_deliveries',
    {
      description: "A webhook's recent delivery attempts, newest first (default 50, at most 100).",
      inputSchema: toolSchema('webhook_deliveries', () =>
        z.object({
          id: z.string(),
          limit: z.number().int().min(1).max(MAX_PAGE_LIMIT).optional(),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.spaceAdmin, scopeOf(args));
      const items = await listWebhookDeliveries(ctx, scopeOf(args), args.id, {
        limit: args.limit,
      });
      return ok({ items });
    },
  );

  // --- functions (event-triggered, HTTP-invoked) -------------------------
  server.registerTool(
    'functions_list',
    {
      description: 'List the user-defined functions registered in a space/environment.',
      inputSchema: toolSchema('functions_list', () => z.object(scopeArgs)),
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      return ok(await listFunctions(ctx, scopeOf(args)));
    },
  );

  server.registerTool(
    'function_create',
    {
      description:
        'Register a function: an HTTP endpoint invoked on events matching ' +
        'eventPattern (a glob on the event type, e.g. "entry.*" or "*").',
      inputSchema: toolSchema('function_create', () =>
        z.object({
          name: z.string(),
          eventPattern: z.string(),
          url: z.string(),
          active: z.boolean().optional(),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentManage, scopeOf(args));
      return ok(
        await createFunction(ctx, scopeOf(args), {
          name: args.name,
          eventPattern: args.eventPattern,
          url: args.url,
          active: args.active,
        }),
      );
    },
  );

  server.registerTool(
    'function_delete',
    {
      description: 'Delete a registered function by id.',
      inputSchema: toolSchema('function_delete', () => z.object({ id: z.string(), ...scopeArgs })),
    },
    async (args) => {
      guard(SCOPES.contentManage, scopeOf(args));
      await deleteFunction(ctx, scopeOf(args), args.id);
      return ok({ deleted: args.id });
    },
  );

  // --- app extensions (admin UI extensions) ------------------------------
  server.registerTool(
    'app_extensions_list',
    {
      description:
        'List the admin UI extensions (custom field editors / sidebar widgets) registered in a space/environment.',
      inputSchema: toolSchema('app_extensions_list', () => z.object(scopeArgs)),
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      return ok(await listAppExtensions(ctx, scopeOf(args)));
    },
  );

  server.registerTool(
    'app_extension_create',
    {
      description:
        'Register an admin UI extension rendered in a sandboxed iframe. target is ' +
        '"field-editor" (custom editor for the given fieldTypes) or "sidebar" (entry widget).',
      inputSchema: toolSchema('app_extension_create', () =>
        z.object({
          name: z.string(),
          target: z.enum(['field-editor', 'sidebar']),
          entryUrl: z.string(),
          fieldTypes: z.array(z.string()).optional(),
          active: z.boolean().optional(),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentManage, scopeOf(args));
      return ok(
        await createAppExtension(ctx, scopeOf(args), {
          name: args.name,
          target: args.target,
          entryUrl: args.entryUrl,
          fieldTypes: args.fieldTypes,
          active: args.active,
        }),
      );
    },
  );

  server.registerTool(
    'app_extension_delete',
    {
      description: 'Delete a registered admin UI extension by id.',
      inputSchema: toolSchema('app_extension_delete', () =>
        z.object({ id: z.string(), ...scopeArgs }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentManage, scopeOf(args));
      await deleteAppExtension(ctx, scopeOf(args), args.id);
      return ok({ deleted: args.id });
    },
  );

  // --- AI Actions (templated, governed operations) -----------------------
  server.registerTool(
    'ai_actions_list',
    {
      description: 'List the reusable AI Actions defined in a space/environment.',
      inputSchema: toolSchema('ai_actions_list', () => z.object(scopeArgs)),
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      return ok(await listAIActions(ctx, scopeOf(args)));
    },
  );

  server.registerTool(
    'ai_action_create',
    {
      description:
        'Create a reusable AI Action: a prompt template with {{variables}} and an ' +
        'optional targetField the run writes into. Variables are derived from the template.',
      inputSchema: toolSchema('ai_action_create', () =>
        z.object({
          name: z.string(),
          promptTemplate: z.string(),
          description: z.string().optional(),
          targetField: z.string().optional(),
          tier: z.enum(['flagship', 'balanced', 'fast']).optional(),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentManage, scopeOf(args));
      return ok(
        await createAIAction(ctx, scopeOf(args), {
          name: args.name,
          promptTemplate: args.promptTemplate,
          description: args.description,
          targetField: args.targetField,
          tier: args.tier,
        }),
      );
    },
  );

  server.registerTool(
    'ai_action_run',
    {
      description:
        'Run a stored AI Action. Pass variables, and/or an entryId whose fields ' +
        'become {{field.<apiId>}}; apply=true writes the output into the targetField.',
      inputSchema: toolSchema('ai_action_run', () =>
        z.object({
          id: z.string(),
          entryId: z.string().optional(),
          variables: z.record(z.string(), z.string()).optional(),
          locale: z.string().optional(),
          apply: z.boolean().optional(),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      return ok(
        await runAIAction(ctx, ai, scopeOf(args), args.id, {
          entryId: args.entryId,
          variables: args.variables,
          locale: args.locale,
          apply: args.apply,
        }),
      );
    },
  );

  // --- write -------------------------------------------------------------
  server.registerTool(
    'model_create_content_type',
    {
      description: 'Create or update a content type definition.',
      inputSchema: toolSchema('model_create_content_type', () =>
        z.object({
          apiId: z.string(),
          name: z.string(),
          displayField: z.string(),
          fields: z.array(fieldSchema),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentManage, scopeOf(args));
      return ok(
        await createContentType(ctx, scopeOf(args), {
          apiId: args.apiId,
          name: args.name,
          displayField: args.displayField,
          // biome-ignore lint/suspicious/noExplicitAny: zod field shape → domain FieldDefinition
          fields: args.fields as any,
        }),
      );
    },
  );

  server.registerTool(
    'model_publish_content_type',
    {
      description: 'Publish a content type so entries can be delivered against it.',
      inputSchema: toolSchema('model_publish_content_type', () =>
        z.object({ apiId: z.string(), ...scopeArgs }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentPublish, scopeOf(args));
      return ok(await publishContentType(ctx, scopeOf(args), args.apiId));
    },
  );

  server.registerTool(
    'entries_create',
    {
      description: 'Create a draft entry. Fields are validated against the content model.',
      inputSchema: toolSchema('entries_create', () =>
        z.object({ contentType: z.string(), fields: entryFields, ...scopeArgs }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      authorizeContent(principal, 'write', args.contentType);
      assertWritableFields(principal, args.contentType, args.fields ?? {});
      return ok(
        await createEntry(ctx, scopeOf(args), {
          contentTypeApiId: args.contentType,
          fields: args.fields as EntryFields,
        }),
      );
    },
  );

  server.registerTool(
    'entries_update',
    {
      description: 'Save new field values as a new draft version of an entry.',
      inputSchema: toolSchema('entries_update', () =>
        z.object({ id: z.string(), fields: entryFields, ...scopeArgs }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      if (principal.contentGrants) {
        const entry = await getPreviewEntry(ctx, scopeOf(args), args.id);
        authorizeContent(principal, 'write', entry.contentType);
        assertWritableFields(principal, entry.contentType, args.fields ?? {});
      }
      return ok(await updateEntry(ctx, scopeOf(args), args.id, args.fields as EntryFields));
    },
  );

  server.registerTool(
    'entries_publish',
    {
      description:
        'Publish an entry (validates references; emits an entry.published event). Refused (publish_gated) when a workflow that gates publishing covers the entry: only a run of that workflow publishes it.',
      inputSchema: toolSchema('entries_publish', () =>
        z.object({
          id: z.string(),
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
      guard(SCOPES.contentPublish, scopeOf(args));
      await guardEntry(scopeOf(args), args.id, 'publish');
      if (deps.moderateBeforePublish) {
        const verdict = await moderateEntry(ctx, agents, scopeOf(args), args.id);
        if (verdict.flagged) {
          throw new ValidationError([
            {
              field: 'moderation',
              message: `Publish blocked by moderation: ${verdict.decisions.join('; ') || 'policy violation'}`,
            },
          ]);
        }
      }
      return ok(
        await publishEntry(ctx, scopeOf(args), args.id, { expectedVersion: args.expectedVersion }),
      );
    },
  );

  server.registerTool(
    'entries_unpublish',
    {
      description: 'Withdraw an entry from the Delivery API.',
      inputSchema: toolSchema('entries_unpublish', () =>
        z.object({
          id: z.string(),
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
      guard(SCOPES.contentPublish, scopeOf(args));
      await guardEntry(scopeOf(args), args.id, 'publish');
      return ok(
        await unpublishEntry(ctx, scopeOf(args), args.id, {
          expectedVersion: args.expectedVersion,
        }),
      );
    },
  );

  // --- trash lifecycle ----------------------------------------------------
  server.registerTool(
    'entries_trash',
    {
      description:
        'Move an entry to the trash. Unpublishes it first when it is live, so ' +
        'delivery stops serving it. Recoverable with entries_restore.',
      inputSchema: toolSchema('entries_trash', () => z.object({ id: z.string(), ...scopeArgs })),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      await guardEntry(scopeOf(args), args.id, 'write');
      return ok(await trashEntry(ctx, scopeOf(args), args.id));
    },
  );

  server.registerTool(
    'entries_list_trashed',
    {
      description: 'List the entries currently in the trash.',
      inputSchema: toolSchema('entries_list_trashed', () =>
        z.object({
          contentType: z.string().optional(),
          limit: z.number().int().positive().optional(),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      const items = await listPreviewEntries(ctx, scopeOf(args), {
        contentTypeApiId: args.contentType,
        limit: args.limit,
        archived: true,
      });
      return ok(items.filter((e) => canAccessContentType(principal, 'read', e.contentType)));
    },
  );

  server.registerTool(
    'entries_restore',
    {
      description:
        'Bring an entry back from the trash as a draft. Publishing it again is a ' +
        'separate action.',
      inputSchema: toolSchema('entries_restore', () => z.object({ id: z.string(), ...scopeArgs })),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      await guardEntry(scopeOf(args), args.id, 'write');
      return ok(await restoreEntry(ctx, scopeOf(args), args.id));
    },
  );

  server.registerTool(
    'entries_purge',
    {
      description:
        'Permanently delete a trashed entry and every version of it. IRREVERSIBLE. ' +
        'Refuses while published entries still link to it unless force is true.',
      inputSchema: toolSchema('entries_purge', () =>
        z.object({ id: z.string(), force: z.boolean().optional(), ...scopeArgs }),
      ),
    },
    async (args) => {
      // Gated on content:publish, not content:write: this is the only entry
      // action that cannot be undone.
      guard(SCOPES.contentPublish, scopeOf(args));
      await guardEntry(scopeOf(args), args.id, 'publish');
      await purgeEntry(ctx, scopeOf(args), args.id, {
        force: args.force,
        ...(deps.blob ? { blob: deps.blob } : {}),
      });
      return ok({ purged: args.id });
    },
  );

  server.registerTool(
    'entries_duplicate',
    {
      description: 'Copy an entry, with its taxonomy metadata, into a new draft.',
      inputSchema: toolSchema('entries_duplicate', () =>
        z.object({ id: z.string(), ...scopeArgs }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      await guardEntry(scopeOf(args), args.id, 'read');
      const created = await duplicateEntry(ctx, scopeOf(args), args.id);
      authorizeContent(principal, 'write', created.entry.contentTypeApiId);
      return ok(created);
    },
  );

  // --- entry version history ---------------------------------------------
  server.registerTool(
    'entries_list_versions',
    {
      description: 'List every saved version of an entry, newest first.',
      inputSchema: toolSchema('entries_list_versions', () =>
        z.object({ id: z.string(), ...scopeArgs }),
      ),
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      const type = await authorizeEntryRead(scopeOf(args), args.id);
      const items = (await listVersions(ctx, scopeOf(args), args.id)).map((v) => ({
        ...v,
        fields: maskDeniedFields(principal, type, v.fields),
      }));
      return ok(items);
    },
  );

  server.registerTool(
    'entries_diff_versions',
    {
      description: 'Diff two versions of an entry field-by-field (from → to).',
      inputSchema: toolSchema('entries_diff_versions', () =>
        z.object({ id: z.string(), from: z.number(), to: z.number(), ...scopeArgs }),
      ),
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      const type = await authorizeEntryRead(scopeOf(args), args.id);
      const diff = await diffVersions(ctx, scopeOf(args), args.id, args.from, args.to);
      const allowed = maskDeniedFields(
        principal,
        type,
        Object.fromEntries(diff.changes.map((ch) => [ch.field, ch])),
      );
      return ok({ ...diff, changes: Object.values(allowed) });
    },
  );

  server.registerTool(
    'entries_restore_version',
    {
      description: 'Restore an older version by copying its fields into a new draft version.',
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
        }),
      );
    },
  );

  // --- releases & scheduling ---------------------------------------------
  server.registerTool(
    'releases_list',
    {
      description:
        'List releases (entry bundles published together) in a space/environment, newest ' +
        'first, each with itemCount (how many members it holds).',
      inputSchema: toolSchema('releases_list', () => z.object(scopeArgs)),
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      return ok(await listReleases(ctx, scopeOf(args)));
    },
  );

  server.registerTool(
    'releases_get',
    {
      description: 'Get a release with its member entries.',
      inputSchema: toolSchema('releases_get', () => z.object({ id: z.string(), ...scopeArgs })),
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      return ok(await getRelease(ctx, scopeOf(args), args.id));
    },
  );

  server.registerTool(
    'releases_create',
    {
      description: 'Create an open release to group entries for atomic publishing.',
      inputSchema: toolSchema('releases_create', () =>
        z.object({
          title: z.string(),
          description: z.string().optional(),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      return ok(
        await createRelease(ctx, scopeOf(args), {
          title: args.title,
          description: args.description,
        }),
      );
    },
  );

  server.registerTool(
    'releases_add_entry',
    {
      description: 'Add an entry to an open release, choosing whether it publishes or unpublishes.',
      inputSchema: toolSchema('releases_add_entry', () =>
        z.object({
          releaseId: z.string(),
          entryId: z.string(),
          action: z.enum(['publish', 'unpublish']).optional(),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      return ok(
        await addEntryToRelease(ctx, scopeOf(args), args.releaseId, {
          entityId: args.entryId,
          action: args.action,
        }),
      );
    },
  );

  server.registerTool(
    'releases_publish',
    {
      description:
        'Ship a release: publish/unpublish every member atomically in one transaction. Refused whole (publish_gated) when a gated workflow covers a member it publishes.',
      inputSchema: toolSchema('releases_publish', () => z.object({ id: z.string(), ...scopeArgs })),
    },
    async (args) => {
      guard(SCOPES.contentPublish, scopeOf(args));
      return ok(await publishRelease(ctx, scopeOf(args), args.id));
    },
  );

  // --- collaboration: comments, tasks, workflow --------------------------
  server.registerTool(
    'comments_list',
    {
      description: 'List comments on an entry (oldest first; threaded via parentId).',
      inputSchema: toolSchema('comments_list', () =>
        z.object({ entryId: z.string(), ...scopeArgs }),
      ),
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      return ok(await listComments(ctx, scopeOf(args), args.entryId));
    },
  );

  server.registerTool(
    'comments_add',
    {
      description: 'Add a comment (or threaded reply) to an entry.',
      inputSchema: toolSchema('comments_add', () =>
        z.object({
          entryId: z.string(),
          body: z.string(),
          author: z.string().optional(),
          parentId: z.string().optional(),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      return ok(
        await addComment(ctx, scopeOf(args), {
          entryId: args.entryId,
          body: args.body,
          author: args.author ?? principal.kind,
          parentId: args.parentId,
        }),
      );
    },
  );

  server.registerTool(
    'tasks_list',
    {
      description: 'List tasks on an entry.',
      inputSchema: toolSchema('tasks_list', () => z.object({ entryId: z.string(), ...scopeArgs })),
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      return ok(await listTasks(ctx, scopeOf(args), args.entryId));
    },
  );

  server.registerTool(
    'tasks_create',
    {
      description: 'Create an editorial task on an entry, optionally assigned to someone.',
      inputSchema: toolSchema('tasks_create', () =>
        z.object({
          entryId: z.string(),
          body: z.string(),
          assignee: z.string().optional(),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      return ok(
        await createTask(ctx, scopeOf(args), {
          entryId: args.entryId,
          body: args.body,
          assignee: args.assignee,
        }),
      );
    },
  );

  server.registerTool(
    'tasks_resolve',
    {
      description: 'Mark a task resolved.',
      inputSchema: toolSchema('tasks_resolve', () => z.object({ id: z.string(), ...scopeArgs })),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      return ok(await resolveTask(ctx, scopeOf(args), args.id));
    },
  );

  server.registerTool(
    'workflow_transition',
    {
      description:
        'Move an entry into a workflow step. The target step may require a scope the ' +
        'caller must hold (enforced from the workflow definition).',
      inputSchema: toolSchema('workflow_transition', () =>
        z.object({
          entryId: z.string(),
          workflowId: z.string(),
          toStepId: z.string(),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      return ok(
        await transitionEntry(
          ctx,
          scopeOf(args),
          { entryId: args.entryId, workflowId: args.workflowId, toStepId: args.toStepId },
          principal.scopes,
        ),
      );
    },
  );

  // --- editorial workflows (graphs, versions, runs, tasks) -----------------
  // Same use-cases and scope checks as the HTTP routes in api/routes/workflows.ts.
  const workflowEngine = () => {
    if (deps.workflowEngine) return deps.workflowEngine;
    throw new NotConfiguredError(
      'workflows',
      'Workflow runs need the EDITORIAL_WF Cloudflare Workflows binding on this deployment',
    );
  };
  const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true } as const;

  server.registerTool(
    'workflow_list',
    {
      description:
        'List the editorial workflows: each with its draft graph and latestVersion, plus how its ' +
        'latest PUBLISHED version starts (publishedTrigger: { type, label }) and startsAlongside, ' +
        'the ids of the other published workflows that start on the same trigger for an ' +
        'overlapping content type (each of them starts too; for trigger.manual the editor ' +
        'chooses). Both are null for a workflow never published.',
      inputSchema: toolSchema('workflow_list', () => z.object(scopeArgs)),
      annotations: READ_ONLY,
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      return ok(await listWorkflows(ctx, scopeOf(args)));
    },
  );

  server.registerTool(
    'workflow_save_draft',
    {
      description:
        'Create or update an editorial workflow draft (a graph of trigger, content, AI and ' +
        'control nodes). Without workflowId it creates a new unpublished workflow (name ' +
        'required); with it, omitted fields keep their value. Drafts may be incomplete: the ' +
        'answer carries the validation issues. Never affects published versions or runs; ' +
        'publish with workflow_publish.',
      inputSchema: toolSchema('workflow_save_draft', () =>
        z.object({
          workflowId: z.string().optional().describe('omit to create a new workflow'),
          name: z.string().max(256).optional(),
          description: z.string().max(2000).optional(),
          contentTypes: z
            .array(z.string())
            .max(100)
            .optional()
            .describe('content type apiIds the workflow covers; empty means all'),
          graph: z
            .record(z.string(), z.unknown())
            .optional()
            .describe('{ nodes: [...], edges: [...] } in the editor’s (React Flow) shape'),
          gatesPublish: z.boolean().optional(),
          ...scopeArgs,
        }),
      ),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (args) => {
      const s = scopeOf(args);
      guard(SCOPES.contentManage, s);
      const fields = {
        ...(args.description !== undefined ? { description: args.description } : {}),
        ...(args.contentTypes !== undefined ? { contentTypes: args.contentTypes } : {}),
        ...(args.graph !== undefined ? { graph: args.graph } : {}),
        ...(args.gatesPublish !== undefined ? { gatesPublish: args.gatesPublish } : {}),
      };
      if (!args.workflowId) {
        if (!args.name) {
          throw new ValidationError([{ field: 'name', message: 'required to create a workflow' }]);
        }
        return ok(await createWorkflowDraft(ctx, s, { name: args.name, ...fields }));
      }
      return ok(
        await saveWorkflowDraft(ctx, s, args.workflowId, {
          ...(args.name !== undefined ? { name: args.name } : {}),
          ...fields,
        }),
      );
    },
  );

  server.registerTool(
    'workflow_publish',
    {
      description:
        'Publish a workflow’s current draft as its next immutable version; new runs pin it, ' +
        'running runs keep theirs. Refused while the graph has validation errors.',
      inputSchema: toolSchema('workflow_publish', () =>
        z.object({ workflowId: z.string(), ...scopeArgs }),
      ),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (args) => {
      const s = scopeOf(args);
      guard(SCOPES.contentManage, s);
      return ok(
        await publishWorkflowVersion(ctx, s, args.workflowId, {
          publishedBy: principalActorId(principal),
        }),
      );
    },
  );

  server.registerTool(
    'workflow_versions',
    {
      description:
        'List a workflow’s published versions (newest first), or get one with its graph when ' +
        '`version` is given.',
      inputSchema: toolSchema('workflow_versions', () =>
        z.object({
          workflowId: z.string(),
          version: z.number().int().positive().optional(),
          ...scopeArgs,
        }),
      ),
      annotations: READ_ONLY,
    },
    async (args) => {
      const s = scopeOf(args);
      guard(SCOPES.previewRead, s);
      return ok(
        args.version !== undefined
          ? await getWorkflowVersion(ctx, s, args.workflowId, args.version)
          : await listWorkflowVersions(ctx, s, args.workflowId),
      );
    },
  );

  server.registerTool(
    'workflow_validate',
    {
      description:
        'Validate a workflow graph with the checks the editor and publishing use. Saves ' +
        'nothing; answers { ok, errors, warnings }.',
      inputSchema: toolSchema('workflow_validate', () =>
        z.object({ graph: z.record(z.string(), z.unknown()), ...scopeArgs }),
      ),
      annotations: READ_ONLY,
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      return ok(validateWorkflowGraph(args.graph));
    },
  );

  server.registerTool(
    'workflow_copilot',
    {
      description:
        'Draft a workflow graph from a plain-language prompt, or edit `graph` when given. ' +
        'Read-only: it returns a proposal (graph, explanation, validation issues, changes and ' +
        'a one-line summary) and never saves; save it with workflow_save_draft.',
      inputSchema: toolSchema('workflow_copilot', () =>
        z.object({
          prompt: z.string().min(1).max(4000),
          graph: z.record(z.string(), z.unknown()).optional(),
          contentTypes: z.array(z.string()).max(20).optional(),
          ...scopeArgs,
        }),
      ),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      const s = scopeOf(args);
      guard(SCOPES.contentManage, s);
      const result = await draftWorkflowGraph(ctx, ai, s, {
        prompt: args.prompt,
        ...(args.graph !== undefined ? { graph: args.graph } : {}),
        ...(args.contentTypes ? { contentTypes: args.contentTypes } : {}),
      });
      return ok({ ...result, summary: describeDiff(result.changes) });
    },
  );

  server.registerTool(
    'workflow_run_start',
    {
      description:
        'Start a run of a published workflow (trigger.manual) on an entry, e.g. "submit for ' +
        'review". The run acts as you: you need content:write on the entry’s type. One active ' +
        'run per workflow and entry.',
      inputSchema: toolSchema('workflow_run_start', () =>
        z.object({
          entryId: z.string(),
          workflowId: z.string(),
          version: z.number().int().positive().optional().describe('default: latest'),
          input: z.record(z.string(), z.unknown()).optional(),
          vars: z.record(z.string(), z.unknown()).optional(),
          ...scopeArgs,
        }),
      ),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (args) => {
      const s = scopeOf(args);
      guard(SCOPES.contentWrite, s);
      const run = await startWorkflowRun(ctx, workflowEngine(), principal, s, {
        entryId: args.entryId,
        workflowId: args.workflowId,
        ...(args.version !== undefined ? { version: args.version } : {}),
        ...(args.input ? { input: args.input } : {}),
        ...(args.vars ? { vars: args.vars } : {}),
      });
      return ok(workflowRunView(run));
    },
  );

  server.registerTool(
    'workflow_run_list',
    {
      description:
        'List workflow runs, newest first, filtered by entry, workflow or status (e.g. ' +
        '"running", "waiting").',
      inputSchema: toolSchema('workflow_run_list', () =>
        z.object({
          entryId: z.string().optional(),
          workflowId: z.string().optional(),
          status: z.enum(WORKFLOW_RUN_STATUSES as unknown as [string, ...string[]]).optional(),
          limit: z.number().int().min(1).max(200).optional(),
          ...scopeArgs,
        }),
      ),
      annotations: READ_ONLY,
    },
    async (args) => {
      const s = scopeOf(args);
      guard(SCOPES.previewRead, s);
      const runs = await listWorkflowRuns(
        ctx,
        s,
        {
          entryId: args.entryId,
          workflowId: args.workflowId,
          status: args.status as WorkflowRunStatus | undefined,
          limit: args.limit,
        },
        principal,
      );
      return ok(runs.map(workflowRunView));
    },
  );

  server.registerTool(
    'workflow_run_get',
    {
      description:
        'Get a workflow run: status, plan, per-node detail and what it waits on. `include` adds ' +
        'its timeline and/or finished node runs.',
      inputSchema: toolSchema('workflow_run_get', () =>
        z.object({
          runId: z.string(),
          include: z.array(z.enum(['timeline', 'nodeRuns'])).optional(),
          ...scopeArgs,
        }),
      ),
      annotations: READ_ONLY,
    },
    async (args) => {
      const s = scopeOf(args);
      guard(SCOPES.previewRead, s);
      const run = workflowRunView(await getWorkflowRun(ctx, s, args.runId, principal));
      const include = new Set(args.include ?? []);
      return ok({
        run,
        ...(include.has('timeline')
          ? { timeline: await getWorkflowRunTimeline(ctx, s, args.runId, principal) }
          : {}),
        ...(include.has('nodeRuns')
          ? { nodeRuns: await listWorkflowNodeRuns(ctx, s, args.runId, principal) }
          : {}),
      });
    },
  );

  server.registerTool(
    'workflow_run_cancel',
    {
      description:
        'Cancel a workflow run: stops it, undoes its finished compensable steps (newest first), ' +
        'closes its open tasks and ends it cancelled. Does nothing to a finished run.',
      inputSchema: toolSchema('workflow_run_cancel', () =>
        z.object({ runId: z.string(), reason: z.string().max(500).optional(), ...scopeArgs }),
      ),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async (args) => {
      const s = scopeOf(args);
      guard(SCOPES.contentWrite, s);
      return ok(
        await cancelWorkflowRun(
          ctx,
          workflowEngine(),
          principal,
          s,
          args.runId,
          args.reason !== undefined ? { reason: args.reason } : {},
          deps.workflowNodes ?? { ai },
        ),
      );
    },
  );

  server.registerTool(
    'workflow_event_deliver',
    {
      description:
        'Deliver a business event (e.g. "legal.cleared") to the run node waiting for it. An ' +
        'event nothing waits for yet is held for the first wait that opens (buffered: true).',
      inputSchema: toolSchema('workflow_event_deliver', () =>
        z.object({
          runId: z.string(),
          event: z.string().min(1).max(100),
          payload: z.record(z.string(), z.unknown()).optional(),
          ...scopeArgs,
        }),
      ),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (args) => {
      const s = scopeOf(args);
      guard(SCOPES.contentWrite, s);
      return ok(
        await deliverWorkflowEvent(ctx, workflowEngine(), principal, s, {
          runId: args.runId,
          event: args.event,
          ...(args.payload ? { payload: args.payload } : {}),
        }),
      );
    },
  );

  server.registerTool(
    'workflow_task_list',
    {
      description:
        'List workflow tasks: approvals, event waits and agent reviews that runs hold open. ' +
        'Filter by status (e.g. "pending"), run, entry or kind.',
      inputSchema: toolSchema('workflow_task_list', () =>
        z.object({
          status: z
            .enum([
              'pending',
              'approved',
              'rejected',
              'escalated',
              'received',
              'timeout',
              'applied',
              'cancelled',
            ])
            .optional(),
          runId: z.string().optional(),
          entryId: z.string().optional(),
          kind: z.enum(['approval', 'event', 'review']).optional(),
          limit: z.number().int().min(1).max(200).optional(),
          ...scopeArgs,
        }),
      ),
      annotations: READ_ONLY,
    },
    async (args) => {
      const s = scopeOf(args);
      guard(SCOPES.previewRead, s);
      return ok(
        await listWorkflowTasks(
          ctx,
          s,
          {
            status: args.status,
            runId: args.runId,
            entryId: args.entryId,
            kind: args.kind,
            limit: args.limit,
          },
          principal,
        ),
      );
    },
  );

  server.registerTool(
    'workflow_task_decide',
    {
      description:
        'Approve or reject a workflow approval (or an agent review a run waits on). You need ' +
        'the task’s requiredScope and content-type grant; with separation of duties the run’s ' +
        'starter can’t decide, and an API token can’t decide at all.',
      inputSchema: toolSchema('workflow_task_decide', () =>
        z.object({
          taskId: z.string(),
          decision: z.enum(['approved', 'rejected']),
          note: z.string().max(2000).optional(),
          ...scopeArgs,
        }),
      ),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (args) => {
      const s = scopeOf(args);
      // The use-case checks the task's own scope (workflow:approve by default).
      guard(SCOPES.previewRead, s);
      return ok(
        await decideWorkflowTask(ctx, workflowEngine(), principal, s, {
          taskId: args.taskId,
          decision: args.decision,
          ...(args.note !== undefined ? { note: args.note } : {}),
        }),
      );
    },
  );

  server.registerTool(
    'workflow_settings_set',
    {
      description:
        'Set the space’s workflow settings. separateDuties is the default for approvals whose ' +
        'node leaves it unset (applies to approvals opened from then on). Needs space:admin.',
      inputSchema: toolSchema('workflow_settings_set', () =>
        z.object({ separateDuties: z.boolean(), ...scopeArgs }),
      ),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (args) => {
      const s = scopeOf(args);
      guard(SCOPES.spaceAdmin, s);
      await setWorkflowSeparationDefault(ctx, principal, s, args.separateDuties);
      return ok(await getWorkflowSettings(ctx, s));
    },
  );

  // --- taxonomy ----------------------------------------------------------
  server.registerTool(
    'taxonomy_list_tags',
    {
      description: 'List the flat tags defined in a space/environment.',
      inputSchema: toolSchema('taxonomy_list_tags', () => z.object(scopeArgs)),
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      return ok(await listTags(ctx, scopeOf(args)));
    },
  );

  server.registerTool(
    'taxonomy_create_tag',
    {
      description: 'Create a flat tag.',
      inputSchema: toolSchema('taxonomy_create_tag', () =>
        z.object({ name: z.string(), ...scopeArgs }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentManage, scopeOf(args));
      return ok(await createTag(ctx, scopeOf(args), { name: args.name }));
    },
  );

  server.registerTool(
    'taxonomy_create_scheme',
    {
      description: 'Create a concept scheme (a controlled vocabulary).',
      inputSchema: toolSchema('taxonomy_create_scheme', () =>
        z.object({ name: z.string(), ...scopeArgs }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentManage, scopeOf(args));
      return ok(await createScheme(ctx, scopeOf(args), { name: args.name }));
    },
  );

  server.registerTool(
    'taxonomy_list_concepts',
    {
      description: 'List concepts, optionally limited to one scheme.',
      inputSchema: toolSchema('taxonomy_list_concepts', () =>
        z.object({ scheme: z.string().optional(), ...scopeArgs }),
      ),
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      return ok(await listConcepts(ctx, scopeOf(args), args.scheme));
    },
  );

  server.registerTool(
    'taxonomy_create_concept',
    {
      description: 'Create a concept within a scheme, optionally nested under a broader concept.',
      inputSchema: toolSchema('taxonomy_create_concept', () =>
        z.object({
          schemeId: z.string(),
          prefLabel: z.string(),
          broaderId: z.string().optional(),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentManage, scopeOf(args));
      return ok(
        await createConcept(ctx, scopeOf(args), {
          schemeId: args.schemeId,
          prefLabel: args.prefLabel,
          broaderId: args.broaderId,
        }),
      );
    },
  );

  server.registerTool(
    'entries_set_metadata',
    {
      description:
        "Set an entry's taxonomy associations (tag ids + concept ids). Takes effect " +
        'on the next publish.',
      inputSchema: toolSchema('entries_set_metadata', () =>
        z.object({
          entryId: z.string(),
          tags: z.array(z.string()).optional(),
          concepts: z.array(z.string()).optional(),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      return ok(
        await setEntryMetadata(ctx, scopeOf(args), args.entryId, {
          tags: args.tags,
          concepts: args.concepts,
        }),
      );
    },
  );

  server.registerTool(
    'schedule_action',
    {
      description:
        'Schedule a publish/unpublish of an entry or release for a future ISO-8601 instant. A publish a gated workflow covers is refused (publish_gated) now, and fails if gating is on when it fires.',
      inputSchema: toolSchema('schedule_action', () =>
        z.object({
          action: z.enum(['publish', 'unpublish']),
          entityType: z.enum(['Entry', 'Release']),
          entityId: z.string(),
          scheduledFor: z.string().describe('ISO-8601 instant'),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentPublish, scopeOf(args));
      return ok(
        await scheduleAction(ctx, scopeOf(args), {
          action: args.action,
          entityType: args.entityType,
          entityId: args.entityId,
          scheduledFor: args.scheduledFor,
        }),
      );
    },
  );

  // --- agent schedules (recurring agent jobs) ------------------------------
  server.registerTool(
    'agent_schedule_create',
    {
      description:
        'Create a recurring agent job: on a cron cadence (UTC), run one agent ' +
        'workflow over entries published since the previous run.',
      inputSchema: toolSchema('agent_schedule_create', () =>
        z.object({
          workflow: z.enum(AGENT_WORKFLOWS),
          cron: z.string().describe('5-field cron expression, evaluated in UTC'),
          contentTypeApiId: z.string().optional(),
          enabled: z.boolean().optional(),
          autoApply: z.boolean().optional(),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentPublish, scopeOf(args));
      return ok(
        await createAgentSchedule(ctx, scopeOf(args), {
          workflow: args.workflow,
          cron: args.cron,
          contentTypeApiId: args.contentTypeApiId,
          enabled: args.enabled,
          autoApply: args.autoApply,
        }),
      );
    },
  );

  server.registerTool(
    'agent_schedule_list',
    {
      description: 'List the recurring agent jobs configured for a space environment.',
      inputSchema: toolSchema('agent_schedule_list', () => z.object({ ...scopeArgs })),
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      return ok({ items: await listAgentSchedules(ctx, scopeOf(args)) });
    },
  );

  server.registerTool(
    'agent_schedule_update',
    {
      description:
        'Update a recurring agent job (cron cadence, enabled, autoApply, content-type filter).',
      inputSchema: toolSchema('agent_schedule_update', () =>
        z.object({
          id: z.string(),
          cron: z.string().optional(),
          enabled: z.boolean().optional(),
          autoApply: z.boolean().optional(),
          contentTypeApiId: z.string().nullable().optional(),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentPublish, scopeOf(args));
      return ok(
        await updateAgentSchedule(ctx, scopeOf(args), args.id, {
          cron: args.cron,
          enabled: args.enabled,
          autoApply: args.autoApply,
          contentTypeApiId: args.contentTypeApiId,
        }),
      );
    },
  );

  // --- agent reviews (human-in-the-loop) -----------------------------------
  server.registerTool(
    'agent_review_list',
    {
      description: 'List agent proposals awaiting (or past) human review.',
      inputSchema: toolSchema('agent_review_list', () =>
        z.object({
          status: z.enum(['pending', 'approved', 'rejected']).optional(),
          entryId: z.string().optional(),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      const items = await listAgentReviews(ctx, scopeOf(args), {
        status: args.status,
        entryId: args.entryId,
      });
      if (!principal.contentGrants) return ok({ items });
      const visible = [];
      for (const review of items) {
        try {
          const entry = await getPreviewEntry(ctx, scopeOf(args), review.entryId);
          if (!canAccessContentType(principal, 'read', entry.contentType)) continue;
          visible.push({
            ...review,
            proposed: maskDeniedFields(principal, entry.contentType, review.proposed),
          });
        } catch {
          // entry gone — skip rather than leak an unmaskable proposal
        }
      }
      return ok({ items: visible });
    },
  );

  // Granular RBAC for a review decision: role-bound principals need write on
  // the entry's content type and every proposed field must be writable.
  const guardReviewDecision = async (s: Scope, reviewId: string) => {
    if (!principal.contentGrants) return;
    const review = await getAgentReview(ctx, s, reviewId);
    try {
      const entry = await getPreviewEntry(ctx, s, review.entryId);
      authorizeContent(principal, 'write', entry.contentType);
      assertWritableFields(principal, entry.contentType, review.proposed);
    } catch (err) {
      if ((err as { code?: string }).code === 'not_found') return; // entry gone
      throw err;
    }
  };

  server.registerTool(
    'agent_review_approve',
    {
      description:
        'Approve a pending agent proposal: its field values are applied as a new draft version (exactly once).',
      inputSchema: toolSchema('agent_review_approve', () =>
        z.object({ id: z.string(), ...scopeArgs }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      await guardReviewDecision(scopeOf(args), args.id);
      return ok(
        await decideAgentReview(
          ctx,
          scopeOf(args),
          args.id,
          { approve: true, decidedBy: principal.subject ?? principal.kind },
          { signalReview: deps.signalReview },
        ),
      );
    },
  );

  server.registerTool(
    'agent_review_reject',
    {
      description: 'Reject a pending agent proposal (nothing is applied).',
      inputSchema: toolSchema('agent_review_reject', () =>
        z.object({ id: z.string(), ...scopeArgs }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      await guardReviewDecision(scopeOf(args), args.id);
      return ok(
        await decideAgentReview(
          ctx,
          scopeOf(args),
          args.id,
          { approve: false, decidedBy: principal.subject ?? principal.kind },
          { signalReview: deps.signalReview },
        ),
      );
    },
  );

  server.registerTool(
    'agent_schedule_delete',
    {
      description: 'Delete a recurring agent job.',
      inputSchema: toolSchema('agent_schedule_delete', () =>
        z.object({ id: z.string(), ...scopeArgs }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentPublish, scopeOf(args));
      await deleteAgentSchedule(ctx, scopeOf(args), args.id);
      return ok({ deleted: true });
    },
  );

  // --- audit log (governance) --------------------------------------------
  server.registerTool(
    'audit_log_list',
    {
      description: 'List a space’s append-only audit trail (mutating actions), newest first.',
      inputSchema: toolSchema('audit_log_list', () =>
        z.object({
          space: z.string().optional(),
          environment: z.string().optional(),
          limit: z.number().int().positive().optional(),
        }),
      ),
    },
    async (args) => {
      const spaceId = args.space ?? DEFAULT_SPACE;
      guard(SCOPES.spaceAdmin, { spaceId, environmentId: DEFAULT_ENV });
      return ok(
        await listAuditLog(ctx, spaceId, { environmentId: args.environment, limit: args.limit }),
      );
    },
  );

  // --- assets / media intelligence ---------------------------------------
  // Reads hand out a short-lived signed URL, never the stored non-expiring one (as the REST
  // routes do). Without a blob store (local fakes) there is nothing to sign with.
  const signedOne = (s: Scope, asset: Asset) =>
    deps.blob ? withReadUrl(deps.blob, s, asset) : Promise.resolve(asset);
  const signedPage = async <P extends { items: Asset[] }>(s: Scope, page: P): Promise<P> => ({
    ...page,
    items: await Promise.all(page.items.map((a) => signedOne(s, a))),
  });
  server.registerTool(
    'assets_list',
    {
      description:
        'List the asset library in a space/environment, one page at a time: filter by kind, ' +
        'content type, tag, folder and status (archived assets are left out unless asked for), ' +
        'sort, and pass nextCursor back as cursor for the next page.',
      inputSchema: toolSchema('assets_list', () =>
        z.object({
          limit: z.number().int().positive().max(100).optional(),
          cursor: z.string().optional().describe('nextCursor from the previous page'),
          kind: z.enum(ASSET_KINDS as unknown as [string, ...string[]]).optional(),
          mime: z.string().max(256).optional().describe('exact (image/png) or family (image/*)'),
          tag: z.string().max(128).optional().describe('taxonomy tag id'),
          folderId: z
            .string()
            .nullable()
            .optional()
            .describe('assets filed in this folder; null for those in no folder'),
          status: z.enum(['draft', 'published', 'archived', 'all']).optional(),
          sort: z.enum(['updatedAt', 'createdAt', 'size']).optional(),
          order: z.enum(['asc', 'desc']).optional(),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      return ok(
        await signedPage(
          scopeOf(args),
          await listAssets(ctx, scopeOf(args), {
            ...(args.limit ? { limit: args.limit } : {}),
            ...(args.cursor ? { cursor: args.cursor } : {}),
            filters: {
              ...(args.kind ? { kind: args.kind as (typeof ASSET_KINDS)[number] } : {}),
              ...(args.mime ? { mime: args.mime } : {}),
              ...(args.tag ? { tag: args.tag } : {}),
              ...(args.folderId !== undefined ? { folderId: args.folderId } : {}),
              ...(args.status ? { status: args.status } : {}),
            },
            ...(args.sort || args.order
              ? { sort: { field: args.sort ?? 'updatedAt', direction: args.order ?? 'desc' } }
              : {}),
          }),
        ),
      );
    },
  );

  // Preview's asset reads (`GET /preview/…/assets[/:id]`): drafts included, archived left out, in
  // the shape Delivery serves, every URL signed and short-lived. Same scope and the same refusal
  // of a content-granted key as the REST routes.
  const previewBlob = () => {
    if (!deps.blob) throw new NotConfiguredError('blob', 'Preview asset reads need a blob store');
    return deps.blob;
  };
  server.registerTool(
    'asset_preview_list',
    {
      description:
        'List the asset library as Preview serves it: drafts and published (archived left out), ' +
        'in the delivered shape (url, renditions, srcset) with short-lived signed URLs. Filter ' +
        'by kind, tag or folder; pass nextCursor back as cursor for the next page. A key with ' +
        'content grants reads none.',
      inputSchema: toolSchema('asset_preview_list', () =>
        z.object({
          limit: z.number().int().positive().max(100).optional(),
          cursor: z.string().optional().describe('nextCursor from the previous page'),
          kind: z.enum(ASSET_KINDS as unknown as [string, ...string[]]).optional(),
          tag: z.string().max(128).optional().describe('taxonomy tag id'),
          folderId: z
            .string()
            .nullable()
            .optional()
            .describe('assets filed in this folder; null for those in no folder'),
          locale: z
            .string()
            .optional()
            .describe('resolve title, description and alt text for one locale'),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      // As the REST route: a key with content grants reads no assets.
      if (principal.contentGrants) return ok({ items: [], total: 0 });
      const page = await listPreviewAssets(
        ctx,
        previewBlob(),
        scopeOf(args),
        {
          ...(args.limit ? { limit: args.limit } : {}),
          ...(args.cursor ? { cursor: args.cursor } : {}),
          filters: {
            ...(args.kind ? { kind: args.kind as (typeof ASSET_KINDS)[number] } : {}),
            ...(args.tag ? { tag: args.tag } : {}),
            ...(args.folderId !== undefined ? { folderId: args.folderId } : {}),
          },
        },
        args.locale !== undefined ? { locale: args.locale } : {},
      );
      return ok({ ...page, total: page.items.length });
    },
  );

  server.registerTool(
    'asset_preview_get',
    {
      description:
        'Get one asset as Preview serves it, draft or published (not archived), in the ' +
        'delivered shape with short-lived signed URLs. Refused for a key with content grants.',
      inputSchema: toolSchema('asset_preview_get', () =>
        z.object({
          id: z.string(),
          locale: z
            .string()
            .optional()
            .describe('resolve title, description and alt text for one locale'),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      if (principal.contentGrants) {
        throw new ForbiddenError('assets (a key with content grants reads no assets)');
      }
      return ok(
        await getPreviewAsset(
          ctx,
          previewBlob(),
          scopeOf(args),
          args.id,
          args.locale !== undefined ? { locale: args.locale } : {},
        ),
      );
    },
  );

  server.registerTool(
    'assets_move',
    {
      description: `File assets in a folder (folderId null: the library root), up to ${MAX_ASSET_MOVE} at once. Ids that are not assets here are skipped.`,
      inputSchema: toolSchema('assets_move', () =>
        z.object({
          ids: z.array(z.string()).min(1).max(MAX_ASSET_MOVE),
          folderId: z.string().nullable(),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      return ok(await moveAssets(ctx, scopeOf(args), { ids: args.ids, folderId: args.folderId }));
    },
  );

  server.registerTool(
    'asset_archive',
    {
      description:
        'Archive an asset: it leaves Delivery at once when published and is hidden from the ' +
        'default listing until restored. Idempotent.',
      inputSchema: toolSchema('asset_archive', () => z.object({ id: z.string(), ...scopeArgs })),
    },
    async (args) => {
      guard(SCOPES.contentPublish, scopeOf(args));
      return ok(await signedOne(scopeOf(args), await archiveAsset(ctx, scopeOf(args), args.id)));
    },
  );

  server.registerTool(
    'asset_restore',
    {
      description: 'Restore an archived asset as a draft (publish it again separately).',
      inputSchema: toolSchema('asset_restore', () => z.object({ id: z.string(), ...scopeArgs })),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      return ok(await signedOne(scopeOf(args), await restoreAsset(ctx, scopeOf(args), args.id)));
    },
  );

  server.registerTool(
    'asset_delete',
    {
      description:
        'Delete an asset permanently, with its files. Refused while entries link to it: the ' +
        'result then lists those links (usage); archive it instead, or remove the links first.',
      inputSchema: toolSchema('asset_delete', () => z.object({ id: z.string(), ...scopeArgs })),
    },
    async (args) => {
      guard(SCOPES.contentPublish, scopeOf(args));
      try {
        await deleteAsset(ctx, scopeOf(args), args.id);
      } catch (err) {
        if (!(err instanceof AssetInUseError)) throw err;
        return {
          ...ok({
            error: { code: err.code, message: err.message, usage: err.usage, total: err.total },
          }),
          isError: true,
        };
      }
      return ok({ deleted: args.id });
    },
  );

  server.registerTool(
    'asset_folders_list',
    {
      description: 'List the asset library’s folders, a parent before its children.',
      inputSchema: toolSchema('asset_folders_list', () => z.object(scopeArgs)),
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      return ok(await listAssetFolders(ctx, scopeOf(args)));
    },
  );

  server.registerTool(
    'asset_folders_create',
    {
      description:
        'Create an asset folder at the root or inside parentId. Sibling names are unique.',
      inputSchema: toolSchema('asset_folders_create', () =>
        z.object({
          name: z.string().min(1).max(128),
          parentId: z.string().nullable().optional(),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      return ok(
        await createAssetFolder(ctx, scopeOf(args), { name: args.name, parentId: args.parentId }),
      );
    },
  );

  server.registerTool(
    'asset_folders_update',
    {
      description:
        'Rename an asset folder and/or move it (parentId null: to the root). A move takes its ' +
        'subfolders along.',
      inputSchema: toolSchema('asset_folders_update', () =>
        z.object({
          id: z.string(),
          name: z.string().min(1).max(128).optional(),
          parentId: z.string().nullable().optional(),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      return ok(
        await updateAssetFolder(ctx, scopeOf(args), args.id, {
          ...(args.name !== undefined ? { name: args.name } : {}),
          ...(args.parentId !== undefined ? { parentId: args.parentId } : {}),
        }),
      );
    },
  );

  server.registerTool(
    'asset_folders_delete',
    {
      description: 'Delete an empty asset folder (one with subfolders or assets is refused).',
      inputSchema: toolSchema('asset_folders_delete', () =>
        z.object({ id: z.string(), ...scopeArgs }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      await deleteAssetFolder(ctx, scopeOf(args), args.id);
      return ok({ deleted: args.id });
    },
  );

  const renditionSpec = {
    width: z.number().int().min(1).max(4096).optional(),
    height: z.number().int().min(1).max(4096).optional(),
    fit: z.enum(['clip', 'crop', 'fill', 'max', 'scale']).optional(),
    format: z.enum(['auto', 'jpg', 'png', 'webp', 'avif']).optional(),
    quality: z.number().int().min(1).max(100).optional(),
  };
  const specOf = (args: {
    width?: number;
    height?: number;
    fit?: RenditionFit;
    format?: RenditionFormat;
    quality?: number;
  }) => ({
    ...(args.width !== undefined ? { width: args.width } : {}),
    ...(args.height !== undefined ? { height: args.height } : {}),
    ...(args.fit !== undefined ? { fit: args.fit } : {}),
    ...(args.format !== undefined ? { format: args.format } : {}),
    ...(args.quality !== undefined ? { quality: args.quality } : {}),
  });

  server.registerTool(
    'asset_renditions_list',
    {
      description:
        'List the space’s rendition presets (named image sizes, the same in every environment). ' +
        'Delivered images carry a URL for each, at …/r-<name>/… on the media origin.',
      inputSchema: toolSchema('asset_renditions_list', () => z.object(scopeArgs)),
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      return ok({ items: await listAssetRenditions(ctx, scopeOf(args)) });
    },
  );

  server.registerTool(
    'asset_renditions_create',
    {
      description:
        'Create a rendition preset: a name (lowercase letters, digits, dashes) and what it does ' +
        '(width, height, fit, format, quality; at least a width, height or format). A space has ' +
        'at most 20.',
      inputSchema: toolSchema('asset_renditions_create', () =>
        z.object({
          name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
          ...renditionSpec,
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentManage, scopeOf(args));
      return ok(
        await createAssetRendition(ctx, scopeOf(args), { name: args.name, ...specOf(args) }),
      );
    },
  );

  server.registerTool(
    'asset_renditions_update',
    {
      description:
        'Replace what a rendition preset does. Its URLs stay the same; the media cached under ' +
        'them is purged in the background.',
      inputSchema: toolSchema('asset_renditions_update', () =>
        z.object({ name: z.string(), ...renditionSpec, ...scopeArgs }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentManage, scopeOf(args));
      return ok(await updateAssetRendition(ctx, scopeOf(args), args.name, specOf(args)));
    },
  );

  server.registerTool(
    'asset_renditions_delete',
    {
      description: 'Delete a rendition preset; its URLs answer 404 once their media is purged.',
      inputSchema: toolSchema('asset_renditions_delete', () =>
        z.object({ name: z.string(), ...scopeArgs }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentManage, scopeOf(args));
      await deleteAssetRendition(ctx, scopeOf(args), args.name);
      return ok({ deleted: args.name });
    },
  );

  server.registerTool(
    'asset_set_metadata',
    {
      description:
        'Update an asset’s editorial metadata: localized alt text, focal point ' +
        '(x/y in 0..1 for smart cropping), taxonomy tag ids, and custom fields.',
      inputSchema: toolSchema('asset_set_metadata', () =>
        z.object({
          id: z.string(),
          altText: z.record(z.string(), z.string()).optional().describe('locale -> alt text'),
          tags: z.array(z.string()).optional().describe('taxonomy tag ids'),
          focalPoint: z.object({ x: z.number(), y: z.number() }).optional(),
          fields: z.record(z.string(), z.any()).optional(),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      return ok(
        await setAssetMetadata(ctx, scopeOf(args), args.id, {
          altText: args.altText,
          tags: args.tags,
          focalPoint: args.focalPoint,
          fields: args.fields,
        }),
      );
    },
  );

  server.registerTool(
    'asset_usage',
    {
      description: 'List the entries that reference an asset (where it is used).',
      inputSchema: toolSchema('asset_usage', () => z.object({ id: z.string(), ...scopeArgs })),
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      return ok(await getAssetUsage(ctx, scopeOf(args), args.id));
    },
  );

  server.registerTool(
    'asset_generate_alt_text',
    {
      description:
        'Suggest accessibility/SEO alt text for an image asset; set apply=true to ' +
        'write it to the asset metadata. Recorded in the agent cost ledger.',
      inputSchema: toolSchema('asset_generate_alt_text', () =>
        z.object({
          id: z.string(),
          locale: z.string().optional(),
          context: z.string().optional().describe('extra context about how the image is used'),
          apply: z.boolean().optional(),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      return ok(
        await generateAltText(ctx, ai, scopeOf(args), args.id, {
          locale: args.locale,
          context: args.context,
          apply: args.apply,
        }),
      );
    },
  );

  server.registerTool(
    'asset_auto_tag',
    {
      description:
        'Suggest taxonomy tags for an image asset (matching the existing vocabulary ' +
        'and proposing new names); set apply=true to create + assign them.',
      inputSchema: toolSchema('asset_auto_tag', () =>
        z.object({ id: z.string(), apply: z.boolean().optional(), ...scopeArgs }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      return ok(await autoTagAsset(ctx, ai, scopeOf(args), args.id, { apply: args.apply }));
    },
  );

  server.registerTool(
    'asset_transform_url',
    {
      description:
        'Build a transformed-image URL for an asset (resize/crop/format/quality), ' +
        'anchored to the stored focal point when cropping.',
      inputSchema: toolSchema('asset_transform_url', () =>
        z.object({
          id: z.string(),
          width: z.number().int().positive().optional(),
          height: z.number().int().positive().optional(),
          fit: z.enum(['clip', 'crop', 'fill', 'max', 'scale']).optional(),
          format: z
            .enum(['auto', 'jpg', 'png', 'webp', 'avif'])
            .optional()
            .describe('auto negotiates AVIF/WebP per client'),
          quality: z.number().int().min(1).max(100).optional(),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      return ok(
        await transformAssetUrl(ctx, scopeOf(args), args.id, {
          width: args.width,
          height: args.height,
          fit: args.fit,
          format: args.format,
          quality: args.quality,
        }),
      );
    },
  );

  server.registerTool(
    'asset_video_create',
    {
      description:
        'Create a draft video asset and get a one-time direct upload URL on the video host ' +
        '(Cloudflare Stream). The client POSTs the file as multipart field `fileField` to ' +
        '`uploadUrl`; then call asset_video_refresh until file.video.status is ready.',
      inputSchema: toolSchema('asset_video_create', () =>
        z.object({
          fileName: z.string().min(1),
          contentType: z.string().describe('video/* MIME type'),
          title: z.record(z.string(), z.string()).optional().describe('locale -> title'),
          maxDurationSeconds: z.number().int().positive().optional(),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      return ok(
        await createVideoAsset(ctx, scopeOf(args), {
          fileName: args.fileName,
          contentType: args.contentType,
          title: args.title,
          maxDurationSeconds: args.maxDurationSeconds,
        }),
      );
    },
  );

  server.registerTool(
    'asset_video_refresh',
    {
      description:
        "Refresh a video asset's processing status, playback URLs (HLS/DASH) and poster from the video host.",
      inputSchema: toolSchema('asset_video_refresh', () =>
        z.object({ id: z.string(), ...scopeArgs }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      return ok(await refreshVideoAsset(ctx, scopeOf(args), args.id));
    },
  );

  // --- branch compare/merge ----------------------------------------------
  server.registerTool(
    'environments_compare',
    {
      description: 'Diff two environments in a space (content types + entries that differ).',
      inputSchema: toolSchema('environments_compare', () =>
        z.object({
          source: z.string(),
          target: z.string(),
          space: z.string().optional(),
        }),
      ),
    },
    async (args) => {
      const spaceId = args.space ?? DEFAULT_SPACE;
      guard(SCOPES.previewRead, { spaceId, environmentId: args.source });
      return ok(await compareEnvironments(ctx, spaceId, args.source, args.target));
    },
  );

  server.registerTool(
    'environments_merge',
    {
      description:
        'Apply selected content types/entries from a source environment into a target (additive).',
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
        await mergeEnvironments(ctx, spaceId, args.source, args.target, {
          contentTypes: args.contentTypes,
          entries: args.entries,
        }),
      );
    },
  );

  // --- spaces (deployment) -------------------------------------------------
  server.registerTool(
    'spaces_list',
    {
      description:
        'List the spaces this credential can reach (every space for the deployment admin ' +
        'token; otherwise the one space the key or token belongs to), as { id, name }.',
      inputSchema: toolSchema('spaces_list', () => z.object({})),
    },
    async () => {
      const items = await listSpacesFor(ctx, principal);
      return ok({ items: items.map((s) => ({ id: s.spaceId, name: s.name })) });
    },
  );

  server.registerTool(
    'space_create',
    {
      description:
        'Create a space with its locales and environments (`main` by default). Deployment ' +
        'administrators only: a space’s own keys and tokens cannot create spaces. ' +
        '`starter: "sample"` also installs sample content into the first environment (a content ' +
        'model covering every field type, a few dozen entries, taxonomy, sample images and ' +
        'documents, one open release); "empty" (the default) creates it with nothing in it. ' +
        'An existing id is updated, not refused, and repeating a sample create finishes an ' +
        'install that failed part-way.',
      inputSchema: toolSchema('space_create', () =>
        z.object({
          spaceId: z
            .string()
            .regex(SPACE_ID_PATTERN)
            .describe(
              '1–64 letters, digits, ".", "_" or "-", starting with a letter or digit; not versions, imports, plugins or dlq (reserved)',
            ),
          name: z.string().max(256),
          defaultLocale: z.string().min(2).max(35),
          locales: z.array(z.string().min(2).max(35)).max(200).optional(),
          environments: z.array(z.string().min(1).max(128)).max(100).optional(),
          starter: z.enum(STARTERS).optional().describe('"empty" (default) or "sample"'),
        }),
      ),
    },
    async (args) => {
      // The same check as POST /spaces: space:admin across the deployment, not in one space.
      authorize(principal, SCOPES.spaceAdmin, '*');
      const created = await createSpaceWithStarter(ctx, args, { blob: deps.blob });
      return ok({
        id: created.space.spaceId,
        name: created.space.name,
        starter: created.starter,
        ...(created.installed ? { installed: created.installed } : {}),
      });
    },
  );

  // --- promotions (environment → environment, with approval) -------------
  server.registerTool(
    'promotion_request',
    {
      description:
        'Promote content from one environment to another. Pins the entries to copy (what is live ' +
        'in the source goes live in the target; drafts go as drafts) and runs a risk check. ' +
        'Applies at once when nothing stops it; otherwise it waits as `awaiting_approval` (into ' +
        'main or an aliased environment, a field removed or retyped, or the risk check flagged ' +
        'it), and someone other than you approves it with promotion_approve. Omit contentTypes ' +
        'and entries to promote everything that differs (at most 200 entries).',
      inputSchema: toolSchema('promotion_request', () =>
        z.object({
          source: z.string(),
          target: z.string(),
          contentTypes: z.array(z.string()).max(MAX_PROMOTION_CONTENT_TYPES).optional(),
          entries: z.array(z.string()).max(MAX_PROMOTION_ENTRIES).optional(),
          space: z.string().optional(),
        }),
      ),
    },
    async (args) => {
      const spaceId = args.space ?? DEFAULT_SPACE;
      guard(SCOPES.contentManage, { spaceId, environmentId: args.target });
      guard(SCOPES.contentPublish, { spaceId, environmentId: args.target });
      return ok(
        await requestPromotion(ctx, principal, spaceId, {
          source: args.source,
          target: args.target,
          ...(args.contentTypes ? { contentTypes: args.contentTypes } : {}),
          ...(args.entries ? { entries: args.entries } : {}),
        }),
      );
    },
  );

  server.registerTool(
    'promotion_list',
    {
      description: 'List promotions, newest first, optionally only those with one status.',
      inputSchema: toolSchema('promotion_list', () =>
        z.object({
          status: z.enum(PROMOTION_STATUSES).optional(),
          space: z.string().optional(),
        }),
      ),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const spaceId = args.space ?? DEFAULT_SPACE;
      guard(SCOPES.contentPublish, { spaceId, environmentId: DEFAULT_ENV });
      return ok(await listPromotions(ctx, spaceId, args.status ? { status: args.status } : {}));
    },
  );

  server.registerTool(
    'promotion_get',
    {
      description: 'Get a promotion: what it copies, its risk check and why, and its result.',
      inputSchema: toolSchema('promotion_get', () =>
        z.object({ id: z.string(), space: z.string().optional() }),
      ),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const spaceId = args.space ?? DEFAULT_SPACE;
      guard(SCOPES.contentPublish, { spaceId, environmentId: DEFAULT_ENV });
      return ok(await getPromotion(ctx, spaceId, args.id));
    },
  );

  server.registerTool(
    'promotion_approve',
    {
      description:
        'Approve a promotion waiting for approval, and apply it. Refused for whoever requested it.',
      inputSchema: toolSchema('promotion_approve', () =>
        z.object({ id: z.string(), space: z.string().optional() }),
      ),
    },
    async (args) => {
      const spaceId = args.space ?? DEFAULT_SPACE;
      guard(SCOPES.contentPublish, { spaceId, environmentId: DEFAULT_ENV });
      return ok(await approvePromotion(ctx, principal, spaceId, args.id));
    },
  );

  server.registerTool(
    'promotion_reject',
    {
      description: 'Reject a promotion waiting for approval; nothing is copied.',
      inputSchema: toolSchema('promotion_reject', () =>
        z.object({ id: z.string(), space: z.string().optional() }),
      ),
    },
    async (args) => {
      const spaceId = args.space ?? DEFAULT_SPACE;
      guard(SCOPES.contentPublish, { spaceId, environmentId: DEFAULT_ENV });
      return ok(await rejectPromotion(ctx, principal, spaceId, args.id));
    },
  );

  // --- environment aliases (blue/green) ----------------------------------
  server.registerTool(
    'environment_aliases_list',
    {
      description: 'List a space’s environment aliases (repointable pointers to environments).',
      inputSchema: toolSchema('environment_aliases_list', () =>
        z.object({ space: z.string().optional() }),
      ),
    },
    async (args) => {
      const spaceId = args.space ?? DEFAULT_SPACE;
      guard(SCOPES.previewRead, { spaceId, environmentId: DEFAULT_ENV });
      return ok(await listEnvironmentAliases(ctx, spaceId));
    },
  );

  server.registerTool(
    'environment_alias_set',
    {
      description: 'Create or atomically repoint an environment alias at a target environment.',
      inputSchema: toolSchema('environment_alias_set', () =>
        z.object({
          alias: z.string(),
          targetEnvironmentId: z.string(),
          space: z.string().optional(),
        }),
      ),
    },
    async (args) => {
      const spaceId = args.space ?? DEFAULT_SPACE;
      guard(SCOPES.spaceAdmin, { spaceId, environmentId: DEFAULT_ENV });
      return ok(await setEnvironmentAlias(ctx, spaceId, args.alias, args.targetEnvironmentId));
    },
  );

  server.registerTool(
    'environment_alias_delete',
    {
      description: 'Delete an environment alias (the target environment is untouched).',
      inputSchema: toolSchema('environment_alias_delete', () =>
        z.object({ alias: z.string(), space: z.string().optional() }),
      ),
    },
    async (args) => {
      const spaceId = args.space ?? DEFAULT_SPACE;
      guard(SCOPES.spaceAdmin, { spaceId, environmentId: DEFAULT_ENV });
      await deleteEnvironmentAlias(ctx, spaceId, args.alias);
      return ok({ deleted: args.alias });
    },
  );

  server.registerTool(
    'environment_delete',
    {
      description:
        'Delete an environment and everything in it (content model, entries, versions, assets, ' +
        'releases, workflows; its audit history stays). IRREVERSIBLE. Refuses `main` and any ' +
        'environment an alias points at. `confirm` must repeat the environment id.',
      inputSchema: toolSchema('environment_delete', () =>
        z.object({
          environment: z.string(),
          confirm: z.string().describe('the environment id again, to confirm'),
          space: z.string().optional(),
        }),
      ),
    },
    async (args) => {
      const spaceId = args.space ?? DEFAULT_SPACE;
      guard(SCOPES.spaceAdmin, { spaceId, environmentId: args.environment });
      return ok(
        await deleteEnvironment(ctx, spaceId, args.environment, {
          confirm: args.confirm,
          principal,
        }),
      );
    },
  );

  skills?.attach(server);
  return server;
}
