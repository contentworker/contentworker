/**
 * @contentworker/sdk-core — the framework-agnostic Delivery client every channel SDK builds
 * on. Zero runtime dependencies; uses the platform `fetch` (injectable for SSR,
 * edge runtimes, and tests). Talks to the read-only Delivery API with a CDA token.
 */

/** Locale-keyed field values, or flattened values when a locale is requested. */
import { bookmarkTracker } from './bookmark.js';
import { CONTENT_REF_ATTRIBUTE, formatContentRef } from './content-ref.js';
import { imageProps } from './image.js';

export type Fields = Record<string, unknown>;

/** A delivered entry. Generic `F` lets codegen supply a typed field shape. */
export interface DeliveredEntry<F extends Fields = Fields> {
  readonly id: string;
  readonly contentType: string;
  readonly fields: F;
  readonly publishedAt: string;
}

/**
 * A delivered asset. Its URLs are on the media origin and immutable: `url` is the original (a
 * hosted video's HLS manifest), `renditions` the space's named presets, `srcset` the width ladder
 * up to the image's own width. Title, description and alt text are one locale's value when a
 * `locale` was asked for, else keyed by locale. From Preview, every URL is short-lived and signed.
 */
export interface DeliveredAsset {
  readonly id: string;
  readonly title: string | Record<string, unknown> | null;
  readonly description: string | Record<string, unknown> | null;
  readonly altText: string | Record<string, unknown> | null;
  readonly focalPoint: { readonly x: number; readonly y: number } | null;
  readonly contentType: string;
  readonly size: number | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly kind: 'image' | 'video' | 'audio' | 'document' | 'other';
  readonly url: string;
  readonly renditions: Readonly<Record<string, string>>;
  readonly srcset: readonly { readonly width: number; readonly url: string }[];
  /**
   * What to show while a raster image loads, once ingest has computed it (else `null`): its
   * ThumbHash (base64; decode with the `thumbhash` package) and dominant colour (`#rrggbb`).
   */
  readonly placeholder: { readonly thumbhash: string; readonly dominantColor: string } | null;
  readonly video?: {
    readonly status: string;
    readonly hlsUrl?: string;
    readonly dashUrl?: string;
    readonly thumbnailUrl?: string;
    readonly durationSeconds?: number;
  };
  readonly rights?: { readonly credit?: string; readonly license?: string };
  /** The stored file description, kept for older readers; `file.url` is `url`. */
  readonly file: Readonly<Record<string, unknown>>;
}

/** A page of delivered assets; pass `nextCursor` back as `cursor` for the next. */
export interface AssetPage {
  readonly items: DeliveredAsset[];
  readonly total: number;
  readonly nextCursor?: string;
}

/** An asset search: published assets, best match first, with facet counts. */
export interface AssetSearchPage {
  readonly items: DeliveredAsset[];
  readonly total: number;
  readonly facets: {
    readonly kind: Readonly<Record<string, number>>;
    readonly tag: Readonly<Record<string, number>>;
    /** By folder id; `root` for assets in no folder. */
    readonly folder: Readonly<Record<string, number>>;
  };
}

export interface AssetSearchQuery {
  /** 1..100, default 20. */
  readonly limit?: number;
  readonly kind?: DeliveredAsset['kind'];
  readonly tag?: string;
  /** A folder id, or `root` for assets in no folder. */
  readonly folder?: string;
  readonly locale?: string;
}

/** A collection as Delivery serves it: its published members, in its order. */
export interface DeliveredCollection {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly items: DeliveredAsset[];
  readonly nextCursor?: string;
}

export interface AssetQuery {
  readonly limit?: number;
  /** `nextCursor` from the previous page. */
  readonly cursor?: string;
  /** Offset paging, without a cursor. */
  readonly skip?: number;
  readonly kind?: DeliveredAsset['kind'];
  /** A taxonomy tag id. */
  readonly tag?: string;
  /** A folder id, or `root` for assets in no folder. */
  readonly folder?: string;
  readonly locale?: string;
}

/**
 * One URL of an asset: the named `rendition` (undefined when the space has none by that name,
 * or the asset isn't a resizable image), the width step at or above `width` (the largest past it;
 * the original when there is no ladder), or the original.
 */
export function assetUrl(
  asset: Pick<DeliveredAsset, 'url' | 'renditions' | 'srcset'>,
  opts: { readonly rendition?: string; readonly width?: number } = {},
): string | undefined {
  if (opts.rendition !== undefined) {
    return Object.hasOwn(asset.renditions, opts.rendition)
      ? asset.renditions[opts.rendition]
      : undefined;
  }
  if (opts.width !== undefined) {
    const width = opts.width;
    const step =
      asset.srcset.find((s) => s.width >= width) ?? asset.srcset[asset.srcset.length - 1];
    return step?.url ?? asset.url;
  }
  return asset.url;
}

/** The asset's width ladder as an `<img srcset>` value (`"… 320w, … 640w"`); empty without one. */
export function srcset(asset: Pick<DeliveredAsset, 'srcset'>): string {
  return asset.srcset.map((s) => `${s.url} ${s.width}w`).join(', ');
}

export interface SearchHit {
  readonly entryId: string;
  readonly score: number;
  readonly snippet: string;
}

export interface ClientOptions {
  /** Base URL of the Delivery API, e.g. https://cms.example.com */
  readonly baseUrl: string;
  readonly space: string;
  readonly environment: string;
  /** Content Delivery API (CDA) token. */
  readonly token: string;
  /** Override fetch (SSR/edge/tests). Defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
  /** In-memory response cache TTL (ms). 0 disables. Default 0. */
  readonly cacheTtlMs?: number;
  /**
   * Read from the Preview API (CPA) instead of Delivery, serving drafts as the
   * editor sees them. Also what turns `editable()` on: inline-edit markup is
   * emitted only here, so the same components can ship to production without
   * disclosing entry ids, field names, or that a CMS is behind the page.
   */
  readonly preview?: boolean;
  /** Locale stamped onto refs from `editable()`. Defaults to `'*'`. */
  readonly locale?: string;
  /**
   * Preview only: echo the api's `x-cw-bookmark` so each read is at least as fresh as the last
   * response, or as `bookmark`. Default `true`. Delivery is cached and reads replicas by design,
   * so a Delivery client never sends or keeps a bookmark.
   */
  readonly readYourWrites?: boolean;
  /**
   * Preview only: a bookmark to start from, e.g. the one a server action's write returned
   * (`managementClient.bookmark`), so this client's first read already sees that write.
   */
  readonly bookmark?: string;
}

/** Comparison operators for a field-level filter. */
export type FilterOp =
  | 'eq'
  | 'ne'
  | 'in'
  | 'nin'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'exists'
  | 'match';

/** A single field predicate. `field` is a field apiId or a `sys.*` pseudo-field. */
export interface EntryFilter {
  readonly field: string;
  readonly op?: FilterOp;
  readonly value?: unknown;
}

export interface EntryQuery {
  readonly contentType?: string;
  readonly locale?: string;
  /** Reference resolution depth (embeds linked entries). */
  readonly include?: number;
  readonly limit?: number;
  readonly skip?: number;
  /** Delta cursor — only entries published after this ISO timestamp. */
  readonly since?: string;
  /** Field-level predicates (all must match). */
  readonly filters?: readonly EntryFilter[];
  /** Sort keys, e.g. `['fields.title', '-sys.publishedAt']`. */
  readonly order?: readonly string[];
  /** Projection — return only these field apiIds. */
  readonly select?: readonly string[];
  /** Full-text search over string fields. */
  readonly search?: string;
}

/**
 * A failed request. `message` and `body` hold the server's text: render them as text, never HTML.
 * `code` is the API's machine-readable error code (`not_found`,
 * `validation_failed`, …) when the body names one, and `body` the parsed JSON body (`undefined`
 * when it wasn't JSON). The delivery gateway's own refusals (`401`, `429`) carry no code.
 */
export class DeliveryError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'DeliveryError';
  }
}

/** `{ error: { code, message } }` from the api, `{ error: 'message' }` from the gateway. */
async function deliveryError(res: Response, url: string): Promise<DeliveryError> {
  let body: unknown;
  try {
    body = JSON.parse(await res.text());
  } catch {
    body = undefined;
  }
  const error = (body as { error?: unknown } | undefined)?.error;
  const detail =
    typeof error === 'string'
      ? error
      : typeof (error as { message?: unknown } | undefined)?.message === 'string'
        ? (error as { message: string }).message
        : undefined;
  const code = (error as { code?: unknown } | undefined)?.code;
  return new DeliveryError(
    res.status,
    `Delivery request failed: ${res.status} ${url}${detail ? ` (${detail.slice(0, 200)})` : ''}`,
    typeof code === 'string' ? code : undefined,
    body,
  );
}

interface CacheEntry {
  expires: number;
  value: unknown;
}

/** Creates a Delivery client bound to one space/environment. */
export function createDeliveryClient(opts: ClientOptions) {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const ttl = opts.cacheTtlMs ?? 0;
  const cache = new Map<string, CacheEntry>();
  const surface = opts.preview ? 'preview' : 'delivery';
  const base = `${opts.baseUrl.replace(/\/$/, '')}/${surface}/${opts.space}/${opts.environment}`;
  const bookmarks = bookmarkTracker(
    opts.baseUrl,
    opts.bookmark,
    opts.preview === true && opts.readYourWrites !== false,
  );

  async function get<T>(
    path: string,
    params: Record<string, string | number | undefined>,
  ): Promise<T> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== '') qs.set(k, String(v));
    }
    const url = `${base}${path}${qs.toString() ? `?${qs}` : ''}`;

    if (ttl > 0) {
      const hit = cache.get(url);
      if (hit && hit.expires > Date.now()) return hit.value as T;
    }

    const res = await doFetch(url, {
      headers: { authorization: `Bearer ${opts.token}`, ...bookmarks.headersFor(url) },
    });
    bookmarks.record(res);
    if (!res.ok) throw await deliveryError(res, url);
    const value = (await res.json()) as T;
    if (ttl > 0) cache.set(url, { expires: Date.now() + ttl, value });
    return value;
  }

  async function* pages(
    first: string | undefined,
    page: (cursor: string | undefined) => Promise<{ items: DeliveredAsset[]; nextCursor?: string }>,
  ): AsyncGenerator<DeliveredAsset, void, undefined> {
    const seen = new Set<string>(first ? [first] : []);
    let cursor = first;
    for (;;) {
      const res = await page(cursor);
      yield* res.items;
      if (!res.nextCursor) return;
      // A cursor that comes back again would page forever; the server never does that.
      if (seen.has(res.nextCursor)) {
        throw new Error(`Delivery returned cursor ${res.nextCursor} twice`);
      }
      seen.add(res.nextCursor);
      cursor = res.nextCursor;
    }
  }

  const getCollection = (
    id: string,
    o: { limit?: number; cursor?: string; locale?: string } = {},
  ): Promise<DeliveredCollection> =>
    get<DeliveredCollection>(`/collections/${encodeURIComponent(id)}`, {
      limit: o.limit,
      cursor: o.cursor,
      locale: o.locale,
    });

  const listAssets = (q: AssetQuery = {}): Promise<AssetPage> =>
    get<AssetPage>('/assets', {
      limit: q.limit,
      cursor: q.cursor,
      skip: q.cursor ? undefined : q.skip,
      kind: q.kind,
      tag: q.tag,
      folder: q.folder,
      locale: q.locale,
    });

  return {
    /**
     * The newest `x-cw-bookmark` this preview client has seen (or was given), sent with its next
     * request; hand it to another client to carry read-your-writes across. Assigning replaces it,
     * `undefined` clears it, and a value that isn't a D1 bookmark is dropped. Always `undefined`
     * on a Delivery client or with `readYourWrites: false`.
     */
    get bookmark(): string | undefined {
      return bookmarks.current;
    },
    set bookmark(value: string | undefined) {
      bookmarks.current = value;
    },

    /** Fetch a single published entry by id. */
    async getEntry<F extends Fields = Fields>(
      id: string,
      o: Pick<EntryQuery, 'locale' | 'include'> = {},
    ): Promise<DeliveredEntry<F>> {
      return get<DeliveredEntry<F>>(`/entries/${encodeURIComponent(id)}`, {
        locale: o.locale,
        include: o.include,
      });
    },

    /** List published entries, optionally filtered/paginated. */
    async listEntries<F extends Fields = Fields>(
      q: EntryQuery = {},
    ): Promise<{ items: DeliveredEntry<F>[]; total: number }> {
      return get('/entries', toParams(q));
    },

    /** Fetch a single published asset by id (from Preview: as it is now, drafts included). */
    async getAsset(id: string, o: { locale?: string } = {}): Promise<DeliveredAsset> {
      return get<DeliveredAsset>(`/assets/${encodeURIComponent(id)}`, { locale: o.locale });
    },

    /**
     * A collection's published assets in its order (drafts and archived members left out), a
     * page at a time. Delivery only.
     */
    getCollection,

    /**
     * Every published member of a collection, in its order, fetching a page (`limit`) at a time
     * as the loop asks for more: `for await (const asset of client.iterateCollection(id)) …`.
     */
    iterateCollection(
      id: string,
      o: { limit?: number; cursor?: string; locale?: string } = {},
    ): AsyncGenerator<DeliveredAsset, void, undefined> {
      return pages(o.cursor, (cursor) => getCollection(id, { ...o, cursor }));
    },

    /** List published assets, a page at a time (pass `nextCursor` back as `cursor`). */
    listAssets,

    /**
     * Every published asset the query matches, following `nextCursor` a page (`limit`) at a
     * time as the loop asks for more: `for await (const asset of client.iterateAssets({ kind:
     * 'image' })) …`. A `skip` applies to the first page only.
     */
    iterateAssets(q: AssetQuery = {}): AsyncGenerator<DeliveredAsset, void, undefined> {
      return pages(q.cursor, (cursor) =>
        listAssets(cursor ? { ...q, cursor, skip: undefined } : q),
      );
    },

    /**
     * Searches published assets (file name, title, caption, alt text, tags, document text; full
     * text and semantic, fused by rank). Delivery only: Preview has no asset search.
     */
    async searchAssets(query: string, q: AssetSearchQuery = {}): Promise<AssetSearchPage> {
      return get<AssetSearchPage>('/assets', {
        q: query,
        limit: q.limit,
        kind: q.kind,
        tag: q.tag,
        folder: q.folder,
        locale: q.locale,
      });
    },

    /** {@link assetUrl}, for convenience. */
    assetUrl,

    /** {@link srcset}, for convenience. */
    srcset,

    /** {@link imageProps}, for convenience. */
    imageProps,

    /** Semantic search over published content. */
    async search(query: string, o: { topK?: number } = {}): Promise<SearchHit[]> {
      const res = await get<{ hits: SearchHit[] }>('/search', { q: query, top_k: o.topK });
      return res.hits;
    },

    /** Chainable query builder for entries. */
    query: () => new EntryQueryBuilder<Fields>((q) => get('/entries', toParams(q))),

    /**
     * Attributes marking a rendered value as the field it came from, to be
     * spread onto the element that renders it:
     *
     * ```tsx
     * <h1 {...client.editable(entry, 'title')}>{entry.fields.title}</h1>
     * ```
     *
     * Outside preview this is an empty object, so the call is inert in
     * production rather than something to strip before deploying.
     */
    editable(
      entry: Pick<DeliveredEntry, 'id' | 'contentType'>,
      field: string,
      o: { locale?: string } = {},
    ): Record<string, string> {
      if (!opts.preview) return {};
      return {
        [CONTENT_REF_ATTRIBUTE]: formatContentRef({
          space: opts.space,
          environment: opts.environment,
          entryId: entry.id,
          contentType: entry.contentType,
          field,
          locale: o.locale ?? opts.locale ?? '*',
        }),
      };
    },

    /** Clears the in-memory response cache. */
    clearCache: () => cache.clear(),
  };
}

function toParams(q: EntryQuery): Record<string, string | number | undefined> {
  const params: Record<string, string | number | undefined> = {
    content_type: q.contentType,
    locale: q.locale,
    include: q.include,
    limit: q.limit,
    skip: q.skip,
    since: q.since,
  };
  for (const f of q.filters ?? []) {
    const path = f.field.startsWith('sys.') ? f.field : `fields.${f.field}`;
    const op = f.op ?? 'eq';
    const key = op === 'eq' ? path : `${path}[${op}]`;
    const value = Array.isArray(f.value) ? f.value.join(',') : String(f.value ?? '');
    params[key] = value;
  }
  if (q.order?.length) params.order = q.order.join(',');
  if (q.select?.length) params.select = q.select.join(',');
  if (q.search) params.query = q.search;
  return params;
}

/** Fluent entry query: `client.query().contentType('article').locale('en-US').limit(10).fetch()`. */
export class EntryQueryBuilder<F extends Fields> {
  private q: EntryQuery = {};
  constructor(
    private readonly run: (q: EntryQuery) => Promise<{ items: DeliveredEntry<F>[]; total: number }>,
  ) {}
  contentType(apiId: string): this {
    this.q = { ...this.q, contentType: apiId };
    return this;
  }
  locale(code: string): this {
    this.q = { ...this.q, locale: code };
    return this;
  }
  include(depth: number): this {
    this.q = { ...this.q, include: depth };
    return this;
  }
  limit(n: number): this {
    this.q = { ...this.q, limit: n };
    return this;
  }
  skip(n: number): this {
    this.q = { ...this.q, skip: n };
    return this;
  }
  /** Add a field predicate, e.g. `.where('views', 'gt', 100)`. Defaults to `eq`. */
  where(field: string, op: FilterOp, value?: unknown): this;
  where(field: string, value: unknown): this;
  where(field: string, ...rest: unknown[]): this {
    const filter: EntryFilter =
      rest.length >= 2
        ? { field, op: rest[0] as FilterOp, value: rest[1] }
        : { field, op: 'eq', value: rest[0] };
    this.q = { ...this.q, filters: [...(this.q.filters ?? []), filter] };
    return this;
  }
  /** Set sort keys, e.g. `.order('fields.title', '-sys.publishedAt')`. */
  order(...keys: string[]): this {
    this.q = { ...this.q, order: keys };
    return this;
  }
  /** Project to a subset of field apiIds. */
  select(...fields: string[]): this {
    this.q = { ...this.q, select: fields };
    return this;
  }
  /** Full-text search over string fields. */
  search(text: string): this {
    this.q = { ...this.q, search: text };
    return this;
  }
  fetch(): Promise<{ items: DeliveredEntry<F>[]; total: number }> {
    return this.run(this.q);
  }
}

export type DeliveryClient = ReturnType<typeof createDeliveryClient>;

export {
  adminEditUrl,
  CONTENT_REF_ATTRIBUTE,
  type ContentRef,
  formatContentRef,
  parseContentRef,
} from './content-ref.js';
export { type EmbedCard, type EmbedData, type EmbedKind, embedCard } from './embed.js';
export {
  type ImageProps,
  type ImagePropsOptions,
  imageProps,
  localizedText,
} from './image.js';
