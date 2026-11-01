/**
 * @contentworker/sdk-management — the framework-agnostic Management (CMA) client for
 * programmatic authoring: content types, entries, assets, releases, webhooks,
 * and space administration. Zero runtime dependencies; uses the platform
 * `fetch` (injectable for SSR, edge runtimes, and tests). Talks to the
 * Management API with a CMA key or admin token — the server enforces RBAC
 * scopes per operation, so a client is only as powerful as its token.
 */

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
  /** 1–64 letters, digits, `.`, `_` or `-`, starting with a letter or digit. */
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
    const headers: Record<string, string> = { authorization: `Bearer ${opts.token}` };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await doFetch(full, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
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

  return {
    /** Who am I: the principal resolved from this client's token. */
    me: () => get<Principal>(`${root}/auth/me`),

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
