# SDKs

Method-level reference for the client packages. For a task-oriented tour, see the
[SDKs guide](https://docs.contentworker.app/guides/sdks/).

Five client packages target the read-only **Delivery API**, one, `@contentworker/sdk-management`,
targets the **Management API** for programmatic authoring, and `@contentworker/sdk-codegen`
generates typed field shapes. Point Delivery clients at the delivery host, `https://cdn.<domain>`
(cached; served by the delivery Worker), and the Management client and codegen at the api host,
`https://api.<domain>`. A Delivery client in `preview: true` mode reads `/preview/*`, which only the
api serves, so give it the api host. The Delivery clients share a model (`DeliveredEntry`,
`SearchHit`) but differ in surface and footprint.

## Choosing a client

| Use case                                                            | Package                           |
| ------------------------------------------------------------------- | --------------------------------- |
| Node/SSR/backend, or building your own integration                  | `@contentworker/sdk-core`         |
| React apps                                                          | `@contentworker/sdk-web`          |
| Vue 3 / Nuxt apps                                                   | `@contentworker/sdk-vue`          |
| Edge functions, constrained devices, single-locale, minimal payload | `@contentworker/sdk-edge`         |
| React Native apps with offline sync                                 | `@contentworker/sdk-react-native` |
| Programmatic authoring/publishing (writes)                          | `@contentworker/sdk-management`   |
| Types for entry fields                                              | `@contentworker/sdk-codegen`      |

The five Delivery packages are **read-only**. For writes and publishing, use
`@contentworker/sdk-management`, call the Management API directly, or drive the MCP tools
([MCP server](./mcp.md)).

## `@contentworker/sdk-core` — framework-agnostic Delivery client

Zero-dependency client for Node, SSR, edge runtimes, and tests.

```ts
import { createDeliveryClient } from '@contentworker/sdk-core';

const client = createDeliveryClient({
  baseUrl: 'https://cdn.example.com',
  space: 'space-1',
  environment: 'main',
  token: '<cda-token>',
  fetch, // optional: inject a fetch (SSR/edge/test)
  cacheTtlMs: 0, // optional in-memory cache (0 = off)
  preview: false, // optional: read drafts from the Preview API (see Inline editing)
  locale: 'en-US', // optional: locale stamped onto inline-edit refs
});
```

API:

```ts
client.getEntry<F>(id, { locale?, include? }): Promise<DeliveredEntry<F>>
client.listEntries<F>(query?): Promise<{ items: DeliveredEntry<F>[]; total: number }>
client.search(query, { topK? }): Promise<SearchHit[]>
client.query(): EntryQueryBuilder<F>     // fluent builder
client.editable(entry, field, { locale? }): Record<string, string>   // see Inline editing
client.clearCache(): void
```

- `EntryQuery` = `{ contentType?, locale?, include?, limit?, skip?, since?, filters?, order?, select?, search? }`.
- `filters` use the same operators as the HTTP query language (`eq`, `ne`, `in`, `match`, etc.).
- The fluent builder reads naturally:
  `client.query().contentType('article').locale('en-US').limit(10).fetch()`.
- `include` controls reference embedding depth (linked entries are nested in `fields`, including
  inside components and rich-text `data.target`s).
- `client.search()` hits `/search` with hybrid mode by default (same as the API).
- Failed requests throw `DeliveryError`.

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

## `@contentworker/sdk-web` — React hooks

Hooks layered over `@contentworker/sdk-core`. Provide a client once via context, then call hooks.

```tsx
import { createDeliveryClient } from '@contentworker/sdk-core';
import {
  ContentworkerProvider,
  useEntry,
  useEntries,
  useSemanticSearch,
  useEditable,
  InlineEditor, // inline editing — see below
} from '@contentworker/sdk-web';

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
- `useSemanticSearch(query, { topK? })` — returns `[]` for an empty query (no request)
- `useDeliveryClient()` — the injected client
- `useEditable()` — returns `editable(entry, field, locale?)`, which spreads the inline-edit mark
  onto an element (see [Inline editing](#inline-editing))

`<InlineEditor adminUrl onEdit defaultEnabled toggle />` mounts the click-to-edit overlay and
renders no markup. `createDeliveryClient` is re-exported, so `sdk-web` alone is enough.

SSR-safe: no fetch happens on the server unless a hook is actually invoked.

## `@contentworker/sdk-vue` — Vue 3 composables

The same surface as the React hooks, as composables. Install the client once as an app
plugin; inputs accept plain values, refs, or getters and re-fetch on change.

```ts
// main.ts (Nuxt: inside a plugin — nuxtApp.vueApp.use(...))
import { createDeliveryClient } from '@contentworker/sdk-core';
import { createContentworker } from '@contentworker/sdk-vue';

app.use(createContentworker(createDeliveryClient({ baseUrl, space, environment, token })));
```

```vue
<script setup lang="ts">
import { useEntry } from '@contentworker/sdk-vue';
const props = defineProps<{ id: string }>();
// Getter input: re-fetches whenever props.id changes.
const { data, error, loading } = useEntry(() => props.id, { locale: 'en-US' });
</script>
```

Composables (all return `AsyncRefs<T> = { data, error, loading }` as refs):

- `useEntry<F>(id, { locale?, include? })`
- `useEntries<F>(query?)`
- `useSemanticSearch(query, { topK? })` — returns `[]` for an empty query (no request)
- `useDeliveryClient()` — the injected client

Fetching starts on mount (client-side), matching the React hooks' SSR behavior — this
holds outside components too (plugins, stores): on the server nothing fetches. Rapid
input changes are race-safe (stale settlements are discarded) and a re-fetch clears the
previous data. Query tracking is top-level: replace the query or its nested
`filters`/`order` arrays (or pass a getter) — in-place mutation of a nested element is
not observed. For server-fetched Nuxt data, wrap the client's promise methods in
`useAsyncData` instead.

## `@contentworker/sdk-edge` — tiny single-locale client

Minimal client for edge functions and constrained devices (IoT, wearables, kiosks). Always resolves to **one locale** and supports
field projection to keep payloads small.

```ts
import { createEdgeClient } from '@contentworker/sdk-edge';

const client = createEdgeClient({ baseUrl, space, environment, token, locale: 'en-US' });

await client.get('entry-42', ['title', 'body']); // pick only these fields
await client.list('article', { limit: 20, pick: ['title'] });
```

Returns `CompactEntry` = `{ id, contentType, fields }` where `fields` is already flattened to the
client locale (no locale nesting).

## `@contentworker/sdk-react-native` — offline Delivery sync

Hooks and helpers for React Native: an offline entry cache, delta sync via `since`, and image URL
helpers. Builds on `@contentworker/sdk-core`.

```ts
import {
  createDeliveryClient, // re-exported from sdk-core
  createOfflineDelivery,
  InMemoryStorage,
  imageUrl,
  useOfflineEntries,
} from '@contentworker/sdk-react-native';
```

- **Storage is injected.** `createOfflineDelivery({ client, storage, contentType, locale?, pageSize? })`
  writes through a `Storage` interface (`getItem` / `setItem` / `removeItem`, sync or async), which
  both AsyncStorage and MMKV satisfy. `InMemoryStorage` ships for tests.
- `store.sync()` delta-syncs entries published since the stored cursor and returns
  `{ synced, cursor }`; `get(id)`, `list()` and `reset()` read and clear local storage. An entry
  unpublished on the server is not removed locally yet.
- `useOfflineEntries(store)` serves the cache first, syncs in the background, and returns
  `{ entries, syncing, error, sync }`; call `sync()` on reconnect or pull-to-refresh.
- `imageUrl(url, { width?, height?, quality?, format?, dpr? })` appends `w`, `h`, `q`, `fm` and
  `dpr` query parameters to an asset URL for device-density sizing.

## `@contentworker/sdk-management` — Management (CMA) client

Zero-dependency client for the Management API: content types, entries (draft → publish →
version history), assets, releases, scheduled actions, webhooks, and space administration.
Authenticate with a CMA key or the admin token — the server enforces RBAC scopes per
operation, so the client is only as powerful as its token.

```ts
import { createManagementClient } from '@contentworker/sdk-management';

const cma = createManagementClient({
  baseUrl: 'https://api.example.com',
  space: 'space-1',
  environment: 'main',
  token: '<cma-token>',
  fetch, // optional: inject a fetch (SSR/edge/test)
});
```

The surface is namespaced; every method maps 1:1 onto a Management route:

```ts
cma.me()                                              // principal probe (/auth/me)

cma.contentTypes.list() / .get(apiId) / .create(draft) / .publish(apiId) / .entryCounts()

cma.entries.create({ contentTypeApiId, fields })      // fields are locale-keyed
cma.entries.get(id) / .update(id, fields)             // update = new draft version
cma.entries.publish(id, { expectedVersion? }) / .unpublish(id, { expectedVersion? })
cma.entries.bulkCreate(items) / .bulkPublish(ids) / .bulkUnpublish(ids)
cma.entries.reverseReferences(id)                     // "what links here"
cma.entries.versions.list(id) / .get(id, v) / .diff(id, from, to)
cma.entries.versions.restore(id, v, { expectedVersion? })

cma.assets.create({ fileName, contentType })          // → { asset, upload } (presigned PUT)
cma.assets.list(query) / .get(id) / .setMetadata(id, patch) / .usage(id) / .archive(id) / .restore(id) / .delete(id) / .move(ids, folderId)
cma.assets.folders.list() / .create({ name, parentId }) / .update(id, changes) / .delete(id)
cma.assets.publish(id) / .unpublish(id)

cma.webhooks.list() / .create(input) / .update(id, patch) / .delete(id) / .deliveries(id)

cma.releases.create({ title }) / .addEntry(id, { entityId }) / .removeEntry(id, entityId)
cma.releases.list() / .get(id) / .publish(id) / .delete(id)   // list: each with itemCount

cma.scheduledActions.list({ status? }) / .create(input) / .cancel(id)

cma.spaces.list() / .create({ spaceId, name, defaultLocale, starter? })  // deployment-wide
cma.environments.list() / .create(id, name)           // space-level
cma.environments.aliases.list() / .set(alias, envId) / .delete(alias)
cma.apiKeys.list() / .create({ kind, name }) / .revoke(id)   // admin scope
```

- Entry `fields` use the Management shape: field apiId → locale → value
  (e.g. `{ title: { 'en-US': 'Hello' } }`).
- `assets.create` returns a presigned upload target: PUT the bytes to `upload.url` with
  `upload.headers`, then `assets.publish(id)` to make it deliverable.
- `apiKeys.create` returns the raw token exactly once; only its hash is stored.
- `publish`, `unpublish` and `versions.restore` take `{ expectedVersion }`, the `currentVersion` you
  read; if a draft was saved since, the server answers 409 and changes nothing (`?expectedVersion=`
  on the route; see [Consistency](./consistency.md#invariants)).
- `spaces.create` takes the deployment's admin token (a space's own keys are refused);
  `starter: 'sample'` installs the sample content before it returns.
- Failed requests throw `ManagementError` with `status` and the parsed error `body`.

## `@contentworker/sdk-codegen` — typed field shapes from your content model

Every SDK client is generic over the field shape (`getEntry<F>`, `EntryFields`), and
`contentworker-codegen` generates those shapes from a space's actual content types — so entry fields are
typed end to end instead of `Record<string, unknown>`.

```bash
# From a live API (any token with preview read):
contentworker-codegen --url https://api.example.com --space space-1 --environment main \
  --token $CMA_TOKEN --out src/generated/content-types.ts

# From an exported JSON file ({ items: [...] } or a bare array); stdout by default:
contentworker-codegen --input content-types.json > content-types.ts
```

For each content type it emits two interfaces plus shared helpers and lookup maps:

- `<Name>Fields` — Delivery shape (locale-flattened values — request entries with
  `?locale=`; without one, Delivery returns locale-keyed values, i.e. the draft shape):
  `Symbol`/`Text`/`Date` → `string`, `Integer`/`Number` → `number`, `Boolean` → `boolean`,
  `Location` → `{ lat, lon }`, `JSON` → `Record<string, unknown>`, `RichText` →
  `RichTextDocument`, `Link` → `EntryLink`/`AssetLink`, `Array` → element type `[]`.
  An `in` validation becomes a literal union (`status: 'draft' | 'live'`) exactly where the
  domain enforces it (`Symbol`/`Text`/`Integer`/`Number`); `required` controls optionality.
  When rendering `RichTextDocument` values, handle the full node vocabulary (headings, lists,
  code blocks, tables, hyperlinks, embeds — see the domain model doc) and skip unrecognized
  `nodeType`s defensively; writes are validated against the vocabulary, but it can grow without an
  SDK change. With `include`, a reference node's `data.target` is the embedded entry or asset,
  or still a `{ id, linkType }` stub when the target is unpublished or past the depth.
- `<Name>DraftFields` — Management shape (locale-keyed: `Localized<T>`), usable with
  `@contentworker/sdk-management`.
- `ContentTypeApiId` (union of apiIds), `FieldsByContentType`, and `DraftFieldsByContentType`.

Pass the shape as the type argument, e.g. `client.getEntry<ArticleFields>(id, { locale })`.

The generator is also importable (`generateTypes(contentTypes)`) for build-tool integration.
Generated modules are self-contained and compile clean under `strict`.

## Inline editing

Turns a previewed page into click-to-edit: hovering a rendered value outlines it and names its
field, and clicking opens that field in the admin. It has two halves — marking rendered values with
the field they came from, and an overlay that reads those marks back out of the DOM.

**Marking values.** Spread `editable()` onto whatever element renders the value:

```tsx
const editable = useEditable();                        // @contentworker/sdk-web
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
import { InlineEditor } from '@contentworker/sdk-web';

<InlineEditor adminUrl="https://example.com" />;
```

Outside React, mount it directly — it is framework-free and reads the DOM, so it works against
markup rendered by anything:

```ts
import { mountInlineEditor } from '@contentworker/sdk-core/inline-edit';

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

## GraphQL

If you prefer GraphQL over the REST client, the Delivery API also exposes a per-space GraphQL
schema generated from your content types at `POST /delivery/:space/:env/graphql` (scope
`delivery:read`). It needs no SDK — use any GraphQL client with a CDA token. See
[API reference → GraphQL Delivery](./api-reference.md#graphql-delivery).
