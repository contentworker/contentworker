/**
 * @contentworker/sdk-management — the framework-agnostic Management (CMA) client for
 * programmatic authoring: content types, entries, assets, releases, webhooks,
 * and space administration. Zero runtime dependencies; uses the platform
 * `fetch` (injectable for SSR, edge runtimes, and tests). Talks to the
 * Management API with a CMA key or admin token — the server enforces RBAC
 * scopes per operation, so a client is only as powerful as its token.
 */

import { bookmarkTracker } from './bookmark.js';
import {
  inPool,
  SINGLE_UPLOAD_MAX_BYTES,
  sizeOf,
  sliceOf,
  type UploadBody,
  type UploadOptions,
  withRetry,
} from './upload.js';

export {
  SINGLE_UPLOAD_MAX_BYTES,
  type UploadBody,
  type UploadOptions,
  type UploadProgress,
} from './upload.js';

/** Locale-keyed values, e.g. `{ 'en-US': 'Hello' }`. */
export type LocalizedValue = Readonly<Record<string, unknown>>;

/** Entry field values: field apiId → locale → value. */
export type EntryFields = Readonly<Record<string, LocalizedValue>>;

export type EntryStatus = 'draft' | 'changed' | 'published' | 'archived';
export type ContentTypeStatus = 'draft' | 'published';
export type AssetStatus = 'draft' | 'published' | 'archived';
export type ReleaseStatus = 'open' | 'published' | 'archived';
export type ScheduledActionType = 'publish' | 'unpublish';
export type ScheduledEntityType = 'Entry' | 'Release';
export type ScheduledActionStatus = 'pending' | 'completed' | 'canceled' | 'failed';
export type ApiKeyKind = 'cma' | 'cda' | 'cpa';

export interface FieldDefinition {
  readonly apiId: string;
  readonly name: string;
  readonly type: string;
  readonly localized?: boolean;
  readonly required?: boolean;
  readonly validations?: readonly Record<string, unknown>[];
  readonly [key: string]: unknown;
}

export interface ContentType {
  readonly apiId: string;
  readonly name: string;
  readonly displayField: string;
  readonly fields: readonly FieldDefinition[];
  readonly version: number;
  readonly status: ContentTypeStatus;
}

/** What waits on a human decision in the environment (`GET …/approvals/count`). */
export interface PendingApprovalsCount {
  /** Workflow steps paused for a person (approvals, reviews, event waits). */
  readonly workflowTasks: number;
  /** Agent proposals awaiting review. */
  readonly agentReviews: number;
  readonly total: number;
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

export interface ContentTypeDraft {
  readonly apiId: string;
  readonly name: string;
  readonly displayField: string;
  readonly fields: readonly FieldDefinition[];
}

export interface Entry {
  readonly id: string;
  readonly contentTypeApiId: string;
  readonly status: EntryStatus;
  readonly currentVersion: number;
  readonly publishedVersion: number | null;
}

/** An entry plus its current draft field values. */
/** Holds a publish, unpublish or version restore to the `currentVersion` the caller read. */
export interface Held {
  readonly expectedVersion?: number;
}

const held = (opts?: Held) =>
  opts?.expectedVersion === undefined ? '' : `?expectedVersion=${opts.expectedVersion}`;

export interface EntryView {
  readonly entry: Entry;
  readonly fields: EntryFields;
}

export interface EntryVersion {
  readonly entryId: string;
  readonly version: number;
  readonly fields: EntryFields;
  /** When this version was saved (ISO-8601). */
  readonly createdAt?: string;
}

export type AssetKind = 'image' | 'video' | 'audio' | 'document' | 'other';

export interface Asset {
  readonly id: string;
  readonly status: AssetStatus;
  readonly file: Readonly<Record<string, unknown>>;
  readonly title: LocalizedValue;
  readonly description: LocalizedValue;
  readonly metadata: Readonly<Record<string, unknown>>;
  /** The folder it is filed in; absent at the library root. */
  readonly folderId?: string;
  readonly version?: number;
  readonly createdAt?: string;
  readonly createdBy?: string;
  readonly archivedAt?: string;
  readonly rights?: {
    readonly license?: string;
    readonly credit?: string;
    readonly expiresAt?: string;
    readonly embargoUntil?: string;
  };
  /** SHA-256 of the bytes (hex), once ingested. */
  readonly contentHash?: string;
  /** Where ingest stands on the current file; absent when it never ran. */
  readonly ingestStatus?: 'pending' | 'processing' | 'ready' | 'error';
  /** Why the last ingest failed. */
  readonly ingestError?: string;
  /** The oldest other asset here with the same bytes. */
  readonly duplicateOf?: string;
  /** What ingest filled from a model that no person has saved yet. */
  readonly aiSuggestions?: {
    readonly altText?: readonly string[];
    readonly tags?: readonly string[];
  };
}

/** An asset search (`assets.search`): text, and filters that narrow it. */
export interface AssetSearchQuery {
  readonly q: string;
  /** 1..100, default 20. */
  readonly limit?: number;
  readonly kind?: AssetKind;
  readonly tag?: string;
  /** A folder id, or `root` for assets in no folder. */
  readonly folder?: string;
  readonly status?: AssetStatus | 'all';
}

/** Matches per value of each facet (each counted without its own filter). */
export interface AssetFacets {
  readonly kind: Readonly<Record<string, number>>;
  readonly tag: Readonly<Record<string, number>>;
  /** By folder id; `root` for assets in no folder. */
  readonly folder: Readonly<Record<string, number>>;
}

export interface AssetSearchPage {
  /** Best match first. */
  readonly items: Asset[];
  readonly total: number;
  readonly facets: AssetFacets;
}

/** What `assets.list` keeps and how it orders them. */
export interface AssetListQuery {
  readonly limit?: number;
  /** `nextCursor` from the previous page. */
  readonly cursor?: string;
  readonly kind?: AssetKind;
  /** An exact content type (`image/png`) or a family (`image/*`). */
  readonly mime?: string;
  /** A taxonomy tag id. */
  readonly tag?: string;
  /** A folder id, or `root` for assets in no folder. */
  readonly folder?: string;
  /** Omitted hides archived assets; `all` includes them. */
  readonly status?: AssetStatus | 'all';
  readonly sort?: 'updatedAt' | 'createdAt' | 'size';
  readonly order?: 'asc' | 'desc';
}

export interface AssetPage {
  readonly items: Asset[];
  /** Present when there may be more: pass it as `cursor`. */
  readonly nextCursor?: string;
}

export interface AssetFolder {
  readonly id: string;
  readonly name: string;
  readonly parentId?: string;
  /** Materialized path of folder ids, e.g. `/a/b/`. */
  readonly path: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A created draft asset plus the presigned target the bytes are PUT to. */
export interface CreatedAsset {
  readonly asset: Asset;
  readonly upload: { readonly url: string; readonly headers: Readonly<Record<string, string>> };
}

export interface CreateAssetInput {
  readonly fileName: string;
  readonly contentType: string;
  readonly title?: LocalizedValue;
  readonly description?: LocalizedValue;
  /** File it in this folder. */
  readonly folderId?: string;
}

/** A named, ordered set of assets; an asset may be in any number of them. */
export interface AssetCollection {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly itemCount: number;
  readonly createdAt: string;
  readonly createdBy?: string;
  readonly updatedAt: string;
}

export interface AssetCollectionPage {
  readonly items: readonly AssetCollection[];
  readonly nextCursor?: string;
}

/** An expiring, revocable link to a published asset or a collection, for people without an account. */
export interface ShareLink {
  readonly id: string;
  readonly targetType: 'asset' | 'collection';
  readonly targetId: string;
  readonly expiresAt: string;
  readonly allowDownload: boolean;
  readonly hasPassword: boolean;
  readonly createdAt: string;
  readonly createdBy?: string;
  readonly revokedAt?: string;
  /** The URL to hand out, on the media origin. */
  readonly url?: string;
}

export interface CreateShareLinkInput {
  readonly targetType: 'asset' | 'collection';
  readonly targetId: string;
  /** ISO 8601, 5 minutes to 90 days from now. */
  readonly expiresAt: string;
  readonly allowDownload?: boolean;
  /** 8 to 256 characters; asked for before the page opens, never stored. */
  readonly password?: string;
}

/** A multipart upload started for a new draft asset. */
export interface MultipartUploadStarted {
  readonly asset: Asset;
  readonly upload: {
    readonly uploadId: string;
    /** Every part but the last has exactly this many bytes. */
    readonly partSize: number;
    readonly partCount: number;
  };
}

/** A signed URL for one part: PUT exactly `length` bytes; the response's ETag names the part. */
export interface SignedPart {
  readonly partNumber: number;
  readonly url: string;
  readonly length: number;
  readonly expiresAt: string;
}

/** A zip download being built; `downloadUrl` once `completed` (15 minutes; get it again for more). */
export interface AssetZip {
  readonly id: string;
  readonly status: 'pending' | 'running' | 'completed' | 'failed';
  readonly fileName: string;
  readonly fileCount?: number;
  readonly totalBytes?: number;
  readonly partsDone: number;
  readonly partCount?: number;
  readonly error?: string;
  readonly createdAt: string;
  readonly completedAt?: string;
  readonly expiresAt: string;
  readonly downloadUrl?: string;
}

/** A file to upload as a new asset (`assets.upload`). */
export interface UploadAssetInput extends CreateAssetInput {
  readonly body: UploadBody;
}

/** A file replacement in progress: PUT the bytes to `upload.url`, then pass `commit` back. */
export interface AssetFileReplacement {
  readonly asset: Asset;
  readonly upload: { readonly url: string; readonly headers: Readonly<Record<string, string>> };
  readonly commit: {
    readonly version: number;
    readonly fileName: string;
    readonly contentType: string;
  };
}

/** One file an asset has had (`assets.versions`). */
export interface AssetVersion {
  readonly version: number;
  /** `file.url` is a short-lived signed read URL. */
  readonly file: Readonly<Record<string, unknown>>;
  readonly contentHash?: string;
  /** When this file became the asset's, and who made it so. */
  readonly createdAt?: string;
  readonly createdBy?: string;
  readonly current: boolean;
  /** The file Delivery serves now. */
  readonly published: boolean;
  /** For a restore: the earliest version with the same file. */
  readonly restoredFrom?: number;
}

/** An asset's usage rights; dates are ISO-8601 with a zone. */
export interface AssetRights {
  readonly license?: string;
  readonly credit?: string;
  /** It is unpublished then, and its media answers 410. */
  readonly expiresAt?: string;
  /** Publishing is refused before then. */
  readonly embargoUntil?: string;
}

/** A bulk action over a selection of assets (`assets.bulk`). */
export type AssetBulkInput =
  | { readonly action: 'move'; readonly ids: readonly string[]; readonly folderId: string | null }
  | {
      readonly action: 'tag';
      readonly ids: readonly string[];
      readonly addTags?: readonly string[];
      readonly removeTags?: readonly string[];
    }
  | { readonly action: 'publish' | 'unpublish' | 'archive'; readonly ids: readonly string[] };

/** A durable bulk job; poll `bulkJobs.get` until `status` is no longer `running`. */
export interface BulkJob {
  readonly id: string;
  readonly action: string;
  readonly status: 'running' | 'completed' | 'cancelled';
  readonly totalItems: number;
  readonly totalChunks: number;
  readonly completedChunks: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly createdAt: string;
  readonly completedAt?: string;
}

/** A bulk job's per-item report: every failure, per chunk (`name`: an asset's title or file). */
export interface BulkJobReport {
  readonly job: BulkJob;
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

export interface Webhook {
  readonly id: string;
  readonly url: string;
  readonly topics: readonly string[];
  readonly active: boolean;
  /** The one environment whose events it receives; `null` for every environment in the space. */
  readonly environmentId: string | null;
}

export interface CreateWebhookInput {
  readonly url: string;
  readonly topics: readonly string[];
  readonly secret: string;
  readonly active?: boolean;
  readonly headers?: Readonly<Record<string, string>>;
  /** `true`: every environment's events. Otherwise only the client's environment's. */
  readonly allEnvironments?: boolean;
}

/**
 * Omitted fields are kept. `allEnvironments: true` makes the hook space-wide, `false` scopes it to
 * the client's environment; omitted, its scope is unchanged.
 */
export type UpdateWebhookInput = Partial<CreateWebhookInput>;

export interface Release {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly status: ReleaseStatus;
  readonly createdAt: string;
  readonly publishedAt?: string;
}

/** A release as `releases.list()` returns it: with how many members it holds. */
export interface ReleaseSummary extends Release {
  readonly itemCount: number;
}

export interface ReleaseItem {
  readonly entityId: string;
  readonly action: ScheduledActionType;
  readonly [key: string]: unknown;
}

export interface ReleaseWithItems {
  readonly release: Release;
  readonly items: readonly ReleaseItem[];
}

export interface ScheduledAction {
  readonly id: string;
  readonly action: ScheduledActionType;
  readonly entityType: ScheduledEntityType;
  readonly entityId: string;
  readonly scheduledFor: string;
  readonly status: ScheduledActionStatus;
  readonly createdAt: string;
  readonly executedAt?: string;
  readonly error?: string;
}

/** Per-item outcome of a bulk operation. */
export interface BulkItemResult {
  readonly id: string;
  readonly ok: boolean;
  readonly error?: string;
}

export interface BulkSummary {
  readonly action: string;
  readonly total: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly results: readonly BulkItemResult[];
}

export interface ApiKeySummary {
  readonly id: string;
  readonly kind: ApiKeyKind;
  readonly name?: string;
  readonly scopes: readonly string[];
  readonly revoked: boolean;
  readonly roleId?: string;
  readonly lastUsedAt?: string;
}

export interface CreateApiKeyInput {
  readonly kind: ApiKeyKind;
  readonly name?: string;
  readonly scopes?: readonly string[];
  readonly roleId?: string;
}

export interface SpaceRef {
  readonly id: string;
  readonly name: string;
}

/** `sample` installs sample content into the new space's first environment; `empty` doesn't. */
export type SpaceStarter = 'empty' | 'sample';

export interface CreateSpaceInput {
  /** 1–64 letters, digits, `.`, `_` or `-`, starting with a letter or digit; never `versions`,
   *  `imports`, `plugins` or `dlq` (in any case), which the media bucket keeps for its own data. */
  readonly spaceId: string;
  readonly name: string;
  readonly defaultLocale: string;
  readonly locales?: readonly string[];
  readonly fallbacks?: Record<string, string | null>;
  /** Environments to create; defaults to `["main"]`. */
  readonly environments?: readonly string[];
  readonly starter?: SpaceStarter;
}

export interface CreatedSpace extends SpaceRef {
  readonly starter: SpaceStarter;
  /** What the sample starter holds once installed (absent for `empty`). */
  readonly installed?: {
    readonly contentTypes: number;
    readonly entries: number;
    readonly assets: number;
    readonly tags: number;
    readonly concepts: number;
    readonly releases: number;
  };
}

/** The raw token is returned exactly once; only its hash is stored. */
export interface CreatedApiKey {
  readonly id: string;
  readonly kind: ApiKeyKind;
  readonly token: string;
}

export interface Principal {
  readonly spaceId: string;
  readonly kind: string;
  readonly scopes: readonly string[];
  readonly subject?: string;
  readonly restricted: boolean;
}

export interface ManagementClientOptions {
  /** Base URL of the Management API, e.g. https://cms.example.com */
  readonly baseUrl: string;
  readonly space: string;
  readonly environment: string;
  /** CMA key or admin token. */
  readonly token: string;
  /** Override fetch (SSR/edge/tests). Defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
  /**
   * Echo the api's `x-cw-bookmark` so each request reads at least as fresh as the last response,
   * a write included, even from a read replica. Default `true`.
   */
  readonly readYourWrites?: boolean;
  /** A bookmark to start from, e.g. one another client's write returned. */
  readonly bookmark?: string;
}

export class ManagementError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Response body, when the server returned one (JSON-parsed if possible). */
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'ManagementError';
  }
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
type Query = Record<string, string | number | undefined>;

/** Creates a Management client bound to one space/environment. */
export function createManagementClient(opts: ManagementClientOptions) {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const root = opts.baseUrl.replace(/\/$/, '');
  const bookmarks = bookmarkTracker(opts.baseUrl, opts.bookmark, opts.readYourWrites !== false);
  const spaceBase = `${root}/spaces/${encodeURIComponent(opts.space)}`;
  const envBase = `${spaceBase}/environments/${encodeURIComponent(opts.environment)}`;

  async function request<T>(
    method: Method,
    url: string,
    body?: unknown,
    query?: Query,
  ): Promise<T> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined && v !== '') qs.set(k, String(v));
    }
    const full = `${url}${qs.size ? `?${qs}` : ''}`;
    const headers: Record<string, string> = {
      authorization: `Bearer ${opts.token}`,
      ...bookmarks.headersFor(full),
    };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await doFetch(full, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    // Before the status check: an error response's bookmark is as current as any other's.
    bookmarks.record(res);
    if (!res.ok) {
      const detail = await res.json().catch(() => undefined);
      throw new ManagementError(
        res.status,
        `Management request failed: ${res.status} ${method} ${full}`,
        detail,
      );
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  const get = <T>(url: string, query?: Query) => request<T>('GET', url, undefined, query);
  const post = <T>(url: string, body?: unknown) => request<T>('POST', url, body);
  const put = <T>(url: string, body?: unknown) => request<T>('PUT', url, body);
  const patch = <T>(url: string, body?: unknown) => request<T>('PATCH', url, body);
  const del = <T>(url: string, query?: Query) => request<T>('DELETE', url, undefined, query);

  const items = async <T>(p: Promise<{ items: T[] }>): Promise<T[]> => (await p).items;

  const e = encodeURIComponent;
  /** A signed URL may be root-relative (a deployment without MEDIA_BASE_URL): resolve it here. */
  const absolute = (url: string) => (/^https?:\/\//.test(url) ? url : `${root}${url}`);

  return {
    /**
     * The newest `x-cw-bookmark` this client has seen (or was given), sent with its next request.
     * Pass it on, e.g. from a server action to the browser's preview client, so that client reads
     * this client's writes. Assigning replaces it, `undefined` clears it, and a value that isn't a
     * D1 bookmark is dropped. Always `undefined` with `readYourWrites: false`.
     */
    get bookmark(): string | undefined {
      return bookmarks.current;
    },
    set bookmark(value: string | undefined) {
      bookmarks.current = value;
    },

    /** Who am I: the principal resolved from this client's token. */
    me: () => get<Principal>(`${root}/auth/me`),

    approvals: {
      /**
       * How many items wait on a decision, uncapped, counting only content types this token may
       * read.
       */
      count: () => get<PendingApprovalsCount>(`${envBase}/approvals/count`),
    },

    contentTypes: {
      list: () => items(get<{ items: ContentType[] }>(`${envBase}/content-types`)),
      get: (apiId: string) => get<ContentType>(`${envBase}/content-types/${e(apiId)}`),
      create: (draft: ContentTypeDraft) => post<ContentType>(`${envBase}/content-types`, draft),
      publish: (apiId: string) =>
        post<ContentType>(`${envBase}/content-types/${e(apiId)}/published`),
      /** Entries per content type, by status, from one grouped count. */
      entryCounts: () =>
        items(get<{ items: ContentTypeEntryCounts[] }>(`${envBase}/content-types/entry-counts`)),
    },

    entries: {
      create: (input: { contentTypeApiId: string; fields: EntryFields }) =>
        post<EntryView>(`${envBase}/entries`, input),
      get: (id: string) => get<EntryView>(`${envBase}/entries/${e(id)}`),
      /** Saves a new draft version with these field values. */
      update: (id: string, fields: EntryFields) =>
        put<EntryView>(`${envBase}/entries/${e(id)}`, { fields }),
      /**
       * Publishes the current draft. With `expectedVersion` (the `currentVersion` you read), a
       * draft saved since makes it a 409 that changes nothing.
       */
      publish: (id: string, opts?: Held) =>
        post<Entry>(`${envBase}/entries/${e(id)}/published${held(opts)}`),
      /** Withdraws it from Delivery; `expectedVersion` holds it as for `publish`. */
      unpublish: (id: string, opts?: Held) =>
        del<Entry>(`${envBase}/entries/${e(id)}/published${held(opts)}`),
      /** Entries/assets that link to this entry ("what links here"). */
      reverseReferences: (id: string) =>
        items(get<{ items: unknown[] }>(`${envBase}/entries/${e(id)}/reverse-references`)),
      bulkCreate: (batch: readonly { contentTypeApiId: string; fields: EntryFields }[]) =>
        post<BulkSummary>(`${envBase}/bulk/entries`, { items: batch }),
      bulkPublish: (ids: readonly string[]) =>
        post<BulkSummary>(`${envBase}/bulk/entries/publish`, { ids }),
      bulkUnpublish: (ids: readonly string[]) =>
        post<BulkSummary>(`${envBase}/bulk/entries/unpublish`, { ids }),
      versions: {
        list: (id: string) =>
          items(get<{ items: EntryVersion[] }>(`${envBase}/entries/${e(id)}/versions`)),
        get: (id: string, version: number) =>
          get<EntryVersion>(`${envBase}/entries/${e(id)}/versions/${version}`),
        /** Field-by-field diff between two versions. */
        diff: (id: string, from: number, to: number) =>
          get<unknown>(`${envBase}/entries/${e(id)}/versions/diff`, { from, to }),
        /**
         * Copies an old version's fields into a NEW draft version; `expectedVersion` (the draft
         * you read) makes a draft saved since a 409.
         */
        restore: (id: string, version: number, opts?: Held) =>
          post<EntryView>(`${envBase}/entries/${e(id)}/versions/${version}/restore${held(opts)}`),
      },
    },

    assets: {
      /** One page of the library; pass `nextCursor` back as `cursor` for the next. */
      list: (query: AssetListQuery = {}) => get<AssetPage>(`${envBase}/assets`, { ...query }),
      get: (id: string) => get<Asset>(`${envBase}/assets/${e(id)}`),
      /** Hybrid search of the library (full text and semantic), with facet counts. */
      search: (query: AssetSearchQuery) =>
        get<AssetSearchPage>(`${envBase}/assets/search`, { ...query }),
      /** Runs ingest on the asset's current file again (a retry after `ingestStatus: error`). */
      reingest: (id: string) => post<Asset>(`${envBase}/assets/${e(id)}/reingest`),
      /**
       * Sends assets through ingest as a bulk job: those never ingested or whose ingest failed,
       * or every asset with a file (`all`). While one is running, that job comes back
       * (`running: true`). Follow `job` with `bulkJobs.get`.
       */
      reindex: (opts: { all?: boolean } = {}) =>
        post<{ assets: number; job?: { id: string; status: string }; running?: true }>(
          `${envBase}/assets/reindex`,
          opts,
        ),
      /**
       * Creates a draft asset and returns a presigned upload target. PUT the
       * bytes to `upload.url` with `upload.headers`, then publish the asset.
       */
      create: (input: CreateAssetInput) => post<CreatedAsset>(`${envBase}/assets`, input),
      setMetadata: (id: string, metadata: Record<string, unknown>) =>
        patch<Asset>(`${envBase}/assets/${e(id)}/metadata`, metadata),
      /** Entries whose fields link to this asset. */
      usage: (id: string) => items(get<{ items: unknown[] }>(`${envBase}/assets/${e(id)}/usage`)),
      publish: (id: string) => post<Asset>(`${envBase}/assets/${e(id)}/published`),
      unpublish: (id: string) => del<Asset>(`${envBase}/assets/${e(id)}/published`),
      /** Takes it out of Delivery and out of the default listing; `restore` brings it back. */
      archive: (id: string) => post<Asset>(`${envBase}/assets/${e(id)}/archive`),
      restore: (id: string) => post<Asset>(`${envBase}/assets/${e(id)}/restore`),
      /**
       * Deletes it for good. A 409 `ManagementError` while entries link to it: its
       * `body.error.usage` lists the first 50 links (each with the entry's `contentTypeApiId` and
       * `entryTitle`) and `body.error.total` counts them all.
       */
      delete: (id: string) => del<void>(`${envBase}/assets/${e(id)}`),
      /** Files assets in a folder (`null`: the root), up to 500 at once. */
      move: (ids: readonly string[], folderId: string | null) =>
        post<{ moved: number }>(`${envBase}/assets/move`, { ids, folderId }),
      /**
       * Moves, tags, publishes, unpublishes or archives many assets as a resumable bulk job.
       * Follow it with `bulkJobs.get`; `bulkJobs.report` names each asset that failed.
       */
      bulk: (input: AssetBulkInput) => post<BulkJob>(`${envBase}/assets/bulk`, input),
      /**
       * Starts replacing the file: PUT the bytes to `upload.url` with `upload.headers`, then
       * `commitFile(id, commit)`. A published asset keeps its published file until republished.
       */
      replaceFile: (id: string, input: { fileName: string; contentType: string }) =>
        post<AssetFileReplacement>(`${envBase}/assets/${e(id)}/file`, input),
      /** Makes an uploaded replacement current as a new version. */
      commitFile: (id: string, commit: AssetFileReplacement['commit']) =>
        post<Asset>(`${envBase}/assets/${e(id)}/file/commit`, commit),
      /** Every file the asset has had, newest first. */
      versions: (id: string) =>
        items(get<{ items: AssetVersion[] }>(`${envBase}/assets/${e(id)}/versions`)),
      /** Makes an earlier version's file current again, as a new version. */
      restoreVersion: (id: string, version: number) =>
        post<Asset>(`${envBase}/assets/${e(id)}/versions/${version}/restore`),
      /**
       * Replaces the asset's usage rights (`{}` clears them). On a published asset they apply at
       * once; needs content:publish.
       */
      setRights: (id: string, rights: AssetRights) =>
        put<Asset>(`${envBase}/assets/${e(id)}/rights`, rights),
      /**
       * Uploads a file as a new draft asset, whatever its size: one signed PUT up to 100 MiB, a
       * multipart upload above it (parts retried on their own, `concurrency` at once, progress
       * after each). A failed or aborted multipart upload is aborted on the server too. Returns
       * the asset once its bytes are stored.
       */
      upload: async (input: UploadAssetInput, uploadOpts: UploadOptions = {}): Promise<Asset> => {
        const { body, ...rest } = input;
        const total = sizeOf(body);
        const sleep =
          uploadOpts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
        const attempts = uploadOpts.attempts ?? 4;
        const retry = <T>(fn: () => Promise<T>) =>
          withRetry(fn, {
            attempts,
            sleep,
            ...(uploadOpts.signal ? { signal: uploadOpts.signal } : {}),
          });
        const putBytes = async (url: string, bytes: Blob | Uint8Array, headers = {}) => {
          const res = await doFetch(absolute(url), {
            method: 'PUT',
            headers,
            body: bytes as BodyInit,
            ...(uploadOpts.signal ? { signal: uploadOpts.signal } : {}),
          });
          if (!res.ok) {
            throw new ManagementError(res.status, `Upload failed: ${res.status} PUT ${url}`);
          }
          return res;
        };
        if (total <= SINGLE_UPLOAD_MAX_BYTES) {
          const created = await post<CreatedAsset>(`${envBase}/assets`, rest);
          uploadOpts.onProgress?.({ loaded: 0, total, partsDone: 0, partCount: 1 });
          await retry(() =>
            putBytes(created.upload.url, sliceOf(body, 0, total), created.upload.headers),
          );
          uploadOpts.onProgress?.({ loaded: total, total, partsDone: 1, partCount: 1 });
          return created.asset;
        }
        const started = await post<MultipartUploadStarted>(`${envBase}/assets/uploads`, {
          ...rest,
          size: total,
        });
        const { uploadId, partSize, partCount } = started.upload;
        const base = `${envBase}/assets/${e(started.asset.id)}/uploads/${e(uploadId)}`;
        let loaded = 0;
        let partsDone = 0;
        uploadOpts.onProgress?.({ loaded, total, partsDone, partCount });
        try {
          const numbers = Array.from({ length: partCount }, (_, i) => i + 1);
          const parts = await inPool(
            numbers.map((n) => async () => {
              const etag = await retry(async () => {
                // Signed again on each attempt: a URL lives 15 minutes, a retry may outlast it.
                const [signed] = (
                  await post<{ parts: SignedPart[] }>(`${base}/parts`, { partNumbers: [n] })
                ).parts;
                if (!signed) throw new Error(`part ${n} was not signed`);
                const res = await putBytes(
                  signed.url,
                  sliceOf(body, (n - 1) * partSize, signed.length),
                );
                const tag = res.headers.get('etag');
                if (!tag) throw new Error(`part ${n} came back without an ETag`);
                return tag;
              });
              partsDone += 1;
              loaded += Math.min(partSize, total - (n - 1) * partSize);
              uploadOpts.onProgress?.({ loaded, total, partsDone, partCount });
              return { partNumber: n, etag };
            }),
            uploadOpts.concurrency ?? 4,
          );
          return await retry(() => post<Asset>(`${base}/complete`, { parts }));
        } catch (err) {
          await del<void>(base).catch(() => undefined);
          throw err;
        }
      },
      /** The multipart steps one at a time (`upload` runs them for you). */
      uploads: {
        start: (input: CreateAssetInput & { size: number }) =>
          post<MultipartUploadStarted>(`${envBase}/assets/uploads`, input),
        signParts: (assetId: string, uploadId: string, partNumbers: readonly number[]) =>
          post<{ parts: SignedPart[] }>(
            `${envBase}/assets/${e(assetId)}/uploads/${e(uploadId)}/parts`,
            { partNumbers },
          ),
        complete: (
          assetId: string,
          uploadId: string,
          parts: readonly { partNumber: number; etag: string }[],
        ) =>
          post<Asset>(`${envBase}/assets/${e(assetId)}/uploads/${e(uploadId)}/complete`, {
            parts,
          }),
        abort: (assetId: string, uploadId: string) =>
          del<void>(`${envBase}/assets/${e(assetId)}/uploads/${e(uploadId)}`),
      },
      collections: {
        /** By name; pass `nextCursor` back as `cursor` for the next page. */
        list: (o: { limit?: number; cursor?: string } = {}) =>
          get<AssetCollectionPage>(`${envBase}/asset-collections`, { ...o }),
        get: (id: string) => get<AssetCollection>(`${envBase}/asset-collections/${e(id)}`),
        create: (input: { name: string; description?: string }) =>
          post<AssetCollection>(`${envBase}/asset-collections`, input),
        /** `description: ''` clears it. */
        update: (id: string, changes: { name?: string; description?: string }) =>
          patch<AssetCollection>(`${envBase}/asset-collections/${e(id)}`, changes),
        /** Its assets stay in the library. */
        delete: (id: string) => del<void>(`${envBase}/asset-collections/${e(id)}`),
        /** Its assets in its order, filtered as the library is. */
        assets: (id: string, query: Omit<AssetListQuery, 'folder' | 'sort' | 'order'> = {}) =>
          get<AssetPage>(`${envBase}/asset-collections/${e(id)}/assets`, { ...query }),
        /** After its last member, in the order given (up to 500 ids; 1,000 members at most). */
        add: (id: string, assetIds: readonly string[]) =>
          post<{ added: number; skipped: string[] }>(
            `${envBase}/asset-collections/${e(id)}/assets`,
            { assetIds },
          ),
        remove: (id: string, assetIds: readonly string[]) =>
          post<{ removed: number }>(`${envBase}/asset-collections/${e(id)}/assets/remove`, {
            assetIds,
          }),
        /** The named members first, in that order (up to 1,000); the rest after, as they were. */
        reorder: (id: string, assetIds: readonly string[]) =>
          put<void>(`${envBase}/asset-collections/${e(id)}/order`, { assetIds }),
      },
      /** Expiring links to a published asset or a collection (content:publish). */
      shareLinks: {
        list: (
          o: {
            targetType?: 'asset' | 'collection';
            targetId?: string;
            includeInactive?: boolean;
          } = {},
        ) =>
          items(
            get<{ items: ShareLink[] }>(`${envBase}/share-links`, {
              targetType: o.targetType,
              targetId: o.targetId,
              includeInactive: o.includeInactive ? 'true' : undefined,
            }),
          ),
        get: (id: string) => get<ShareLink>(`${envBase}/share-links/${e(id)}`),
        create: (input: CreateShareLinkInput) => post<ShareLink>(`${envBase}/share-links`, input),
        /** It stops opening within a minute. */
        revoke: (id: string) => del<ShareLink>(`${envBase}/share-links/${e(id)}`),
      },
      /** Zip downloads of a selection or a collection, built in the background. */
      zips: {
        create: (
          input:
            | { assetIds: readonly string[]; name?: string }
            | { collectionId: string; name?: string },
        ) => post<AssetZip>(`${envBase}/asset-zips`, input),
        /** `downloadUrl` once completed. */
        get: (id: string) => get<AssetZip>(`${envBase}/asset-zips/${e(id)}`),
        list: () => items(get<{ items: AssetZip[] }>(`${envBase}/asset-zips`)),
      },
      folders: {
        list: () => items(get<{ items: AssetFolder[] }>(`${envBase}/asset-folders`)),
        create: (input: { name: string; parentId?: string | null }) =>
          post<AssetFolder>(`${envBase}/asset-folders`, input),
        /** Renames and/or moves it (`parentId: null`: to the root), subfolders along. */
        update: (id: string, changes: { name?: string; parentId?: string | null }) =>
          patch<AssetFolder>(`${envBase}/asset-folders/${e(id)}`, changes),
        /** Only an empty folder; one with subfolders or assets is a 409. */
        delete: (id: string) => del<void>(`${envBase}/asset-folders/${e(id)}`),
      },
    },

    /** Durable bulk jobs (asset bulk actions, entry bulk publishing, imports), newest first. */
    bulkJobs: {
      list: (o: { limit?: number } = {}) =>
        get<BulkJob[]>(`${envBase}/bulk/jobs`, { limit: o.limit }),
      get: (id: string) => get<BulkJob>(`${envBase}/bulk/jobs/${e(id)}`),
      report: (id: string) => get<BulkJobReport>(`${envBase}/bulk/jobs/${e(id)}/report`),
      cancel: (id: string) => post<BulkJob>(`${envBase}/bulk/jobs/${e(id)}/cancel`),
    },

    webhooks: {
      list: () => items(get<{ items: Webhook[] }>(`${envBase}/webhooks`)),
      create: (input: CreateWebhookInput) => post<Webhook>(`${envBase}/webhooks`, input),
      update: (id: string, input: UpdateWebhookInput) =>
        put<Webhook>(`${envBase}/webhooks/${e(id)}`, input),
      delete: (id: string) => del<void>(`${envBase}/webhooks/${e(id)}`),
      deliveries: (id: string, o: { limit?: number } = {}) =>
        items(
          get<{ items: unknown[] }>(`${envBase}/webhooks/${e(id)}/deliveries`, { limit: o.limit }),
        ),
    },

    releases: {
      list: () => items(get<{ items: ReleaseSummary[] }>(`${envBase}/releases`)),
      get: (id: string) => get<ReleaseWithItems>(`${envBase}/releases/${e(id)}`),
      create: (input: { title: string; description?: string }) =>
        post<Release>(`${envBase}/releases`, input),
      delete: (id: string) => del<void>(`${envBase}/releases/${e(id)}`),
      addEntry: (id: string, input: { entityId: string; action?: ScheduledActionType }) =>
        post<ReleaseWithItems>(`${envBase}/releases/${e(id)}/items`, input),
      removeEntry: (id: string, entityId: string) =>
        del<ReleaseWithItems>(`${envBase}/releases/${e(id)}/items/${e(entityId)}`),
      /** Ships the bundle: publishes/unpublishes every member atomically. */
      publish: (id: string) => post<ReleaseWithItems>(`${envBase}/releases/${e(id)}/published`),
    },

    scheduledActions: {
      list: (o: { status?: ScheduledActionStatus } = {}) =>
        items(
          get<{ items: ScheduledAction[] }>(`${envBase}/scheduled-actions`, { status: o.status }),
        ),
      create: (input: {
        action: ScheduledActionType;
        entityType: ScheduledEntityType;
        entityId: string;
        scheduledFor: string;
      }) => post<ScheduledAction>(`${envBase}/scheduled-actions`, input),
      cancel: (id: string) => del<ScheduledAction>(`${envBase}/scheduled-actions/${e(id)}`),
    },

    /** Deployment-wide: not bound to the client's space. */
    spaces: {
      /** The spaces this token can reach (all of them for a deployment admin, else its own). */
      list: () => items(get<{ items: SpaceRef[] }>(`${root}/spaces`)),
      /** Creates a space, optionally with sample content. Deployment administrators only. */
      create: (input: CreateSpaceInput) => post<CreatedSpace>(`${root}/spaces`, input),
    },

    environments: {
      list: () => items(get<{ items: unknown[] }>(`${spaceBase}/environments`)),
      create: (id: string, name?: string) =>
        post<{ id: string }>(`${spaceBase}/environments`, { id, name }),
      aliases: {
        list: () => items(get<{ items: unknown[] }>(`${spaceBase}/environment-aliases`)),
        /** Creates or repoints an alias (atomic cutover). */
        set: (alias: string, targetEnvironmentId: string) =>
          put<unknown>(`${spaceBase}/environment-aliases/${e(alias)}`, { targetEnvironmentId }),
        delete: (alias: string) => del<void>(`${spaceBase}/environment-aliases/${e(alias)}`),
      },
    },

    apiKeys: {
      list: () => items(get<{ items: ApiKeySummary[] }>(`${spaceBase}/api-keys`)),
      create: (input: CreateApiKeyInput) => post<CreatedApiKey>(`${spaceBase}/api-keys`, input),
      revoke: (id: string) => del<void>(`${spaceBase}/api-keys/${e(id)}`),
    },
  };
}

export type ManagementClient = ReturnType<typeof createManagementClient>;
