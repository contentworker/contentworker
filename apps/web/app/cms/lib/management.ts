import type {
  AgentReview,
  AgentReviewStatus,
  Asset,
  AssetFolder,
  AssetKind,
  AssetMetadata,
  AssetRights,
  AssetStatus,
  AssetUsage,
  AssetVersion,
  Comment,
  Concept,
  ConceptScheme,
  ContentType,
  ContentTypeDraft,
  EntryFields,
  EntryMetadata,
  EntryVersion,
  EntryWorkflowState,
  FilterOp,
  GraphIssue,
  ReferenceEdge,
  Release,
  ReleaseItem,
  ReleaseWithItems,
  ScheduledAction,
  ScheduledActionType,
  ScheduledEntityType,
  Tag,
  Task,
  WorkflowDefinition,
  WorkflowGraph,
  WorkflowGraphChanges,
  WorkflowGraphDefinition,
  WorkflowNodeRunRecord,
  WorkflowRun,
  WorkflowRunStatus,
  WorkflowStep,
  WorkflowTask,
  WorkflowTaskStatus,
  WorkflowTimelineRecord,
  WorkflowVersion,
} from '@contentworker/domain';

// ---- editorial workflow (graph) shapes, as the Management API returns them ----

/** A workflow: the legacy `{id, name, steps}` plus its draft graph and version bookkeeping. */
export interface WorkflowSummary extends WorkflowGraphDefinition {
  readonly steps: readonly WorkflowStep[];
  /** The draft's flag. */
  readonly gatesPublish: boolean;
  /** Gating in force: the latest published version gates and a run of it can publish. */
  readonly publishGated: boolean;
  readonly latestVersion: number | null;
  readonly legacy: boolean;
  readonly updatedAt: string | null;
}

/** What starts a workflow: its trigger node type and the catalog's name for it. */
export interface WorkflowTrigger {
  readonly type: string;
  readonly label: string;
}

/** A workflow as the list returns it: the summary plus how its PUBLISHED version starts. */
export interface WorkflowListItem extends WorkflowSummary {
  /** The latest published version's trigger; null when never published. */
  readonly publishedTrigger: WorkflowTrigger | null;
  /** Ids of the other published workflows starting on the same trigger for overlapping types. */
  readonly startsAlongside: readonly string[] | null;
}

/** A release as the list returns it, with how many members it holds. */
export interface ReleaseSummary extends Release {
  readonly itemCount: number;
}

export interface WorkflowGraphValidation {
  readonly ok: boolean;
  readonly errors: readonly GraphIssue[];
  readonly warnings: readonly GraphIssue[];
}

export interface WorkflowDraftInput {
  readonly name?: string;
  readonly description?: string;
  readonly contentTypes?: readonly string[];
  readonly graph?: WorkflowGraph;
  readonly gatesPublish?: boolean;
}

export interface WorkflowCopilotProposal {
  readonly graph: WorkflowGraph;
  readonly explanation: string;
  readonly errors: readonly GraphIssue[];
  readonly warnings: readonly GraphIssue[];
  readonly changes: WorkflowGraphChanges;
  /** One line describing `changes`; null when nothing changed. */
  readonly summary: string | null;
  readonly provenance: {
    readonly source: string;
    readonly tier?: string;
    readonly fallback?: string;
  };
}

/** A run as the API returns it (the starter's principal stays server-side). */
export interface WorkflowRunView
  extends Omit<WorkflowRun, 'startedBy' | 'earlyEvents' | 'rev' | 'logSeq'> {
  readonly startedBy: { readonly id: string };
  readonly earlyEvents: readonly { readonly event: string; readonly at: number }[];
}

export interface WorkflowRunFilter {
  readonly entryId?: string;
  readonly workflowId?: string;
  readonly status?: WorkflowRunStatus;
  readonly limit?: number;
}

export interface WorkflowTaskFilter {
  readonly status?: WorkflowTaskStatus;
  readonly runId?: string;
  readonly entryId?: string;
  readonly kind?: WorkflowTask['kind'];
  readonly limit?: number;
}

const queryString = (q: object): string => {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
  }
  const s = params.toString();
  return s ? `?${s}` : '';
};

/**
 * Which space, environment and locale the admin is working in. The browser talks to its own
 * origin: the web Worker's gateway forwards the API's paths to the api Worker with the signed-in
 * person's signed principal, so there is no base URL and no token here.
 */
export interface Connection {
  readonly space: string;
  readonly environment: string;
  /** The locale the editor and previews read and write. */
  readonly locale: string;
}

/**
 * Read-your-writes. The api answers every request with an `x-cw-bookmark` (a D1 session
 * bookmark); sending the latest one back makes the next read come from a replica at least as
 * fresh as this browser's last write. Module-level: one tab, one session, whatever client made
 * the call.
 */
export const BOOKMARK_HEADER = 'x-cw-bookmark';
let bookmark: string | null = null;

/** The latest bookmark seen (tests and diagnostics). */
export const currentBookmark = () => bookmark;

/** Forget the bookmark (tests). */
export const resetBookmark = () => {
  bookmark = null;
};

/** Notes the bookmark a response carries, if any. */
export function rememberBookmark(res: Response): void {
  const b = res.headers?.get?.(BOOKMARK_HEADER);
  if (b) bookmark = b;
}

/** The headers every same-origin API request carries: JSON, plus the bookmark once there is one. */
export function apiHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { ...extra, ...(bookmark ? { [BOOKMARK_HEADER]: bookmark } : {}) };
}

/** Resolved principal from GET /auth/me. */
export interface PrincipalInfo {
  readonly spaceId: string;
  readonly kind: string;
  readonly scopes: readonly string[];
  readonly subject?: string;
  readonly restricted?: boolean;
}

export interface ManagementClientOptions {
  /** Called when any request returns 401 — typically clears credentials and redirects. */
  readonly onUnauthorized?: () => void;
}

export interface EntryAggregate {
  readonly id: string;
  readonly contentTypeApiId: string;
  readonly status: string;
  readonly currentVersion: number;
  readonly publishedVersion: number | null;
}

/** Preview view of an entry (current/draft version). */
export interface PreviewEntry {
  readonly id: string;
  readonly contentType: string;
  readonly status: string;
  readonly version: number;
  readonly fields: Record<string, unknown>;
}

export interface EntryView {
  readonly entry: EntryAggregate;
  readonly fields: EntryFields;
}

/** One field-level predicate. `field` is a content field apiId or a `sys.*`
 *  pseudo-field (e.g. `sys.status`); the client adds the `fields.` namespace. */
export interface EntryFilter {
  readonly field: string;
  readonly op: FilterOp;
  readonly value?: string | readonly string[] | boolean;
}

/** A sort key over a content field apiId or a `sys.*` pseudo-field. */
export interface EntryOrder {
  readonly field: string;
  readonly direction: 'asc' | 'desc';
}

/** How many entries a content type holds, by status; `total` is the live ones (not the trash). */
export interface ContentTypeEntryCounts {
  readonly contentType: string;
  readonly total: number;
  readonly draft: number;
  readonly changed: number;
  readonly published: number;
  readonly archived: number;
}

/** Query options for the entries list (filters/order/search). */
export interface EntryListQuery {
  readonly filters?: readonly EntryFilter[];
  readonly order?: readonly EntryOrder[];
  readonly search?: string;
  readonly limit?: number;
  readonly skip?: number;
  /** List the trash instead of live entries. Trash is hidden by default. */
  readonly trashed?: boolean;
}

/** Namespaces a field path for the query string: `sys.*` stays, else `fields.*`. */
function fieldPath(field: string): string {
  return field.startsWith('sys.') || field.startsWith('metadata.') ? field : `fields.${field}`;
}

/** Serializes an `EntryListQuery` into field-level query params. */
export function entryQueryParams(query: EntryListQuery): URLSearchParams {
  const params = new URLSearchParams();
  for (const f of query.filters ?? []) {
    const path = fieldPath(f.field);
    const key = f.op === 'eq' ? path : `${path}[${f.op}]`;
    const value = Array.isArray(f.value) ? f.value.join(',') : String(f.value ?? '');
    params.set(key, value);
  }
  if (query.order?.length) {
    params.set(
      'order',
      query.order.map((o) => `${o.direction === 'desc' ? '-' : ''}${fieldPath(o.field)}`).join(','),
    );
  }
  if (query.search) params.set('query', query.search);
  if (query.limit != null) params.set('limit', String(query.limit));
  if (query.skip != null) params.set('skip', String(query.skip));
  if (query.trashed) params.set('trashed', 'true');
  return params;
}

/** A space the principal can access (id + display name). */
export interface SpaceRef {
  readonly id: string;
  readonly name: string;
}

/** What a new space starts with: the sample content (`POST /spaces` `starter`), or nothing. */
export type SpaceStarter = 'sample' | 'empty';

/** An environment (branch) within a space. */
export interface Environment {
  readonly id: string;
  readonly name: string;
}

/** A repointable pointer to a target environment (blue/green serving). */
export interface EnvironmentAlias {
  readonly alias: string;
  readonly targetEnvironmentId: string;
  readonly updatedAt: string;
}

/** Space configuration — drives the localization tabs in the editor. */
export interface SpaceConfig {
  readonly spaceId: string;
  readonly name: string;
  readonly defaultLocale: string;
  readonly locales: readonly string[];
  readonly fallbacks?: Readonly<Record<string, string | null>>;
}

/** A published entry as served by the Delivery API (locale-collapsed, links embedded). */
export interface DeliveredEntry {
  readonly id: string;
  readonly contentType: string;
  readonly fields: Record<string, unknown>;
  readonly publishedAt: string;
}

export interface AgentRun {
  readonly id: string;
  readonly workflow: string;
  readonly entryId: string;
  readonly status: string;
  readonly decisions: string[];
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly createdAt: string;
}

export interface UsageSummary {
  readonly runs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface SearchHit {
  readonly entryId: string;
  readonly score: number;
  readonly snippet: string;
}

/** AI model tier — callers pick a tier, the backend maps it to a concrete model. */
export type ModelTier = 'flagship' | 'balanced' | 'fast';

/** Result of an AI draft: localized field values + token usage. */
export interface GeneratedDraft {
  readonly contentTypeApiId: string;
  readonly fields: EntryFields;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
}

export type ApiKeyKind = 'cma' | 'cda' | 'cpa';

/** An API key as listed (the raw token is never returned after creation). */
export interface ApiKeySummary {
  readonly id: string;
  readonly kind: ApiKeyKind;
  readonly name?: string;
  readonly scopes: string[];
  readonly revoked: boolean;
  readonly roleId?: string;
  readonly lastUsedAt?: string;
}

/** Built-in role presets, in order: each can do everything the one before it can. */
export type RolePreset = 'viewer' | 'approver' | 'editor' | 'manager' | 'admin';

/** A preset as the space has it seeded (an admin may have renamed or edited it). */
export interface RolePresetSummary {
  readonly preset: RolePreset;
  readonly roleId: string;
  readonly name: string;
  readonly description?: string;
  readonly scopes: readonly string[];
}

export interface TeamRole {
  readonly id: string;
  readonly name: string;
  readonly preset?: RolePreset;
}

export interface TeamPerson {
  readonly id: string;
  readonly email: string;
  readonly name?: string;
  /** Has signed in with SSO at least once. */
  readonly linked: boolean;
  readonly disabled: boolean;
  readonly role: TeamRole | null;
  /** Their role administers the space. */
  readonly admin: boolean;
  readonly createdAt: string;
}

export interface TeamKey {
  readonly id: string;
  readonly kind: ApiKeyKind;
  readonly name?: string;
  readonly issuance: 'key' | 'oauth' | 'pat' | 'setup';
  readonly subject?: string;
  readonly role: TeamRole | null;
  /** Counts as one of the space's administrators. */
  readonly admin: boolean;
  readonly lastUsedAt?: string;
  readonly expiresAt?: string;
}

/** The team: people and long-lived keys with their roles (GET /spaces/:space/team). */
export interface TeamSummary {
  readonly people: TeamPerson[];
  readonly keys: TeamKey[];
  /** How many administrators the space has; the last one can't be demoted or revoked. */
  readonly adminCount: number;
  readonly settings: { readonly ssoOnly: boolean };
  /** Single sign-on is configured on this deployment. */
  readonly sso: boolean;
}

/** First-run setup status (GET /auth/setup, public). */
export interface SetupStatus {
  readonly needsSetup: boolean;
  readonly open: boolean;
  readonly sso: boolean;
}

/** What redeeming the setup code returns: the admin token once, or where to sign in with SSO. */
export interface SetupResult {
  readonly spaceId: string;
  readonly recovery: boolean;
  readonly member: { readonly id: string; readonly email: string };
  readonly token?: string;
  readonly signIn?: string;
}

/** The server's own message from an ApiError (`{ error: { message } }`), else the error's text. */
export function apiErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    const json = err.message.slice(err.message.indexOf('{'));
    try {
      // The parsed body when the request kept it; else the JSON at the end of the message.
      const body = (err.body ?? JSON.parse(json)) as {
        error?: { message?: string; issues?: { message: string }[] };
      };
      const issue = body.error?.issues?.[0]?.message;
      if (issue) return issue;
      if (body.error?.message) return body.error.message;
    } catch {
      /* not JSON */
    }
  }
  return err instanceof Error ? err.message : String(err);
}

/** True when the API refused because it would leave the space with no administrator. */
export const isLastAdminError = (err: unknown): boolean =>
  err instanceof ApiError && err.status === 409 && err.message.includes('last_admin');

/** Custom role (granular RBAC). */
export interface RoleSummary {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  /** Set on the built-in presets seeded into every space. */
  readonly preset?: RolePreset;
  readonly scopes: readonly string[];
  readonly contentGrants: readonly {
    contentTypeApiId: string;
    actions: readonly ('read' | 'write' | 'publish')[];
    deniedFields?: readonly string[];
    readOnlyFields?: readonly string[];
  }[];
}

export interface PreviewLinkResult {
  readonly url: string;
  readonly token: string;
  readonly expiresAt: string;
}

/** The one-time result of minting a key — `token` is shown once, never again. */
export interface CreatedApiKey {
  readonly id: string;
  readonly kind: ApiKeyKind;
  readonly token: string;
}

/**
 * An application holding OAuth access to this space, on one person's behalf.
 * Several access tokens may sit behind one connection (each refresh mints
 * another); the server folds them together.
 */
export interface ConnectedApp {
  readonly clientId: string;
  readonly clientName: string;
  readonly subject: string;
  readonly scopes: string[];
  readonly tokenCount: number;
  readonly lastUsedAt?: string;
  readonly expiresAt?: string;
}

/** A personal access token as listed (the raw token is never returned again). */
export interface PersonalAccessToken {
  readonly id: string;
  readonly name?: string;
  readonly subject?: string;
  readonly scopes: string[];
  readonly revoked: boolean;
  readonly lastUsedAt?: string;
  readonly expiresAt?: string;
}

/** The one-time result of minting a PAT. */
export interface CreatedPat {
  readonly id: string;
  readonly token: string;
  readonly expiresAt?: string;
}

/**
 * The permission scopes a token can carry, with the plain-language meaning
 * shown when a human is deciding what to grant. Mirrors `SCOPES` in the domain.
 */
export const PERMISSION_SCOPES = [
  { value: 'delivery:read', label: 'Read published content' },
  { value: 'preview:read', label: 'Read drafts' },
  { value: 'search:read', label: 'Search content' },
  { value: 'content:write', label: 'Create and edit content' },
  { value: 'content:publish', label: 'Publish content' },
  { value: 'content:manage', label: 'Change content types' },
  { value: 'space:admin', label: 'Administer the space' },
  { value: 'workflow:approve', label: 'Decide workflow approvals' },
] as const;

/** Event topics a webhook can subscribe to ("*" matches everything). */
export const WEBHOOK_TOPICS = [
  '*',
  'entry.published',
  'entry.unpublished',
  'content_type.published',
] as const;
export type WebhookTopic = (typeof WEBHOOK_TOPICS)[number];

export interface WebhookSummary {
  readonly id: string;
  readonly url: string;
  readonly topics: readonly WebhookTopic[];
  readonly active: boolean;
  /** The one environment whose events it receives; `null` for every environment in the space. */
  readonly environmentId: string | null;
}

/** A recorded webhook delivery attempt. */
export interface WebhookDeliveryRecord {
  readonly id: number;
  readonly webhookId: string;
  readonly eventId: string;
  readonly status: 'success' | 'failed';
  readonly statusCode?: number;
  readonly attempts: number;
  readonly error?: string;
  readonly createdAt: string;
}

/** A single field's difference between two entry versions. */
export interface FieldChange {
  readonly field: string;
  readonly kind: 'added' | 'removed' | 'changed' | 'unchanged';
  readonly before: unknown;
  readonly after: unknown;
}

/** Field-by-field diff of two entry versions (from → to). */
export interface VersionDiff {
  readonly entryId: string;
  readonly from: number;
  readonly to: number;
  readonly changes: readonly FieldChange[];
}

/** How a source-environment item relates to the target. */
export type ChangeKind = 'added' | 'removed' | 'changed' | 'unchanged';

/** A diff of two environments (what merging source→target would change). */
export interface EnvironmentComparison {
  readonly spaceId: string;
  readonly source: string;
  readonly target: string;
  readonly contentTypes: readonly { apiId: string; kind: ChangeKind }[];
  readonly entries: readonly { entryId: string; contentTypeApiId: string; kind: ChangeKind }[];
}

export interface MergeResult {
  readonly mergedContentTypes: readonly string[];
  readonly mergedEntries: readonly string[];
}

export interface AuditEntry {
  readonly id: string;
  readonly spaceId: string;
  readonly environmentId?: string;
  readonly actor: string;
  readonly action: string;
  readonly targetType?: string;
  readonly targetId?: string;
  readonly status: number;
  readonly at: string;
}

/** A persisted, templated AI Action. */
export interface AIAction {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly promptTemplate: string;
  readonly variables: readonly string[];
  readonly targetField?: string;
  readonly tier: ModelTier;
  readonly createdAt: string;
}

/** A user-defined function invoked over HTTP on matching domain events. */
export interface FunctionDefinition {
  readonly id: string;
  readonly name: string;
  readonly eventPattern: string;
  readonly url: string;
  readonly active: boolean;
  readonly createdAt: string;
}

/** An admin UI extension rendered in a sandboxed iframe. */
export interface AppExtension {
  readonly id: string;
  readonly name: string;
  readonly target: 'field-editor' | 'sidebar';
  readonly entryUrl: string;
  readonly fieldTypes?: readonly string[];
  readonly active: boolean;
  readonly createdAt: string;
}

/** A plugin installed in this space, as the management API summarizes it. */
export interface InstalledPluginSummary {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  /** What the manifest asked for. */
  readonly requestedCapabilities: readonly string[];
  /** What a human actually approved — never wider than the request. */
  readonly approvedCapabilities: readonly string[];
  /** What it actually runs with: requested ∩ approved. */
  readonly grantedCapabilities?: readonly string[];
  /**
   * Its manifest predates the `capabilities` field: it is treated as requesting
   * what it already holds, and cannot be switched on until someone approves.
   */
  readonly needsReapproval?: boolean;
  readonly allowedHosts: readonly string[];
  readonly hooks: readonly string[];
  readonly checksum: string;
  readonly enabled: boolean;
  readonly installedAt: string;
  readonly installedBy?: string;
}

/** One entry, reduced to what a chooser shows. */
export interface EntrySuggestion {
  readonly id: string;
  readonly contentType: string;
  readonly status: string;
  readonly title: string;
}

/** A durable job's progress, as the management API reports it. */
export interface BulkJobSummary {
  readonly id: string;
  readonly action:
    | 'publish'
    | 'unpublish'
    | 'import'
    | 'asset_reindex'
    | 'asset_move'
    | 'asset_tag'
    | 'asset_publish'
    | 'asset_unpublish'
    | 'asset_archive';
  readonly status: 'running' | 'completed' | 'cancelled';
  readonly totalItems: number;
  readonly totalChunks: number;
  readonly completedChunks: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly createdAt?: string;
  readonly completedAt?: string;
}

/**
 * A job's per-item failures, chunk by chunk (`GET …/bulk/jobs/:id/report`). An asset job names
 * each failure by the asset's title or file name.
 */
export interface BulkJobReport {
  readonly job: BulkJobSummary;
  readonly chunks: readonly {
    readonly chunkId: string;
    readonly status: string;
    readonly attempts: number;
    readonly itemCount: number;
    readonly failures: readonly {
      readonly id: string;
      readonly error: string;
      readonly name?: string;
    }[];
  }[];
}

/** What `POST …/assets/bulk` runs over a selection of assets, as a job. */
export type AssetBulkRequest =
  | { readonly action: 'move'; readonly ids: readonly string[]; readonly folderId: string | null }
  | {
      readonly action: 'tag';
      readonly ids: readonly string[];
      readonly addTags?: readonly string[];
      readonly removeTags?: readonly string[];
    }
  | { readonly action: 'publish' | 'unpublish' | 'archive'; readonly ids: readonly string[] };

/** Rights as the form sends them: a value, or null for none. */
export type AssetRightsInput = { readonly [K in keyof AssetRights]-?: string | null };

/** Largest import the synchronous route will write; past this, start a job. */
export const IMPORT_SYNC_MAX_RECORDS = 10_000;

/** The body both import phases take — the same request to two paths. */
export interface ImportRequest {
  readonly source: string;
  readonly payload: string;
  readonly mapping: {
    readonly contentTypeApiId: string;
    /** Target field apiId -> source field name. */
    readonly fields: Record<string, string>;
    readonly identityField?: string;
    readonly locale?: string;
  };
  readonly sourceOptions?: Record<string, unknown>;
  readonly conflicts?: 'skip' | 'update' | 'fail';
}

export interface ImportAnalysis {
  readonly contentTypeApiId: string;
  readonly locale: string;
  readonly records: number;
  readonly willCreate: number;
  readonly willUpdate: number;
  readonly willSkip: number;
  readonly invalid: number;
  /** Source fields nothing maps to — the data this import would throw away. */
  readonly unmappedSourceFields: readonly string[];
  readonly missingRequiredFields: readonly string[];
  readonly unknownTargetFields: readonly string[];
  readonly warnings: readonly string[];
  readonly issues: readonly { externalId: string; messages: readonly string[] }[];
  readonly executable: boolean;
}

export interface ImportResult {
  readonly analysis: ImportAnalysis;
  readonly created: number;
  readonly updated: number;
  readonly skipped: number;
  readonly failed: readonly { externalId: string; message: string }[];
}

/** What a package at a URL turns out to be, once the server verified it. */
export interface InspectedPluginPackage {
  readonly manifest: PluginManifestInput;
  /** Checksum of the bytes the server actually fetched. Pin this on install. */
  readonly checksum: string;
  readonly publishedAt?: string;
  readonly bundleBytes: number;
}

/** The manifest half of a plugin package, as authored. */
export interface PluginManifestInput {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly capabilities: readonly string[];
  readonly allowedHosts?: readonly string[];
  readonly hooks: readonly string[];
  readonly entrypoint: string;
}

/**
 * What each capability lets a plugin do, in the words of the person deciding.
 *
 * Consent is only consent if the grant is legible: `content:write` is not a
 * sentence an editor can weigh, and this screen is where authority is handed
 * over. Anything not listed falls back to the raw string rather than being
 * hidden — an unknown capability the operator cannot read is exactly the one
 * they should see verbatim.
 */
export const PLUGIN_CAPABILITIES: readonly {
  value: string;
  label: string;
  detail: string;
}[] = [
  { value: 'content:read', label: 'Read content', detail: 'Drafts and published entries.' },
  { value: 'content:write', label: 'Create and edit content', detail: 'Write entries as itself.' },
  { value: 'content:publish', label: 'Publish content', detail: 'Make entries live.' },
  { value: 'assets:read', label: 'Read assets', detail: 'Media library metadata.' },
  { value: 'assets:write', label: 'Create and edit assets', detail: 'Add or change media.' },
  { value: 'taxonomy:read', label: 'Read taxonomy', detail: 'Tags and concept schemes.' },
  { value: 'taxonomy:write', label: 'Edit taxonomy', detail: 'Change tags and schemes.' },
  { value: 'search:read', label: 'Search content', detail: 'Lexical and semantic search.' },
  { value: 'ai:generate', label: 'Use AI generation', detail: 'Spends the space’s AI budget.' },
  {
    value: 'network:request',
    label: 'Call external services',
    detail: 'Reads from the hosts listed below, and nowhere else. It cannot write to them.',
  },
  { value: 'kv:storage', label: 'Store its own data', detail: 'A namespace only it can see.' },
];

/**
 * Capabilities no runtime here can enforce, so they are never offered.
 *
 * Empty today. `network:request` used to be listed: the isolate's own outbound
 * cannot be filtered per plugin, so it is severed entirely and network access
 * is handed in as a capability method checked against the allowlist host-side
 * — which is enforceable, and is what the consent screen now grants.
 *
 * Kept as a list rather than deleted because the next capability that cannot be
 * enforced should be refused here rather than quietly offered.
 */
export const UNENFORCEABLE_PLUGIN_CAPABILITIES: readonly string[] = [];

/**
 * Capabilities a manifest may declare and a human may approve, but which no
 * host method backs yet. The sandbox refuses calls to them as "not provided",
 * so approving one grants nothing today — said on the consent screen rather
 * than left for a plugin author to discover.
 */
export const UNPROVIDED_PLUGIN_CAPABILITIES: readonly string[] = [
  'assets:write',
  'search:read',
  'ai:generate',
  'kv:storage',
];

/**
 * A requested image transformation. `auto` format lets the image service
 * negotiate AVIF/WebP per browser (Cloudflare Images on the edge deployment).
 */
export interface ImageTransform {
  readonly width?: number;
  readonly height?: number;
  readonly fit?: 'clip' | 'crop' | 'fill' | 'max' | 'scale';
  readonly format?: 'auto' | 'jpg' | 'png' | 'webp' | 'avif';
  readonly quality?: number;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** The response's JSON body, when it had one: `{ error: { code, message, … } }`. */
    readonly body?: unknown,
  ) {
    super(message);
  }

  /** The API's stable error code (`asset_in_use`, `conflict`, …), when the body carried one. */
  get code(): string | undefined {
    return (this.body as { error?: { code?: string } } | undefined)?.error?.code;
  }
}

/**
 * The fields a 422 named (`error.issues[].field`, e.g. `rights.expiresAt`), each with its first
 * message, so a form can say what is wrong beside the field. Empty for any other failure.
 */
export function apiFieldIssues(err: unknown): Record<string, string> {
  if (!(err instanceof ApiError) || err.status !== 422) return {};
  const issues = (err.body as { error?: { issues?: unknown } } | undefined)?.error?.issues;
  const out: Record<string, string> = {};
  if (!Array.isArray(issues)) return out;
  for (const issue of issues as { field?: unknown; message?: unknown }[]) {
    if (typeof issue.field === 'string' && typeof issue.message === 'string') {
      out[issue.field] ??= issue.message;
    }
  }
  return out;
}

/** True when the API refused because the caller's role lacks the scope (403). */
export const isForbidden = (err: unknown): boolean => err instanceof ApiError && err.status === 403;

/** The links that hold an asset, as a refused delete reports them: the first few, and how many. */
export interface AssetInUse {
  /** The first links (the API sends at most 50), each with its entry's type and title. */
  readonly usage: readonly AssetUsage[];
  /** Every link, counted, so the screen can say how many it isn't showing. */
  readonly total: number;
}

/**
 * Why an asset couldn't be deleted: the entries that still link to it (409 `asset_in_use`), so the
 * screen can show where it is used without fetching each entry. Null for any other failure.
 */
export function assetUsageOf(err: unknown): AssetInUse | null {
  if (!(err instanceof ApiError) || err.status !== 409 || err.code !== 'asset_in_use') return null;
  const body = (err.body as { error?: { usage?: unknown; total?: unknown } }).error;
  const usage = Array.isArray(body?.usage) ? (body.usage as AssetUsage[]) : [];
  const total = typeof body?.total === 'number' ? body.total : usage.length;
  return { usage, total };
}

/** What the asset library can be narrowed and ordered by (the API's `GET …/assets` query). */
export interface AssetListQuery {
  readonly kind?: AssetKind;
  /** Exact (`image/png`) or a family (`image/*`). */
  readonly mime?: string;
  readonly tag?: string;
  /** A folder id, or `root` for assets in no folder; absent: every folder. */
  readonly folder?: string;
  /** Absent hides archived assets. */
  readonly status?: AssetStatus | 'all';
  readonly sort?: 'updatedAt' | 'createdAt' | 'size';
  readonly order?: 'asc' | 'desc';
  readonly limit?: number;
  readonly cursor?: string;
}

/** One page of assets; pass `nextCursor` back as `cursor` for the next. */
export interface AssetPage {
  readonly items: Asset[];
  readonly nextCursor?: string;
}

/** An asset search (`GET …/assets/search`): text, and the filters that narrow it. */
export interface AssetSearchQuery {
  readonly q: string;
  readonly kind?: AssetKind;
  readonly tag?: string;
  /** A folder id, or `root` for assets in no folder; absent: every folder. */
  readonly folder?: string;
  /** Absent hides archived assets. */
  readonly status?: AssetStatus | 'all';
  /** 1..100; the API's default is 20. */
  readonly limit?: number;
}

/**
 * How many matches each facet value has, each counted with the other filters but not its own:
 * `kind` by asset kind, `tag` by tag id, `folder` by folder id (`root` for assets in no folder).
 */
export interface AssetFacets {
  readonly kind: Readonly<Record<string, number>>;
  readonly tag: Readonly<Record<string, number>>;
  readonly folder: Readonly<Record<string, number>>;
}

/** An asset search's results: best match first, with facet counts. */
export interface AssetSearchPage {
  readonly items: Asset[];
  readonly total: number;
  readonly facets: AssetFacets;
}

/** The query string for an {@link AssetListQuery}, without the empty parts. */
export function assetQueryParams(query: AssetListQuery | AssetSearchQuery): URLSearchParams {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== '') params.set(k, String(v));
  }
  return params;
}

/**
 * Typed client for the Management + Preview APIs. The admin uses one CMA/admin
 * token (CMA keys carry preview:read, so the same token lists drafts and writes
 * content). Management routes author/publish; Preview routes list drafts.
 */
export function createManagementClient(
  conn: Connection,
  fetchImpl: typeof fetch = fetch,
  options: ManagementClientOptions = {},
) {
  // Same origin: the web Worker's gateway forwards these paths to the api Worker.
  const root = '';
  const spaceBase = `${root}/spaces/${conn.space}`;
  const mgmt = `${root}/spaces/${conn.space}/environments/${conn.environment}`;
  const preview = `${root}/preview/${conn.space}/${conn.environment}`;
  const delivery = `${root}/delivery/${conn.space}/${conn.environment}`;
  async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
    const res = await fetchImpl(url, {
      method,
      headers: apiHeaders({ 'content-type': 'application/json' }),
      credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    rememberBookmark(res);
    if (!res.ok) {
      if (res.status === 401) options.onUnauthorized?.();
      const text = await res.text().catch(() => '');
      let body: unknown;
      try {
        body = text ? JSON.parse(text) : undefined;
      } catch {
        body = undefined;
      }
      throw new ApiError(res.status, `${method} ${url} → ${res.status} ${text}`, body);
    }
    return (res.status === 204 ? undefined : await res.json()) as T;
  }
  // The bytes go straight to storage on the signed URL the API handed out, not through the API.
  async function putFile(upload: { url: string; headers: Record<string, string> }, file: File) {
    const put = await fetchImpl(upload.url, { method: 'PUT', headers: upload.headers, body: file });
    if (!put.ok) throw new ApiError(put.status, `upload failed: ${put.status}`);
  }

  return {
    getSpaceConfig(): Promise<SpaceConfig> {
      return req('GET', `${mgmt}/space-config`);
    },
    /** Spaces the current token can reach (admin → all; a scoped key → its own). */
    async listSpaces(): Promise<SpaceRef[]> {
      const r = await req<{ items: SpaceRef[] }>('GET', `${root}/spaces`);
      return r.items;
    },
    /** Provision a new space, optionally with sample content (deployment admins only). */
    createSpace(input: {
      spaceId: string;
      name: string;
      defaultLocale: string;
      locales?: string[];
      starter?: SpaceStarter;
    }): Promise<SpaceRef & { starter: SpaceStarter }> {
      return req('POST', `${root}/spaces`, input);
    },
    /** Environments (branches) in the current space. */
    async listEnvironments(): Promise<Environment[]> {
      const r = await req<{ items: Environment[] }>('GET', `${spaceBase}/environments`);
      return r.items;
    },
    createEnvironment(input: { id: string; name?: string }): Promise<{ id: string }> {
      return req('POST', `${spaceBase}/environments`, input);
    },
    /** Environment aliases (repointable blue/green pointers) in the current space. */
    async listEnvironmentAliases(): Promise<EnvironmentAlias[]> {
      const r = await req<{ items: EnvironmentAlias[] }>('GET', `${spaceBase}/environment-aliases`);
      return r.items;
    },
    /** Creates or atomically repoints an alias at a target environment. */
    setEnvironmentAlias(alias: string, targetEnvironmentId: string): Promise<EnvironmentAlias> {
      return req('PUT', `${spaceBase}/environment-aliases/${encodeURIComponent(alias)}`, {
        targetEnvironmentId,
      });
    },
    deleteEnvironmentAlias(alias: string): Promise<void> {
      return req('DELETE', `${spaceBase}/environment-aliases/${encodeURIComponent(alias)}`);
    },
    /** Diffs two environments (content types + entries that differ). */
    compareEnvironments(source: string, target: string): Promise<EnvironmentComparison> {
      return req(
        'GET',
        `${spaceBase}/compare?source=${encodeURIComponent(source)}&target=${encodeURIComponent(target)}`,
      );
    },
    /** Applies selected content types/entries from source→target (additive). */
    mergeEnvironments(input: {
      source: string;
      target: string;
      contentTypes?: string[];
      entries?: string[];
    }): Promise<MergeResult> {
      return req('POST', `${spaceBase}/merge`, input);
    },
    /** Reads the space's append-only audit trail, newest first (requires space:admin). */
    async listAuditLog(
      query: { environment?: string; limit?: number } = {},
    ): Promise<AuditEntry[]> {
      const params = new URLSearchParams();
      if (query.environment) params.set('environment', query.environment);
      if (query.limit) params.set('limit', String(query.limit));
      const qs = params.toString();
      const r = await req<{ items: AuditEntry[] }>(
        'GET',
        `${spaceBase}/audit-log${qs ? `?${qs}` : ''}`,
      );
      return r.items;
    },
    async listContentTypes(): Promise<ContentType[]> {
      const r = await req<{ items: ContentType[] }>('GET', `${mgmt}/content-types`);
      return r.items;
    },
    getContentType(apiId: string): Promise<ContentType> {
      return req('GET', `${mgmt}/content-types/${apiId}`);
    },
    /** Create or update a content type (the route is idempotent on apiId). */
    saveContentType(draft: ContentTypeDraft): Promise<ContentType> {
      return req('POST', `${mgmt}/content-types`, draft);
    },
    publishContentType(apiId: string): Promise<ContentType> {
      return req('POST', `${mgmt}/content-types/${apiId}/published`);
    },
    /** Entries per content type by status, from one grouped count (the content overview). */
    async contentTypeEntryCounts(): Promise<ContentTypeEntryCounts[]> {
      const r = await req<{ items: ContentTypeEntryCounts[] }>(
        'GET',
        `${mgmt}/content-types/entry-counts`,
      );
      return r.items;
    },
    /** Lists draft/current entries (Preview API), with optional field filters,
     *  ordering, and full-text search applied server-side. */
    async listEntries(contentType?: string, query: EntryListQuery = {}): Promise<PreviewEntry[]> {
      const params = entryQueryParams(query);
      if (contentType) params.set('content_type', contentType);
      const qs = params.toString();
      const r = await req<{ items: PreviewEntry[] }>(
        'GET',
        `${preview}/entries${qs ? `?${qs}` : ''}`,
      );
      return r.items;
    },
    /**
     * Entries matching what someone is typing, resolved server-side.
     *
     * A chooser cannot filter a fetched list: `listEntries` is capped, so an
     * entry past the cap is unreachable rather than merely slow to find.
     */
    async suggestEntries(input: {
      q?: string;
      contentType?: string;
      limit?: number;
    }): Promise<EntrySuggestion[]> {
      const params = new URLSearchParams();
      if (input.q) params.set('q', input.q);
      if (input.contentType) params.set('content_type', input.contentType);
      if (input.limit) params.set('limit', String(input.limit));
      if (conn.locale) params.set('locale', conn.locale);
      const qs = params.toString();
      const r = await req<{ items: EntrySuggestion[] }>(
        'GET',
        `${preview}/suggest${qs ? `?${qs}` : ''}`,
      );
      return r.items;
    },
    /**
     * One entry's current (draft) version. Read through the list route filtered by `sys.id`:
     * the single-entry preview route (`/preview/:space/:env/entries/:id`) authenticates only a
     * bearer or a shareable preview token, not the web app's signed principal.
     */
    async getEntry(id: string): Promise<PreviewEntry> {
      const r = await req<{ items: PreviewEntry[] }>(
        'GET',
        `${preview}/entries?sys.id=${encodeURIComponent(id)}&limit=1`,
      );
      const entry = r.items.find((e) => e.id === id);
      if (!entry) throw new ApiError(404, `Entry ${id} was not found`);
      return entry;
    },

    // --- trash lifecycle -------------------------------------------------
    /** Moves an entry to the trash, unpublishing it first when it is live. */
    trashEntry(id: string): Promise<EntryAggregate> {
      return req('DELETE', `${mgmt}/entries/${encodeURIComponent(id)}`);
    },
    restoreEntry(id: string): Promise<EntryAggregate> {
      return req('POST', `${mgmt}/entries/${encodeURIComponent(id)}/restore`);
    },
    /** Irreversible. `force` deletes even when published entries still link to it. */
    purgeEntry(id: string, force = false): Promise<void> {
      return req(
        'DELETE',
        `${mgmt}/entries/${encodeURIComponent(id)}/permanent${force ? '?force=true' : ''}`,
      );
    },
    duplicateEntry(id: string): Promise<{ entry: EntryAggregate }> {
      return req('POST', `${mgmt}/entries/${encodeURIComponent(id)}/duplicate`);
    },
    /** Entries/assets that reference this entry ("what links here"). */
    async reverseReferences(id: string): Promise<ReferenceEdge[]> {
      const r = await req<{ items: ReferenceEdge[] }>(
        'GET',
        `${mgmt}/entries/${encodeURIComponent(id)}/reverse-references`,
      );
      return r.items;
    },
    /** Reads the published (delivery) version of an entry, rendered for the connection locale. */
    getPublished(id: string): Promise<DeliveredEntry> {
      return req(
        'GET',
        `${delivery}/entries/${encodeURIComponent(id)}?locale=${encodeURIComponent(conn.locale)}`,
      );
    },
    /** `fields` is the localized shape: `{ field: { locale: value } }`. */
    createEntry(contentTypeApiId: string, fields: EntryFields): Promise<EntryView> {
      return req('POST', `${mgmt}/entries`, { contentTypeApiId, fields });
    },
    updateEntry(id: string, fields: EntryFields): Promise<EntryView> {
      return req('PUT', `${mgmt}/entries/${encodeURIComponent(id)}`, { fields });
    },
    publishEntry(id: string): Promise<EntryAggregate> {
      return req('POST', `${mgmt}/entries/${encodeURIComponent(id)}/published`);
    },
    unpublishEntry(id: string): Promise<EntryAggregate> {
      return req('DELETE', `${mgmt}/entries/${encodeURIComponent(id)}/published`);
    },
    /** AI-draft field values for a content type from a natural-language prompt. */
    generateEntry(input: {
      contentTypeApiId: string;
      prompt: string;
      tier?: ModelTier;
    }): Promise<GeneratedDraft> {
      return req('POST', `${mgmt}/entries/generate`, input);
    },
    /** Map free-form prose into a content type's structured fields (Canvas authoring). */
    canvasEntry(input: {
      contentTypeApiId: string;
      prose: string;
      tier?: ModelTier;
    }): Promise<GeneratedDraft> {
      return req('POST', `${mgmt}/entries/canvas`, input);
    },

    // --- assets ----------------------------------------------------------
    /** One page of the asset library, filtered and sorted server-side. */
    listAssets(query: AssetListQuery = {}): Promise<AssetPage> {
      const qs = assetQueryParams(query).toString();
      return req('GET', `${mgmt}/assets${qs ? `?${qs}` : ''}`);
    },
    /** Searches the library (full text and semantic), with facet counts. */
    searchAssets(query: AssetSearchQuery): Promise<AssetSearchPage> {
      const qs = assetQueryParams(query).toString();
      return req('GET', `${mgmt}/assets/search?${qs}`);
    },
    getAsset(id: string): Promise<Asset> {
      return req('GET', `${mgmt}/assets/${encodeURIComponent(id)}`);
    },
    /** Runs ingest on the asset's file again (after it failed); comes back pending. */
    reingestAsset(id: string): Promise<Asset> {
      return req('POST', `${mgmt}/assets/${encodeURIComponent(id)}/reingest`);
    },
    /**
     * Sends the library through ingest as a bulk job: the assets never ingested or whose ingest
     * failed, or every asset with a file (`all`).
     */
    reindexAssets(opts: { all?: boolean } = {}): Promise<{
      assets: number;
      job?: BulkJobSummary;
    }> {
      return req('POST', `${mgmt}/assets/reindex`, opts);
    },
    createAsset(input: {
      fileName: string;
      contentType: string;
      title?: string;
      folderId?: string;
    }): Promise<{
      asset: Asset;
      upload: { url: string; headers: Record<string, string> };
    }> {
      const title = input.title ? { [conn.locale]: input.title } : undefined;
      return req('POST', `${mgmt}/assets`, {
        fileName: input.fileName,
        contentType: input.contentType,
        title,
        ...(input.folderId ? { folderId: input.folderId } : {}),
      });
    },
    /**
     * Acts on a selection of assets as a resumable job: follow it with {@link getBulkJob}, and
     * read what failed, by asset name, with {@link getBulkJobReport}.
     */
    startAssetBulkJob(input: AssetBulkRequest): Promise<BulkJobSummary> {
      return req('POST', `${mgmt}/assets/bulk`, input);
    },
    /** Starts replacing an asset's file: a signed PUT for the next version, and what to commit. */
    startAssetFileReplacement(
      id: string,
      input: { fileName: string; contentType: string },
    ): Promise<{
      asset: Asset;
      upload: { url: string; headers: Record<string, string> };
      commit: { version: number; fileName: string; contentType: string };
    }> {
      return req('POST', `${mgmt}/assets/${encodeURIComponent(id)}/file`, input);
    },
    /** Makes the uploaded replacement current as a new version. */
    commitAssetFile(
      id: string,
      commit: { version: number; fileName: string; contentType: string },
    ): Promise<Asset> {
      return req('POST', `${mgmt}/assets/${encodeURIComponent(id)}/file/commit`, commit);
    },
    /** Every file the asset has had, newest first, with which is current and which is delivered. */
    async listAssetVersions(id: string): Promise<AssetVersion[]> {
      const r = await req<{ items: AssetVersion[] }>(
        'GET',
        `${mgmt}/assets/${encodeURIComponent(id)}/versions`,
      );
      return r.items;
    },
    /** Makes an earlier version's file current again, as a new version. */
    restoreAssetVersion(id: string, version: number): Promise<Asset> {
      return req('POST', `${mgmt}/assets/${encodeURIComponent(id)}/versions/${version}/restore`);
    },
    /** Replaces an asset's usage rights (content:publish); null clears a field. */
    setAssetRights(id: string, rights: AssetRightsInput): Promise<Asset> {
      return req('PUT', `${mgmt}/assets/${encodeURIComponent(id)}/rights`, rights);
    },
    /** Files assets in a folder; `null` takes them back to the root. */
    moveAssets(ids: readonly string[], folderId: string | null): Promise<{ moved: number }> {
      return req('POST', `${mgmt}/assets/move`, { ids, folderId });
    },
    /** Takes an asset out of Delivery and out of the library's default view. */
    archiveAsset(id: string): Promise<Asset> {
      return req('POST', `${mgmt}/assets/${encodeURIComponent(id)}/archive`);
    },
    /** Brings an archived asset back as a draft. */
    restoreAsset(id: string): Promise<Asset> {
      return req('POST', `${mgmt}/assets/${encodeURIComponent(id)}/restore`);
    },
    /**
     * Deletes an asset and its files. Refused (409 `asset_in_use`, read with
     * {@link assetUsageOf}) while an entry links to it.
     */
    deleteAsset(id: string): Promise<void> {
      return req('DELETE', `${mgmt}/assets/${encodeURIComponent(id)}`);
    },
    async listAssetFolders(): Promise<AssetFolder[]> {
      const r = await req<{ items: AssetFolder[] }>('GET', `${mgmt}/asset-folders`);
      return r.items;
    },
    createAssetFolder(input: { name: string; parentId?: string }): Promise<AssetFolder> {
      return req('POST', `${mgmt}/asset-folders`, input);
    },
    updateAssetFolder(
      id: string,
      patch: { name?: string; parentId?: string | null },
    ): Promise<AssetFolder> {
      return req('PATCH', `${mgmt}/asset-folders/${encodeURIComponent(id)}`, patch);
    },
    /** Deletes an empty folder (409 while anything is in it). */
    deleteAssetFolder(id: string): Promise<void> {
      return req('DELETE', `${mgmt}/asset-folders/${encodeURIComponent(id)}`);
    },
    /** Creates a draft video asset with a one-time direct upload to the video host. */
    createVideoAsset(input: { fileName: string; contentType: string; title?: string }): Promise<{
      asset: Asset;
      upload: { videoId: string; uploadUrl: string; method: 'POST'; fileField: string };
    }> {
      const title = input.title ? { [conn.locale]: input.title } : undefined;
      return req('POST', `${mgmt}/assets/videos`, {
        fileName: input.fileName,
        contentType: input.contentType,
        title,
      });
    },
    /** Re-reads a video asset's processing status, playback URLs and poster. */
    refreshVideoAsset(id: string): Promise<Asset> {
      return req('POST', `${mgmt}/assets/${encodeURIComponent(id)}/video/refresh`);
    },
    publishAsset(id: string): Promise<Asset> {
      return req('POST', `${mgmt}/assets/${encodeURIComponent(id)}/published`);
    },
    unpublishAsset(id: string): Promise<Asset> {
      return req('DELETE', `${mgmt}/assets/${encodeURIComponent(id)}/published`);
    },
    /** Updates an asset's editorial metadata (alt text, focal point, tags, custom fields). */
    setAssetMetadata(id: string, patch: Partial<AssetMetadata>): Promise<Asset> {
      return req('PATCH', `${mgmt}/assets/${encodeURIComponent(id)}/metadata`, patch);
    },
    /** Lists the entries that reference an asset (where it is used). */
    async assetUsage(id: string): Promise<ReferenceEdge[]> {
      const r = await req<{ items: ReferenceEdge[] }>(
        'GET',
        `${mgmt}/assets/${encodeURIComponent(id)}/usage`,
      );
      return r.items;
    },
    // --- content semantics (vector-backed) -------------------------------
    /** Entries semantically related to a given entry. */
    async relatedEntries(id: string, topK?: number): Promise<SearchHit[]> {
      const qs = topK ? `?top_k=${topK}` : '';
      const r = await req<{ items: SearchHit[] }>(
        'GET',
        `${mgmt}/entries/${encodeURIComponent(id)}/related${qs}`,
      );
      return r.items;
    },
    /** Near-duplicate entries for a given entry (high similarity). */
    async findDuplicates(id: string, threshold?: number): Promise<SearchHit[]> {
      const qs = threshold ? `?threshold=${threshold}` : '';
      const r = await req<{ items: SearchHit[] }>(
        'GET',
        `${mgmt}/entries/${encodeURIComponent(id)}/duplicates${qs}`,
      );
      return r.items;
    },

    // --- AI Actions (templated, governed) --------------------------------
    async listAIActions(): Promise<AIAction[]> {
      const r = await req<{ items: AIAction[] }>('GET', `${mgmt}/ai-actions`);
      return r.items;
    },
    createAIAction(input: {
      name: string;
      promptTemplate: string;
      description?: string;
      targetField?: string;
      tier?: ModelTier;
    }): Promise<AIAction> {
      return req('POST', `${mgmt}/ai-actions`, input);
    },
    deleteAIAction(id: string): Promise<void> {
      return req('DELETE', `${mgmt}/ai-actions/${encodeURIComponent(id)}`);
    },
    runAIAction(
      id: string,
      input: {
        entryId?: string;
        variables?: Record<string, string>;
        locale?: string;
        apply?: boolean;
      } = {},
    ): Promise<{ actionId: string; output: string; applied: boolean }> {
      return req('POST', `${mgmt}/ai-actions/${encodeURIComponent(id)}/run`, input);
    },

    // --- functions (event-triggered) -------------------------------------
    async listFunctions(): Promise<FunctionDefinition[]> {
      const r = await req<{ items: FunctionDefinition[] }>('GET', `${mgmt}/functions`);
      return r.items;
    },
    createFunction(input: {
      name: string;
      eventPattern: string;
      url: string;
      active?: boolean;
    }): Promise<FunctionDefinition> {
      return req('POST', `${mgmt}/functions`, input);
    },
    deleteFunction(id: string): Promise<void> {
      return req('DELETE', `${mgmt}/functions/${encodeURIComponent(id)}`);
    },

    // --- importing content from elsewhere ---------------------------------
    async listImportSources(): Promise<{ id: string; name: string }[]> {
      const r = await req<{ items: { id: string; name: string }[] }>(
        'GET',
        `${mgmt}/imports/sources`,
      );
      return r.items;
    },
    /** Reports what an import would do. Writes nothing. */
    analyzeImport(input: ImportRequest): Promise<ImportAnalysis> {
      return req('POST', `${mgmt}/imports/analyze`, input);
    },
    runImport(input: ImportRequest): Promise<ImportResult> {
      return req('POST', `${mgmt}/imports`, input);
    },
    /** Starts the same import as a resumable job, for files too big for one request. */
    startImportJob(input: ImportRequest): Promise<{ job: BulkJobSummary }> {
      return req('POST', `${mgmt}/imports/job`, input);
    },
    getBulkJob(id: string): Promise<BulkJobSummary> {
      return req('GET', `${mgmt}/bulk/jobs/${encodeURIComponent(id)}`);
    },
    /** A job's failures by item; 403 for a role limited to some content types. */
    getBulkJobReport(id: string): Promise<BulkJobReport> {
      return req('GET', `${mgmt}/bulk/jobs/${encodeURIComponent(id)}/report`);
    },

    // --- plugins (sandboxed code on the write path) ----------------------
    // Space-scoped, not environment-scoped: a plugin is installed once for a
    // space and runs in every environment in it. Pointing these at `mgmt`
    // silently 404s, which reads as "no plugins installed".
    async listPlugins(): Promise<InstalledPluginSummary[]> {
      const r = await req<{ items: InstalledPluginSummary[] }>('GET', `${spaceBase}/plugins`);
      return r.items;
    },
    /** Installs disabled: approving a capability list and running code are two decisions. */
    installPlugin(input: {
      manifest: PluginManifestInput;
      bundle: string;
      approvedCapabilities: string[];
    }): Promise<InstalledPluginSummary> {
      return req('POST', `${spaceBase}/plugins`, input);
    },
    /**
     * Fetches a package over HTTPS and installs it, disabled.
     *
     * `expectedChecksum` pins the release: the server refuses bytes that
     * changed since the operator wrote that checksum down, which is the whole
     * reason to install from a URL rather than a file someone already has.
     */
    /**
     * Fetches and verifies a package without installing it, so the consent
     * screen has a manifest to show. Install with `expectedChecksum` set to
     * what this returned.
     */
    inspectPluginPackage(input: {
      packageUrl: string;
      expectedChecksum?: string;
    }): Promise<InspectedPluginPackage> {
      return req('POST', `${spaceBase}/plugins/from-url/inspect`, input);
    },
    installPluginFromUrl(input: {
      packageUrl: string;
      approvedCapabilities: string[];
      expectedChecksum?: string;
      expectedId?: string;
      expectedVersion?: string;
    }): Promise<InstalledPluginSummary> {
      return req('POST', `${spaceBase}/plugins/from-url`, input);
    },
    /**
     * Replaces the manifest and bundle. Omit `approvedCapabilities` to carry the
     * existing grant forward; a version asking for more requires it, and lands
     * disabled so a human sees what changed before it runs again.
     */
    upgradePlugin(
      id: string,
      input: {
        manifest: PluginManifestInput;
        bundle: string;
        approvedCapabilities?: string[];
      },
    ): Promise<InstalledPluginSummary> {
      return req('PUT', `${spaceBase}/plugins/${encodeURIComponent(id)}`, input);
    },
    /**
     * Records a fresh capability decision without changing the code. Never
     * wider than the manifest; a grant that grows disables the plugin.
     */
    approvePluginCapabilities(
      id: string,
      approvedCapabilities: readonly string[],
    ): Promise<InstalledPluginSummary> {
      return req('POST', `${spaceBase}/plugins/${encodeURIComponent(id)}/capabilities`, {
        approvedCapabilities,
      });
    },
    setPluginEnabled(id: string, enabled: boolean): Promise<InstalledPluginSummary> {
      return req('POST', `${spaceBase}/plugins/${encodeURIComponent(id)}/enabled`, { enabled });
    },
    uninstallPlugin(id: string): Promise<void> {
      return req('DELETE', `${spaceBase}/plugins/${encodeURIComponent(id)}`);
    },

    // --- app extensions (UI extensions) ----------------------------------
    async listAppExtensions(): Promise<AppExtension[]> {
      const r = await req<{ items: AppExtension[] }>('GET', `${mgmt}/app-extensions`);
      return r.items;
    },
    createAppExtension(input: {
      name: string;
      target: 'field-editor' | 'sidebar';
      entryUrl: string;
      fieldTypes?: string[];
      active?: boolean;
    }): Promise<AppExtension> {
      return req('POST', `${mgmt}/app-extensions`, input);
    },
    deleteAppExtension(id: string): Promise<void> {
      return req('DELETE', `${mgmt}/app-extensions/${encodeURIComponent(id)}`);
    },

    // --- Live Content API (SSE) ------------------------------------------
    /**
     * Subscribes to the Live Content API, invoking `onEvent` per published-content
     * change until `signal` aborts. Uses fetch streaming (EventSource can't send
     * the bearer token); keepalive `ping` frames are filtered out.
     */
    async subscribeLive(
      onEvent: (e: { type: string; data: unknown }) => void,
      signal: AbortSignal,
    ): Promise<void> {
      const res = await fetchImpl(`${delivery}/live`, {
        headers: apiHeaders(),
        credentials: 'same-origin',
        signal,
      });
      rememberBookmark(res);
      if (!res.ok || !res.body) throw new ApiError(res.status, `live failed: ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const frames = buf.split('\n\n');
        buf = frames.pop() ?? '';
        for (const frame of frames) {
          let type = 'message';
          let data = '';
          for (const line of frame.split('\n')) {
            if (line.startsWith('event:')) type = line.slice(6).trim();
            else if (line.startsWith('data:')) data += line.slice(5).trim();
          }
          if (type === 'ping' || !data) continue;
          try {
            onEvent({ type, data: JSON.parse(data) });
          } catch {
            onEvent({ type, data });
          }
        }
      }
    },

    // --- bulk operations -------------------------------------------------
    /** Publishes or unpublishes many entries in one call; failures are per-item. */
    bulkEntryAction(
      action: 'publish' | 'unpublish',
      ids: string[],
    ): Promise<{
      total: number;
      succeeded: number;
      failed: number;
      results: { id: string; ok: boolean; error?: string }[];
    }> {
      return req('POST', `${mgmt}/bulk/entries/${action}`, { ids });
    },

    // --- agent actions (audit → work packages) ---------------------------
    auditEntry(
      id: string,
      input: {
        createTasks?: boolean;
        taskSeverity?: 'info' | 'warning' | 'error';
        assignee?: string;
      } = {},
    ): Promise<{
      findings: {
        field?: string;
        severity: 'info' | 'warning' | 'error';
        message: string;
        suggestedAction: string;
      }[];
      taskIds: string[];
    }> {
      return req('POST', `${mgmt}/entries/${encodeURIComponent(id)}/audit`, input);
    },

    // --- AI content operations over an entry -----------------------------
    /** Translates an entry's localized text fields; `apply` saves a draft. */
    translateEntry(
      id: string,
      input: { targetLocale: string; sourceLocale?: string; apply?: boolean },
    ): Promise<{ fields: EntryFields; translatedFields: string[]; applied: boolean }> {
      return req('POST', `${mgmt}/entries/${encodeURIComponent(id)}/translate`, input);
    },
    /** Summarizes an entry; `apply` writes the summary into `targetField`. */
    summarizeEntry(
      id: string,
      input: { locale?: string; maxWords?: number; targetField?: string; apply?: boolean } = {},
    ): Promise<{ summary: string; applied: boolean }> {
      return req('POST', `${mgmt}/entries/${encodeURIComponent(id)}/summarize`, input);
    },
    /** Generates a value for one scalar field; `apply` saves it. */
    autofillField(
      id: string,
      input: { field: string; locale?: string; instructions?: string; apply?: boolean },
    ): Promise<{ field: string; value: unknown; applied: boolean }> {
      return req('POST', `${mgmt}/entries/${encodeURIComponent(id)}/autofill`, input);
    },
    /** Suggests taxonomy tags for an entry; `apply` creates + assigns them. */
    suggestEntryTags(
      id: string,
      input: { apply?: boolean } = {},
    ): Promise<{ tagIds: string[]; newTags: string[]; applied: boolean }> {
      return req('POST', `${mgmt}/entries/${encodeURIComponent(id)}/suggest-tags`, input);
    },
    /** Persists a reviewed tag suggestion exactly as approved (no model re-run). */
    applyEntryTags(
      id: string,
      input: { tagIds?: string[]; newTags?: string[] },
    ): Promise<{ tagIds: string[]; createdTags: { id: string; name: string }[] }> {
      return req('POST', `${mgmt}/entries/${encodeURIComponent(id)}/apply-tags`, input);
    },
    /** Suggests alt text for an image; `apply` writes it to the asset metadata. */
    generateAltText(
      id: string,
      input: { locale?: string; context?: string; apply?: boolean } = {},
    ): Promise<{ altText: string; locale: string; applied: boolean }> {
      return req('POST', `${mgmt}/assets/${encodeURIComponent(id)}/alt-text`, input);
    },
    /** Suggests taxonomy tags for an image; `apply` creates + assigns them. */
    autoTagAsset(
      id: string,
      input: { apply?: boolean } = {},
    ): Promise<{ tagIds: string[]; newTags: string[]; applied: boolean }> {
      return req('POST', `${mgmt}/assets/${encodeURIComponent(id)}/auto-tag`, input);
    },
    /** Resolves a transformed-image URL for an asset (focal-point-aware). */
    transformAsset(
      id: string,
      transform: ImageTransform,
    ): Promise<{ url: string; transform: ImageTransform }> {
      const params = new URLSearchParams();
      if (transform.width) params.set('w', String(transform.width));
      if (transform.height) params.set('h', String(transform.height));
      if (transform.fit) params.set('fit', transform.fit);
      if (transform.format) params.set('fm', transform.format);
      if (transform.quality != null) params.set('q', String(transform.quality));
      const qs = params.toString();
      return req('GET', `${mgmt}/assets/${encodeURIComponent(id)}/transform${qs ? `?${qs}` : ''}`);
    },
    /**
     * Full upload: create the draft asset (gets a presigned PUT), upload the
     * bytes directly to storage, then publish. Returns the published asset.
     */
    async uploadAsset(file: File, opts: { folderId?: string } = {}): Promise<Asset> {
      const { asset, upload } = await this.createAsset({
        fileName: file.name,
        contentType: file.type || 'application/octet-stream',
        title: file.name,
        ...(opts.folderId ? { folderId: opts.folderId } : {}),
      });
      await putFile(upload, file);
      return this.publishAsset(asset.id);
    },
    /**
     * Replaces an asset's file the way Upload creates one: the signed PUT for the next version,
     * then the commit that makes it current. A published asset keeps delivering its published
     * file until it is published again. Returns the asset at its new version.
     */
    async replaceAssetFile(id: string, file: File): Promise<Asset> {
      // Straight through `req`, not `this`: the method still works passed around on its own.
      const base = `${mgmt}/assets/${encodeURIComponent(id)}/file`;
      const { upload, commit } = await req<{
        upload: { url: string; headers: Record<string, string> };
        commit: { version: number; fileName: string; contentType: string };
      }>('POST', base, {
        fileName: file.name,
        contentType: file.type || 'application/octet-stream',
      });
      await putFile(upload, file);
      return req<Asset>('POST', `${base}/commit`, commit);
    },
    /**
     * Video upload: create the draft video asset, POST the bytes straight to
     * the video host, then refresh its status. Stays a draft — publish once
     * the host reports it ready, so the delivered snapshot carries playback.
     */
    async uploadVideo(file: File): Promise<Asset> {
      const { asset, upload } = await this.createVideoAsset({
        fileName: file.name,
        contentType: file.type || 'video/mp4',
        title: file.name,
      });
      const form = new FormData();
      form.append(upload.fileField, file, file.name);
      const res = await fetchImpl(upload.uploadUrl, { method: upload.method, body: form });
      if (!res.ok) throw new ApiError(res.status, `video upload failed: ${res.status}`);
      return this.refreshVideoAsset(asset.id);
    },

    // --- dashboards ------------------------------------------------------
    async listAgentRuns(): Promise<AgentRun[]> {
      const r = await req<{ items: AgentRun[] }>('GET', `${mgmt}/agent-runs`);
      return r.items;
    },
    agentUsage(): Promise<UsageSummary> {
      return req('GET', `${mgmt}/agent-runs/usage`);
    },
    async search(query: string): Promise<SearchHit[]> {
      const r = await req<{ hits: SearchHit[] }>(
        'GET',
        `${delivery}/search?q=${encodeURIComponent(query)}`,
      );
      return r.hits;
    },

    // --- settings: API keys (space-scoped) -------------------------------
    async listApiKeys(): Promise<ApiKeySummary[]> {
      const r = await req<{ items: ApiKeySummary[] }>('GET', `${spaceBase}/api-keys`);
      return r.items;
    },
    /** Mints a key; the returned `token` is shown once and never retrievable again. */
    createApiKey(input: {
      kind: ApiKeyKind;
      name?: string;
      roleId?: string;
    }): Promise<CreatedApiKey> {
      return req('POST', `${spaceBase}/api-keys`, input);
    },
    revokeApiKey(id: string): Promise<void> {
      return req('DELETE', `${spaceBase}/api-keys/${encodeURIComponent(id)}`);
    },

    // --- settings: OAuth connections + personal access tokens -------------
    async listConnectedApps(): Promise<ConnectedApp[]> {
      const r = await req<{ items: ConnectedApp[] }>('GET', `${spaceBase}/oauth/connections`);
      return r.items;
    },
    /** Revokes the app's tokens AND the grants behind them, so it can't refresh back in. */
    revokeConnectedApp(clientId: string, subject: string): Promise<{ revokedTokens: number }> {
      return req('POST', `${spaceBase}/oauth/connections/revoke`, { clientId, subject });
    },
    async listPersonalAccessTokens(): Promise<PersonalAccessToken[]> {
      const r = await req<{ items: PersonalAccessToken[] }>(
        'GET',
        `${spaceBase}/personal-access-tokens`,
      );
      return r.items;
    },
    /** Mints a PAT; the returned `token` is shown once and never retrievable again. */
    createPersonalAccessToken(input: {
      name: string;
      scopes: string[];
      expiresInDays?: number;
    }): Promise<CreatedPat> {
      return req('POST', `${spaceBase}/personal-access-tokens`, input);
    },
    /** PATs are API keys, so revocation goes through the same route. */
    revokePersonalAccessToken(id: string): Promise<void> {
      return req('DELETE', `${spaceBase}/api-keys/${encodeURIComponent(id)}`);
    },

    // --- settings: roles (space-scoped) ----------------------------------
    async listRoles(): Promise<RoleSummary[]> {
      const r = await req<{ items: RoleSummary[] }>('GET', `${spaceBase}/roles`);
      return r.items;
    },
    createRole(input: Omit<RoleSummary, 'id'> & { name: string }): Promise<RoleSummary> {
      return req('POST', `${spaceBase}/roles`, input);
    },
    updateRole(id: string, input: Partial<RoleSummary>): Promise<RoleSummary> {
      return req('PUT', `${spaceBase}/roles/${encodeURIComponent(id)}`, input);
    },
    deleteRole(id: string): Promise<void> {
      return req('DELETE', `${spaceBase}/roles/${encodeURIComponent(id)}`);
    },
    cloneRole(id: string, name?: string): Promise<RoleSummary> {
      return req('POST', `${spaceBase}/roles/${encodeURIComponent(id)}/clone`, { name });
    },

    // --- settings: team + role presets (space-scoped) --------------------
    getTeam(): Promise<TeamSummary> {
      return req('GET', `${spaceBase}/team`);
    },
    async listRolePresets(): Promise<RolePresetSummary[]> {
      const r = await req<{ items: RolePresetSummary[] }>('GET', `${spaceBase}/role-presets`);
      return r.items;
    },
    /** `role` is a role id or a preset name. */
    addMember(input: { email: string; name?: string; role: string }): Promise<TeamPerson> {
      return req('POST', `${spaceBase}/members`, input);
    },
    updateMember(
      id: string,
      input: { role?: string; disabled?: boolean; name?: string },
    ): Promise<TeamPerson> {
      return req('PATCH', `${spaceBase}/members/${encodeURIComponent(id)}`, input);
    },
    removeMember(id: string): Promise<void> {
      return req('DELETE', `${spaceBase}/members/${encodeURIComponent(id)}`);
    },
    /** Rebinds a key to a role id or preset name; `null` unbinds it. */
    setApiKeyRole(id: string, role: string | null): Promise<{ id: string; roleId: string | null }> {
      return req('PUT', `${spaceBase}/api-keys/${encodeURIComponent(id)}/role`, { role });
    },
    setAccessSettings(input: { ssoOnly: boolean }): Promise<{ ssoOnly: boolean }> {
      return req('PUT', `${spaceBase}/access-settings`, input);
    },

    /** Expiring shareable preview URL for an entry. */
    createPreviewLink(
      entryId: string,
      input?: { ttlHours?: number; previewBaseUrl?: string },
    ): Promise<PreviewLinkResult> {
      return req(
        'POST',
        `${mgmt}/entries/${encodeURIComponent(entryId)}/preview-link`,
        input ?? {},
      );
    },

    // --- settings: webhooks (environment-scoped) -------------------------
    async listWebhooks(): Promise<WebhookSummary[]> {
      const r = await req<{ items: WebhookSummary[] }>('GET', `${mgmt}/webhooks`);
      return r.items;
    },
    createWebhook(input: {
      url: string;
      topics: readonly WebhookTopic[];
      secret: string;
      active?: boolean;
      /** `true`: every environment's events. Omitted: the current environment's only. */
      allEnvironments?: boolean;
    }): Promise<WebhookSummary> {
      return req('POST', `${mgmt}/webhooks`, input);
    },
    /** Partial update; omitted fields are left untouched (e.g. just toggle `active`). */
    updateWebhook(
      id: string,
      changes: {
        url?: string;
        topics?: readonly WebhookTopic[];
        secret?: string;
        active?: boolean;
        /** `true`: space-wide; `false`: scoped to the current environment; omitted: unchanged. */
        allEnvironments?: boolean;
      },
    ): Promise<WebhookSummary> {
      return req('PUT', `${mgmt}/webhooks/${encodeURIComponent(id)}`, changes);
    },
    deleteWebhook(id: string): Promise<void> {
      return req('DELETE', `${mgmt}/webhooks/${encodeURIComponent(id)}`);
    },
    /** Recent delivery attempts for a webhook, newest first. */
    async webhookDeliveries(id: string, limit?: number): Promise<WebhookDeliveryRecord[]> {
      const qs = limit ? `?limit=${limit}` : '';
      const r = await req<{ items: WebhookDeliveryRecord[] }>(
        'GET',
        `${mgmt}/webhooks/${encodeURIComponent(id)}/deliveries${qs}`,
      );
      return r.items;
    },

    // --- releases (bundled atomic publish) -------------------------------
    async listReleases(): Promise<ReleaseSummary[]> {
      const r = await req<{ items: ReleaseSummary[] }>('GET', `${mgmt}/releases`);
      return r.items;
    },
    createRelease(input: { title: string; description?: string }): Promise<Release> {
      return req('POST', `${mgmt}/releases`, input);
    },
    getRelease(id: string): Promise<ReleaseWithItems> {
      return req('GET', `${mgmt}/releases/${encodeURIComponent(id)}`);
    },
    deleteRelease(id: string): Promise<void> {
      return req('DELETE', `${mgmt}/releases/${encodeURIComponent(id)}`);
    },
    addEntryToRelease(
      id: string,
      input: { entityId: string; action?: ReleaseItem['action'] },
    ): Promise<ReleaseWithItems> {
      return req('POST', `${mgmt}/releases/${encodeURIComponent(id)}/items`, input);
    },
    removeEntryFromRelease(id: string, entityId: string): Promise<ReleaseWithItems> {
      return req(
        'DELETE',
        `${mgmt}/releases/${encodeURIComponent(id)}/items/${encodeURIComponent(entityId)}`,
      );
    },
    /** Ships the bundle — every member publishes/unpublishes in one transaction. */
    publishRelease(id: string): Promise<ReleaseWithItems> {
      return req('POST', `${mgmt}/releases/${encodeURIComponent(id)}/published`);
    },

    // --- scheduled actions -----------------------------------------------
    async listScheduledActions(status?: string): Promise<ScheduledAction[]> {
      const qs = status ? `?status=${encodeURIComponent(status)}` : '';
      const r = await req<{ items: ScheduledAction[] }>('GET', `${mgmt}/scheduled-actions${qs}`);
      return r.items;
    },
    /** Schedules a publish/unpublish of an entry or release at a future instant. */
    scheduleAction(input: {
      action: ScheduledActionType;
      entityType: ScheduledEntityType;
      entityId: string;
      scheduledFor: string;
    }): Promise<ScheduledAction> {
      return req('POST', `${mgmt}/scheduled-actions`, input);
    },
    cancelScheduledAction(id: string): Promise<ScheduledAction> {
      return req('DELETE', `${mgmt}/scheduled-actions/${encodeURIComponent(id)}`);
    },

    // --- comments (threaded, on entries) ---------------------------------
    async listComments(entryId: string): Promise<Comment[]> {
      const r = await req<{ items: Comment[] }>(
        'GET',
        `${mgmt}/entries/${encodeURIComponent(entryId)}/comments`,
      );
      return r.items;
    },
    addComment(
      entryId: string,
      input: { body: string; parentId?: string | null; author?: string },
    ): Promise<Comment> {
      return req('POST', `${mgmt}/entries/${encodeURIComponent(entryId)}/comments`, input);
    },
    deleteComment(id: string): Promise<void> {
      return req('DELETE', `${mgmt}/comments/${encodeURIComponent(id)}`);
    },

    // --- tasks (on entries) ----------------------------------------------
    async listTasks(entryId: string): Promise<Task[]> {
      const r = await req<{ items: Task[] }>(
        'GET',
        `${mgmt}/entries/${encodeURIComponent(entryId)}/tasks`,
      );
      return r.items;
    },
    createTask(entryId: string, input: { body: string; assignee?: string }): Promise<Task> {
      return req('POST', `${mgmt}/entries/${encodeURIComponent(entryId)}/tasks`, input);
    },
    /** One change per call: status ('resolved'|'open') or reassignment. */
    updateTask(
      id: string,
      change: { status: 'resolved' | 'open' } | { assignee: string | null },
    ): Promise<Task> {
      return req('PUT', `${mgmt}/tasks/${encodeURIComponent(id)}`, change);
    },
    deleteTask(id: string): Promise<void> {
      return req('DELETE', `${mgmt}/tasks/${encodeURIComponent(id)}`);
    },

    // --- workflows (configurable editorial steps) ------------------------
    async listWorkflows(): Promise<WorkflowDefinition[]> {
      const r = await req<{ items: WorkflowDefinition[] }>('GET', `${mgmt}/workflows`);
      return r.items;
    },
    defineWorkflow(input: { name: string; steps: WorkflowStep[] }): Promise<WorkflowDefinition> {
      return req('POST', `${mgmt}/workflows`, input);
    },
    deleteWorkflow(id: string): Promise<void> {
      return req('DELETE', `${mgmt}/workflows/${encodeURIComponent(id)}`);
    },
    /** The same list as `listWorkflows`, typed as the graph summaries the route returns. */
    async listWorkflowGraphs(): Promise<WorkflowListItem[]> {
      const r = await req<{ items: WorkflowListItem[] }>('GET', `${mgmt}/workflows`);
      return r.items;
    },
    /** Creates an unpublished graph workflow; drafts may be incomplete (see `validation`). */
    createWorkflowDraft(
      input: WorkflowDraftInput & { name: string },
    ): Promise<{ workflow: WorkflowSummary; validation: WorkflowGraphValidation }> {
      return req('POST', `${mgmt}/workflows`, input);
    },
    getWorkflow(id: string): Promise<WorkflowSummary> {
      return req('GET', `${mgmt}/workflows/${encodeURIComponent(id)}`);
    },
    /** Saves the draft; omitted fields keep their value. Never touches published versions. */
    saveWorkflowDraft(
      id: string,
      input: WorkflowDraftInput,
    ): Promise<{ workflow: WorkflowSummary; validation: WorkflowGraphValidation }> {
      return req('PUT', `${mgmt}/workflows/${encodeURIComponent(id)}/draft`, input);
    },
    /** Publishes the draft as the next immutable version (refused while it has errors). */
    publishWorkflowVersion(id: string): Promise<WorkflowVersion> {
      return req('POST', `${mgmt}/workflows/${encodeURIComponent(id)}/versions`);
    },
    async listWorkflowVersions(id: string): Promise<WorkflowVersion[]> {
      const r = await req<{ items: WorkflowVersion[] }>(
        'GET',
        `${mgmt}/workflows/${encodeURIComponent(id)}/versions`,
      );
      return r.items;
    },
    getWorkflowVersion(id: string, version: number): Promise<WorkflowVersion> {
      return req('GET', `${mgmt}/workflows/${encodeURIComponent(id)}/versions/${version}`);
    },
    validateWorkflowGraph(graph: WorkflowGraph): Promise<WorkflowGraphValidation> {
      return req('POST', `${mgmt}/workflows/validate`, { graph });
    },
    /** Proposes a graph from a prompt (editing `graph` when given). Never saves. */
    workflowCopilot(input: {
      prompt: string;
      graph?: WorkflowGraph;
      contentTypes?: readonly string[];
    }): Promise<WorkflowCopilotProposal> {
      return req('POST', `${mgmt}/workflows/copilot`, input);
    },

    // --- workflow runs and tasks -------------------------------------------
    startWorkflowRun(
      entryId: string,
      input: {
        workflowId: string;
        version?: number;
        input?: Record<string, unknown>;
        vars?: Record<string, unknown>;
      },
    ): Promise<WorkflowRunView> {
      return req('POST', `${mgmt}/entries/${encodeURIComponent(entryId)}/workflow-runs`, input);
    },
    async listWorkflowRuns(filter: WorkflowRunFilter = {}): Promise<WorkflowRunView[]> {
      const r = await req<{ items: WorkflowRunView[] }>(
        'GET',
        `${mgmt}/workflow-runs${queryString(filter)}`,
      );
      return r.items;
    },
    getWorkflowRun(id: string): Promise<WorkflowRunView> {
      return req('GET', `${mgmt}/workflow-runs/${encodeURIComponent(id)}`);
    },
    async getWorkflowRunTimeline(id: string): Promise<WorkflowTimelineRecord[]> {
      const r = await req<{ items: WorkflowTimelineRecord[] }>(
        'GET',
        `${mgmt}/workflow-runs/${encodeURIComponent(id)}/timeline`,
      );
      return r.items;
    },
    async listWorkflowNodeRuns(id: string): Promise<WorkflowNodeRunRecord[]> {
      const r = await req<{ items: WorkflowNodeRunRecord[] }>(
        'GET',
        `${mgmt}/workflow-runs/${encodeURIComponent(id)}/node-runs`,
      );
      return r.items;
    },
    cancelWorkflowRun(
      id: string,
      reason?: string,
    ): Promise<{ ok: boolean; undone: readonly string[] }> {
      return req(
        'POST',
        `${mgmt}/workflow-runs/${encodeURIComponent(id)}/cancel`,
        reason ? { reason } : {},
      );
    },
    deliverWorkflowEvent(
      runId: string,
      event: string,
      payload?: Record<string, unknown>,
    ): Promise<{ delivered: boolean; buffered?: boolean; nodeId?: string }> {
      return req('POST', `${mgmt}/workflow-runs/${encodeURIComponent(runId)}/events`, {
        event,
        ...(payload ? { payload } : {}),
      });
    },
    async listWorkflowTasks(filter: WorkflowTaskFilter = {}): Promise<WorkflowTask[]> {
      const r = await req<{ items: WorkflowTask[] }>(
        'GET',
        `${mgmt}/workflow-tasks${queryString(filter)}`,
      );
      return r.items;
    },
    getWorkflowTask(id: string): Promise<WorkflowTask> {
      return req('GET', `${mgmt}/workflow-tasks/${encodeURIComponent(id)}`);
    },
    decideWorkflowTask(
      id: string,
      input: { decision: 'approved' | 'rejected'; note?: string },
    ): Promise<{ taskId: string; runId: string; decision: 'approved' | 'rejected'; by: string }> {
      return req('POST', `${mgmt}/workflow-tasks/${encodeURIComponent(id)}/decide`, input);
    },
    /** What waits in Approvals, uncapped and limited to what this caller may read. */
    countPendingApprovals(): Promise<{
      workflowTasks: number;
      agentReviews: number;
      total: number;
    }> {
      return req('GET', `${mgmt}/approvals/count`);
    },
    // --- agent reviews (human-in-the-loop decisions on agent proposals) ----
    /** Agent proposals, oldest first as the API returns them; `status` narrows. */
    async listAgentReviews(
      filter: { status?: AgentReviewStatus; entryId?: string } = {},
    ): Promise<AgentReview[]> {
      const r = await req<{ items: AgentReview[] }>(
        'GET',
        `${mgmt}/agent-reviews${queryString(filter)}`,
      );
      return r.items;
    },
    /** Applies the proposal as a new draft version. */
    approveAgentReview(id: string): Promise<AgentReview> {
      return req('POST', `${mgmt}/agent-reviews/${encodeURIComponent(id)}/approve`);
    },
    rejectAgentReview(id: string): Promise<AgentReview> {
      return req('POST', `${mgmt}/agent-reviews/${encodeURIComponent(id)}/reject`);
    },
    getWorkflowSettings(): Promise<{ separateDuties: boolean }> {
      return req('GET', `${mgmt}/workflow-settings`);
    },
    setWorkflowSettings(input: { separateDuties: boolean }): Promise<{ separateDuties: boolean }> {
      return req('PUT', `${mgmt}/workflow-settings`, input);
    },

    /** The entry's current workflow step, or null if it hasn't entered one. */
    getEntryWorkflowState(entryId: string): Promise<EntryWorkflowState | null> {
      return req('GET', `${mgmt}/entries/${encodeURIComponent(entryId)}/workflow`);
    },
    /** Moves the entry into a step; the backend enforces the step's required scope. */
    transitionEntry(
      entryId: string,
      input: { workflowId: string; toStepId: string },
    ): Promise<EntryWorkflowState> {
      return req(
        'POST',
        `${mgmt}/entries/${encodeURIComponent(entryId)}/workflow/transition`,
        input,
      );
    },

    // --- taxonomy: concept schemes ---------------------------------------
    async listSchemes(): Promise<ConceptScheme[]> {
      const r = await req<{ items: ConceptScheme[] }>('GET', `${mgmt}/taxonomy/schemes`);
      return r.items;
    },
    createScheme(input: { name: string }): Promise<ConceptScheme> {
      return req('POST', `${mgmt}/taxonomy/schemes`, input);
    },
    deleteScheme(id: string): Promise<void> {
      return req('DELETE', `${mgmt}/taxonomy/schemes/${encodeURIComponent(id)}`);
    },

    // --- taxonomy: concepts (hierarchical) -------------------------------
    async listConcepts(schemeId?: string): Promise<Concept[]> {
      const qs = schemeId ? `?scheme=${encodeURIComponent(schemeId)}` : '';
      const r = await req<{ items: Concept[] }>('GET', `${mgmt}/taxonomy/concepts${qs}`);
      return r.items;
    },
    createConcept(input: {
      schemeId: string;
      prefLabel: string;
      broaderId?: string | null;
    }): Promise<Concept> {
      return req('POST', `${mgmt}/taxonomy/concepts`, input);
    },
    setConceptBroader(id: string, broaderId: string | null): Promise<Concept> {
      return req('PUT', `${mgmt}/taxonomy/concepts/${encodeURIComponent(id)}/broader`, {
        broaderId,
      });
    },
    deleteConcept(id: string): Promise<void> {
      return req('DELETE', `${mgmt}/taxonomy/concepts/${encodeURIComponent(id)}`);
    },

    // --- taxonomy: tags --------------------------------------------------
    async listTags(): Promise<Tag[]> {
      const r = await req<{ items: Tag[] }>('GET', `${mgmt}/taxonomy/tags`);
      return r.items;
    },
    createTag(input: { name: string }): Promise<Tag> {
      return req('POST', `${mgmt}/taxonomy/tags`, input);
    },
    deleteTag(id: string): Promise<void> {
      return req('DELETE', `${mgmt}/taxonomy/tags/${encodeURIComponent(id)}`);
    },

    // --- entry taxonomy associations -------------------------------------
    getEntryMetadata(entryId: string): Promise<EntryMetadata> {
      return req('GET', `${mgmt}/entries/${encodeURIComponent(entryId)}/metadata`);
    },
    setEntryMetadata(
      entryId: string,
      input: { tags?: readonly string[]; concepts?: readonly string[] },
    ): Promise<EntryMetadata> {
      return req('PUT', `${mgmt}/entries/${encodeURIComponent(entryId)}/metadata`, input);
    },

    // --- entry version history -------------------------------------------
    async listVersions(entryId: string): Promise<EntryVersion[]> {
      const r = await req<{ items: EntryVersion[] }>(
        'GET',
        `${mgmt}/entries/${encodeURIComponent(entryId)}/versions`,
      );
      return r.items;
    },
    getVersion(entryId: string, version: number): Promise<EntryVersion> {
      return req('GET', `${mgmt}/entries/${encodeURIComponent(entryId)}/versions/${version}`);
    },
    diffVersions(entryId: string, from: number, to: number): Promise<VersionDiff> {
      return req(
        'GET',
        `${mgmt}/entries/${encodeURIComponent(entryId)}/versions/diff?from=${from}&to=${to}`,
      );
    },
    /** Copies an older version's fields into a new draft version. */
    restoreVersion(entryId: string, version: number): Promise<EntryView> {
      return req(
        'POST',
        `${mgmt}/entries/${encodeURIComponent(entryId)}/versions/${version}/restore`,
      );
    },
  };
}

export type ManagementClient = ReturnType<typeof createManagementClient>;
