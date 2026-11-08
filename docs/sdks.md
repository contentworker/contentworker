# SDKs

Method-level reference for the client packages. For a task-oriented tour, see the
[SDKs guide](https://docs.contentworker.app/guides/sdks/).

Everything ships as one npm package, `@contentworker/sdk` (`packages/sdk/sdk`), with a subpath per
module and the `contentworker` CLI as its binary. In the workspace each module is its own private
package under `packages/sdk/*` (`sdk-core`, `sdk-web`, …); the published package bundles them with
tsup and copies their `.d.ts` files (`packages/sdk/sdk/scripts/types.ts`), so a user only ever sees
`@contentworker/sdk`. `scripts/sdk-packages.ts` packs it, loads and type-checks every subpath
from the tarball, and publishes it on an `sdk-v<version>` tag.

Five modules target the read-only **Delivery API**, one, `@contentworker/sdk/management`,
targets the **Management API** for programmatic authoring, and `@contentworker/sdk/codegen`
generates typed field shapes. Point Delivery clients at the delivery host, `https://cdn.<domain>`
(cached; served by the delivery worker), and the Management client and codegen at the api host,
`https://api.<domain>`. A Delivery client in `preview: true` mode reads `/preview/*`, which only the
api serves, so give it the api host. The Delivery clients share a model (`DeliveredEntry`,
`SearchHit`) but differ in surface and footprint.

## Choosing a client

| Use case                                                            | Import                            |
| ------------------------------------------------------------------- | --------------------------------- |
| Node/SSR/backend, or building your own integration                  | `@contentworker/sdk`         |
| React apps                                                          | `@contentworker/sdk/react`          |
| Vue 3 / Nuxt apps                                                   | `@contentworker/sdk/vue`          |
| Edge functions, constrained devices, single-locale, minimal payload | `@contentworker/sdk/edge`         |
| React Native apps with offline sync                                 | `@contentworker/sdk/react-native` |
| Programmatic authoring/publishing (writes)                          | `@contentworker/sdk/management`   |
| Types for entry fields                                              | `@contentworker/sdk/codegen`      |
| Rendering rich text to HTML, Markdown or plain text (any framework) | `@contentworker/sdk/rich-text`    |

The five Delivery modules are **read-only**. For writes and publishing, use
`@contentworker/sdk/management`, call the Management API directly, or drive the MCP tools
([MCP server](./mcp.md)).

## `@contentworker/sdk` — framework-agnostic Delivery client

Zero-dependency client for Node, SSR, edge runtimes, and tests.

```ts
import { createDeliveryClient } from '@contentworker/sdk';

const client = createDeliveryClient({
  baseUrl: 'https://cdn.example.com',
  space: 'space-1',
  environment: 'main',
  token: '<cda-token>',
  fetch, // optional: inject a fetch (SSR/edge/test)
  cacheTtlMs: 0, // optional in-memory cache (0 = off)
  preview: false, // optional: read drafts from the Preview API (see Inline editing)
  locale: 'en-US', // optional: locale stamped onto inline-edit refs
  readYourWrites: true, // optional, preview only: echo x-cw-bookmark (default true)
  bookmark: undefined, // optional, preview only: a bookmark to start from
});
```

API:

```ts
client.getEntry<F>(id, { locale?, include? }): Promise<DeliveredEntry<F>>
client.getSingleton<F>(contentType, { locale?, include? }): Promise<DeliveredEntry<F>> // a singleton type's one entry; 404 DeliveryError otherwise
client.listEntries<F>(query?): Promise<{ items: DeliveredEntry<F>[]; total: number; nextCursor? }>
client.search(query, { topK? }): Promise<SearchHit[]>
client.getAsset(id, { locale? }): Promise<DeliveredAsset>
client.listAssets({ limit?, cursor?, skip?, kind?, tag?, folder?, locale? }): Promise<AssetPage>
client.iterateAssets(query?): AsyncGenerator<DeliveredAsset>   // every page, following nextCursor
client.getCollection(id, { limit?, cursor?, locale? }): Promise<DeliveredCollection>  // Delivery only
client.iterateCollection(id, { limit?, cursor?, locale? }): AsyncGenerator<DeliveredAsset>
client.searchAssets(q, { limit?, kind?, tag?, folder?, locale? }): Promise<AssetSearchPage>  // Delivery only
client.listTags({ locale?, contentType? }): Promise<DeliveredTag[]>      // Delivery only
client.getTag(slug, { locale?, contentType? }): Promise<DeliveredTag>
client.listConcepts({ scheme?, locale?, contentType? }): Promise<DeliveredConcept[]>
client.getConcept(slug, { scheme?, locale?, contentType? }): Promise<DeliveredConcept>
client.redirects(): Promise<DeliveredRedirect[]>         // Delivery only: the enabled set, to apply
client.resolveRedirect(path, { locale? }): Promise<RedirectMatch | null>  // Delivery only; null on 404
client.menus(): Promise<DeliveredMenuSummary[]>          // Delivery only: { handle, name, description? }
client.menu(handle, { locale? }): Promise<DeliveredMenu> // Delivery only: resolved; 404 DeliveryError for an unknown handle
client.routes(): Promise<DeliveredRoute[]>               // Delivery only: { contentType, urlPattern } per published type
client.sitemap({ from?, limit?, base? }): Promise<SitemapPage>  // Delivery only: { items, next }, published pages and their paths
client.query(): EntryQueryBuilder<F>     // fluent builder; .tagged(...slugs) for an archive,
                                         // .references(field, ...ids), .linksTo(...ids), .or(...conditions)
client.editable(entry, field, { locale? }): Record<string, string>   // see Inline editing
client.clearCache(): void
client.bookmark: string | undefined     // read-your-writes position (preview); assignable
```

- `EntryQuery` = `{ contentType?, locale?, include?, limit?, skip?, cursor?, since?, filters?, where?, linksToEntry?, order?, select?, search?, tags? }`.
  `where` (an `EntryWhere` tree of `and`/`or` groups) is sent as the `where` parameter's JSON,
  `linksToEntry` as `links_to_entry`; a filter `field` may be a component path (`seo.title`).
  Delivery pages with `skip`; Preview (`preview: true`) pages with `cursor`, the last page's
  `nextCursor`, and refuses `skip` (`422`).
  `tags` (slugs) sends `metadata.tags.slug[in]`, and a filter on `metadata.*` is sent unprefixed.
- `DeliveredTag` = `{ id, slug, label, labels?, description, count, countsByContentType }`;
  `DeliveredConcept` adds `schemeId` and `broaderId`.
- `filters` use the same operators as the HTTP query language (`eq`, `ne`, `in`, `match`, etc.).
- The fluent builder reads naturally:
  `client.query().contentType('article').locale('en-US').limit(10).fetch()`.
- `include` controls reference embedding depth (linked entries are nested in `fields`, including
  inside components and rich-text `data.target`s).
- `client.search()` hits `/search` with hybrid mode by default (same as the API).
- Failed requests throw `DeliveryError` with the `status`, the API's error `code` when the body
  names one (`{ error: { code, message } }`; the delivery gateway's `{ error: '…' }` refusals have
  none), the parsed `body` (`undefined` if it wasn't JSON) and the server's message in `message`.
- `iterateAssets(query)` and `iterateCollection(id, opts)` are `async` generators: each fetches a
  page (`limit`) when the loop needs the next item and follows `nextCursor` to the last page, so
  `break` stops fetching. A `skip` applies to the first page only, and a cursor the server
  repeats (the starting `cursor` included) throws a plain `Error` rather than looping.
- `getAsset` / `listAssets` read `/assets` (or `/preview/…/assets` with `preview: true`) and return
  the delivered asset shape (see [API reference](./api-reference.md#delivery-api-cda));
  `AssetPage` is `{ items, total, nextCursor? }`, and a `cursor` wins over `skip`.
- Pure helpers, also on the client: `assetUrl(asset, { rendition?, width? })` returns the
  rendition's URL (`undefined` if the space has none by that name), the ladder step at or above
  `width` (the largest past it, the original without a ladder), or the original; `srcset(asset)`
  returns `"url 320w, url 640w, …"` (empty without a ladder). Neither adds a query parameter, so
  signed and immutable URLs stay intact.
- `embedCard(node)` turns a rich-text `embed` node into a link card `{ href, title, provider,
  providerName, kind, authorName?, thumbnail? }` (`thumbnail` is `<img>` attributes: `src`,
  `width?`, `height?`, `alt: ''`, lazy, `referrerPolicy: 'no-referrer'`), or `undefined` for any
  other node or a non-https URL. The title falls back to the URL without its scheme; an unknown
  provider is named by its id. It is the safe default; a front end that wants a player builds it
  from `provider` and `url` (`packages/sdk/core/src/embed.ts`).
- `imageProps(asset, { sizes?, width?, rendition?, locale?, priority? })` (also on the client)
  returns the `<img>` attributes `{ src, srcSet?, sizes?, width?, height?, alt, loading,
  decoding, fetchPriority?, style: { objectPosition?, backgroundColor? } }`, or `undefined` for
  an asset with no image (audio, documents, a video without `video.thumbnailUrl`, which is a
  video's `src`). `srcSet` is the ladder with `sizes` (default `(max-width: Wpx) 100vw, Wpx` with
  `width`, else `100vw`); `src` is the step at or above `width`, else `url`; `width`/`height` are
  the asset's, scaled to `width`; a found `rendition` is the only `src`, with only the target
  `width`. When the image is wider than the ladder's last step (the ladder stops below its own width), the original `url` is the top
  `srcSet` candidate. `alt` is
  `localizedText(altText, locale)`, else the title, else `''` (decorative); `localizedText`
  takes a flattened string, the `locale` key of a map, or without a `locale` the map's first
  non-empty value. `objectPosition` is the focal point in percent, clamped to 0–100;
  `backgroundColor` is `placeholder.dominantColor` only when it is `#rrggbb`; URLs that aren't
  http(s) or relative are dropped. `priority` gives `loading: 'eager'` and `fetchPriority:
  'high'`, else `'lazy'`. With no ladder (no media origin, as in local development) it is `src`
  alone. The implementation is `packages/sdk/core/src/image.ts`.
- With `preview: true` the client keeps [read-your-writes](#read-your-writes) by default. A
  Delivery client never sends a bookmark: the delivery host is cached, reads replicas by design
  and doesn't accept the header.
- `DeliveredAsset.placeholder` is `{ thumbhash, dominantColor } | null`: the ThumbHash (base64;
  decode it with the `thumbhash` package) and `#rrggbb` ingest computed for a raster image, `null`
  for videos, other kinds and assets processed before it existed. Codegen's `DeliveredAsset`
  prelude declares it.

- **Redirects.** ContentWorker serves no site, so redirects are data a front end applies.
  `client.redirects()` fetches the enabled set once; `resolveRedirect(path, { locale? })` asks
  Delivery about one path (one request each, so prefer the set). The subpath
  `@contentworker/sdk/redirects` (`packages/sdk/core/src/redirects.ts`, zero dependencies)
  matches them locally with Delivery's rules (kept in step by a test):
  `createRedirectMatcher(set).match(pathOrPathWithQuery, locale?)`;
  `createRedirectHandler(source, { ttlMs?, locale? })`, a front-door helper that returns
  `(request) => Promise<Response | null>` (the redirect `Response`, or `null` to serve the request
  as usual), caching the set for `ttlMs` (default 60 000) and keeping the last set while a refresh
  runs or fails; `locale` is `(request) => string | undefined`; and
  `applyRedirects(request, redirects, { locale? })` for a one-off. See
  [the guide](https://docs.contentworker.app/guides/redirects/).
- **Menus.** `client.menus()` lists the navigation menus' handles; `client.menu(handle, { locale? })`
  returns one resolved for rendering: each `DeliveredMenuItem` has `label`, `url` (`null` for a term
  link), optional `target`, `attrs`, `entry` or `term`, and `children`. Only published entries
  appear; an item whose link doesn't resolve is dropped and its children lifted. See
  [the guide](https://docs.contentworker.app/guides/menus/).

Shapes:

```ts
interface DeliveredEntry<F = Fields> {
  id: string;
  contentType: string;
  fields: F;
  publishedAt: string;
}
interface SearchHit {
  entryId: string;
  score: number;
  snippet: string;
}
type DeliveryClient = ReturnType<typeof createDeliveryClient>;
```

## `@contentworker/sdk/react` — React hooks

Hooks layered over `@contentworker/sdk`. Provide a client once via context, then call hooks.

```tsx
import { createDeliveryClient } from '@contentworker/sdk';
import {
  ContentworkerProvider,
  useEntry,
  useEntries,
  useSemanticSearch,
  useEditable,
  InlineEditor, // inline editing — see below
} from '@contentworker/sdk/react';

const client = createDeliveryClient({ baseUrl, space, environment, token });

function App() {
  return (
    <ContentworkerProvider client={client}>
      <YourApp />
    </ContentworkerProvider>
  );
}
```

Hooks (all return `AsyncState<T> = { data?: T; error?: Error; loading: boolean }`):

- `useEntry<F>(id, { locale?, include? })`
- `useEntries<F>(query?)`
- `useAsset(id, { locale? })`
- `useSemanticSearch(query, { topK? })` — returns `[]` for an empty query (no request)
- `useDeliveryClient()` — the injected client
- `useEditable()` — returns `editable(entry, field, locale?)`, which spreads the inline-edit mark
  onto an element (see [Inline editing](#inline-editing))

`<InlineEditor adminUrl onEdit defaultEnabled toggle />` mounts the click-to-edit overlay and
renders no markup. `<Image asset sizes? width? rendition? locale? priority? …img />` renders
`imageProps(asset, …)` as an `<img>` (nothing while `asset` is unset, or for an asset with no
image); other `<img>` attributes pass through, and an `alt` or `style` given wins over or merges
into its own. `createDeliveryClient`, `DeliveryError`, `assetUrl`, `srcset`, `imageProps` and
`localizedText` are re-exported, so `@contentworker/sdk/react` alone is enough.

SSR-safe: no fetch happens on the server unless a hook is actually invoked.

## `@contentworker/sdk/vue` — Vue 3 composables

The same surface as the React hooks, as composables. Install the client once as an app
plugin; inputs accept plain values, refs, or getters and re-fetch on change.

```ts
// main.ts (Nuxt: inside a plugin — nuxtApp.vueApp.use(...))
import { createDeliveryClient } from '@contentworker/sdk';
import { createContentworker } from '@contentworker/sdk/vue';

app.use(createContentworker(createDeliveryClient({ baseUrl, space, environment, token })));
```

```vue
<script setup lang="ts">
import { useEntry } from '@contentworker/sdk/vue';
const props = defineProps<{ id: string }>();
// Getter input: re-fetches whenever props.id changes.
const { data, error, loading } = useEntry(() => props.id, { locale: 'en-US' });
</script>
```

Composables (all return `AsyncRefs<T> = { data, error, loading }` as refs):

- `useEntry<F>(id, { locale?, include? })`
- `useEntries<F>(query?)`
- `useAsset(id, { locale? })`
- `useSemanticSearch(query, { topK? })` — returns `[]` for an empty query (no request)
- `useDeliveryClient()` — the injected client

`<CwImage :asset sizes width rendition locale priority />` renders `imageProps` as an `<img>`
(`srcset`, `fetchpriority` as attributes), nothing while `asset` is unset; fallthrough `alt`,
`class` and `style` win or merge. The same helpers as `@contentworker/sdk/react` are re-exported.

Fetching starts on mount (client-side), matching the React hooks' SSR behavior — this
holds outside components too (plugins, stores): on the server nothing fetches. Rapid
input changes are race-safe (stale settlements are discarded) and a re-fetch clears the
previous data. Query tracking is top-level: replace the query or its nested
`filters`/`order` arrays (or pass a getter) — in-place mutation of a nested element is
not observed. For server-fetched Nuxt data, wrap the client's promise methods in
`useAsyncData` instead.

## `@contentworker/sdk/edge` — tiny single-locale client

Minimal client for edge functions and constrained devices (IoT, wearables, kiosks). Always resolves to **one locale** and supports
field projection to keep payloads small.

```ts
import { createEdgeClient } from '@contentworker/sdk/edge';

const client = createEdgeClient({ baseUrl, space, environment, token, locale: 'en-US' });

await client.get('entry-42', ['title', 'body']); // pick only these fields
await client.list('article', { limit: 20, pick: ['title'] });
```

Returns `CompactEntry` = `{ id, contentType, fields }` where `fields` is already flattened to the
client locale (no locale nesting). It asks for no `include`, so an asset field is the bare link
`{ id, linkType: 'Asset' }`; fetch the asset with `@contentworker/sdk`'s `getAsset` (and render it with
`imageProps`) where a device shows images.

## `@contentworker/sdk/webhooks` — verify a webhook delivery

```ts
import { verifyWebhook } from '@contentworker/sdk/webhooks';

const event = await verifyWebhook(request, secret); // the event, or null
```

It checks `x-contentworker-signature` (HMAC-SHA256 of `<timestamp>.<raw body>`) in constant time
with Web Crypto and rejects timestamps outside a window (default 5 minutes, `toleranceMs`).
`verifyWebhookSignature({ body, timestamp, signature, secret })` takes the parts, for frameworks
that parse the request first.

## `@contentworker/sdk/rich-text` — render rich text anywhere

Rich text is delivered as a `RichTextDocument` tree, never as HTML. Every channel renders it
for itself. This package does that for web and text channels, with no dependencies, in any
framework or runtime.

```ts
import { toHtml, toMarkdown, toPlainText, excerpt } from '@contentworker/sdk/rich-text';

const html = toHtml(entry.fields.body, {
  entryHref: (target) => `/${target.fields?.slug}`,      // links to other entries
  renderEntry: (target) => renderMyBlock(target),          // embedded entries: your components
  imageSizes: '(min-width: 900px) 800px, 100vw',           // embedded images' `sizes`
});
```

- **Safe by default.** All text is escaped. Links pass `safeLinkUri`, the same rule the CMS
  applies on save (http, https, mailto, tel or relative; `java\tscript:` and entity-hidden
  colons are refused), so the output can go straight into a page.
- **Embedded assets** render as a sized, lazy `<img>` with the delivered `srcset`. Embedded
  entries render nothing until you pass `renderEntry`, because only your app knows what a CTA
  or a product card looks like. Third-party `embed` nodes render as a plain link; render an
  iframe yourself if you want one.
- **Overrides:** `nodes: { paragraph: (node, next) => … }` replaces one node type (return
  `undefined` to keep the default). `next()` renders the node's children. `marks: { bold: (html)
  => … }` does the same for marks.
- **`toMarkdown`** gives CommonMark with GFM tables, for agents, feeds and `.md` endpoints.
  **`toPlainText`** and **`excerpt`** give search text and meta descriptions.

## `@contentworker/sdk/react-native` — offline Delivery sync

Hooks and helpers for React Native: an offline entry cache, delta sync via `since`, and image
helpers (`imageUrl`, `imageSource`). Builds on `@contentworker/sdk`.
`imageUrl(asset, { width?, dpr?, rendition? })` takes a delivered asset and returns the rendition
when it exists, else the ladder step for `ceil(width × dpr)` (through `assetUrl`), else `url`; it
never appends parameters to a URL.

```ts
import {
  createDeliveryClient, // re-exported from @contentworker/sdk
  createOfflineDelivery,
  InMemoryStorage,
  imageSource,
  imageUrl,
  useOfflineEntries,
} from '@contentworker/sdk/react-native';
```

- **Storage is injected.** `createOfflineDelivery({ client, storage, contentType, locale?, pageSize? })`
  writes through a `Storage` interface (`getItem` / `setItem` / `removeItem`, sync or async), which
  both AsyncStorage and MMKV satisfy. `InMemoryStorage` ships for tests.
- `store.sync()` delta-syncs entries published since the stored cursor and returns
  `{ synced, cursor }`; `get(id)`, `list()` and `reset()` read and clear local storage. An entry
  unpublished on the server is not removed locally yet.
- `useOfflineEntries(store)` serves the cache first, syncs in the background, and returns
  `{ entries, syncing, error, sync }`; call `sync()` on reconnect or pull-to-refresh.
- `imageSource(asset, { width?, dpr?, rendition? })` is an `<Image source>`: `{ uri, width?,
  height? }`, the same URL `imageUrl` picks (through `imageProps`, so a hosted video gives its thumbnail
  and audio or a document gives `undefined`) with `width` and, from the aspect ratio, `height` in
  dp (no `height` for a rendition, which may crop). `imageProps(asset)?.alt` (re-exported) gives
  its alt, with the same title fallback as the web.

## `@contentworker/sdk/management` — Management (CMA) client

Zero-dependency client for the Management API: content types, entries (draft → publish →
version history), the asset library, releases, scheduled actions, webhooks, and space
administration.
Authenticate with a CMA key or the admin token — the server enforces RBAC scopes per
operation, so the client is only as powerful as its token.

```ts
import { createManagementClient } from '@contentworker/sdk/management';

const cma = createManagementClient({
  baseUrl: 'https://api.example.com',
  space: 'space-1',
  environment: 'main',
  token: '<cma-token>',
  fetch, // optional: inject a fetch (SSR/edge/test)
  readYourWrites: true, // optional: echo x-cw-bookmark (default true)
  bookmark: undefined, // optional: a bookmark to start from
});
```

The surface is namespaced; every method maps 1:1 onto a Management route (`opts` on `upload`
and `replaceFile` is `UploadOptions`: `onProgress`, `concurrency`, `attempts`, `signal`):

```ts
cma.me()                                              // principal probe (/auth/me)
cma.bookmark                                          // read-your-writes position; assignable
cma.approvals.count()                                 // what waits on a person

cma.contentTypes.list() / .get(apiId) / .create(draft) / .publish(apiId) / .entryCounts()
cma.contentTypes.fieldValues(apiId, field, { locale?, limit?, cursor? }): Promise<FieldValuesPage>
cma.contentTypes.dependents(apiId) / .delete(apiId, { purgeEntries? }) / .clone(apiId, { apiId, name })
                                                      // create on an existing apiId revises it

cma.entries.list({ contentType?, locale?, limit?, skip?, order?, query? })  // Preview: drafts included
cma.entries.create({ contentTypeApiId, fields })      // fields are locale-keyed
cma.entries.get(id) / .update(id, fields)             // update = new draft version
cma.entries.publish(id, { expectedVersion? }) / .unpublish(id, { expectedVersion? })
cma.entries.bulkCreate(items) / .bulkPublish(ids) / .bulkUnpublish(ids)
cma.entries.reverseReferences(id)                     // "what links here"
cma.entries.versions.list(id) / .get(id, v) / .diff(id, from, to)
cma.entries.versions.restore(id, v, { expectedVersion? })

// Imports (CSV, JSON, WXR) into one content type, as drafts
cma.imports.sources() / .analyze(input) / .run(input) / .start(input)   // start = durable job

// Assets: reading
cma.assets.list(query?) → AssetPage                   // { kind, mime, tag, folder, status, sort, order, limit, cursor }
cma.assets.iterate(query?) → AsyncGenerator<Asset>    // follows nextCursor as the loop reads
cma.assets.get(id) / .search({ q, kind?, tag?, folder?, status?, limit? }) / .usage(id) → AssetLink[]
cma.assets.versions(id) → AssetVersion[]              // newest first, file.url signed
cma.assets.transformUrl(id, { width?, height?, fit?, format?, quality? }) → { url, transform }

// Assets: uploading and replacing
cma.assets.upload({ fileName, contentType, body, title?, description?, folderId? }, opts?) → Asset
cma.assets.create({ fileName, contentType, … }) → { asset, upload }   // one signed PUT, by hand
cma.assets.replaceFile(id, { fileName, contentType, body }, opts?) → Asset   // any size; the new version
cma.assets.startReplace(id, { fileName, contentType }) → { asset, upload, commit }
cma.assets.commitFile(id, commit) → Asset
cma.assets.restoreVersion(id, version) → Asset
cma.assets.uploads.start({ fileName, contentType, size, … }) / .startReplace(id, { fileName, contentType, size })
cma.assets.uploads.signParts(assetId, uploadId, partNumbers) / .complete(assetId, uploadId, parts) / .abort(assetId, uploadId)
cma.assets.videos.create({ fileName, contentType, title?, description?, maxDurationSeconds? }) → { asset, upload }
cma.assets.videos.refresh(id) → Asset                 // poll until file.video.status is ready

// Assets: editing and publishing
cma.assets.setMetadata(id, { altText?, tags?, focalPoint?, fields? }) → Asset
cma.assets.generateAltText(id, { locale?, context?, apply?, tier? }) → { altText, locale, applied, usage }
cma.assets.autoTag(id, { apply?, tier? }) → { tagIds, newTags, applied, usage }
cma.assets.setRights(id, { license?, credit?, expiresAt?, embargoUntil? }) → Asset   // content:publish
cma.assets.publish(id) / .unpublish(id) / .archive(id) / .restore(id) → Asset
cma.assets.delete(id)                                 // archived only; 409 asset_in_use while linked
cma.assets.move(ids, folderId | null) → { moved }
cma.assets.reingest(id) / .reindex({ all? })
cma.assets.bulk({ action: 'move' | 'tag' | 'publish' | 'unpublish' | 'archive', ids, … }) → BulkJob

// Assets: organizing and sharing
cma.assets.folders.list() / .create({ name, parentId? }) / .update(id, { name?, parentId? }) / .delete(id)
cma.assets.collections.list({ limit?, cursor? }) / .iterate({ limit? }) / .get(id) / .create({ name, description? })
cma.assets.collections.update(id, { name?, description? }) / .delete(id)
cma.assets.collections.assets(id, query?) / .iterateAssets(id, query?)   // members, in order
cma.assets.collections.add(id, assetIds) / .remove(id, assetIds) / .reorder(id, assetIds)
cma.assets.shareLinks.list({ targetType?, targetId?, includeInactive? }) / .get(id) / .create(input) / .revoke(id)
cma.assets.zips.create({ assetIds, name? } | { collectionId, name? }) / .get(id) / .list()
cma.assets.renditions.list() / .get(name) / .create({ name, width?, height?, fit?, format?, quality? })
cma.assets.renditions.update(name, spec) / .delete(name)   // content:manage; update replaces the preset

cma.bulkJobs.list({ limit? }) / .get(id) / .report(id) / .cancel(id)
cma.bulkJobs.setFields({ contentTypeApiId, entryIds, fields })   // field → locale → value; null clears

cma.entries.setSeo(id, { locale?, title?, description?, canonicalUrl?, noindex?, ogImage? })   // one locale of the Seo field; null clears
cma.entries.move(id, { after: id | null } | { before: id | null })   // manual order; live, no publish
cma.entries.outlineBlocks(id, { field?, locale? })   // blocks as a tree of keys, types, labels; version
cma.entries.patchBlocks(id, { expectedVersion, ops })   // by _key, all or none; → { entry, fields, keys, inverse }
cma.entries.previewLink(id, { ttlHours?, previewBaseUrl?, locale? })   // { url, frontendUrl?, token, expiresAt }

cma.redirects.list({ q?, limit?, cursor? }) / .get(id) / .create(input) / .update(id, changes) / .delete(id)
cma.redirects.import({ format: 'csv' | 'json', data, dryRun? }) / .resolve(path, { locale? }) / .analyze() / .collapseChains()

cma.savedViews.list({ contentType? }) / .get(id) / .run(id, { limit?, cursor?, locale? }) / .create(input) / .update(id, changes) / .delete(id, { revision? })

cma.menus.list() / .get(id) / .preview(id, { locale? }) / .resolve(handle, { locale? }) / .create(input) / .update(id, changes) / .moveItem(id, move) / .delete(id, { revision? })

cma.webhooks.list() / .create(input) / .update(id, patch) / .delete(id) / .deliveries(id)
  / .test(id) / .resend(id, deliveryId)
cma.taxonomy.tags.list() / .create({ name, slug?, description?, labels? }) / .update(id, patch) / .delete(id)   // list: each with usage
cma.taxonomy.schemes.list() / .create({ name }) / .delete(id)
cma.taxonomy.concepts.list({ scheme? }) / .create(input) / .update(id, patch) / .setBroader(id, broaderId) / .delete(id)
cma.taxonomy.repair() → { slugsAssigned }   // recount published usage, fill missing slugs

cma.releases.create({ title }) / .addEntry(id, { entityId }) / .removeEntry(id, entityId)
cma.releases.list() / .get(id) / .publish(id) / .delete(id)   // list: each with itemCount

cma.scheduledActions.list({ status? }) / .create(input) / .cancel(id)

cma.spaces.list() / .create({ spaceId, name, defaultLocale, starter? })  // deployment-wide
cma.spaces.starters() / .starterInstall(spaceId, environmentId, install)
cma.environments.list() / .create(id, name)           // space-level
cma.environments.aliases.list() / .set(alias, envId) / .delete(alias)
cma.apiKeys.list() / .create({ kind, name }) / .revoke(id)   // admin scope
```

- Entry `fields` use the Management shape: field apiId → locale → value
  (e.g. `{ title: { 'en-US': 'Hello' } }`).
- `Asset` is fully typed: `file` (`AssetFile`: `url`, `fileName`, `contentType`, `size`, `width`,
  `height`, `placeholder`, and `video` with `status`, `hlsUrl`, `dashUrl`, `thumbnailUrl`,
  `durationSeconds`, `errorReason` on a hosted video), `metadata` (`altText`, `tags`, `focalPoint`,
  `fields`), `rights`, `version`, `ingestStatus`, `duplicateOf`, `aiSuggestions`, `folderId`. A
  test in `packages/http` holds it to the API's schema.
- `assets.upload` and `replaceFile` take any size: one signed PUT up to 100 MiB, a multipart upload
  above it with each part retried on its own and progress after each; a failed or aborted
  multipart upload is aborted on the server too. A signed PUT stores once, so a second PUT through
  it is a `412`: on a retry the SDK counts that as stored (an earlier attempt's bytes landed and its
  answer was lost); on a first attempt it throws a `ManagementError` with status 412.
- `assets.startReplace` + `commitFile` is the single-PUT replace one step at a time; past 100 MiB,
  `uploads.startReplace` and `uploads.complete` (which commits). A replace another commit beat is a
  `409`.
- `iterate`, `collections.iterate` and `collections.iterateAssets` fetch a page (`limit`) at a time
  as the loop reads; break out and no further page is fetched. Share links and zips aren't paged.
- `bulkJobs.cancel` stops a job taking new work: chunks not started are skipped, one already running
  finishes, and nothing done is rolled back. Cancelling a finished job returns it unchanged.
- `contentTypes.create(draft)` takes `urlPattern` (e.g. `/blog/{slug}`; `null` clears it), which makes
  a publish that changes a slug write a redirect. `redirects.import` is all or nothing, and
  `redirects.resolve` answers `null` on `404`.
- `menus.update` replaces the whole tree when given `items`; with `revision` (and on `moveItem` and
  `delete`) a menu saved since is a `409`.
- `savedViews.create` stores `query` in the structured form (`filters`, `where`, `order`, `search`,
  `extra`); `savedViews.run` is the caller's own Preview list query, `{ view, items, total,
  nextCursor?, ignored?, typeMissing? }`. Another person's personal view is a `404`, and a view's
  `createdBy` is left out for a key that isn't served author ids.
- `apiKeys.create` returns the raw token exactly once; only its hash is stored.
- `entries.list` reads `GET /preview/:space/:env/entries` on the same origin (the Management API
  has no entry list): the latest saved version, drafts included, `{ items, total }` with `total`
  counting the page. It needs `preview:read`.
- `imports.analyze`, `run` and `start` take the same `ImportInput` (`source`, `payload`,
  `mapping`, `sourceOptions?`, `conflicts?`); `analyze` writes nothing and is the plan the other two
  execute. `start` returns `{ job, analysis }`; follow `job.id` with `bulkJobs.get`.
- `publish`, `unpublish` and `versions.restore` take `{ expectedVersion }`, the `currentVersion` you
  read; if a draft was saved since, the server answers 409 and changes nothing (`?expectedVersion=`
  on the route; see [Consistency](./consistency.md#invariants)).
- `spaces.create` takes the deployment's admin token (a space's own keys are refused);
  `starter: 'sample'` installs the sample content before it returns; `'enterprise'`, where
  `spaces.starters()` lists it, returns `installing` at once, followed with `spaces.starterInstall`.
- A read after the client's own write sees it: see [Read-your-writes](#read-your-writes).

### Errors

A failed request throws `ManagementError` with `status`, the API's error `code`, the parsed
`error` object (`code`, `message` and the details a code carries) and the raw `body`. Guards
narrow it to the bodies a client branches on:

```ts
import { isAssetInUse, isAssetRightsError, isValidationError } from '@contentworker/sdk/management';

try {
  await cma.assets.archive(id); // deleting needs an archived asset
  await cma.assets.delete(id);
} catch (err) {
  if (isAssetInUse(err)) {
    // err.error.usage: the first 50 links, each with contentTypeApiId and entryTitle
    // err.error.total: every link, counted
  } else throw err;
}
```

| Guard                | `code`                              | Details on `err.error`                                   |
| -------------------- | ---------------------------------------- | ----------------------------------------- |
| `isAssetInUse`       | `asset_in_use` (409)                | `usage`, `total`                                         |
| `isAssetRightsError` | `asset_embargoed`, `asset_expired` (409) | `embargoUntil` or `expiresAt`, by `code`            |
| `isValidationError`  | `validation_failed` (422)           | `issues`: `{ field, locale?, message }[]`                 |
| `isConflict`         | `conflict` (409)                    |                                                          |
| `isNotFound`         | `not_found` (404)                   |                                                          |
| `isRateLimited`      | `rate_limited` (429)                |                                                          |

`code` is read from `{ error: { code } }` and from the flat `{ code }` of a refusal made before a
route runs (the 413, a request-rate 429). The full list is in the
[REST API reference](https://docs.contentworker.app/reference/rest-api/#errors).

## Read-your-writes

The api answers every request with `x-cw-bookmark`, the database session's bookmark after its
queries, and a request that sends one back reads a database at least that fresh, even from a read
replica ([Consistency](./consistency.md#database-sessions-and-replicas)). The Management client and
a Delivery client in `preview: true` mode do this for you:

- Each client instance keeps the newest bookmark it has been answered with (bookmarks sort oldest
  to newest as strings, so a late response to an earlier request never moves it back, and a
  failed request's bookmark counts too) and sends it with its next request.
- It goes only to, and is taken only from, the origin of `baseUrl` (a relative `baseUrl` is the
  page's own origin); a response redirected elsewhere is ignored.
- `client.bookmark` reads it, and assigning replaces it (`undefined` clears it). `bookmark` in the
  options seeds it. A value that isn't shaped like a database bookmark is dropped, as the api would.
- `readYourWrites: false` turns it off: nothing is kept or sent, and `bookmark` stays `undefined`.

To carry it from a write on the server to a reader in the browser, hand the bookmark across:

```ts
// Server action
await cma.entries.update(id, fields);
return { bookmark: cma.bookmark };

// Browser
const preview = createDeliveryClient({ ...previewOptions, preview: true, bookmark });
```

A Delivery client (not preview) never sends one: Delivery is served from the cache and replicas
and is eventually consistent after a publish (see [Consistency](./consistency.md)). The
in-memory cache (`cacheTtlMs`) answers without asking the api, so a cached read does not see a
later write; `clearCache()` after writing.

## `@contentworker/sdk/codegen` — typed field shapes from your content model

Every SDK client is generic over the field shape (`getEntry<F>`, `EntryFields`), and
`contentworker types` generates those shapes from a space's actual content types — so entry fields
are typed end to end instead of `Record<string, unknown>`.

```bash
# The signed-in space (contentworker login), or CONTENTWORKER_URL / _TOKEN / _SPACE / _ENVIRONMENT:
npx contentworker types --out src/generated/content-types.ts
```

```ts
// From content types you already have ({ items: [...] } JSON, a build step):
import { generateTypes } from '@contentworker/sdk/codegen';
const source = generateTypes(contentTypes);
```

For each content type it emits two interfaces plus shared helpers and lookup maps:

- `<Name>Fields` — Delivery shape (locale-flattened values — request entries with
  `?locale=`; without one, Delivery returns locale-keyed values, i.e. the draft shape):
  `Symbol`/`Text`/`Date` → `string`, `Integer`/`Number` → `number`, `Boolean` → `boolean`,
  `Location` → `{ lat, lon }`, `JSON` → `Record<string, unknown>`, `RichText` →
  `RichTextDocument`, `Link` → `EntryLink` / `AssetLink | DeliveredAsset` (an asset link can be
  embedded), `Seo` → `{ title?, description?, canonicalUrl?, noindex?, ogImage? }`, `Array` → element type `[]`. The generated prelude declares `DeliveredAsset`.
  An `in` validation becomes a literal union of its stored values (`status: 'draft' | 'live'`;
  a labelled option contributes its `value`) exactly where the domain enforces it
  (`Symbol`/`Text`/`Integer`/`Number`); `required` controls optionality, except that a required
  field a conditional rule can hide is optional (a hidden field is not required). A list of
  `Integer` or `Number` is `number[]`, of `Symbol`, `Text` or `Date` `string[]`. A field's
  `description` (else its `help`) goes into the property's doc comment, with a Date field's
  format (`date: YYYY-MM-DD`) and a note when rules hide or disable it. An older codegen types a
  list of numbers as `string[]` and a hideable required field as required: regenerate after
  upgrading.
  **Breaking (types):** the management SDK's `FieldDefinition.validations` was typed as an array
  of records; it is now the `FieldValidations` object the API returns (with `in: FieldOption[]`
  and `messages`). Code that indexed it as an array reads the rule by name instead.
  **Breaking (codegen):** an `in` list may hold `{ value, label }` objects. A codegen release from
  before labelled options throws on one. Upgrade
  `@contentworker/sdk` before a content type gains a labelled option, regenerate the types, and
  read an option with `typeof o === 'object' ? o.value : o` wherever your code walks
  `validations.in` itself.
  When rendering `RichTextDocument` values, handle the full node vocabulary (headings, lists,
  code blocks, tables, hyperlinks, embeds — see the domain model doc) and skip unrecognized
  `nodeType`s defensively; writes are validated against the vocabulary, but it can grow without an
  SDK change. With `include`, a reference node's `data.target` is the embedded entry or asset,
  or still a `{ id, linkType }` stub when the target is unpublished or past the depth. An
  `embed` node's `data` is typed `EmbedData` (`{ url, provider, kind?, title?, authorName?,
  thumbnail?, width?, height?, aspectRatio? }`), structured metadata, never markup.
- `<Name>DraftFields` — Management shape (locale-keyed: `Localized<T>`), usable with
  `@contentworker/sdk/management`.
- `ContentTypeApiId` (union of apiIds), `FieldsByContentType`, and `DraftFieldsByContentType`.

Pass the shape as the type argument, e.g. `client.getEntry<ArticleFields>(id, { locale })`.

`contentworker types` is the [CLI](./developer-tooling.md)'s command over the same generator. The
workspace package `sdk-codegen` still has its own `contentworker-codegen` bin for local use; it
isn't published.
Generated modules are self-contained and compile clean under `strict`.

## Inline editing

Turns a previewed page into click-to-edit: hovering a rendered value outlines it and names its
field, and clicking opens that field in the admin. It has two halves — marking rendered values with
the field they came from, and an overlay that reads those marks back out of the DOM.

**Marking values.** Spread `editable()` onto whatever element renders the value:

```tsx
const editable = useEditable();                        // @contentworker/sdk/react
<h1 {...editable(entry, 'title')}>{entry.fields.title}</h1>
<p {...editable(entry, 'summary', 'de-DE')}>{entry.fields.summary}</p>
```

It emits a single `data-cw-ref` attribute — and **only when the client is in preview mode**. On a
production client the call returns `{}`, so the same components ship unchanged without disclosing
entry ids, field names, or that there is a CMS behind the page. There is nothing to strip before
deploying and no second code path to keep in step.

Refs are derived on the client, not served in delivery payloads: the space, environment and locale
are already known to whoever configured the client, and the entry id and content type are already
in the response, so having the API repeat all five on every field of every entry would add weight
to the hottest read path to carry nothing new.

**The overlay.** In React, render it anywhere in the tree:

```tsx
import { InlineEditor } from '@contentworker/sdk/react';

<InlineEditor adminUrl="https://example.com" />;
```

Outside React, mount it directly — it is framework-free and reads the DOM, so it works against
markup rendered by anything:

```ts
import { mountInlineEditor } from '@contentworker/sdk/inline-edit';

const editor = mountInlineEditor({ adminUrl: 'https://example.com' });
editor.setEnabled(true);
editor.destroy();
```

| Option           | Meaning                                                            |
| ---------------- | ------------------------------------------------------------------ |
| `adminUrl`       | Admin base URL. Required unless `onEdit` handles the click itself. |
| `onEdit(ref)`    | Called instead of navigating — open a side panel, or route in-app. |
| `defaultEnabled` | Start with editing on. Default `false`.                            |
| `toggle`         | Render the built-in toggle button. Default `true`.                 |

Editing starts **off** and is switched on from the toggle (or `setEnabled`). A previewed page is
still a page: with every click intercepted, following a link to the next page — the reason to
preview a site rather than one entry — would be impossible. While it is on, clicks on marked
elements are claimed in the capture phase, so a heading inside a link opens the editor instead of
navigating.

**In the admin.** The link opens the entry editor on the referenced field; see
[Admin UI](./admin-ui.md#inline-edit-links).

## `@contentworker/sdk/live-preview` — the page side of live preview

Preview-only: the admin side (framing the frontend in `apps/web`, drawing overlays) isn't built
yet, so nothing sends a page `init` today. The page side and the protocol are in
`packages/sdk/core/src/live-preview/` (`protocol.ts`, `patch.ts`, `guest.ts`), re-exported as
`@contentworker/sdk/live-preview`; the user guide is
https://docs.contentworker.app/guides/live-preview/.

- `startLivePreview({ adminOrigin, onChange, onSelect?, onHover?, newKey?, window? })` is inert
  (returns `active: false`) unless the page is framed (`window.parent !== window`) and its URL
  carries `cw_session` matching `[A-Za-z0-9_-]{8,128}`. Only then is `adminOrigin` checked: an
  exact https origin, http only on a loopback host (it throws otherwise, so a typo breaks previews,
  never production page views). The page posts to it only, and accepts a message only when
  `event.origin === adminOrigin`, `event.source === window.parent` and the envelope's `session`
  matches. Every message is parsed by `parseAdminMessage` before it is acted on.
- Patches apply with `applyLivePatch`, a schema-less copy of the domain's `applyBlockPatch`
  (`packages/domain/src/content-type/block-patch.ts`) plus `setField`. A block is any object with
  a string `_type`; its slots are its direct properties holding a list of objects, each keyed or
  typed, at least one typed (so a block missing `_type` doesn't hide its keyed siblings, and a
  repeater's items are never read as blocks). Plain objects under a block are opaque: the page
  can't tell a component from a JSON value, so it neither mints keys nor checks collisions in them.
  For patches the server accepts, in the applied form, the two give equal fields:
  `packages/http/test/live-preview-patch-parity.test.ts` runs the same fixtures, and the domain's
  `applied` ops, through both (http is the one package allowed to import both). Keys a page mints
  are its own, so the admin must send the applied form. Known divergences, pinned in that test: a
  raw `duplicate` leaves blocks under a plain component with their old keys (the server rekeys
  them; the applied form carries the server's keys, so the two agree there), and keyed, typed
  objects in a JSON value that is itself a list, or in a field the variant no longer declares, or
  under a block of an unknown `_type`, are read as blocks, so a key they share with a real block
  makes an op ambiguous on the page that the server applies. The admin's way out, so a refusal
  can't loop: resend `init`, and if the same patch is refused again, send the changed field whole as
  `setField` with the value the server holds.
- Rendering is serialized: one `onChange` at a time, later patches folded into the next call,
  `rendered { seq }` after it settles, then geometry. An `onChange` that throws answers
  `error { kind: 'render', seq }`, acks nothing, and puts its ops back on the queue; the next call
  (on the next patch or `init`, never a retry loop) carries them, and its ack covers them.
- Desync: a refused patch, or a patch the parser rejects as too large or malformed (with `seq` above
  the last applied), answers `error { kind: 'patch', seq }` and marks the page out of step. Every
  later patch is dropped with the same error and `seq` (the first that went missing) until an
  `init` clears it. `init` sets the baseline to its `seq`, or 0 when absent. The queue of ops
  waiting on a render (failed renders requeue theirs) is capped at 1,000 ops; a patch that would
  pass it is refused the same way, so a page whose `onChange` keeps throwing resyncs instead of
  growing without bound. A slot with more seams than fit (count or bytes) keeps those that do.
- Geometry is event-driven (MutationObserver on the document, ResizeObserver on every marked
  element, passive scroll and resize listeners), coalesced into one `requestAnimationFrame` and
  skipped when unchanged. No polling. Up to 10,000 elements of each kind are measured;
  `fitGeometry` then keeps what fits `MAX_MESSAGE_BYTES` (with the envelope) and the item caps,
  on-screen boxes first, then by distance from the viewport, each list in document order, and sets
  `truncated: true` when anything was left out.
- Edit mode listens on the window in the capture phase: clicks on marked elements become `pick`,
  link clicks `navigate` (https, http only on loopback; `cw_session` stripped), hover goes out at most once
  a frame, and only `FORWARDED_KEYS` are forwarded, never from a form field. Arrows and
  Delete/Backspace are only `preventDefault`ed while the admin reports a selection.
- Caps (`protocol.ts`): `MAX_MESSAGE_BYTES` 256 KB, `MAX_INIT_BYTES` 2 MB (a D1 row's limit),
  `MAX_PATCH_OPS` 100, `MAX_GEOMETRY_ITEMS` 2,000 per list, `MAX_GEOMETRY_GAPS` 4,000. `__proto__`,
  `constructor` and `prototype` are refused as names anywhere in an admin message, and nesting past
  64 levels.
- `parseGuestMessage({ data, origin, source }, { session, origin, source, navigateOrigins? })` is
  the admin's parser for what a page sends; the frame is untrusted to the admin too. The session is
  a bearer value in the frame URL (any script on the page, and any page the frame navigates to,
  can read it), so the parser checks the event's origin against the frame's and its source against
  `iframe.contentWindow` before the session. The admin must mint a fresh random session per
  framing and post with `targetOrigin` set to the frame's origin, never `'*'`. The parser runs the
  same `clean()` as the page (no `__proto__`/`constructor`/`prototype` names, plain objects only,
  depth 64), refuses those names as keys and refs, accepts `navigate` only to `navigateOrigins`
  (default: the frame's origin) over https (http only on loopback), and returns a freshly built
  message holding only the validated fields.
- `applyLivePatch` runs `clean()` on each op too, for callers that didn't parse them.
- Key forwarding judges the event's innermost target (`composedPath()[0]`), so typing in an input
  inside a shadow root stays with the page.
- `LIVE_PREVIEW_SDK_VERSION` is sent in `hello`; `packages/sdk/sdk/test/subpaths.test.ts` keeps it
  equal to `@contentworker/sdk`'s version.
- React: `useLivePreview(options)` in `@contentworker/sdk/react` returns `{ active, fields, update }`
  and resolves `onChange` after React commits, so `rendered` means on screen.

## GraphQL

If you prefer GraphQL over the REST client, the Delivery API also exposes a per-space GraphQL
schema generated from your content types at `POST /delivery/:space/:env/graphql` (scope
`delivery:read`). It needs no SDK — use any GraphQL client with a CDA token. `asset(id)` is a
typed `Asset` with `url(rendition, width)`, `srcset`, `placeholder`, per-field `locale` arguments and `video`. See
[API reference → GraphQL Delivery](./api-reference.md#graphql-delivery).
**Breaking (GraphQL):** a list of `Symbol` values is now typed `[String]`, not `JSON`; regenerate
client types made from the schema.
