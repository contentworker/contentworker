# Domain model

The domain layer (`packages/domain`) is pure TypeScript with no infrastructure dependencies. It
defines the structured-content model and the rules that govern it.

## Core scalar types

| Type                | Shape                                               | Notes                                                                     |
| ------------------- | --------------------------------------------------- | ------------------------------------------------------------------------- |
| `Scope`             | `{ spaceId, environmentId }`                        | The multi-tenant boundary on every operation                              |
| `LocaleCode`        | `string`                                            | BCP-47, e.g. `"en-US"`                                                    |
| `LocalizedValue`    | `Record<LocaleCode, unknown>`                       | A field value keyed by locale, e.g. `{ "en-US": "Hi", "de-DE": "Hallo" }` |
| `EntryFields`       | `Record<string, LocalizedValue>`                    | All field values for an entry: `fieldApiId → locale → value`              |
| `EntryStatus`       | `'draft' \| 'changed' \| 'published' \| 'archived'` | Entry lifecycle                                                           |
| `ContentTypeStatus` | `'draft' \| 'published'`                            | Content-type lifecycle                                                    |

Non-localized fields still use `LocalizedValue` with a single entry under the space's default
locale, keeping the read/write paths uniform.

## Field types

A content type is an ordered list of typed, validated fields. The 13 field types
(`FIELD_TYPES`):

| Type        | Represents                                          | Stored value                   |
| ----------- | --------------------------------------------------- | ------------------------------ |
| `Symbol`    | Short single-line text                              | `string`                       |
| `Slug`      | URL-safe identifier (normalized on write)           | `string`                       |
| `Text`      | Long multi-line text                                | `string`                       |
| `RichText`  | Structured rich-text document                       | object                         |
| `Integer`   | Whole number                                        | integer                        |
| `Number`    | Floating-point number                               | number                         |
| `Boolean`   | True/false                                          | boolean                        |
| `Date`      | ISO-8601 date/time                                  | string                         |
| `Location`  | Geographic point                                    | `{ lat: number, lon: number }` |
| `JSON`      | Arbitrary JSON                                      | object                         |
| `Link`      | Reference to an Entry or Asset                      | `{ id, linkType }`             |
| `Component` | A group of nested typed fields                      | object keyed by nested apiId   |
| `Array`     | Homogeneous list of `Symbol`, `Link` or `Component` | array                          |

### Components and repeaters

A `Component` is a named group of nested field definitions — the "hero block", "call to action",
"spec row" shape. An `Array` whose `items.type` is `Component` is the **repeater**: a list of
feature cards, timeline entries, table rows.

Nested fields are ordinary `FieldDefinition`s, with three things withheld, each because it would
otherwise be a promise nothing keeps:

| Withheld    | Why                                                                                                                                                                                                                  |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `localized` | Localization is decided once, on the field holding the component. Per-leaf flags would let one card in a list be German while its sibling was not — a shape no editor can express and no fallback chain can resolve. |
| `unique`    | The constraint behind it is a row per (content type, field, locale, value). There is no row for the third card's title.                                                                                              |
| `Slug`      | Slugs are normalized by walking an entry's top-level fields, so a nested one would be stored exactly as typed and then fail its own validation.                                                                      |

Components nest up to `MAX_COMPONENT_DEPTH` (3). The cap exists because validation, codegen,
GraphQL type generation and the editor all walk this tree; anything deeper is better modeled as its
own content type and linked, which is what the error says.

Everything else behaves as it does at the top level, and is tested that way:

- **Validation recurses**, and issues are addressed by path — `hero.title`, `cards[2].title`. An
  editor looking at eight cards needs to be told which one is wrong.
- **Required means required** wherever the component appears, including the fourth repeater item.
- **`defaultValue` fills gaps** in components that exist, including every item of a repeater. A
  component the author never supplied stays absent rather than being invented from its defaults.
- **Links nested anywhere produce reference edges**, so referential integrity, `?include=`
  resolution and reverse cache invalidation cover component content. Edges are attributed to the
  **top-level** field, not the nested path: an edge answers "does anything still link to this?", and
  knowing it was card 3's image makes that answer no better while multiplying near-identical rows.
- **Text inside components is embedded and indexed**, so component-modeled content is findable.

**GraphQL** gives a component a real object type, named for the content type and the field path —
`ArticleHero`, `ArticleHeroCta`, and `[PageCards]` for a repeater. Type names are global and
"content type + field path" is not unique, so a collision takes a numeric suffix; content-type names
are reserved first, since those are what clients query by. A component with no declared shape stays
`JSON`, because an object type with no fields is not a legal schema.

One surface still treats a component as opaque, deliberately:

- **Query pushdown** cannot filter on a nested value. Filter on a top-level field, or model the
  thing you filter by as one.

The admin's entry editor renders a component as a group of real inputs, and a repeater as a list
with add / remove / reorder. Validation issues land on the nested input that caused them, and the
error summary reads paths as directions ("Cards 3 › Title", not `cards[2].title`). The content-type
dialog does not offer to _create_ a component — it has no nested-field authoring, and a component
with no fields is refused by the domain — so component shapes are authored through the API or MCP.
Existing ones load, edit and round-trip there unchanged.

### Rich text

A `RichText` value is a document tree (`packages/domain/src/rich-text/rich-text.ts`): a
`document` root whose `content` is block and inline nodes. Text lives in `text` nodes carrying
`marks`; reference nodes carry a `data.target` link so the reference graph can be extracted from
rich text exactly as from `Link` fields (`extractRichTextTargets`). `richTextToPlainText`
flattens a document for search/embedding.

The node vocabulary (`RICH_TEXT_BLOCK_NODE_TYPES`, `RICH_TEXT_INLINE_NODE_TYPES`):

- **Blocks** — `paragraph`, `heading-1`…`heading-6`, `blockquote`, `unordered-list`,
  `ordered-list`, `list-item`, `code-block` (optional `data.language`), `hr`, and the table
  nodes `table`, `table-row`, `table-header-cell`, `table-cell`.
- **Inline** — `text` (with `marks`), `hard-break`, `hyperlink` (`data.uri`, text children).
- **References** (`REFERENCE_NODE_TYPES`, each with `data.target: { id, linkType }`) —
  `embedded-entry-block`, `embedded-asset-block`, `embedded-entry-inline`, `entry-hyperlink`,
  `asset-hyperlink`.
- **Marks** — `bold`, `italic`, `underline`, `code`, `strikethrough`.

`validateRichText` runs on every write (API, MCP, editor, import, AI) and refuses:

- a `nodeType` outside the vocabulary, anywhere in the tree — delivery clients switch on
  `nodeType`, so a type they cannot know is refused rather than delivered;
- a `text` node without a string `value`, a reference node without a well-formed `data.target`,
  and a node whose `data` is not an object or whose `content` is not an array;
- a `hyperlink` whose `data.uri` is missing or unsafe. `safeLinkUri` allows `http`, `https`,
  `mailto` and `tel`, plus relative and fragment URIs; it reads the scheme the way a browser does
  (ignoring embedded whitespace and control characters) and refuses an undecoded entity before
  the path (`javascript&colon;`). The HTML import applies the same rule, keeping an unsafe link's
  text and dropping its target;
- a document over `MAX_RICH_TEXT_BYTES` (512 KiB serialized, twice the `JSON` field cap) or
  nested more than `MAX_RICH_TEXT_DEPTH` (64) nodes below the root.

Which node may hold which (blocks inside inline nodes, table structure) is not yet constrained.

In Delivery, `?include=` resolves rich-text references like `Link` fields: each reference node's
`data.target` becomes the embedded entry or asset (the node and its `nodeType` stay), and a
dangling, unpublished or cyclic target stays a `{ id, linkType }` stub.

### Slug, `unique` and `defaultValue`

**`Slug`** is a constrained string: lowercase ASCII letters, digits and single hyphens, ≤200
characters. Values are normalized on every write (`normalizeSlug`), so an editor can type
"Crème Brûlée" and store `creme-brulee`. Normalization is idempotent and transliterates accents
rather than dropping the letter; characters with no ASCII equivalent are removed, so a title that
is entirely non-Latin normalizes to `''` and the caller decides what to do.

**`unique`** means no two entries of the content type may share a value, compared **per locale**
and scoped **per content type** — a post named `about` does not stop a page being named `about`.
It is backed by a real uniqueness constraint (`entry_unique_values`, one row per claim with a
unique index), not a read-then-write check, so two concurrent creates of the same slug cannot both
succeed. A pre-check runs first purely to produce a message naming the field and the entry holding
the value; the constraint is what guarantees the invariant.

Only the types in `UNIQUE_FIELD_TYPES` may declare it (`Symbol`, `Slug`, `Text`, `Integer`,
`Number`, `Date`). Declaring it elsewhere is refused at content-type authoring time rather than
accepted and never enforced. Empty values are not claims — otherwise a single entry with an empty
slug would block every other entry from having one.

Claims follow the trash lifecycle: trashing an entry **frees** its values (an editor who deleted
`about` expects to reuse it), and restoring **re-claims** them, which can legitimately fail with a
409 if someone took the value meanwhile. Duplicating an entry rewrites its unique values to free
ones (`about` → `about-2`) rather than failing.

There is deliberately **no `indexed` attribute**: field values live in a JSON `text` column, so
honouring it would mean issuing DDL per field on publish. Accepting the flag and not indexing
would be a promise the storage layer does not keep.

**`defaultValue`** is applied only on **create**, for fields the caller omitted. An update that
omits a field means "leave it alone" and one that clears it means "make it empty" — re-applying a
default in either case would override the editor. A bare value fills every locale of a localized
field; a `{ locale: value }` map sets them individually. A default is only read as a locale map
when _every_ key is one of the space's locales, so a JSON field defaulting to `{ theme: 'dark' }`
is stored whole rather than torn apart.

### Field definition

```ts
interface FieldDefinition {
  apiId: string; // unique within the type; /[a-zA-Z][a-zA-Z0-9_]*/, ≤ 64 chars
  name: string; // human-facing label
  type: FieldType;
  localized: boolean; // may values differ per locale?
  required: boolean;
  position: number; // ascending order within the type
  validations?: FieldValidations;
  linkType?: 'Entry' | 'Asset'; // for Link fields
  items?: {
    // for Array fields
    type: 'Symbol' | 'Link' | 'Component';
    linkType?: 'Entry' | 'Asset';
    validations?: FieldValidations;
    fields?: readonly FieldDefinition[]; // for Array-of-Component
  };
  fields?: readonly FieldDefinition[]; // for Component fields
}
```

### Per-field validations

```ts
interface FieldValidations {
  in?: readonly (string | number)[]; // enumeration (Symbol/Text/Integer/Number)
  regexp?: { pattern: string; flags?: string }; // pattern match (Symbol/Text)
  range?: { min?: number; max?: number }; // numeric range, inclusive (Integer/Number)
  size?: { min?: number; max?: number }; // length (Symbol/Text) or item count (Array)
  linkContentTypes?: readonly string[]; // restrict Link targets to these content-type apiIds
}
```

## The validation engine

`validateEntryFields(contentType, fields, ctx)` returns a `FieldIssue[]` (empty when valid).
`assertEntryFieldsValid(...)` wraps it and throws `ValidationError` if any issue exists. This is
the **single validation path** for both human API writes and AI-generated content.

Rules applied:

1. **Unknown fields** — any key not in the content type is rejected.
2. **Required** — enforced on the default locale only; other locales resolve via fallback at
   delivery time.
3. **Type checks** — per the table above (string/integer/number/boolean/valid ISO date/`{lat,lon}`
   /object/`{id,linkType}`/array-of-items).
4. **Size** — `size.min`/`size.max` against string length or array item count.
5. **Range** — `range.min`/`range.max` against numeric value.
6. **Enumeration** — value must be in `validations.in`.
7. **Regex** — `Symbol`/`Text` must match `validations.regexp`.
8. **Localization** — non-localized fields must not carry values under non-default locales.

```ts
interface FieldIssue {
  field: string; // field apiId ("" for entry-level issues)
  locale?: string; // present when locale-specific
  message: string;
}
```

## Content type

```ts
interface ContentType {
  apiId: string; // stable machine identifier
  name: string;
  displayField: string; // apiId of the field used as the entry's display title
  fields: readonly FieldDefinition[];
  version: number; // bumped on each revision
  status: 'draft' | 'published';
}
```

- `defineContentType(draft)` — validates the `apiId` and field set (no duplicate apiIds,
  `displayField` must exist), returns a `ContentType` at version 1, status `draft`. Throws
  `ValidationError` / `ConflictError`.
- `reviseContentType(current, changes)` — increments `version`, resets status to `draft`, sorts
  fields by `position`, optionally updates `name`/`displayField`/`fields`.

## Entry aggregate & state machine

```ts
interface Entry {
  id: string;
  contentTypeApiId: string;
  status: EntryStatus;
  currentVersion: number; // latest saved draft snapshot
  publishedVersion: number | null; // snapshot served by Delivery (if any)
}

interface EntryVersion {
  // immutable point-in-time snapshot
  entryId: string;
  version: number;
  fields: EntryFields;
}
```

Status is **derived**, never set directly, by `deriveStatus(currentVersion, publishedVersion, archived)`:

| Condition                             | Status                                              |
| ------------------------------------- | --------------------------------------------------- |
| `archived === true`                   | `archived`                                          |
| `publishedVersion === null`           | `draft`                                             |
| `currentVersion > publishedVersion`   | `changed` (published, with newer unpublished edits) |
| `currentVersion === publishedVersion` | `published`                                         |

Transitions (pure functions; each throws `InvalidStateError` when its precondition fails):

| Function                   | Effect                                                      | Precondition        |
| -------------------------- | ----------------------------------------------------------- | ------------------- |
| `saveDraft(entry, fields)` | `currentVersion += 1`, new `EntryVersion`, re-derive status | not `archived`      |
| `publish(entry)`           | `publishedVersion = currentVersion`, status `published`     | not `archived`      |
| `unpublish(entry)`         | `publishedVersion = null`, status `draft`                   | currently published |
| `archive(entry)`           | status `archived`                                           | —                   |

`currentVersion`/`publishedVersion` are pointers into the immutable version ledger; each
`saveDraft` appends a new version, and `publishedVersion` pins which one Delivery serves.

### The trash

`archive` moves an entry out of circulation and `restore` brings it back as a _draft_ — never
straight to published, since archiving requires an unpublished entry and re-publishing should be a
deliberate act rather than a side effect of undoing a delete. Application-side, `trashEntry`
unpublishes a live entry first so one editor intention stays one step, and `purgeEntry` is the only
operation that destroys an entry and its version history.

## Locales & fallback

```ts
interface LocaleConfig {
  defaultLocale: LocaleCode;
  locales: readonly LocaleCode[];
  fallbacks?: Record<LocaleCode, LocaleCode | null>; // locale → fallback (null = stop)
}
```

- `fallbackChain(config, requested)` — builds an ordered chain (most specific first) by following
  fallback pointers, guards against cycles, and always ends at `defaultLocale`. E.g. with
  `fallbacks = { "fr-CA": "fr", "fr": null }`, requesting `fr-CA` yields `["fr-CA", "fr", default]`.
- `resolveLocalizedValue(value, config, requested)` — walks the chain and returns the first
  defined value.
- `resolveFieldsForLocale(fields, config, requested)` — flattens an entry's fields to a single
  locale with fallback applied; used by Delivery/Preview when `?locale=` is given.

## Assets

```ts
interface Asset {
  id: string;
  status: 'draft' | 'published' | 'archived';
  file: AssetFile; // { url, fileName, contentType, size?, width?, height?, video? }
  title: LocalizedValue;
  description: LocalizedValue;
  metadata: AssetMetadata; // { altText, tags, focalPoint?, fields? }
  folderId?: string; // absent at the library root
  version?: number; // 1, then +1 per file replacement (absent reads as 1)
  r2Key?: string; // where the bytes live; absent for a hosted video
  contentHash?: string;
  createdAt?: string;
  createdBy?: string; // as the audit log names actors
  archivedAt?: string; // only while archived
  rights?: AssetRights; // { license?, credit?, expiresAt?, embargoUntil? }
}
```

An asset has one current file. `publishAsset` / `unpublishAsset` move between `draft` and
`published`; `archiveAsset(asset, at)` takes any non-archived asset to `archived`, and
`restoreAsset` brings an archived one back as a `draft` (each throws `InvalidStateError` on a bad
transition; an archived asset cannot be published). Bytes are uploaded directly to object storage
via a presigned URL — they never transit the API.

`assetKind(contentType)` derives an `AssetKind` (`image`, `video`, `audio`, `document`, `other`;
`ASSET_KINDS`) from the content type; the store keeps it in a column for filtering, so it is never
set by a client. Deleting an asset that entries still link to throws `AssetInUseError`
(`asset_in_use`), whose `usage` lists the links.

### Asset folders

```ts
interface AssetFolder {
  id: string;
  name: string; // 1..128 characters, no "/"; unique among siblings
  parentId?: string; // absent at the root
  path: string; // materialized path of ids, e.g. "/a/b/"
  createdAt: string;
  updatedAt: string;
}
```

Folders nest up to `MAX_ASSET_FOLDER_DEPTH` (16). `assetFolderPath(parent, id)` builds a path and
enforces the depth; `assertFolderMove` refuses a move into the folder itself or below it. Moving a
folder rewrites the path prefix of its whole subtree.

## References

```ts
interface ReferenceEdge {
  fromEntryId: string;
  fromField: string; // the link field's apiId
  toId: string; // target entry/asset id
  toType: 'Entry' | 'Asset';
}
```

`extractReferences(fromEntryId, fields, contentType)` is a pure function that walks an entry's
`Link`, `Array`-of-`Link`, `RichText` and `Component` fields across all locales — however deep the
components nest — and returns deduplicated edges attributed to the top-level field. On publish,
edges are materialized so the platform can:

- enforce **referential integrity** (publishing fails if a linked entry/asset doesn't exist),
- **resolve links** in Delivery (`?include=` embedding, including links inside `Component`
  values and rich-text reference nodes), and
- **invalidate caches** in reverse — when X changes, entries embedding X are refreshed.

## Webhooks

```ts
interface Webhook {
  id: string;
  url: string;
  topics: readonly (EventType | '*')[]; // subscribed event types; "*" = all
  secret: string; // HMAC signing secret
  active: boolean;
  headers?: Record<string, string>; // extra headers per delivery
}
```

`matchesTopic(webhook, type)` is true when the webhook is active and its topics include `*` or the
exact event type. Delivery attempts are recorded as `WebhookDelivery` rows for observability.

## Domain events

`DomainEvent` is a discriminated union appended to the transactional outbox. All share a
`BaseEvent` of `{ id, scope, occurredAt }`:

| `type`                      | Extra payload                                                              |
| --------------------------- | -------------------------------------------------------------------------- |
| `entry.published`           | `entryId`, `contentTypeApiId`, `version`, `fields`                         |
| `entry.unpublished`         | `entryId`, `contentTypeApiId`                                              |
| `entries.published_bulk`    | `jobId`, `chunkId`, `action`, `entryIds`                                   |
| `asset.published`           | `assetId`                                                                  |
| `asset.unpublished`         | `assetId`                                                                  |
| `asset.deleted`             | `assetId`, `r2Key?`, `videoId?`                                            |
| `content_type.published`    | `contentTypeApiId`, `version`                                              |
| `release.published`         | `releaseId`, `entryIds`                                                    |
| `environment_alias.changed` | `targetEnvironmentId` (null when removed); `scope.environmentId` is the alias name |
| `bulk.job_completed`        | `jobId`, `action`, `total`, `succeeded`, `failed`                          |
| `workflow_run.*`            | `runId`, `workflowId`, `version`, `entryId`, `contentTypeApiId`, `reason`  |
| `workflow.task_opened`, `workflow.webhook` | Editorial workflow tasks and inbound webhook nodes          |
| `search.reindex_requested`, `bulk.chunk_due`, `environment.purge_due` | Control messages for background jobs |

The full list and payloads are in [Events & webhooks](./events-and-webhooks.md#event-payloads).

`EventType = DomainEvent['type']`. The stable `id` makes dispatch idempotent.

## Platform aggregates

Beyond core content types and entries, the domain (and store) model several platform capabilities.
See [API reference](./api-reference.md) for HTTP shapes.

| Aggregate                         | Purpose                                                                   |
| --------------------------------- | ------------------------------------------------------------------------- |
| **Release**                       | Bundle entries/assets for coordinated publish (`release.published` event) |
| **ScheduledAction**               | Deferred publish/unpublish at a future time                               |
| **Comment / Task**                | Editorial collaboration on entries                                        |
| **WorkflowDefinition**            | Named steps with scope requirements; per-entry workflow state             |
| **ConceptScheme / Concept / Tag** | Controlled vocabulary and free-form tags                                  |
| **EntryMetadata**                 | Tags and concept associations on an entry                                 |
| **Role / ContentTypeGrant**       | Granular RBAC (see [Auth & RBAC](./auth-and-rbac.md))                     |
| **AiAction**                      | Configurable prompt templates runnable against entries                    |
| **Function**                      | User-defined HTTP endpoint invoked on domain events                       |
| **AppExtension**                  | iframe panel registration for the admin UI                                |
| **AgentRun**                      | Audit record for agent workflow executions                                |
| **AuditLogEntry**                 | Space-level change audit                                                  |
| **EnvironmentAlias**              | Map a path alias to a concrete environment id                             |

Asset `metadata` (alt text per locale, tags) lives on the asset aggregate as JSON.

## RBAC types

See [Auth & RBAC](./auth-and-rbac.md) for the full model. The domain owns: the `SCOPES` map,
`scopesForKind(kind)`, the `Principal` type, and the `authorize` / `inScope` decisions.

## Errors

All extend `DomainError` (`{ code, message, details? }`) and carry a stable, client-facing `code`:

| Class                              | `code`              | Meaning                                     |
| ---------------------------------- | ------------------- | ------------------------------------------- |
| `NotFoundError(resource, id)`      | `not_found`         | Resource missing                            |
| `ValidationError(issues)`          | `validation_failed` | Carries `issues: FieldIssue[]`              |
| `ConflictError(message, details?)` | `conflict`          | Uniqueness violation (e.g. duplicate apiId) |
| `InvalidStateError(message)`       | `invalid_state`     | Illegal state-machine transition            |
| `AssetInUseError(assetId, usage)`  | `asset_in_use`      | Entries still link to the asset (`usage`)   |
| `UnauthorizedError(message?)`      | `unauthorized`      | Invalid/missing credentials                 |
| `ForbiddenError(scope)`            | `forbidden`         | Missing the required scope                  |

The HTTP layer maps each `code` to a status code — see [API reference](./api-reference.md#error-handling).
