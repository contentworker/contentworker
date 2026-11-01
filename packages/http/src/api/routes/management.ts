import {
  addComment,
  addEntryToRelease,
  agentUsage,
  analyzeImport,
  applyEntryTags,
  approvePluginCapabilities,
  approvePromotion,
  auditEntry,
  autofillField,
  autoTagAsset,
  bulkCreateEntries,
  bulkEntryAction,
  cancelBulkJob,
  cancelScheduledAction,
  canvasToEntry,
  cloneEnvironment,
  compareEnvironments,
  countEntriesByContentType,
  createAgentSchedule,
  createAIAction,
  createApiKey,
  createAppExtension,
  createAsset,
  createConcept,
  createContentType,
  createEntry,
  createEnvironment,
  createFunction,
  createPersonalAccessToken,
  createPreviewLink,
  createRelease,
  createRole,
  createScheme,
  createTag,
  createTask,
  createVideoAsset,
  createWebhook,
  decideAgentReview,
  deleteAgentSchedule,
  deleteAIAction,
  deleteAppExtension,
  deleteComment,
  deleteConcept,
  deleteEnvironment,
  deleteEnvironmentAlias,
  deleteFunction,
  deleteRelease,
  deleteRole,
  deleteScheme,
  deleteTag,
  deleteTask,
  deleteWebhook,
  deleteWorkflow,
  diffVersions,
  draftEntry,
  duplicateEntry,
  type EnvironmentSnapshot,
  executeImport,
  exportSnapshot,
  findDuplicates,
  generateAltText,
  getAgentReview,
  getAsset,
  getAssetUsage,
  getBulkJob,
  getBulkJobReport,
  getContentType,
  getEntry,
  getEntryEmbedding,
  getEntryMetadata,
  getEntryWorkflowState,
  getPlugin,
  getPromotion,
  getRelease,
  getReverseReferences,
  getRole,
  getSpaceConfig,
  getVersion,
  getWorkflow,
  importSnapshot,
  inspectPluginPackage,
  installPlugin,
  installPluginFromUrl,
  listAgentReviews,
  listAgentRuns,
  listAgentSchedules,
  listAIActions,
  listApiKeys,
  listAppExtensions,
  listAssets,
  listAuditLog,
  listBulkJobs,
  listComments,
  listConcepts,
  listConnectedApps,
  listContentTypes,
  listEnvironmentAliases,
  listEnvironments,
  listFunctions,
  listPersonalAccessTokens,
  listPlugins,
  listPromotions,
  listReleases,
  listRoles,
  listScheduledActions,
  listSchemes,
  listSpacesFor,
  listTags,
  listTasks,
  listVersions,
  listWebhookDeliveries,
  listWebhooks,
  listWorkflows,
  mergeEnvironments,
  moderateEntry,
  parseImageTransform,
  publishAsset,
  publishContentType,
  publishEntry,
  publishRelease,
  purgeEntry,
  reassignTask,
  refreshVideoAsset,
  rejectPromotion,
  relatedEntries,
  removeEntryFromRelease,
  reopenTask,
  requestPromotion,
  requestReindex,
  resolveTask,
  restoreEntry,
  restoreVersion,
  revokeApiKey,
  revokeConnectedApp,
  revokeEverythingFor,
  runAIAction,
  scheduleAction,
  searchIndexHealth,
  setAssetMetadata,
  setConceptBroader,
  setEntryMetadata,
  setEnvironmentAlias,
  setPluginEnabled,
  startBulkJob,
  startEnvironmentClone,
  startImportJob,
  startSnapshotImport,
  suggestEntryTags,
  summarizeEntry,
  transformAssetUrl,
  transitionEntry,
  translateEntry,
  trashEntry,
  uninstallPlugin,
  unpublishAsset,
  unpublishEntry,
  updateAgentSchedule,
  updateEntry,
  updateRole,
  updateWebhook,
  upgradePlugin,
  upgradePluginFromUrl,
} from '@contentworker/application';
import { listDocs, readDoc, searchDocs } from '@contentworker/docs';
import {
  type ApiKey,
  assertWritableFields,
  authorize,
  authorizeContent,
  type ContentAction,
  canAccessContentType,
  effectivePluginGrant,
  ForbiddenError,
  type InstalledPlugin,
  maskDeniedFields,
  NotFoundError,
  PROMOTION_STATUSES,
  type PromotionStatus,
  SCOPES,
  type Scope,
  ValidationError,
  type Webhook,
} from '@contentworker/domain';
import type { ImportSource } from '@contentworker/ports';
import { generateTypes } from '@contentworker/sdk-codegen';
import { createSpaceWithStarter } from '@contentworker/seed';
import { type Context, Hono } from 'hono';
import {
  type AuthDeps,
  type AuthVars,
  auditMiddleware,
  environmentMiddleware,
  principalMiddleware,
  requireScope,
} from '../auth';
import { doc } from '../docs/openapi';
import * as docs from '../docs/schemas';
import { clampCount, MAX_PAGE_LIMIT } from '../query';
import {
  agentScheduleBody,
  agentSchedulePatchBody,
  altTextBody,
  appExtensionBody,
  applyTagsBody,
  assetMetadataBody,
  auditBody,
  autofillBody,
  broaderBody,
  bulkEntriesBody,
  bulkJobBody,
  canvasBody,
  cloneBody,
  commentBody,
  conceptBody,
  contentTypeBody,
  createAiActionBody,
  createApiKeyBody,
  createAssetBody,
  createEntryBody,
  createEnvironmentBody,
  createFunctionBody,
  createPatBody,
  createReleaseBody,
  createSpaceBody,
  createTaskBody,
  createVideoAssetBody,
  draftEntryBody,
  entryMetadataBody,
  idsBody,
  importBody,
  inspectPluginBody,
  installPluginBody,
  installPluginFromUrlBody,
  mergeBody,
  parseBody,
  pluginCapabilitiesBody,
  pluginEnabledBody,
  previewLinkBody,
  promotionBody,
  reindexBody,
  releaseItemBody,
  revokeConnectionBody,
  roleBody,
  runAiActionBody,
  scheduleBody,
  schemeBody,
  setAliasBody,
  snapshotBody,
  summarizeBody,
  tagBody,
  tierOnlyBody,
  transitionBody,
  translateBody,
  updateEntryBody,
  updateTaskBody,
  updateWebhookBody,
  upgradePluginFromUrlBody,
  webhookBody,
} from '../validation';
import { workflowRoutes } from './workflows';

// Reads the route's scope, preferring the alias-resolved environment id stamped
// by environmentMiddleware over the raw `:env` param.
const scopeOf = (c: Context<AuthVars>): Scope => ({
  spaceId: c.req.param('space') as string,
  environmentId: c.get('environmentId') ?? (c.req.param('env') as string),
});

// Public projections that strip secrets before they leave the server: API keys
// never expose their stored hash, webhooks never expose their signing secret.
const apiKeySummary = (k: ApiKey) => ({
  id: k.id,
  kind: k.kind,
  name: k.name,
  scopes: k.scopes,
  revoked: k.revoked,
  roleId: k.roleId,
  lastUsedAt: k.lastUsedAt,
});
const pluginSummary = (p: InstalledPlugin) => ({
  id: p.id,
  name: p.manifest.name,
  version: p.manifest.version,
  description: p.manifest.description,
  requestedCapabilities: p.manifest.capabilities,
  approvedCapabilities: p.approvedCapabilities,
  // What it actually runs with: declared ∩ approved.
  grantedCapabilities: effectivePluginGrant(p.manifest.capabilities, p.approvedCapabilities),
  needsReapproval: p.needsReapproval === true,
  allowedHosts: p.manifest.allowedHosts,
  hooks: p.manifest.hooks,
  checksum: p.checksum,
  enabled: p.enabled,
  installedAt: p.installedAt,
  installedBy: p.installedBy,
});
const webhookSummary = (h: Webhook) => ({
  id: h.id,
  url: h.url,
  topics: h.topics,
  active: h.active,
  environmentId: h.environmentId,
});

const BASE = '/spaces/:space/environments/:env';

/**
 * `?expectedVersion=N`: hold a publish, unpublish or restore to the version the caller read (a
 * 409 when the entry has moved on). Absent, the write acts on the entry as it is.
 */
function expectedVersionOf(c: Context<AuthVars>): { expectedVersion?: number } {
  const raw = c.req.query('expectedVersion');
  if (raw === undefined || raw === '') return {};
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new ValidationError([
      { field: 'expectedVersion', message: 'expectedVersion must be a positive integer' },
    ]);
  }
  return { expectedVersion: n };
}

/** Management API (CMA): authoring + publishing, gated by RBAC scopes. */
/**
 * Resolves a source id, naming what is available when it is unknown.
 *
 * A bare 404 here is unhelpful: the caller almost always mistyped one of two
 * ids, and the list is short enough to just show them.
 */
function importSourceOr400(
  sources: Readonly<Record<string, ImportSource>> | undefined,
  id: string,
): ImportSource {
  const found = sources?.[id];
  if (found) return found;
  const known = Object.keys(sources ?? {});
  throw new ValidationError([
    {
      field: 'source',
      message: known.length
        ? `Unknown import source "${id}". Available: ${known.join(', ')}`
        : 'No import sources are configured on this deployment',
    },
  ]);
}

export function managementRoutes(deps: AuthDeps): Hono<AuthVars> {
  const { ctx, hasher, blob, ai, rag, agents } = deps;
  const resolveSource = (id: string) => importSourceOr400(deps.importSources, id);
  const requireFetcher = () => {
    if (deps.remoteFetcher) return deps.remoteFetcher;
    // A deployment with no outbound fetcher cannot install from a URL, and
    // saying so beats a stack trace about an undefined method.
    throw new ValidationError([
      { field: 'packageUrl', message: 'This deployment cannot fetch remote plugin packages' },
    ]);
  };
  const toImportInput = (body: { payload: string; mapping: unknown; sourceOptions?: unknown }) => ({
    payload: body.payload,
    mapping: body.mapping as Parameters<typeof analyzeImport>[3]['mapping'],
    ...(body.sourceOptions ? { sourceOptions: body.sourceOptions as Record<string, unknown> } : {}),
  });
  const app = new Hono<AuthVars>();
  // Authenticated, but unscoped: the product's own documentation is identical
  // for every space and discloses nothing about anyone's content. Requiring a
  // token anyway keeps a deployment from unintentionally serving a public docs
  // site, and matches the MCP tools.
  // `/guides/*` covers the bare `/guides` too — verified, not assumed.
  app.use('/guides/*', principalMiddleware(deps));
  app.use('/deployment/*', principalMiddleware(deps));
  app.use('/spaces', principalMiddleware(deps));
  app.use('/spaces/*', principalMiddleware(deps));
  // Resolve environment aliases for any scoped (:env) route.
  app.use('/spaces/:space/environments/:env/*', environmentMiddleware(deps));
  // Record successful mutations to the append-only audit trail.
  app.use('/spaces/:space/*', auditMiddleware(deps));

  // --- people (deployment-wide) ------------------------------------------
  // The web app calls this, as the deployment admin acting, when it disables, removes or
  // re-secures a person: their sessions are the web app's to end; their tokens live here.
  app.delete(
    '/deployment/people/:subject/credentials',
    doc('Auth', 'Revoke every token a person holds', {
      description:
        'Revokes the OAuth access tokens and grants, personal access tokens and setup credentials ' +
        "held by `subject` (the person's web user id), in every space. Deployment administrators only.",
    }),
    async (c) => {
      const principal = c.get('principal');
      if (principal.spaceId !== '*') throw new ForbiddenError('Deployment administrators only');
      return c.json(await revokeEverythingFor(ctx, c.req.param('subject')));
    },
  );

  /** Lightweight principal probe for admin connection UI and SSO sessions. */
  app.get(
    '/auth/me',
    doc('Auth', 'Resolve the calling principal', { ok: docs.principal }),
    principalMiddleware(deps),
    (c) => {
      const principal = c.get('principal');
      return c.json({
        spaceId: principal.spaceId,
        kind: principal.kind,
        scopes: principal.scopes,
        subject: principal.subject,
        restricted: principal.contentGrants !== undefined,
      });
    },
  );

  // --- documentation ------------------------------------------------------
  app.get(
    '/guides',
    doc('Guides', 'List documentation pages', {
      description:
        "Lists contentworker's documentation pages with their headings and sizes, so a " +
        'client can find which page covers a topic before reading it. Requires any valid ' +
        'token; there is no space in the path and nothing space-specific in the response.',
    }),
    async (c) => c.json({ items: listDocs() }),
  );
  app.get(
    '/guides/search',
    doc('Guides', 'Search the documentation', {
      description:
        'Full-text search across every page (`q`, optional `path` and `limit`). Every term ' +
        'must appear on the same line. Each match names the page, the nearest heading above ' +
        'it, and the line, so a hit can be followed with a section read.',
    }),
    async (c) => {
      const limit = Number(c.req.query('limit'));
      return c.json({
        items: searchDocs(c.req.query('q') ?? '', {
          path: c.req.query('path'),
          limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
        }),
      });
    },
  );
  app.get(
    '/guides/:path',
    doc('Guides', 'Read a documentation page', {
      description:
        'Returns one page as Markdown, or one section of it when `section` names a heading ' +
        'slug from the listing — that heading down to the next of the same level.',
    }),
    async (c) => {
      const path = c.req.param('path');
      const section = c.req.query('section');
      const body = readDoc(path, { section });
      if (body === undefined) throw new NotFoundError('Documentation page', section ?? path);
      return c.json({ path, section, body });
    },
  );

  // --- provisioning (admin) ----------------------------------------------
  // Authenticated principals see the spaces they can reach: admin → all, a signed-in member →
  // their teams, a scoped key → just its own. (No requireScope: there is no :space here.)
  app.get('/spaces', async (c) => {
    const items = await listSpacesFor(ctx, c.get('principal'));
    return c.json({ items: items.map((s) => ({ id: s.spaceId, name: s.name })) });
  });
  app.post(
    '/spaces',
    doc('Spaces & environments', 'Create a space', {
      description:
        'Creates a space with its locales and environments (`main` by default), optionally with ' +
        'sample content (`starter: "sample"`), installed before the response returns. Deployment ' +
        'administrators only: the admin token, or a person signed in to the admin as a ' +
        "deployment admin. A space's own API keys can't create spaces. Creating a space whose id " +
        'exists updates its name and locales; repeating a `sample` create finishes an install ' +
        'that failed part-way without duplicating anything.',
      body: createSpaceBody,
      ok: docs.createdSpace,
      status: 201,
    }),
    requireScope(SCOPES.spaceAdmin),
    async (c) => {
      const body = await parseBody(c, createSpaceBody);
      const created = await createSpaceWithStarter(ctx, body, { blob });
      return c.json(
        {
          id: created.space.spaceId,
          name: created.space.name,
          starter: created.starter,
          ...(created.installed ? { installed: created.installed } : {}),
        },
        201,
      );
    },
  );

  app.get('/spaces/:space/environments', requireScope(SCOPES.previewRead), async (c) =>
    c.json({ items: await listEnvironments(ctx, c.req.param('space')) }),
  );
  app.post('/spaces/:space/environments', requireScope(SCOPES.spaceAdmin), async (c) => {
    const body = await parseBody(c, createEnvironmentBody);
    await createEnvironment(ctx, c.req.param('space'), body.id, body.name);
    return c.json({ id: body.id }, 201);
  });
  app.delete(
    '/spaces/:space/environments/:env',
    doc('Spaces & environments', 'Delete an environment and everything in it', {
      query: { confirm: 'The environment id again (required: deleting is irreversible)' },
      description:
        'Removes the environment, its content model, entries, versions, assets, releases, ' +
        'workflows and the rest (its audit history stays); search documents, vectors and the ' +
        'delivery cache are cleaned up asynchronously. Refuses `main` and any environment an ' +
        'alias points at (409).',
    }),
    requireScope(SCOPES.spaceAdmin),
    async (c) =>
      c.json(
        await deleteEnvironment(ctx, c.req.param('space'), c.req.param('env'), {
          confirm: c.req.query('confirm'),
          principal: c.get('principal'),
        }),
      ),
  );

  // --- environment aliases (blue/green) ----------------------------------
  app.get('/spaces/:space/environment-aliases', requireScope(SCOPES.previewRead), async (c) =>
    c.json({ items: await listEnvironmentAliases(ctx, c.req.param('space')) }),
  );
  // Create or repoint an alias (atomic cutover).
  app.put(
    '/spaces/:space/environment-aliases/:alias',
    requireScope(SCOPES.spaceAdmin),
    async (c) => {
      const body = await parseBody(c, setAliasBody);
      return c.json(
        await setEnvironmentAlias(
          ctx,
          c.req.param('space'),
          c.req.param('alias'),
          body.targetEnvironmentId,
        ),
      );
    },
  );
  app.delete(
    '/spaces/:space/environment-aliases/:alias',
    requireScope(SCOPES.spaceAdmin),
    async (c) => {
      await deleteEnvironmentAlias(ctx, c.req.param('space'), c.req.param('alias'));
      return c.body(null, 204);
    },
  );

  // --- audit log (governance, admin) -------------------------------------
  app.get('/spaces/:space/audit-log', requireScope(SCOPES.spaceAdmin), async (c) => {
    const limit = c.req.query('limit');
    const items = await listAuditLog(ctx, c.req.param('space'), {
      environmentId: c.req.query('environment'),
      limit: clampCount(limit, MAX_PAGE_LIMIT, { min: 1 }),
    });
    return c.json({ items });
  });

  // --- branch compare/merge (environments) -------------------------------
  app.get('/spaces/:space/compare', requireScope(SCOPES.previewRead), async (c) =>
    c.json(
      await compareEnvironments(
        ctx,
        c.req.param('space'),
        c.req.query('source') ?? '',
        c.req.query('target') ?? '',
      ),
    ),
  );
  // Apply selected content types/entries from source→target (additive).
  app.post('/spaces/:space/merge', requireScope(SCOPES.contentManage), async (c) => {
    const body = await parseBody(c, mergeBody);
    return c.json(
      await mergeEnvironments(ctx, c.req.param('space'), body.source, body.target, {
        contentTypes: body.contentTypes,
        entries: body.entries,
      }),
    );
  });

  // --- promotions (environment → environment, with approval) -------------
  app.post(
    '/spaces/:space/promotions',
    doc('Spaces & environments', 'Promote content from one environment to another', {
      body: promotionBody,
      status: 201,
      description:
        'Pins the entries to copy (what is live in the source goes live in the target; a draft ' +
        'goes as a draft) and runs a risk check. With nothing to stop it, it applies at once ' +
        '(`completed`). A promotion into `main` or an aliased environment, one that would remove ' +
        'or retype a field, or one the risk check flags waits as `awaiting_approval` for someone ' +
        'else to approve. Omit `contentTypes` and `entries` to promote everything that differs ' +
        '(at most 200 entries).',
    }),
    requireScope(SCOPES.contentManage),
    async (c) => {
      // It can publish, so it needs both.
      authorize(c.get('principal'), SCOPES.contentPublish, c.req.param('space'));
      const body = await parseBody(c, promotionBody);
      return c.json(
        await requestPromotion(ctx, c.get('principal'), c.req.param('space'), body),
        201,
      );
    },
  );
  app.get(
    '/spaces/:space/promotions',
    doc('Spaces & environments', 'List promotions, newest first'),
    requireScope(SCOPES.contentPublish),
    async (c) => {
      const status = c.req.query('status');
      return c.json({
        items: await listPromotions(ctx, c.req.param('space'), {
          ...(status && (PROMOTION_STATUSES as readonly string[]).includes(status)
            ? { status: status as PromotionStatus }
            : {}),
        }),
      });
    },
  );
  app.get(
    '/spaces/:space/promotions/:id',
    doc('Spaces & environments', 'Get a promotion, with its risk check and result'),
    requireScope(SCOPES.contentPublish),
    async (c) => c.json(await getPromotion(ctx, c.req.param('space'), c.req.param('id'))),
  );
  app.post(
    '/spaces/:space/promotions/:id/approve',
    doc('Spaces & environments', 'Approve a waiting promotion and apply it', {
      description: 'By someone other than whoever requested it (403 otherwise).',
    }),
    requireScope(SCOPES.contentPublish),
    async (c) =>
      c.json(
        await approvePromotion(ctx, c.get('principal'), c.req.param('space'), c.req.param('id')),
      ),
  );
  app.post(
    '/spaces/:space/promotions/:id/reject',
    doc('Spaces & environments', 'Reject a waiting promotion'),
    requireScope(SCOPES.contentPublish),
    async (c) =>
      c.json(
        await rejectPromotion(ctx, c.get('principal'), c.req.param('space'), c.req.param('id')),
      ),
  );

  // --- API key management (admin) ----------------------------------------
  app.get(
    '/spaces/:space/api-keys',
    doc('Auth', 'List API keys for a space'),
    requireScope(SCOPES.spaceAdmin),
    async (c) => {
      const keys = await listApiKeys(ctx, c.req.param('space'));
      return c.json({ items: keys.map(apiKeySummary) });
    },
  );
  app.post(
    '/spaces/:space/api-keys',
    doc('Auth', 'Mint an API key', {
      body: createApiKeyBody,
      ok: docs.apiKeyCreated,
      status: 201,
      description: 'The raw token is returned once; only its SHA-256 hash is stored.',
    }),
    requireScope(SCOPES.spaceAdmin),
    async (c) => {
      const body = await parseBody(c, createApiKeyBody);
      // spaceId is taken ONLY from the authorized route param, so a caller-supplied
      // `spaceId` can never rebind the key to another space (the schema strips
      // unknown keys, so it never reaches here regardless).
      const created = await createApiKey(ctx, hasher, {
        spaceId: c.req.param('space'),
        kind: body.kind,
        name: body.name,
        scopes: body.scopes,
        roleId: body.roleId,
      });
      // Return the raw token once; only its hash is stored.
      return c.json(
        { id: created.apiKey.id, kind: created.apiKey.kind, token: created.token },
        201,
      );
    },
  );
  app.delete('/spaces/:space/api-keys/:id', requireScope(SCOPES.spaceAdmin), async (c) => {
    await revokeApiKey(ctx, c.req.param('space'), c.req.param('id'), deps.accessPolicy);
    return c.body(null, 204);
  });

  /**
   * Mints a personal access token for the caller — the non-interactive
   * counterpart to an OAuth grant, for CLI and CI clients that cannot run a
   * browser flow. It lists and revokes through the API-key routes above.
   *
   * Deliberately NOT exposed as an MCP tool, and refused to OAuth-delegated
   * callers: an access token that expires in an hour must not be able to mint
   * itself a credential that never expires. PATs are issued by a human at a
   * keyboard, or by an operator key.
   */
  app.post(
    '/spaces/:space/personal-access-tokens',
    doc('Auth', 'Mint a personal access token', {
      body: createPatBody,
      ok: docs.apiKeyCreated,
      status: 201,
      description: 'Scopes are intersected with the caller’s own. The raw token is returned once.',
    }),
    requireScope(SCOPES.spaceAdmin),
    async (c) => {
      const principal = c.get('principal');
      // Minted by a person for themselves (it acts as them, checked against their membership on
      // every use), never by a key or by a token another application holds.
      if (principal.clientId || principal.kind !== 'user' || !principal.subject) {
        throw new ForbiddenError('personal-access-token:create');
      }
      const body = await parseBody(c, createPatBody);
      const created = await createPersonalAccessToken(ctx, hasher, {
        spaceId: c.req.param('space'),
        subject: principal.subject,
        name: body.name,
        scopes: body.scopes,
        expiresInDays: body.expiresInDays,
        issuerScopes: principal.scopes,
      });
      return c.json({ id: created.id, token: created.token, expiresAt: created.expiresAt }, 201);
    },
  );
  app.get(
    '/spaces/:space/personal-access-tokens',
    doc('Auth', 'List personal access tokens'),
    requireScope(SCOPES.spaceAdmin),
    async (c) => c.json({ items: await listPersonalAccessTokens(ctx, c.req.param('space')) }),
  );

  // --- connected OAuth applications (admin) --------------------------------
  app.get(
    '/spaces/:space/oauth/connections',
    doc('Auth', 'List applications connected via OAuth'),
    requireScope(SCOPES.spaceAdmin),
    async (c) => c.json({ items: await listConnectedApps(ctx, c.req.param('space')) }),
  );
  /**
   * Disconnects an application. POST rather than DELETE because the subject is
   * an identity string (usually an email) that has no business being a path
   * segment.
   */
  app.post(
    '/spaces/:space/oauth/connections/revoke',
    doc('Auth', 'Disconnect an OAuth application', {
      body: revokeConnectionBody,
      description:
        'Revokes every access token the client holds for that subject, and the grants behind them.',
    }),
    requireScope(SCOPES.spaceAdmin),
    async (c) => {
      const body = await parseBody(c, revokeConnectionBody);
      const result = await revokeConnectedApp(
        ctx,
        c.req.param('space'),
        body.clientId,
        body.subject,
      );
      return c.json(result);
    },
  );

  // --- environment snapshots (export / import / clone) ---------------------
  app.get(
    `${BASE}/export`,
    doc('Spaces & environments', 'Export an environment as a snapshot', {
      description:
        'Portable JSON: content model, entries, taxonomy, workflows, and asset METADATA. ' +
        'Never includes credentials (API keys, OAuth clients, webhook secrets) or asset binaries.',
    }),
    // Reads the whole environment in one response, so it needs the same
    // authority as managing the model, not merely reading drafts.
    requireScope(SCOPES.contentManage),
    async (c) => {
      const limit = c.req.query('limit');
      return c.json(
        await exportSnapshot(ctx, scopeOf(c), {
          limit: limit ? Number(limit) : undefined,
        }),
      );
    },
  );
  app.post(
    `${BASE}/import`,
    doc('Spaces & environments', 'Import a snapshot into this environment', {
      body: snapshotBody,
      description:
        'Replays the snapshot through the normal use-cases, so validation, the reference ' +
        'graph and the delivery read model all end up consistent. Requires an environment ' +
        'with no content types. Everything is checked before anything is written; then the ' +
        'content model, taxonomy and workflows are written and the assets and entries run as ' +
        "a job (202: `{ report, job, publishJobId }`; follow it at this environment's " +
        '`bulk/jobs/:id`, then the publishing job, which starts once it completes with no ' +
        'failures). `?dryRun=true` reports without writing (200).',
    }),
    requireScope(SCOPES.contentManage),
    async (c) => {
      const snapshot = (await parseBody(c, snapshotBody)) as unknown as EnvironmentSnapshot;
      const options = {
        dryRun: c.req.query('dryRun') === 'true',
        publish: c.req.query('publish') !== 'false',
      };
      if (options.dryRun || !blob) {
        const report = await importSnapshot(ctx, scopeOf(c), snapshot, options);
        return c.json(report, report.dryRun ? 200 : 201);
      }
      return c.json(await startSnapshotImport(ctx, blob, scopeOf(c), snapshot, options), 202);
    },
  );
  app.post(
    `${BASE}/clone`,
    doc('Spaces & environments', 'Clone this environment into another', {
      body: cloneBody,
      status: 202,
      description:
        'Export plus import with no file in between. The target may be in another space, ' +
        'which is the case environment merge does not cover. Runs entirely as jobs (202: ' +
        '`{ job, createJobId, publishJobId }`): `job` exports the source, checks it (a ' +
        'refused snapshot fails it, its report naming the problems) and starts `createJobId`, ' +
        'whose clean completion starts `publishJobId` (when anything is published). All ' +
        'belong to the target environment: follow them at its `bulk/jobs/:id`.',
    }),
    requireScope(SCOPES.contentManage),
    async (c) => {
      const body = await parseBody(c, cloneBody);
      // The target space is authorized separately: cloning into a space the
      // caller cannot manage would be a tenancy hole.
      authorize(
        c.get('principal'),
        SCOPES.contentManage,
        body.targetSpaceId ?? c.req.param('space'),
      );
      const target = {
        spaceId: body.targetSpaceId ?? (c.req.param('space') as string),
        environmentId: body.targetEnvironmentId,
      };
      const options = { publish: body.publish !== false };
      if (!blob) return c.json(await cloneEnvironment(ctx, scopeOf(c), target, options), 201);
      return c.json(await startEnvironmentClone(ctx, scopeOf(c), target, options), 202);
    },
  );

  // --- importing content from elsewhere -------------------------------------
  // Two phases: analyze reports, execute writes. Both call the same planner,
  // so the report is not a prediction — it is the run, without the commit.
  app.get(
    `${BASE}/imports/sources`,
    doc('Spaces & environments', 'List import sources', {
      description: 'The external formats this deployment can read.',
    }),
    requireScope(SCOPES.contentWrite),
    (c) =>
      c.json({
        items: Object.values(deps.importSources ?? {}).map((s) => ({ id: s.id, name: s.name })),
      }),
  );
  app.post(
    `${BASE}/imports/analyze`,
    doc('Spaces & environments', 'Analyze an import without writing', {
      body: importBody,
      description:
        'Reports what the import would create, update and skip — plus the source fields ' +
        'nothing maps to (the data it would throw away) and the records that would fail. ' +
        'Writes nothing.',
    }),
    requireScope(SCOPES.contentWrite),
    async (c) => {
      const body = await parseBody(c, importBody);
      return c.json(
        await analyzeImport(ctx, scopeOf(c), resolveSource(body.source), toImportInput(body), {
          ...(body.conflicts ? { conflicts: body.conflicts } : {}),
        }),
      );
    },
  );
  app.post(
    `${BASE}/imports`,
    doc('Spaces & environments', 'Run an import', {
      body: importBody,
      status: 201,
      description:
        'Creates entries through the same use-cases as any other write, so validation, ' +
        'uniqueness and the reference graph all apply. Entries arrive as drafts; publishing ' +
        'them is a separate bulk job. Re-analyzes first, so a stale plan cannot be acted on.',
    }),
    requireScope(SCOPES.contentWrite),
    async (c) => {
      const body = await parseBody(c, importBody);
      return c.json(
        await executeImport(ctx, scopeOf(c), resolveSource(body.source), toImportInput(body), {
          ...(body.conflicts ? { conflicts: body.conflicts } : {}),
        }),
        201,
      );
    },
  );

  app.post(
    `${BASE}/imports/job`,
    doc('Spaces & environments', 'Run an import as a durable job', {
      body: importBody,
      status: 202,
      description:
        'Same planner and same report as the synchronous run, but the writing is chunked into a ' +
        'resumable job — so an import survives a crash, a deploy, and a client that hung up. ' +
        'Poll `…/bulk/jobs/:id` for progress and `…/bulk/jobs/:id/report` for per-record failures.',
    }),
    requireScope(SCOPES.contentWrite),
    async (c) => {
      const body = await parseBody(c, importBody);
      const started = await startImportJob(
        ctx,
        blob,
        scopeOf(c),
        resolveSource(body.source),
        toImportInput(body),
        { ...(body.conflicts ? { conflicts: body.conflicts } : {}) },
      );
      return c.json(started, 202);
    },
  );

  // --- plugins (install, consent, lifecycle) -------------------------------
  // Gated on space:admin throughout: installing code that runs on the write
  // path is an administrative act, not an editorial one. The capability grant
  // is additionally intersected with the installer's own scopes.
  app.get('/spaces/:space/plugins', requireScope(SCOPES.spaceAdmin), async (c) =>
    c.json({ items: (await listPlugins(ctx, c.req.param('space'))).map(pluginSummary) }),
  );
  app.get('/spaces/:space/plugins/:id', requireScope(SCOPES.spaceAdmin), async (c) =>
    c.json(pluginSummary(await getPlugin(ctx, c.req.param('space'), c.req.param('id')))),
  );
  app.post(
    '/spaces/:space/plugins',
    doc('Apps', 'Install a plugin', {
      body: installPluginBody,
      status: 201,
      description:
        'Installs DISABLED. `approvedCapabilities` is the human consent and may be narrower ' +
        'than the manifest requests, never wider; each capability is also checked against the ' +
        'installer’s own scopes.',
    }),
    requireScope(SCOPES.spaceAdmin),
    async (c) => {
      const body = await parseBody(c, installPluginBody);
      const plugin = await installPlugin(ctx, blob, c.get('principal'), c.req.param('space'), {
        manifest: body.manifest as unknown as Parameters<typeof installPlugin>[4]['manifest'],
        bundle: body.bundle,
        approvedCapabilities: body.approvedCapabilities as never,
      });
      return c.json(pluginSummary(plugin), 201);
    },
  );
  app.put(
    '/spaces/:space/plugins/:id',
    doc('Apps', 'Upgrade a plugin', {
      body: installPluginBody,
      description:
        'A version requesting capabilities beyond the current grant requires ' +
        '`approvedCapabilities` and lands disabled, so an upgrade can never widen authority quietly.',
    }),
    requireScope(SCOPES.spaceAdmin),
    async (c) => {
      const body = await parseBody(c, installPluginBody.partial({ approvedCapabilities: true }));
      const plugin = await upgradePlugin(ctx, blob, c.get('principal'), c.req.param('space'), {
        manifest: body.manifest as unknown as Parameters<typeof upgradePlugin>[4]['manifest'],
        bundle: body.bundle,
        approvedCapabilities: body.approvedCapabilities as never,
      });
      return c.json(pluginSummary(plugin));
    },
  );
  app.post(
    '/spaces/:space/plugins/from-url/inspect',
    doc('Apps', 'Inspect a plugin package without installing it', {
      body: inspectPluginBody,
      description:
        'Fetches and verifies a package exactly as install would, and returns what it found — ' +
        'so a consent screen can show the manifest before anything is approved. Install with ' +
        '`expectedChecksum` set to the checksum returned here, and a release swapped in ' +
        'between the two calls is refused rather than installed under the wrong approval.',
    }),
    requireScope(SCOPES.spaceAdmin),
    async (c) => {
      const body = await parseBody(c, inspectPluginBody);
      return c.json(
        await inspectPluginPackage(
          ctx,
          requireFetcher(),
          body as unknown as Parameters<typeof inspectPluginPackage>[2],
          deps.pluginSources ?? {},
        ),
      );
    },
  );
  app.post(
    '/spaces/:space/plugins/from-url',
    doc('Apps', 'Install a plugin from a URL', {
      body: installPluginFromUrlBody,
      status: 201,
      description:
        'Fetches a package descriptor over HTTPS, verifies the bundle against the SHA-256 it ' +
        'declares, and installs it DISABLED. `expectedChecksum` pins the release, so bytes ' +
        'that changed since the approval are refused rather than installed.',
    }),
    requireScope(SCOPES.spaceAdmin),
    async (c) => {
      const body = await parseBody(c, installPluginFromUrlBody);
      const plugin = await installPluginFromUrl(
        ctx,
        blob,
        requireFetcher(),
        c.get('principal'),
        c.req.param('space'),
        body as unknown as Parameters<typeof installPluginFromUrl>[5],
        deps.pluginSources ?? {},
      );
      return c.json(pluginSummary(plugin), 201);
    },
  );
  app.put(
    '/spaces/:space/plugins/:id/from-url',
    doc('Apps', 'Upgrade a plugin from a URL', {
      body: upgradePluginFromUrlBody,
      description:
        'Same verification as install. A version requesting more than the current grant needs ' +
        '`approvedCapabilities` and lands disabled.',
    }),
    requireScope(SCOPES.spaceAdmin),
    async (c) => {
      const body = await parseBody(c, upgradePluginFromUrlBody);
      const plugin = await upgradePluginFromUrl(
        ctx,
        blob,
        requireFetcher(),
        c.get('principal'),
        c.req.param('space'),
        { ...body, expectedId: body.expectedId ?? c.req.param('id') } as unknown as Parameters<
          typeof upgradePluginFromUrl
        >[5],
        deps.pluginSources ?? {},
      );
      return c.json(pluginSummary(plugin));
    },
  );
  app.post(
    '/spaces/:space/plugins/:id/capabilities',
    doc('Apps', 'Approve a plugin’s capabilities', {
      body: pluginCapabilitiesBody,
      description:
        'Records a fresh capability decision without changing the code: re-approves a plugin ' +
        'flagged `needsReapproval`, narrows a grant, or grants something the manifest requested ' +
        'that was declined earlier. Never wider than the manifest or the approver’s own scopes; ' +
        'a grant that grows disables the plugin until it is re-enabled.',
    }),
    requireScope(SCOPES.spaceAdmin),
    async (c) => {
      const body = await parseBody(c, pluginCapabilitiesBody);
      return c.json(
        pluginSummary(
          await approvePluginCapabilities(
            ctx,
            c.get('principal'),
            c.req.param('space'),
            c.req.param('id'),
            body.approvedCapabilities as never,
          ),
        ),
      );
    },
  );
  app.post('/spaces/:space/plugins/:id/enabled', requireScope(SCOPES.spaceAdmin), async (c) => {
    const body = await parseBody(c, pluginEnabledBody);
    return c.json(
      pluginSummary(
        await setPluginEnabled(ctx, c.req.param('space'), c.req.param('id'), body.enabled),
      ),
    );
  });
  app.delete('/spaces/:space/plugins/:id', requireScope(SCOPES.spaceAdmin), async (c) => {
    await uninstallPlugin(ctx, blob, c.req.param('space'), c.req.param('id'));
    return c.body(null, 204);
  });

  // --- roles (granular RBAC, admin) ----------------------------------------
  app.get('/spaces/:space/roles', requireScope(SCOPES.spaceAdmin), async (c) =>
    c.json({ items: await listRoles(ctx, c.req.param('space')) }),
  );
  app.post('/spaces/:space/roles', requireScope(SCOPES.spaceAdmin), async (c) =>
    c.json(await createRole(ctx, c.req.param('space'), await parseBody(c, roleBody)), 201),
  );
  app.get('/spaces/:space/roles/:id', requireScope(SCOPES.spaceAdmin), async (c) =>
    c.json(await getRole(ctx, c.req.param('space'), c.req.param('id'))),
  );
  app.put('/spaces/:space/roles/:id', requireScope(SCOPES.spaceAdmin), async (c) =>
    c.json(
      await updateRole(
        ctx,
        c.req.param('space'),
        c.req.param('id'),
        await parseBody(c, roleBody),
        deps.accessPolicy,
      ),
    ),
  );
  app.delete('/spaces/:space/roles/:id', requireScope(SCOPES.spaceAdmin), async (c) => {
    await deleteRole(ctx, c.req.param('space'), c.req.param('id'));
    return c.body(null, 204);
  });

  // --- space config (locales) --------------------------------------------
  app.get(`${BASE}/space-config`, requireScope(SCOPES.previewRead), async (c) =>
    c.json(await getSpaceConfig(ctx, scopeOf(c))),
  );

  // --- content types ------------------------------------------------------
  app.get(
    `${BASE}/content-types`,
    doc('Content types', 'List content types', {
      description:
        '`?format=typescript` returns the content model as a TypeScript module instead of ' +
        'JSON — the same output the codegen CLI produces, served from the live model so CI ' +
        'and coding agents need nothing installed to type against it.',
      query: { format: 'json (default) | typescript' },
    }),
    requireScope(SCOPES.previewRead),
    async (c) => {
      const types = await listContentTypes(ctx, scopeOf(c));
      if (c.req.query('format') !== 'typescript') return c.json({ items: types });

      // Served as text/plain rather than a TypeScript media type: browsers and
      // `curl` show it, and nothing downstream tries to execute it.
      return c.text(
        generateTypes(types as unknown as Parameters<typeof generateTypes>[0], {
          banner: `Generated from ${scopeOf(c).spaceId}/${scopeOf(c).environmentId} at ${ctx.clock
            .now()
            .toISOString()}. Do not edit by hand.`,
        }),
        200,
        { 'content-type': 'text/plain; charset=utf-8' },
      );
    },
  );
  app.post(
    `${BASE}/content-types`,
    doc('Content types', 'Create a content type', {
      body: contentTypeBody,
      ok: docs.contentType,
      status: 201,
    }),
    requireScope(SCOPES.contentManage),
    async (c) => {
      const ct = await createContentType(
        ctx,
        scopeOf(c),
        (await parseBody(c, contentTypeBody)) as unknown as Parameters<typeof createContentType>[2],
      );
      return c.json(ct, 201);
    },
  );
  // Before `/content-types/:apiId`, which would take "entry-counts" for an apiId (apiIds have no
  // hyphens, so no real type is shadowed).
  app.get(
    `${BASE}/content-types/entry-counts`,
    doc('Content types', 'Count entries per content type', {
      description:
        'Entries per content type by status (`draft`, `changed`, `published`, and `archived` ' +
        'for the trash), from one grouped count. `total` is the live entries, without the ' +
        'trash. Types the caller cannot read are left out.',
      ok: docs.contentTypeEntryCounts,
    }),
    requireScope(SCOPES.previewRead),
    async (c) => {
      const principal = c.get('principal');
      const counts = await countEntriesByContentType(ctx, scopeOf(c));
      return c.json({
        items: counts.filter((n) => canAccessContentType(principal, 'read', n.contentType)),
      });
    },
  );
  app.get(
    `${BASE}/content-types/:apiId`,
    doc('Content types', 'Get a content type', { ok: docs.contentType }),
    requireScope(SCOPES.previewRead),
    async (c) => c.json(await getContentType(ctx, scopeOf(c), c.req.param('apiId'))),
  );
  app.post(
    `${BASE}/content-types/:apiId/published`,
    requireScope(SCOPES.contentPublish),
    async (c) => c.json(await publishContentType(ctx, scopeOf(c), c.req.param('apiId'))),
  );

  // --- entries ------------------------------------------------------------
  // Granular RBAC: content-level check on top of the coarse scope for
  // role-bound principals (unrestricted principals short-circuit inside the
  // domain helpers). Resolves the entry's content type when needed.
  const guardEntry = async (c: Context<AuthVars>, id: string, action: ContentAction) => {
    const principal = c.get('principal');
    if (!principal.contentGrants) return;
    const { entry } = await getEntry(ctx, scopeOf(c), id);
    authorizeContent(principal, action, entry.contentTypeApiId);
  };

  // Authorizes read on an entry (404 if missing, 403 if the role can't read its
  // content type) and returns the content type id so callers can mask denied
  // fields on version/history/related reads. Use this on every path that returns
  // an entry's field values so granular RBAC can't be bypassed via a side door.
  const authorizeEntryRead = async (c: Context<AuthVars>, id: string): Promise<string> => {
    const { entry } = await getEntry(ctx, scopeOf(c), id);
    authorizeContent(c.get('principal'), 'read', entry.contentTypeApiId);
    return entry.contentTypeApiId;
  };

  app.post(
    `${BASE}/entries`,
    doc('Entries', 'Create a draft entry', {
      body: createEntryBody,
      ok: docs.createdEntry,
      status: 201,
    }),
    requireScope(SCOPES.contentWrite),
    async (c) => {
      const body = await parseBody(c, createEntryBody);
      const principal = c.get('principal');
      authorizeContent(principal, 'write', body.contentTypeApiId);
      assertWritableFields(principal, body.contentTypeApiId, body.fields ?? {});
      const view = await createEntry(ctx, scopeOf(c), body as Parameters<typeof createEntry>[2]);
      return c.json(view, 201);
    },
  );
  // AI-draft an entry's fields. Generated values pass the same validators a
  // human write does, so an agent can't produce an entry a person couldn't.
  app.post(`${BASE}/entries/generate`, requireScope(SCOPES.contentWrite), async (c) => {
    const body = await parseBody(c, draftEntryBody);
    authorizeContent(c.get('principal'), 'write', body.contentTypeApiId);
    return c.json(await draftEntry(ctx, ai, scopeOf(c), body));
  });
  // Canvas: map free-form prose into structured fields (same validation gate).
  app.post(`${BASE}/entries/canvas`, requireScope(SCOPES.contentWrite), async (c) => {
    const body = await parseBody(c, canvasBody);
    authorizeContent(c.get('principal'), 'write', body.contentTypeApiId);
    return c.json(await canvasToEntry(ctx, ai, scopeOf(c), body));
  });
  app.get(
    `${BASE}/entries/:id`,
    doc('Entries', 'Get an entry (draft state)', { ok: docs.entry }),
    requireScope(SCOPES.previewRead),
    async (c) => {
      const view = await getEntry(ctx, scopeOf(c), c.req.param('id'));
      const principal = c.get('principal');
      authorizeContent(principal, 'read', view.entry.contentTypeApiId);
      return c.json({
        ...view,
        fields: maskDeniedFields(principal, view.entry.contentTypeApiId, view.fields),
      });
    },
  );
  app.post(`${BASE}/entries/:id/preview-link`, requireScope(SCOPES.contentWrite), async (c) => {
    await guardEntry(c, c.req.param('id'), 'read');
    const body = await parseBody(c, previewLinkBody);
    const origin = c.req.header('origin') ?? '';
    const link = await createPreviewLink(ctx, hasher, scopeOf(c), c.req.param('id'), {
      ttlHours: body.ttlHours,
      previewBaseUrl: body.previewBaseUrl ?? origin,
    });
    return c.json(link, 201);
  });
  // --- trash lifecycle ----------------------------------------------------
  // Two deliberate steps: DELETE moves to the trash (recoverable), and only a
  // trashed entry can be permanently deleted.
  app.delete(
    `${BASE}/entries/:id`,
    doc('Entries', 'Move an entry to the trash', {
      status: 200,
      description:
        'Unpublishes the entry first when it is live, so delivery stops serving it. ' +
        'Idempotent. Restore it, or delete it permanently, from the trash.',
    }),
    requireScope(SCOPES.contentWrite),
    async (c) => {
      await guardEntry(c, c.req.param('id'), 'write');
      return c.json(await trashEntry(ctx, scopeOf(c), c.req.param('id')));
    },
  );
  app.post(
    `${BASE}/entries/:id/restore`,
    doc('Entries', 'Restore an entry from the trash', {
      description: 'Comes back as a draft; re-publishing is a separate action.',
    }),
    requireScope(SCOPES.contentWrite),
    async (c) => {
      await guardEntry(c, c.req.param('id'), 'write');
      return c.json(await restoreEntry(ctx, scopeOf(c), c.req.param('id')));
    },
  );
  app.delete(
    `${BASE}/entries/:id/permanent`,
    doc('Entries', 'Permanently delete a trashed entry', {
      status: 204,
      description:
        'Irreversible. Refuses with 409 while published entries still link to it, ' +
        'unless ?force=true. Requires content:publish, not merely content:write.',
    }),
    // A harder gate than trashing: this is the only unrecoverable entry action.
    requireScope(SCOPES.contentPublish),
    async (c) => {
      await guardEntry(c, c.req.param('id'), 'publish');
      await purgeEntry(ctx, scopeOf(c), c.req.param('id'), {
        force: c.req.query('force') === 'true',
        ...(blob ? { blob } : {}),
      });
      return c.body(null, 204);
    },
  );
  app.post(
    `${BASE}/entries/:id/duplicate`,
    doc('Entries', 'Duplicate an entry', {
      ok: docs.createdEntry,
      status: 201,
      description: 'Copies fields and taxonomy metadata into a new draft.',
    }),
    requireScope(SCOPES.contentWrite),
    async (c) => {
      await guardEntry(c, c.req.param('id'), 'read');
      const created = await duplicateEntry(ctx, scopeOf(c), c.req.param('id'));
      // Writing a copy is a write of that content type, not just a read.
      authorizeContent(c.get('principal'), 'write', created.entry.contentTypeApiId);
      return c.json(created, 201);
    },
  );

  // "What links here": entries/assets that reference this entry.
  app.get(`${BASE}/entries/:id/reverse-references`, requireScope(SCOPES.previewRead), async (c) => {
    await authorizeEntryRead(c, c.req.param('id'));
    return c.json({ items: await getReverseReferences(ctx, scopeOf(c), c.req.param('id')) });
  });
  app.put(
    `${BASE}/entries/:id`,
    doc('Entries', 'Save a new draft version', { body: updateEntryBody, ok: docs.entry }),
    requireScope(SCOPES.contentWrite),
    async (c) => {
      const body = await parseBody(c, updateEntryBody);
      const principal = c.get('principal');
      if (principal.contentGrants) {
        const { entry } = await getEntry(ctx, scopeOf(c), c.req.param('id'));
        authorizeContent(principal, 'write', entry.contentTypeApiId);
        assertWritableFields(principal, entry.contentTypeApiId, body.fields ?? {});
      }
      return c.json(await updateEntry(ctx, scopeOf(c), c.req.param('id'), body.fields));
    },
  );
  // --- AI content operations over an entry -------------------------------
  app.post(`${BASE}/entries/:id/translate`, requireScope(SCOPES.contentWrite), async (c) =>
    c.json(
      await translateEntry(
        ctx,
        ai,
        scopeOf(c),
        c.req.param('id'),
        await parseBody(c, translateBody),
      ),
    ),
  );
  app.post(`${BASE}/entries/:id/summarize`, requireScope(SCOPES.contentWrite), async (c) =>
    c.json(
      await summarizeEntry(
        ctx,
        ai,
        scopeOf(c),
        c.req.param('id'),
        await parseBody(c, summarizeBody),
      ),
    ),
  );
  app.post(`${BASE}/entries/:id/autofill`, requireScope(SCOPES.contentWrite), async (c) =>
    c.json(
      await autofillField(ctx, ai, scopeOf(c), c.req.param('id'), await parseBody(c, autofillBody)),
    ),
  );
  app.post(`${BASE}/entries/:id/suggest-tags`, requireScope(SCOPES.contentWrite), async (c) =>
    c.json(
      await suggestEntryTags(
        ctx,
        ai,
        scopeOf(c),
        c.req.param('id'),
        await parseBody(c, tierOnlyBody),
      ),
    ),
  );
  // Persists a reviewed tag suggestion exactly as approved (no model re-run).
  app.post(`${BASE}/entries/:id/apply-tags`, requireScope(SCOPES.contentWrite), async (c) =>
    c.json(
      await applyEntryTags(ctx, scopeOf(c), c.req.param('id'), await parseBody(c, applyTagsBody)),
    ),
  );
  // --- functions (event-triggered, HTTP-invoked) -------------------------
  app.get(`${BASE}/functions`, requireScope(SCOPES.previewRead), async (c) =>
    c.json({ items: await listFunctions(ctx, scopeOf(c)) }),
  );
  app.post(`${BASE}/functions`, requireScope(SCOPES.contentManage), async (c) =>
    c.json(await createFunction(ctx, scopeOf(c), await parseBody(c, createFunctionBody)), 201),
  );
  app.delete(`${BASE}/functions/:id`, requireScope(SCOPES.contentManage), async (c) => {
    await deleteFunction(ctx, scopeOf(c), c.req.param('id'));
    return c.body(null, 204);
  });

  // --- app extensions (admin UI extensions) ------------------------------
  app.get(`${BASE}/app-extensions`, requireScope(SCOPES.previewRead), async (c) =>
    c.json({ items: await listAppExtensions(ctx, scopeOf(c)) }),
  );
  app.post(`${BASE}/app-extensions`, requireScope(SCOPES.contentManage), async (c) =>
    c.json(await createAppExtension(ctx, scopeOf(c), await parseBody(c, appExtensionBody)), 201),
  );
  app.delete(`${BASE}/app-extensions/:id`, requireScope(SCOPES.contentManage), async (c) => {
    await deleteAppExtension(ctx, scopeOf(c), c.req.param('id'));
    return c.body(null, 204);
  });

  // --- bulk operations ---------------------------------------------------
  app.post(`${BASE}/bulk/entries`, requireScope(SCOPES.contentWrite), async (c) => {
    const body = await parseBody(c, bulkEntriesBody);
    const principal = c.get('principal');
    for (const item of body.items ?? []) {
      authorizeContent(principal, 'write', item.contentTypeApiId);
      assertWritableFields(principal, item.contentTypeApiId, item.fields ?? {});
    }
    return c.json(
      await bulkCreateEntries(
        ctx,
        scopeOf(c),
        (body.items ?? []) as Parameters<typeof bulkCreateEntries>[2],
      ),
      201,
    );
  });
  app.post(`${BASE}/bulk/entries/publish`, requireScope(SCOPES.contentPublish), async (c) => {
    const body = await parseBody(c, idsBody);
    for (const id of body.ids ?? []) await guardEntry(c, id, 'publish');
    return c.json(await bulkEntryAction(ctx, scopeOf(c), 'publish', body.ids ?? []));
  });
  app.post(`${BASE}/bulk/entries/unpublish`, requireScope(SCOPES.contentPublish), async (c) => {
    const body = await parseBody(c, idsBody);
    for (const id of body.ids ?? []) await guardEntry(c, id, 'publish');
    return c.json(await bulkEntryAction(ctx, scopeOf(c), 'unpublish', body.ids ?? []));
  });

  // --- bulk jobs (durable, chunked; for id sets beyond the sync routes) ----
  // Granular per-entry RBAC guards are impractical at this cardinality, so
  // start/cancel/report require an ungranted (full content:publish) principal
  // — per-item authorization failures would silently skew the compliance
  // report, and reports expose entry ids across all content types. Job
  // status/list (counts only) stay readable by any content:publish key.
  const guardBulkJobs = (c: Context<AuthVars>) => {
    if (c.get('principal').contentGrants) {
      throw new ForbiddenError('bulk jobs (unrestricted content:publish role required)');
    }
  };
  app.post(`${BASE}/bulk/jobs`, requireScope(SCOPES.contentPublish), async (c) => {
    const body = await parseBody(c, bulkJobBody);
    guardBulkJobs(c);
    return c.json(await startBulkJob(ctx, scopeOf(c), body), 202);
  });
  // Reads are `content:write`, not `content:publish`: an import job is started
  // with content:write, and someone who can start a job must be able to watch
  // it. Progress and per-item errors describe work the caller could have
  // started themselves, so this widens nothing that matters.
  app.get(`${BASE}/bulk/jobs`, requireScope(SCOPES.contentWrite), async (c) =>
    c.json(await listBulkJobs(ctx, scopeOf(c), { limit: clampCount(c.req.query('limit'), 50) })),
  );
  app.get(`${BASE}/bulk/jobs/:id`, requireScope(SCOPES.contentWrite), async (c) =>
    c.json(await getBulkJob(ctx, scopeOf(c), c.req.param('id'))),
  );
  app.get(`${BASE}/bulk/jobs/:id/report`, requireScope(SCOPES.contentWrite), async (c) => {
    guardBulkJobs(c);
    return c.json(await getBulkJobReport(ctx, scopeOf(c), c.req.param('id')));
  });
  app.post(`${BASE}/bulk/jobs/:id/cancel`, requireScope(SCOPES.contentPublish), async (c) => {
    guardBulkJobs(c);
    return c.json(await cancelBulkJob(ctx, scopeOf(c), c.req.param('id'), blob ? { blob } : {}));
  });

  // --- agent actions (audit → work packages) -----------------------------
  app.post(`${BASE}/entries/:id/audit`, requireScope(SCOPES.contentWrite), async (c) =>
    c.json(await auditEntry(ctx, ai, scopeOf(c), c.req.param('id'), await parseBody(c, auditBody))),
  );
  // On-demand moderation: classify the entry's text; a flagged result is a
  // recorded hold (`flagged: true`), not a state change — callers decide.
  app.post(`${BASE}/entries/:id/moderate`, requireScope(SCOPES.contentWrite), async (c) =>
    c.json(await moderateEntry(ctx, agents, scopeOf(c), c.req.param('id'))),
  );

  // --- content semantics (vector-backed) ---------------------------------
  app.get(`${BASE}/entries/:id/related`, requireScope(SCOPES.searchRead), async (c) => {
    await guardEntry(c, c.req.param('id'), 'read');
    const topK = c.req.query('top_k');
    return c.json({
      items: await relatedEntries(rag, ctx, scopeOf(c), c.req.param('id'), {
        topK: topK ? Number(topK) : undefined,
        locale: c.req.query('locale'),
      }),
    });
  });
  app.get(`${BASE}/entries/:id/duplicates`, requireScope(SCOPES.searchRead), async (c) => {
    await guardEntry(c, c.req.param('id'), 'read');
    const threshold = c.req.query('threshold');
    return c.json({
      items: await findDuplicates(rag, ctx, scopeOf(c), c.req.param('id'), {
        threshold: threshold ? Number(threshold) : undefined,
        locale: c.req.query('locale'),
      }),
    });
  });
  app.get(`${BASE}/entries/:id/embedding`, requireScope(SCOPES.searchRead), async (c) =>
    c.json(
      await getEntryEmbedding(rag, ctx, scopeOf(c), c.req.param('id'), {
        locale: c.req.query('locale'),
      }),
    ),
  );
  app.get(
    `${BASE}/search/index`,
    doc('AI & agents', 'Report lexical search index health', {
      description:
        'Compares the documents the SearchShard lexical index holds for this environment ' +
        'against the number of published entries. `bound: false` means the index is ' +
        "not bound and the lexical leg runs on the store's built-in term matching. A negative " +
        '`drift` means published entries are missing from the index; a positive one ' +
        'means it holds documents for entries that are no longer published. The remedy ' +
        'is POST search/reindex, which rewrites both the vector and lexical legs.',
    }),
    // content:manage, not search:read: a CDA token carries search:read and
    // ships in browsers, and this reports operational posture — how much is
    // published, and whether indexing has quietly stopped.
    requireScope(SCOPES.contentManage),
    async (c) =>
      c.json(
        await searchIndexHealth(ctx, scopeOf(c), rag?.searchIndex, {
          contentType: c.req.query('content_type'),
        }),
      ),
  );
  // Bulk re-embed the scope's published entries (e.g. after an extraction or
  // embedding-model change). Idempotent per entry; safe to re-run.
  app.post(
    `${BASE}/search/reindex`,
    doc('AI & agents', 'Request a reindex of all published entries', {
      body: reindexBody,
      status: 202,
      description:
        'Enqueues a background reindex (via the outbox → queue) that re-embeds every ' +
        'published entry in the environment (optionally one content type). Returns 202; ' +
        'the work runs on the worker. Rate-limited per scope (429 if requested too soon).',
    }),
    requireScope(SCOPES.contentManage),
    async (c) => {
      const body = await parseBody(c, reindexBody);
      const result = await requestReindex(ctx, scopeOf(c), {
        contentTypeApiId: body.contentTypeApiId,
      });
      return c.json(result, 202);
    },
  );
  app.post(
    `${BASE}/entries/:id/published`,
    doc('Entries', 'Publish an entry', {
      ok: docs.entry,
      description:
        'Writes the delivery read model and appends entry.published to the transactional outbox atomically.',
      query: {
        expectedVersion:
          "The entry's currentVersion as the caller read it; 409 if it has changed since",
      },
    }),
    requireScope(SCOPES.contentPublish),
    async (c) => {
      const id = c.req.param('id');
      await guardEntry(c, id, 'publish');
      // Optional synchronous pre-publish moderation gate: reject flagged content
      // before it ever reaches the delivery read model.
      //
      // SCOPE: this route only. Bulk publish, bulk jobs, release publish and
      // scheduled publishes deliberately do NOT gate — one inline model call
      // per entry is incompatible with their throughput — and rely on
      // post-publish moderation retracting a flagged entry instead. Do not
      // read this flag as "flagged content can never reach delivery".
      if (deps.moderateBeforePublish) {
        const verdict = await moderateEntry(ctx, agents, scopeOf(c), id);
        if (verdict.flagged) {
          throw new ValidationError([
            {
              field: 'moderation',
              message: `Publish blocked by moderation: ${verdict.decisions.join('; ') || 'policy violation'}`,
            },
          ]);
        }
      }
      return c.json(await publishEntry(ctx, scopeOf(c), id, expectedVersionOf(c)));
    },
  );
  app.delete(
    `${BASE}/entries/:id/published`,
    doc('Entries', 'Unpublish an entry', {
      ok: docs.entry,
      query: {
        expectedVersion:
          "The entry's currentVersion as the caller read it; 409 if it has changed since",
      },
    }),
    requireScope(SCOPES.contentPublish),
    async (c) => {
      await guardEntry(c, c.req.param('id'), 'publish');
      return c.json(await unpublishEntry(ctx, scopeOf(c), c.req.param('id'), expectedVersionOf(c)));
    },
  );

  // --- entry version history ---------------------------------------------
  // Version snapshots carry raw field values, so every read authorizes the
  // entry's content type and masks denied fields — matching GET /entries/:id.
  app.get(`${BASE}/entries/:id/versions`, requireScope(SCOPES.previewRead), async (c) => {
    const type = await authorizeEntryRead(c, c.req.param('id'));
    const principal = c.get('principal');
    const items = (await listVersions(ctx, scopeOf(c), c.req.param('id'))).map((v) => ({
      ...v,
      fields: maskDeniedFields(principal, type, v.fields),
    }));
    return c.json({ items });
  });
  // A field-by-field diff between two versions (?from=&to=).
  app.get(`${BASE}/entries/:id/versions/diff`, requireScope(SCOPES.previewRead), async (c) => {
    const type = await authorizeEntryRead(c, c.req.param('id'));
    const principal = c.get('principal');
    const diff = await diffVersions(
      ctx,
      scopeOf(c),
      c.req.param('id'),
      Number(c.req.query('from')),
      Number(c.req.query('to')),
    );
    // Drop denied fields from the diff so they can't leak via before/after.
    const allowed = maskDeniedFields(
      principal,
      type,
      Object.fromEntries(diff.changes.map((ch) => [ch.field, ch])),
    );
    return c.json({ ...diff, changes: Object.values(allowed) });
  });
  app.get(`${BASE}/entries/:id/versions/:version`, requireScope(SCOPES.previewRead), async (c) => {
    const type = await authorizeEntryRead(c, c.req.param('id'));
    const version = await getVersion(
      ctx,
      scopeOf(c),
      c.req.param('id'),
      Number(c.req.param('version')),
    );
    return c.json({
      ...version,
      fields: maskDeniedFields(c.get('principal'), type, version.fields),
    });
  });
  // Restore copies an old version's fields into a NEW draft version. It must pass
  // the same write authorization as a normal edit, so a role with denied/
  // read-only fields can't resurrect them by restoring, or write an ungranted type.
  app.post(
    `${BASE}/entries/:id/versions/:version/restore`,
    doc('Entries', 'Restore a version', {
      description: "Copies the version's fields into a new draft version.",
      query: {
        expectedVersion:
          "The entry's currentVersion as the caller read it; 409 if it has changed since",
      },
    }),
    requireScope(SCOPES.contentWrite),
    async (c) => {
      const principal = c.get('principal');
      const { entry } = await getEntry(ctx, scopeOf(c), c.req.param('id'));
      authorizeContent(principal, 'write', entry.contentTypeApiId);
      const target = await getVersion(
        ctx,
        scopeOf(c),
        c.req.param('id'),
        Number(c.req.param('version')),
      );
      assertWritableFields(principal, entry.contentTypeApiId, target.fields);
      return c.json(
        await restoreVersion(
          ctx,
          scopeOf(c),
          c.req.param('id'),
          Number(c.req.param('version')),
          expectedVersionOf(c),
        ),
      );
    },
  );

  // --- assets -------------------------------------------------------------
  app.get(`${BASE}/assets`, requireScope(SCOPES.previewRead), async (c) => {
    const limit = c.req.query('limit');
    const items = await listAssets(ctx, scopeOf(c), {
      limit: clampCount(limit, MAX_PAGE_LIMIT, { min: 1 }),
    });
    return c.json({ items });
  });
  app.post(
    `${BASE}/assets`,
    doc('Assets', 'Create an asset (presigned direct upload)', {
      body: createAssetBody,
      ok: docs.uploadTicket,
      status: 201,
      description: 'PUT the file bytes to upload.url with upload.headers, then publish the asset.',
    }),
    requireScope(SCOPES.contentWrite),
    async (c) => {
      const created = await createAsset(ctx, blob, scopeOf(c), await parseBody(c, createAssetBody));
      return c.json(created, 201);
    },
  );
  app.post(
    `${BASE}/assets/videos`,
    doc('Assets', 'Create a video asset (direct upload to the video host)', {
      body: createVideoAssetBody,
      ok: docs.videoUploadTicket,
      status: 201,
      description:
        'POST the file as multipart field upload.fileField to upload.uploadUrl, then poll ' +
        '/assets/{id}/video/refresh (or rely on the host webhook) until file.video.status is ready. ' +
        '501 when no video host is bound.',
    }),
    requireScope(SCOPES.contentWrite),
    async (c) =>
      c.json(
        await createVideoAsset(ctx, scopeOf(c), await parseBody(c, createVideoAssetBody)),
        201,
      ),
  );
  app.get(`${BASE}/assets/:id`, requireScope(SCOPES.previewRead), async (c) =>
    c.json(await getAsset(ctx, scopeOf(c), c.req.param('id'))),
  );
  app.post(
    `${BASE}/assets/:id/video/refresh`,
    doc('Assets', "Refresh a video asset's processing status from the video host", {
      ok: docs.asset,
    }),
    requireScope(SCOPES.contentWrite),
    async (c) => c.json(await refreshVideoAsset(ctx, scopeOf(c), c.req.param('id'))),
  );
  app.patch(`${BASE}/assets/:id/metadata`, requireScope(SCOPES.contentWrite), async (c) =>
    c.json(
      await setAssetMetadata(
        ctx,
        scopeOf(c),
        c.req.param('id'),
        await parseBody(c, assetMetadataBody),
      ),
    ),
  );
  app.get(`${BASE}/assets/:id/usage`, requireScope(SCOPES.previewRead), async (c) =>
    c.json({ items: await getAssetUsage(ctx, scopeOf(c), c.req.param('id')) }),
  );
  app.get(`${BASE}/assets/:id/transform`, requireScope(SCOPES.previewRead), async (c) =>
    c.json(
      await transformAssetUrl(
        ctx,
        scopeOf(c),
        c.req.param('id'),
        parseImageTransform(c.req.query()),
      ),
    ),
  );
  app.post(`${BASE}/assets/:id/alt-text`, requireScope(SCOPES.contentWrite), async (c) =>
    c.json(
      await generateAltText(
        ctx,
        ai,
        scopeOf(c),
        c.req.param('id'),
        await parseBody(c, altTextBody),
      ),
    ),
  );
  app.post(`${BASE}/assets/:id/auto-tag`, requireScope(SCOPES.contentWrite), async (c) =>
    c.json(
      await autoTagAsset(ctx, ai, scopeOf(c), c.req.param('id'), await parseBody(c, tierOnlyBody)),
    ),
  );
  app.post(`${BASE}/assets/:id/published`, requireScope(SCOPES.contentPublish), async (c) =>
    c.json(await publishAsset(ctx, scopeOf(c), c.req.param('id'))),
  );
  app.delete(`${BASE}/assets/:id/published`, requireScope(SCOPES.contentPublish), async (c) =>
    c.json(await unpublishAsset(ctx, scopeOf(c), c.req.param('id'))),
  );

  // --- AI Actions (templated, governed AI operations) --------------------
  app.get(`${BASE}/ai-actions`, requireScope(SCOPES.previewRead), async (c) =>
    c.json({ items: await listAIActions(ctx, scopeOf(c)) }),
  );
  app.post(`${BASE}/ai-actions`, requireScope(SCOPES.contentManage), async (c) =>
    c.json(await createAIAction(ctx, scopeOf(c), await parseBody(c, createAiActionBody)), 201),
  );
  app.delete(`${BASE}/ai-actions/:id`, requireScope(SCOPES.contentManage), async (c) => {
    await deleteAIAction(ctx, scopeOf(c), c.req.param('id'));
    return c.body(null, 204);
  });
  app.post(`${BASE}/ai-actions/:id/run`, requireScope(SCOPES.contentWrite), async (c) =>
    c.json(
      await runAIAction(
        ctx,
        ai,
        scopeOf(c),
        c.req.param('id'),
        await parseBody(c, runAiActionBody),
      ),
    ),
  );

  // --- agent runs / cost ledger (admin) ----------------------------------
  app.get(`${BASE}/agent-runs`, requireScope(SCOPES.spaceAdmin), async (c) => {
    const limit = c.req.query('limit');
    const items = await listAgentRuns(ctx, scopeOf(c), {
      workflow: c.req.query('workflow'),
      limit: clampCount(limit, MAX_PAGE_LIMIT, { min: 1 }),
    });
    return c.json({ items });
  });
  app.get(`${BASE}/agent-runs/usage`, requireScope(SCOPES.spaceAdmin), async (c) =>
    c.json(
      await agentUsage(ctx, scopeOf(c), {
        workflow: c.req.query('workflow'),
        since: c.req.query('since'),
      }),
    ),
  );

  // --- webhooks (admin) ---------------------------------------------------
  // A hook is scoped to one environment (`environmentId`) or space-wide (`null`). Under an
  // environment, every route sees that environment's hooks and the space-wide ones; a hook scoped to
  // another environment is a 404 here. The raw `:env` goes to the use-case so a hook is never pinned
  // to an alias's current target.
  app.get(
    `${BASE}/webhooks`,
    doc('Webhooks', 'List webhooks', {
      description:
        "The environment's own webhooks and every space-wide one (`environmentId: null`). " +
        'Signing secrets and headers are never returned.',
      ok: docs.webhookList,
    }),
    requireScope(SCOPES.spaceAdmin),
    async (c) => {
      const hooks = await listWebhooks(ctx, scopeOf(c));
      return c.json({ items: hooks.map(webhookSummary) });
    },
  );
  app.post(
    `${BASE}/webhooks`,
    doc('Webhooks', 'Create a webhook', {
      description:
        "Receives only the path environment's events, or every environment's with " +
        '`allEnvironments: true`. Under an alias it is space-wide, and `allEnvironments: false` is ' +
        'refused (422). The URL must be http(s) and not a loopback, link-local or private address.',
      body: webhookBody,
      ok: docs.webhook,
      status: 201,
    }),
    requireScope(SCOPES.spaceAdmin),
    async (c) =>
      c.json(
        webhookSummary(
          await createWebhook(
            ctx,
            scopeOf(c),
            (await parseBody(c, webhookBody)) as Parameters<typeof createWebhook>[2],
            { requestedEnvironment: c.req.param('env') },
          ),
        ),
        201,
      ),
  );
  app.put(
    `${BASE}/webhooks/:id`,
    doc('Webhooks', 'Update a webhook', {
      description:
        'Omitted fields are kept. `allEnvironments: true` makes the hook space-wide, `false` ' +
        "scopes it to the path's environment (422 under an alias); omitted, its scope is unchanged.",
      body: updateWebhookBody,
      ok: docs.webhook,
    }),
    requireScope(SCOPES.spaceAdmin),
    async (c) =>
      c.json(
        webhookSummary(
          await updateWebhook(
            ctx,
            scopeOf(c),
            c.req.param('id'),
            (await parseBody(c, updateWebhookBody)) as Parameters<typeof updateWebhook>[3],
            { requestedEnvironment: c.req.param('env') },
          ),
        ),
      ),
  );
  app.delete(`${BASE}/webhooks/:id`, requireScope(SCOPES.spaceAdmin), async (c) => {
    await deleteWebhook(ctx, scopeOf(c), c.req.param('id'));
    return c.body(null, 204);
  });
  app.get(`${BASE}/webhooks/:id/deliveries`, requireScope(SCOPES.spaceAdmin), async (c) => {
    const limit = c.req.query('limit');
    const items = await listWebhookDeliveries(ctx, scopeOf(c), c.req.param('id'), {
      limit: clampCount(limit, MAX_PAGE_LIMIT, { min: 1 }),
    });
    return c.json({ items });
  });

  // --- releases -----------------------------------------------------------
  // Bundle entries and ship them atomically. Authoring (create/add/remove) is a
  // write; shipping the bundle requires publish.
  app.get(
    `${BASE}/releases`,
    doc('Releases & scheduling', 'List releases', {
      description:
        'Every release, newest first, each with `itemCount` (its members, from one grouped ' +
        'count), so a list never fetches each release for its size.',
      ok: docs.releaseList,
    }),
    requireScope(SCOPES.previewRead),
    async (c) => c.json({ items: await listReleases(ctx, scopeOf(c)) }),
  );
  app.post(`${BASE}/releases`, requireScope(SCOPES.contentWrite), async (c) =>
    c.json(await createRelease(ctx, scopeOf(c), await parseBody(c, createReleaseBody)), 201),
  );
  app.get(`${BASE}/releases/:id`, requireScope(SCOPES.previewRead), async (c) =>
    c.json(await getRelease(ctx, scopeOf(c), c.req.param('id'))),
  );
  app.delete(`${BASE}/releases/:id`, requireScope(SCOPES.contentWrite), async (c) => {
    await deleteRelease(ctx, scopeOf(c), c.req.param('id'));
    return c.body(null, 204);
  });
  app.post(`${BASE}/releases/:id/items`, requireScope(SCOPES.contentWrite), async (c) =>
    c.json(
      await addEntryToRelease(
        ctx,
        scopeOf(c),
        c.req.param('id'),
        await parseBody(c, releaseItemBody),
      ),
    ),
  );
  app.delete(`${BASE}/releases/:id/items/:entityId`, requireScope(SCOPES.contentWrite), async (c) =>
    c.json(
      await removeEntryFromRelease(ctx, scopeOf(c), c.req.param('id'), c.req.param('entityId')),
    ),
  );
  app.post(`${BASE}/releases/:id/published`, requireScope(SCOPES.contentPublish), async (c) =>
    c.json(await publishRelease(ctx, scopeOf(c), c.req.param('id'))),
  );

  // --- scheduled actions --------------------------------------------------
  app.get(`${BASE}/scheduled-actions`, requireScope(SCOPES.previewRead), async (c) =>
    c.json({
      items: await listScheduledActions(ctx, scopeOf(c), { status: c.req.query('status') }),
    }),
  );
  app.post(`${BASE}/scheduled-actions`, requireScope(SCOPES.contentPublish), async (c) =>
    c.json(
      await scheduleAction(
        ctx,
        scopeOf(c),
        (await parseBody(c, scheduleBody)) as unknown as Parameters<typeof scheduleAction>[2],
      ),
      201,
    ),
  );
  app.delete(`${BASE}/scheduled-actions/:id`, requireScope(SCOPES.contentPublish), async (c) =>
    c.json(await cancelScheduledAction(ctx, scopeOf(c), c.req.param('id'))),
  );

  // --- agent schedules (recurring agent jobs) ------------------------------
  app.get(`${BASE}/agent-schedules`, requireScope(SCOPES.previewRead), async (c) =>
    c.json({ items: await listAgentSchedules(ctx, scopeOf(c)) }),
  );
  app.post(`${BASE}/agent-schedules`, requireScope(SCOPES.contentPublish), async (c) =>
    c.json(await createAgentSchedule(ctx, scopeOf(c), await parseBody(c, agentScheduleBody)), 201),
  );
  app.patch(`${BASE}/agent-schedules/:id`, requireScope(SCOPES.contentPublish), async (c) =>
    c.json(
      await updateAgentSchedule(
        ctx,
        scopeOf(c),
        c.req.param('id'),
        await parseBody(c, agentSchedulePatchBody),
      ),
    ),
  );
  app.delete(`${BASE}/agent-schedules/:id`, requireScope(SCOPES.contentPublish), async (c) => {
    await deleteAgentSchedule(ctx, scopeOf(c), c.req.param('id'));
    return c.body(null, 204);
  });

  // --- agent reviews (human-in-the-loop decisions on agent proposals) ------
  const reviewStatus = (raw: string | undefined) =>
    raw === 'pending' || raw === 'approved' || raw === 'rejected' ? raw : undefined;
  // Granular RBAC for a review's proposal: role-bound principals must hold
  // write on the entry's content type, and the proposed fields must all be
  // writable — the same enforcement an equivalent direct update would face.
  const authorizeReviewDecision = async (c: Context<AuthVars>, reviewId: string) => {
    const principal = c.get('principal');
    if (!principal.contentGrants) return;
    const review = await getAgentReview(ctx, scopeOf(c), reviewId);
    const entry = await getEntry(ctx, scopeOf(c), review.entryId).catch(() => null);
    if (!entry) return; // entry gone — the apply will no-op
    authorizeContent(principal, 'write', entry.entry.contentTypeApiId);
    assertWritableFields(principal, entry.entry.contentTypeApiId, review.proposed);
  };
  app.get(`${BASE}/agent-reviews`, requireScope(SCOPES.previewRead), async (c) => {
    const items = await listAgentReviews(ctx, scopeOf(c), {
      status: reviewStatus(c.req.query('status')),
      entryId: c.req.query('entryId'),
    });
    const principal = c.get('principal');
    if (!principal.contentGrants) return c.json({ items });
    // Role-bound principals: drop reviews of unreadable types, mask denied fields.
    const visible = [];
    for (const review of items) {
      const entry = await getEntry(ctx, scopeOf(c), review.entryId).catch(() => null);
      if (!entry) continue;
      const type = entry.entry.contentTypeApiId;
      if (!canAccessContentType(principal, 'read', type)) continue;
      visible.push({ ...review, proposed: maskDeniedFields(principal, type, review.proposed) });
    }
    return c.json({ items: visible });
  });
  app.post(`${BASE}/agent-reviews/:id/approve`, requireScope(SCOPES.contentWrite), async (c) => {
    await authorizeReviewDecision(c, c.req.param('id'));
    return c.json(
      await decideAgentReview(
        ctx,
        scopeOf(c),
        c.req.param('id'),
        { approve: true, decidedBy: c.get('principal').subject ?? c.get('principal').kind },
        { signalReview: deps.signalReview },
      ),
    );
  });
  app.post(`${BASE}/agent-reviews/:id/reject`, requireScope(SCOPES.contentWrite), async (c) => {
    await authorizeReviewDecision(c, c.req.param('id'));
    return c.json(
      await decideAgentReview(
        ctx,
        scopeOf(c),
        c.req.param('id'),
        { approve: false, decidedBy: c.get('principal').subject ?? c.get('principal').kind },
        { signalReview: deps.signalReview },
      ),
    );
  });

  // --- comments (on entries) ---------------------------------------------
  app.get(`${BASE}/entries/:id/comments`, requireScope(SCOPES.previewRead), async (c) => {
    await authorizeEntryRead(c, c.req.param('id'));
    return c.json({ items: await listComments(ctx, scopeOf(c), c.req.param('id')) });
  });
  app.post(`${BASE}/entries/:id/comments`, requireScope(SCOPES.contentWrite), async (c) => {
    const body = await parseBody(c, commentBody);
    const created = await addComment(ctx, scopeOf(c), {
      entryId: c.req.param('id'),
      body: body.body,
      author: body.author ?? c.get('principal').kind,
      parentId: body.parentId,
    });
    return c.json(created, 201);
  });
  app.delete(`${BASE}/comments/:id`, requireScope(SCOPES.contentWrite), async (c) => {
    await deleteComment(ctx, scopeOf(c), c.req.param('id'));
    return c.body(null, 204);
  });

  // --- tasks (on entries) ------------------------------------------------
  app.get(`${BASE}/entries/:id/tasks`, requireScope(SCOPES.previewRead), async (c) => {
    await authorizeEntryRead(c, c.req.param('id'));
    return c.json({ items: await listTasks(ctx, scopeOf(c), c.req.param('id')) });
  });
  app.post(`${BASE}/entries/:id/tasks`, requireScope(SCOPES.contentWrite), async (c) => {
    const body = await parseBody(c, createTaskBody);
    const created = await createTask(ctx, scopeOf(c), {
      entryId: c.req.param('id'),
      body: body.body,
      assignee: body.assignee,
    });
    return c.json(created, 201);
  });
  // PUT applies one change: resolve/reopen (status) or reassign (assignee).
  app.put(`${BASE}/tasks/:id`, requireScope(SCOPES.contentWrite), async (c) => {
    const body = await parseBody(c, updateTaskBody);
    const id = c.req.param('id');
    const scope = scopeOf(c);
    if (body.status === 'resolved') return c.json(await resolveTask(ctx, scope, id));
    if (body.status === 'open') return c.json(await reopenTask(ctx, scope, id));
    if ('assignee' in body)
      return c.json(await reassignTask(ctx, scope, id, body.assignee ?? null));
    return c.json({ error: 'Provide status or assignee' }, 400);
  });
  app.delete(`${BASE}/tasks/:id`, requireScope(SCOPES.contentWrite), async (c) => {
    await deleteTask(ctx, scopeOf(c), c.req.param('id'));
    return c.body(null, 204);
  });

  // --- workflows ---------------------------------------------------------
  app.get(
    `${BASE}/workflows`,
    doc('Workflows', 'List workflows', {
      description:
        'Every workflow with its draft `graph`, plus how its latest PUBLISHED version starts: ' +
        '`publishedTrigger`, and `startsAlongside`, the other published workflows that start on ' +
        'the same trigger for an overlapping content type. Both are null until it is published.',
      ok: docs.workflowList,
    }),
    requireScope(SCOPES.previewRead),
    async (c) => c.json({ items: await listWorkflows(ctx, scopeOf(c)) }),
  );
  // Graph workflows: create, drafts, versions, validation, copilot, runs, tasks, settings.
  app.route('/', workflowRoutes(deps));
  app.get(`${BASE}/workflows/:id`, requireScope(SCOPES.previewRead), async (c) =>
    c.json(await getWorkflow(ctx, scopeOf(c), c.req.param('id'))),
  );
  app.delete(`${BASE}/workflows/:id`, requireScope(SCOPES.contentManage), async (c) => {
    await deleteWorkflow(ctx, scopeOf(c), c.req.param('id'));
    return c.body(null, 204);
  });
  app.get(`${BASE}/entries/:id/workflow`, requireScope(SCOPES.previewRead), async (c) => {
    await authorizeEntryRead(c, c.req.param('id'));
    return c.json(await getEntryWorkflowState(ctx, scopeOf(c), c.req.param('id')));
  });
  // The transition's required scope is data-driven by the target step, so the
  // base guard is only previewRead; transitionEntry enforces the step's scope.
  app.post(
    `${BASE}/entries/:id/workflow/transition`,
    requireScope(SCOPES.previewRead),
    async (c) => {
      const body = await parseBody(c, transitionBody);
      return c.json(
        await transitionEntry(
          ctx,
          scopeOf(c),
          { entryId: c.req.param('id'), workflowId: body.workflowId, toStepId: body.toStepId },
          c.get('principal').scopes,
        ),
      );
    },
  );

  // --- taxonomy (controlled vocabulary) ----------------------------------
  app.get(`${BASE}/taxonomy/schemes`, requireScope(SCOPES.previewRead), async (c) =>
    c.json({ items: await listSchemes(ctx, scopeOf(c)) }),
  );
  app.post(`${BASE}/taxonomy/schemes`, requireScope(SCOPES.contentManage), async (c) =>
    c.json(await createScheme(ctx, scopeOf(c), await parseBody(c, schemeBody)), 201),
  );
  app.delete(`${BASE}/taxonomy/schemes/:id`, requireScope(SCOPES.contentManage), async (c) => {
    await deleteScheme(ctx, scopeOf(c), c.req.param('id'));
    return c.body(null, 204);
  });

  app.get(`${BASE}/taxonomy/concepts`, requireScope(SCOPES.previewRead), async (c) =>
    c.json({ items: await listConcepts(ctx, scopeOf(c), c.req.query('scheme')) }),
  );
  app.post(`${BASE}/taxonomy/concepts`, requireScope(SCOPES.contentManage), async (c) =>
    c.json(await createConcept(ctx, scopeOf(c), await parseBody(c, conceptBody)), 201),
  );
  app.put(
    `${BASE}/taxonomy/concepts/:id/broader`,
    requireScope(SCOPES.contentManage),
    async (c) => {
      const body = await parseBody(c, broaderBody);
      return c.json(
        await setConceptBroader(ctx, scopeOf(c), c.req.param('id'), body.broaderId ?? null),
      );
    },
  );
  app.delete(`${BASE}/taxonomy/concepts/:id`, requireScope(SCOPES.contentManage), async (c) => {
    await deleteConcept(ctx, scopeOf(c), c.req.param('id'));
    return c.body(null, 204);
  });

  app.get(`${BASE}/taxonomy/tags`, requireScope(SCOPES.previewRead), async (c) =>
    c.json({ items: await listTags(ctx, scopeOf(c)) }),
  );
  app.post(`${BASE}/taxonomy/tags`, requireScope(SCOPES.contentManage), async (c) =>
    c.json(await createTag(ctx, scopeOf(c), await parseBody(c, tagBody)), 201),
  );
  app.delete(`${BASE}/taxonomy/tags/:id`, requireScope(SCOPES.contentManage), async (c) => {
    await deleteTag(ctx, scopeOf(c), c.req.param('id'));
    return c.body(null, 204);
  });

  // --- entry taxonomy associations ---------------------------------------
  app.get(`${BASE}/entries/:id/metadata`, requireScope(SCOPES.previewRead), async (c) => {
    await authorizeEntryRead(c, c.req.param('id'));
    return c.json(
      (await getEntryMetadata(ctx, scopeOf(c), c.req.param('id'))) ?? { tags: [], concepts: [] },
    );
  });
  app.put(`${BASE}/entries/:id/metadata`, requireScope(SCOPES.contentWrite), async (c) =>
    c.json(
      await setEntryMetadata(
        ctx,
        scopeOf(c),
        c.req.param('id'),
        await parseBody(c, entryMetadataBody),
      ),
    ),
  );

  return app;
}
