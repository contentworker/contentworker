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

A space id (`SPACE_ID_PATTERN`) is 1–64 ASCII letters, digits, `.`, `_` or `-`, starting with a
letter or digit. It is the first segment of the space's asset keys in the media bucket
(`<space>/<environment>/<assetId>/<file>`), which also holds archived version bodies, staged import
chunks, plugin bundles, dead letters and zip downloads under their own top-level prefixes. Those prefixes are
`RESERVED_SPACE_IDS` (`versions`, `imports`, `plugins`, `dlq`, `zips`): `createSpace` refuses each, in any
case, with a `ValidationError`, so deleting a space's files never reaches them.

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
| `Seo`       | Search engine metadata (see [SEO](#seo-and-the-sitemap)) | object of fixed shape     |
| `JSON`      | Arbitrary JSON                                      | object                         |
| `Link`      | Reference to an Entry or Asset                      | `{ id, linkType }`             |
| `Component` | A group of nested typed fields                      | object keyed by nested apiId   |
| `Array`     | List of `Symbol`, `Link` or `Component` (or blocks) | array                          |

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

### Blocks

A **blocks field** is an `Array` of `Component` whose `items` declares `variants` instead of
`fields` (never both): a page body assembled from a hero, then a rich-text section, then a call to
action, in whatever order the editor chooses. Each variant is `{ apiId, name, fields }`
(`ComponentVariant`, `packages/domain/src/content-type/field.ts`), and each stored element names its
variant and carries a stable key:

```json
{
  "_type": "hero",
  "_key": "0192f4a1-…",
  "heading": "Spring launch",
  "image": { "id": "…", "linkType": "Asset" }
}
```

`_`-prefixed keys cannot collide with a field apiId, which must start with a letter. A variant-less
repeater is unchanged: its elements carry neither key.

- **Definition rules** (`defineContentType` / `reviseContentType`): at least one variant, variant
  apiIds legal and unique within the field, each variant at least one field. A variant's fields
  obey the component rules above (no `localized`, `unique` or `Slug`) and count toward
  `MAX_COMPONENT_DEPTH`. Variants are refused on a single `Component`: one optional block slot is
  the same `Array` field with `validations.size.max: 1`. Content type fields are stored as JSON
  (`content_types.fields`), so blocks needed no migration.
- **`_key` is assigned on write.** `createEntry` and `updateEntry` fill a missing `_key` from
  `ctx.ids.newId()` (`assignBlockKeys`, however deep the blocks field sits) and keep the ones sent,
  so a block keeps its identity across edits and reorders. Validation does not require `_key`
  (an AI draft or an import dry-run is judged on content), but a present key must be a non-empty
  string used once in the field value: a duplicate is refused at `body[i]`.
- **Validation** looks up each element's variant by `_type`; a missing or unknown `_type` is one
  issue at `body[i]`, and the element is then checked as that variant's component (`body[i].heading`).
- **References, defaults and search** read each element with its own variant's fields, so links in
  a block produce edges (and `?include=` resolves them), nested defaults apply per variant, and
  text is indexed. `_type` and `_key` are left out of the embedded text.
- **Removing a variant** is refused with `409 conflict` while any entry still has a block of it
  (`updateContentType`, `removedVariants` / `removedVariantUses` in
  `packages/domain/src/content-type/blocks.ts`). It scans the type's current versions, the trash
  and the published snapshots in keyset pages of 100 by entry id, only when a variant is removed,
  and names each `location: variant` with the entries using it (`details.variantsInUse`). Adding a
  variant, or an optional field to one, is always allowed.
- **Removing a field**, at any depth, is refused the same way while any entry still holds a
  value for it (anything but absent or `null`): `removedFields` / `removedFieldUses` name each
  location (`seo.description`, `body[hero].image`) with its entries (`details.fieldsInUse`). One
  scan (`removedContentInUse` in `packages/application/src/content-types.ts`) serves both checks
  and the promotion risk check. There is no override, as for variants: clear the values, publish
  the entries whose published snapshot holds them, purge them from the trash, then remove it.

**GraphQL** gives a blocks field a union named like a component in that place (`LandingPageBody`)
with one object type per variant (`LandingPageBodyHero`), each exposing `_type`, `_key` and the
variant's fields; `resolveType` reads `_type`. An element whose `_type` names no variant is left
out of the list rather than failing the query. **SDK codegen** emits a discriminated union on
`_type`: `({ _type: 'hero'; _key: string; heading: string } | …)[]`.

One surface still treats a component as opaque, deliberately:

- **Query pushdown** cannot filter on a nested value. Filter on a top-level field, or model the
  thing you filter by as one.

The admin's entry editor renders a component as a group of real inputs, and a repeater as a list
with add / remove / reorder. Validation issues land on the nested input that caused them, and the
error summary reads paths as directions ("Cards 3 › Title", not `cards[2].title`). The content-type
dialog does not offer to _create_ a component — it has no nested-field authoring, and a component
with no fields is refused by the domain — so component shapes are authored through the API or MCP.
Existing ones load, edit and round-trip there unchanged. Blocks are the exception: the dialog's
**Blocks** type authors the variants (a name, an API ID and a flat list of fields each), and the
entry editor adds a block from an "Add block" menu of variants (a plain "Add …" button when there
is one), reorders and removes blocks, and names them by type in the error summary
("Body 2 (Hero) › Heading").

### Rich text

A `RichText` value is a document tree (`packages/domain/src/rich-text/rich-text.ts`): a
`document` root whose `content` is block and inline nodes. Text lives in `text` nodes carrying
`marks`; reference nodes carry a `data.target` link so the reference graph can be extracted from
rich text exactly as from `Link` fields (`extractRichTextTargets`). `richTextToPlainText`
flattens a document for search/embedding; a table reads as one block, a line per row with its
cells separated by `|`, and an `embed` as `Title (url)` (its URL alone when it has no title).

The node vocabulary (`RICH_TEXT_BLOCK_NODE_TYPES`, `RICH_TEXT_INLINE_NODE_TYPES`):

- **Blocks** — `paragraph`, `heading-1`…`heading-6`, `blockquote`, `unordered-list`,
  `ordered-list`, `list-item`, `code-block` (optional `data.language`), `hr`.
- **Tables** — `table` → `table-row` → `table-header-cell` | `table-cell` → blocks (normally a
  `paragraph`), each with `data: {}`. A merged cell carries `data.colspan` / `data.rowspan`
  (integers above 1); column widths are not stored.
- **Inline** — `text` (with `marks`), `hard-break`, `hyperlink` (`data.uri`, text children).
- **References** (`REFERENCE_NODE_TYPES`, each with `data.target: { id, linkType }`) —
  `embedded-entry-block`, `embedded-asset-block`, `embedded-entry-inline`, `entry-hyperlink`,
  `asset-hyperlink`.
- **External media** — `embed`, a block with no `content` whose `data` is structured metadata
  (`EmbedData`, `packages/domain/src/rich-text/embed.ts`): `url` (an https page on an allowed
  provider) and `provider` are required; `kind` (`video` | `post` | `audio` | `other`), `title`,
  `authorName`, `thumbnail: { url, width?, height? }`, `width`, `height` and `aspectRatio` are
  optional. The provider's oEmbed `html` is never stored or delivered: channels build their own
  player or link card from the data.
- **Marks** — `bold`, `italic`, `underline`, `code`, `strikethrough`.

`validateRichText` runs on every write (API, MCP, editor, import, AI) and refuses:

- a `nodeType` outside the vocabulary, anywhere in the tree — delivery clients switch on
  `nodeType`, so a type they cannot know is refused rather than delivered;
- a `text` node without a string `value`, a reference node without a well-formed `data.target`,
  and a node whose `data` is not an object or whose `content` is not an array;
- an `embed` whose `data.url` is not https or not on an allowed provider (`EMBED_PROVIDERS`:
  YouTube, Vimeo, X, Bluesky, Spotify, SoundCloud, and Mastodon matched by URL shape on any
  instance), whose `data.provider` is not the one that URL belongs to, whose metadata is
  malformed, that holds `content`, or whose `data` carries any other key (an `html` snippet
  included); Mastodon accepts any public domain with a post's URL shape (never a named provider's
  host), so a `mastodon` embed vouches for its shape, not its origin: channels should frame only
  instances they trust;
- a `hyperlink` whose `data.uri` is missing or unsafe. `safeLinkUri` allows `http`, `https`,
  `mailto` and `tel`, plus relative and fragment URIs; it reads the scheme the way a browser does
  (ignoring embedded whitespace and control characters) and refuses an undecoded entity before
  the path (`javascript&colon;`). The HTML import applies the same rule, keeping an unsafe link's
  text and dropping its target;
- a document over `MAX_RICH_TEXT_BYTES` (512 KiB serialized, twice the `JSON` field cap) or
  nested more than `MAX_RICH_TEXT_DEPTH` (64) nodes below the root;
- table structure: a table must hold at least one `table-row`, and only rows; a row at least
  one cell, and only cells; a cell at least one block, and no bare inline nodes (wrap text in a
  `paragraph`). Rows and cells outside their parent are refused, as is a table over
  `MAX_TABLE_ROWS` (500) rows or a row over `MAX_TABLE_COLUMNS` (50) cells. Spans must be
  integers within those bounds. Tables may nest inside a cell.

Beyond tables, which node may hold which (for example blocks inside inline nodes) is not yet
constrained. The admin editor carries a table it can't draw as a grid (`isWellFormedTable`)
through unchanged.

`resolveEmbed` (`POST …/embeds/resolve`, MCP `embed_resolve`, `content:write`) fills an embed's
metadata: it matches the URL to its provider, screens the provider's oEmbed endpoint with
`assertSafeExternalUrl` (a Mastodon URL names its own host), fetches it through the
`RemoteFetcher` port (64 KiB, 5 s, no redirects) and keeps only the `EmbedData` fields
(`embedFromOEmbed`). A provider that fails to answer gives `resolved: false` and an embed of the
URL, provider and kind alone, which is valid to store. The admin editor calls it when a provider
URL is pasted; imports do not (`richTextFromHtml` makes the bare node), so an imported embed has
no title until someone resolves it.

`richTextFromHtml` reads a provider's player `<iframe>` (YouTube, Vimeo, Spotify, SoundCloud,
Bluesky and Mastodon players map back to the page URL), a post `<blockquote>`
(`twitter-tweet`, `bluesky-embed`, `mastodon-embed`), a WordPress `wp-block-embed` figure (its
caption stays as a paragraph after it), and a provider URL alone on its line or in `[embed]…[/embed]`
(WordPress's classic editor) as an `embed` node. A player inside a paragraph is lifted out, splitting
the paragraph. Media from any other host stays a link to its source, as before.

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
    variants?: readonly { apiId: string; name: string; fields: readonly FieldDefinition[] }[]; // blocks, instead of fields
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
  urlPattern?: string; // where its entries live on the site, e.g. /blog/{slug}
  version: number; // bumped on each revision
  status: 'draft' | 'published';
}
```

- `defineContentType(draft)` — validates the `apiId` and field set (no duplicate apiIds,
  `displayField` must exist), returns a `ContentType` at version 1, status `draft`. Throws
  `ValidationError` / `ConflictError`.
- `reviseContentType(current, changes)` — increments `version`, resets status to `draft`, sorts
  fields by `position`, optionally updates `name`/`displayField`/`fields`/`urlPattern` (`null` or
  `''` clears it).
- `checkUrlPattern(pattern, fields)` — a pattern is a path starting with `/` (at most
  `MAX_URL_PATTERN_LENGTH`, 512; no space, `?`, `#`, `[`, `]` or `\`) whose `{…}` placeholders are
  `{id}`, `{locale}` or the apiId of one of the type's own `Slug` fields; anything else is a
  `ValidationError` on `urlPattern`. A revision is checked against its revised fields, so removing a
  slug a kept pattern names is refused. `urlPath(pattern, entry, locale)` builds an entry's path (or
  `null` when a named slug has no value in that locale), which is also how a preview or site link
  can be built. A pattern is what makes a slug change write a [redirect](#redirects).

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

| Function                   | Effect                                                      | Precondition         |
| -------------------------- | ----------------------------------------------------------- | -------------------- |
| `saveDraft(entry, fields)` | `currentVersion += 1`, new `EntryVersion`, re-derive status | not `archived`       |
| `publish(entry)`           | `publishedVersion = currentVersion`, status `published`     | not `archived`       |
| `unpublish(entry)`         | `publishedVersion = null`, status `draft`                   | currently published  |
| `archive(entry)`           | status `archived`                                           | unpublished          |
| `restore(entry)`           | status `draft` (re-derived with no published version)       | currently `archived` |

`currentVersion`/`publishedVersion` are pointers into the immutable version ledger; each
`saveDraft` appends a new version, and `publishedVersion` pins which one Delivery serves.

### Comparing versions

`diffEntryFields(before, after, contentType?)` (`packages/domain/src/entry/entry-diff.ts`) is the
readable diff between two versions' fields. It returns one `FieldDiff` per field either version
holds, in the content type's order (fields the type no longer declares follow, by name), each
labelled with the field's `name` and `fieldType` and split per locale into `LocaleDiff`s whose
`kind` is `added`, `removed`, `changed` or `unchanged`. A changed locale carries a typed `detail`
(`ValueDiff`) picked by the field's type:

| Field type                                                 | `detail.type` | What it holds                                                                                           |
| ---------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------- |
| `Symbol`, `Slug`, `Text`                                   | `text`        | `segments`: a word-level diff (`TextSegment`: `added`, `removed`, `unchanged` runs)                     |
| `RichText`                                                 | `richText`    | `blocks`: one `RichTextBlockDiff` per paragraph, heading, list item, table row or embed, with its words |
| `Link`                                                     | `link`        | the entry or asset id before and after                                                                  |
| `Component`                                                | `component`   | the nested fields, each a `NestedFieldDiff` with its own `detail`                                       |
| `Array`                                                    | `list`        | the elements (`ListItemDiff`), with their positions and a `moved` flag                                  |
| `Integer`, `Number`, `Boolean`, `Date`, `Location`, `JSON` | `value`       | the two values                                                                                          |

List elements are matched by identity where they have one (a block's `_key`, under its `_type`; a
link's target; a tag's text) and by content otherwise; a matched element outside the longest run
that kept its order is `moved`. Rich text is read as its blocks (`diffRichText` in
`rich-text/rich-text-diff.ts`): blocks are lined up by content, an unmatched block of the same type
in the same stretch is the same block edited (with `beforeNodeType` when it changed type, and
`formattingChanged` when only its marks or links did), and embedded entries and assets carry their
`target`. The word diff (`diffText`, Myers' algorithm in `entry/sequence-diff.ts`) stops looking for
the shortest script past `MAX_DIFF_EDITS` edits and reports the text replaced. Every part is typed
data, never markup: the admin, an API client and an agent each render it for themselves.

### The trash

`archive` moves an entry out of circulation and `restore` brings it back as a _draft_, never
straight to published: archiving requires an unpublished entry, and re-publishing should be a
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
  file: AssetFile; // { url, fileName, contentType, size?, width?, height?, placeholder?, video? }
  title: LocalizedValue;
  description: LocalizedValue;
  metadata: AssetMetadata; // { altText: LocalizedValue, tags: string[], focalPoint?: { x, y }, fields? }
  folderId?: string; // absent at the library root
  version?: number; // 1, then +1 per file replacement (absent reads as 1)
  r2Key?: string; // where the bytes live; absent for a hosted video
  contentHash?: string; // SHA-256 of the bytes (hex), set by ingest
  createdAt?: string;
  createdBy?: string; // as the audit log names actors
  archivedAt?: string; // only while archived
  rights?: AssetRights; // { license?, credit?, expiresAt?, embargoUntil? }
  ingestStatus?: 'pending' | 'processing' | 'ready' | 'error'; // absent: never ingested
  ingestError?: string;
  duplicateOf?: string; // the oldest other asset in the scope with the same contentHash
  aiSuggestions?: { altText?: string[]; tags?: string[] }; // filled by a model, not yet saved
}
```

Ingest (migration `0011_asset_ingest`; see
[Architecture](./architecture.md#asset-ingest-and-search)) owns `contentHash`, `ingestStatus`,
`ingestError` and `duplicateOf`: it writes them through `AssetRepo.recordIngest`, and `save`
leaves them as they are. `aiSuggestions` marks the alt text locales and tag ids ingest filled
from a model; `clearAcceptedSuggestions` drops a field's mark when a metadata patch carries it,
so saving the field makes it the editor's.

`file.placeholder` (`AssetPlaceholder`: `thumbhash`, base64; `dominantColor`, `#rrggbb`) is
measured by ingest's `placeholder` step for raster types the Images binding decodes, no larger than
20 MiB. Like `width` and `height` it lives in the `file` JSON (no column), is written by
`recordIngest` and copied into the published snapshot by `finish`. It is data a client renders,
never a URL or markup.

An upload whose presigned PUT never landed leaves a draft with no `ingestStatus` and no `size`;
`sweepAbandonedUploads` (hourly, see [Architecture](./architecture.md#asset-ingest-and-search))
removes it a day later, or marks it `error` ("The upload never completed") when an entry links it.

`file.video` is present on hosted video assets (provider, status, playback URLs). `metadata` holds
the editorial "aspects": per-locale alt text, taxonomy tag ids, a focal point (0..1 on each axis,
so transforms crop toward it) and free-form `fields`; `applyAssetMetadata` merges a partial patch
and validates the focal point.

An asset has one current file; `version` counts its files. Replacing or restoring one keeps the
previous file in `asset_versions` (`AssetVersionRecord`: `version`, `file`, `r2Key`,
`contentHash`, `replacedAt`, `replacedBy`), and `listAssetVersions` reads them as `AssetVersion`
(`{ version, file, r2Key?, contentHash?, createdAt?, createdBy?, current, published,
restoredFrom? }`, newest first; `createdAt`/`createdBy` are when and by whom the file became the
asset's, `published` marks the one the snapshot delivers). A restore is a new version pointing at
the old bytes.

`AssetRights` carry `license` and `credit` (delivered with the asset) and `expiresAt` and
`embargoUntil` (ISO-8601). `validateAssetRights` trims text (at most `MAX_ASSET_RIGHTS_TEXT`,
500), requires dates with a zone and an expiry after the embargo;
`assertRightsAllowDelivery(id, rights, now)` throws `AssetRightsError` (`asset_embargoed` or
`asset_expired`, with the deciding instant in `details`), which publishing checks;
`rightsExpireSoon` backs the admin's "Expires soon" status. The published snapshot's expiry is also
a column (`asset_published.expires_at`, migration `0015_asset_expiry`) for the expiry sweep.

`publishAsset` / `unpublishAsset` move between `draft` and `published`; `archiveAsset(asset, at)`
takes any non-archived asset to `archived`, and `restoreAsset` brings an archived one back as a
`draft` (each throws `InvalidStateError` on a bad transition; an archived asset cannot be
published, nor one under embargo or past its expiry). File bytes are not part of the aggregate: `createAsset` returns a signed upload URL
and the bytes go to the blob store (see [Architecture](./architecture.md#assets-r2-images-stream-and-the-media-worker)).

`assetKind(contentType)` derives an `AssetKind` (`image`, `video`, `audio`, `document`, `other`;
`ASSET_KINDS`) from the content type; the store keeps it in a column for filtering, so it is never
set by a client. Deleting an asset that entries still link to throws `AssetInUseError`
(`asset_in_use`), whose `usage` lists the links (`AssetUsage`: the edge plus the entry's
`contentTypeApiId` and `entryTitle`, at most `MAX_ASSET_USAGE_SHOWN`, 50) and `total` counts them.

### Asset collections, share links and zip jobs

`packages/domain/src/asset/collection.ts`. An `AssetCollection` is a named (`name` 1 to 128 characters,
`assetCollectionName`), ordered set of assets of one environment, with an optional `description`
(at most `MAX_COLLECTION_DESCRIPTION`, 1,000) and an `itemCount`. Membership is many-to-many
(`AssetCollectionItem`: `assetId`, `position`), unlike a folder. A collection holds at most
`MAX_COLLECTION_ITEMS` (1,000) assets, and one change names at most `MAX_COLLECTION_CHANGE` (500)
ids (`collectionChangeIds`). Deleting an asset removes its memberships in the same unit.

An `AssetShareLink` (`id`, `targetType` `asset | collection`, `targetId`, `expiresAt`,
`allowDownload`, `hasPassword`, `createdAt`, `createdBy?`, `revokedAt?`, `url?`) is an expiring,
revocable link; the store keeps `StoredAssetShareLink`, with the PBKDF2 `passwordHash` only the
media origin reads. `shareLinkExpiry` requires an expiry `MIN_SHARE_LINK_SECONDS` (5 minutes) to
`MAX_SHARE_LINK_SECONDS` (90 days) out; `shareLinkPassword` requires `MIN_SHARE_PASSWORD` (8) to
`MAX_SHARE_PASSWORD` (256) characters. `shareLinkState(link, nowMs)` is `active`, `expired` or
`revoked` (revoking is permanent). `parseShareLinkPath` reads `/s/<space>/<env>/<link>/<token>`,
`…/unlock` or `…/f/<assetId>/<fileName>`; the token is 22 base64url characters and is checked by the
caller before any lookup.

An `AssetZipJob` (`id`, `status` `pending | running | completed | failed`, `source` (a selection of
`assetIds` or a `collectionId`), `fileName`, `fileCount?`, `totalBytes?`, `partsDone`, `partCount?`,
`error?`, `createdAt`, `completedAt?`, `expiresAt`, and a read-time `downloadUrl?`) describes a zip
being built. A job covers at most `MAX_ZIP_ASSETS` (1,000) assets and lives
`ZIP_RETENTION_SECONDS` (a day); `zipFileName` makes the archive's name safe. The events are
`asset_collection.changed`, `asset_share.created`, `asset_share.revoked` and `asset_zip.requested`
([Events](./events-and-webhooks.md#event-payloads)); how it all runs is in
[Architecture](./architecture.md#collections-share-links-multipart-uploads-and-zips).

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

### Renditions and the delivered asset

`packages/domain/src/asset/delivered.ts`. A **rendition** is a named image preset of a space
(`AssetRendition`: `name`, `width?`, `height?`, `fit?` (`RENDITION_FITS`), `format?`
(`RENDITION_FORMATS`, `auto` negotiates AVIF/WebP), `quality?`, `createdAt`, `updatedAt`).
`assetRenditionName` allows 1–40 lowercase letters, digits and dashes (the name is its URL
segment); `assetRenditionSpec` requires a width, height or format; a space has at most
`MAX_ASSET_RENDITIONS` (20). Presets belong to the space, not an environment.

An `AssetVariant` is the original (`o`), a width from `ASSET_WIDTH_LADDER` (320, 640, 960, 1280,
1920, 2560; `w<width>`) or a rendition (`r-<name>`). `assetMediaPath` / `parseAssetMediaPath`
build and read `/<space>/<env>/<assetId>/v<n>/<token>/<variant>/<fileName>`; a width off the
ladder is no variant, and the parser checks only the token's shape (22 base64url characters): the
`MediaPathSigner` port makes and verifies it, outside the domain, so the projector stays pure. `isTransformableImage` says which types have variants (JPEG, PNG, WebP, AVIF, GIF; not
SVG). `variantForTransform` maps a legacy `?w=` to the next step up (the largest past it).

`deliveredAsset(asset, { urlFor?, renditions, locale? })` is the one projector for Delivery
(REST, embeds, GraphQL) and Preview. It is pure: the caller supplies the URL builder
(`publicAssetUrls(origin, scope, { id, version, fileName })` for published files, width steps with
`?fm=auto`; signed URLs for Preview), the space's rendition names and the locale settings. The
result, `DeliveredAsset`, is `{ id, title, description, altText, focalPoint, contentType, size,
width, height, kind, url, renditions, srcset, placeholder, video?, rights?, file }`; `placeholder`
is `file.placeholder ?? null` (always `null` for a hosted video); text is flattened with
`resolveLocalizedValue` when a locale is given, a hosted video's `url` is its HLS manifest and it
has no variants, and the srcset stops at the image's own width.

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

## Redirects

`packages/domain/src/redirect/redirect.ts`. contentworker serves no site, so a redirect is
**delivery data**: Delivery hands the set (or one path's match) to the front end, or an edge Worker
in front of it, that answers the request. A redirect belongs to a space and environment:

```ts
interface Redirect {
  id: string;
  source: string; // normalized path: exact, or a pattern
  destination: string; // a path (optional query, fragment) or an absolute https:// URL
  status: 301 | 302 | 307 | 308; // default 301 (REDIRECT_STATUSES)
  locale?: string; // applies only to requests in this locale
  enabled: boolean;
  note?: string; // at most MAX_REDIRECT_NOTE_LENGTH (500)
  origin: 'manual' | 'import' | 'slug';
  entryId?: string; // the entry whose slug change made it (origin 'slug')
  createdAt: string;
  updatedAt: string;
}
```

- **Source.** A path starting with `/`, no query, fragment, `.`/`..` segment or whitespace;
  percent-encoded as a request's path is, repeated and trailing slashes removed
  (`normalizeRedirectSource`). It is exact (`/old-page`) or a pattern of whole segments:
  `[param]` captures one segment, a trailing `[...splat]` one or more.
- **Destination.** A path starting with `/` or an absolute `https://` URL without credentials
  (another scheme, `//host` and a relative path are refused). It may insert the source's captures by
  the same names, with the same kind (`normalizeRedirectDestination`).
- **Limits.** `MAX_REDIRECTS` (10,000) per environment, since Delivery serves the set in one
  response; `MAX_REDIRECT_IMPORT` (1,000) rows per import; `MAX_REDIRECT_LENGTH` (2048) characters
  per source or destination. One redirect per source per locale (`redirectKey`).
- **Matching** (`createRedirectMatcher`, `matchRedirect`). Disabled redirects never match. An exact
  source beats any pattern; between patterns the more specific wins segment by segment (a fixed
  segment, then `[param]`, then `[...splat]`); a tie goes to the locale's own redirect, then the
  source, then the id. A locale's redirects apply only to requests in that locale; a request
  without one meets only the all-locale redirects. The request's query string is appended when the
  destination has none.
- **Set analysis** (`analyzeRedirects`): `duplicates`, `loops` and `chains`. Every write checks the
  set it would leave (`redirectSetError`) and refuses a loop or a duplicate source with a
  `ValidationError` (`422`). A chain (a destination that is itself redirected) is allowed and
  reported; `collapseRedirectChains` points each chain's first redirect at where it ends.
- **Slug changes.** `slugMoves` compares the published fields a publish replaces with the new ones
  for every slug the type's `urlPattern` names; `planSlugRedirects` turns the moves into writes
  (see [Slug-change redirects](#slug-change-redirects)).
- **CSV.** `redirectsFromCsv` / `redirectsToCsv` read and write a header row of
  `REDIRECT_CSV_COLUMNS` (`source`, `destination`, `status`, `locale`, `enabled`, `note`; in any
  order on import, unknown columns ignored, `source` and `destination` required).

The application use-cases (`packages/application/src/redirects.ts`) check the whole set on every
write and commit it with the set's revision (`redirect_sets`) as a compare-and-set and a
`redirects.changed` event in one unit; a writer that loses the race reads the set again and checks
once more (three attempts, then the `TransactionConflictError` surfaces). A publish's slug redirects advance the revision unconditionally, so a publish never fails over a concurrent redirect edit; that edit, having read the set before, checks it again.

### Slug-change redirects

When a type has a `urlPattern` and a publish changes a slug it names on an entry that was already
published, `publishEntryTx` / `publishEntriesTx` (so single publish, releases and bulk publish) write
the redirect in the same unit of work as the publish; there is no event of its own, because the
`entry.published` already purges Delivery. The old path gets a `301` (`origin: 'slug'`, `entryId`)
to the new one, taking over a redirect already on that source; redirects that pointed at the old
path are repointed at the new one, so no chain forms; a redirect away from the new path is removed,
so no loop forms. A localized slug writes a per-locale redirect. Nothing is written when the type
has no pattern, a first publish, or when the set is at `MAX_REDIRECTS`.

## SEO and the sitemap

An entry's search engine metadata is a field of type `Seo` (`packages/domain/src/seo/seo.ts`): a
component whose shape is fixed, `SEO_FIELDS`, so the sitemap, the admin and every client find a
page's metadata without reading the model. Being a field, it is versioned with the draft, published
with the entry, localized when the field is, and delivered with the entry's other fields. A content
type opts in by declaring one.

| Part           | Type                     | Rule                                                                                 |
| -------------- | ------------------------ | ------------------------------------------------------------------------------------ |
| `title`        | `Symbol`                 | at most `MAX_SEO_TITLE_LENGTH` (200)                                                 |
| `description`  | `Text`                   | at most `MAX_SEO_DESCRIPTION_LENGTH` (500)                                           |
| `canonicalUrl` | `Symbol`                 | a site path (`/…`, not `//…`) or an absolute `http(s)` URL (`canonicalUrlIssue`); at most 2,048 |
| `noindex`      | `Boolean`                | keeps the page out of search results and the sitemap                                 |
| `ogImage`      | `Link` (`Asset`)         | the social image; a reference edge like any link (integrity, purges)                 |

A type declares at most one `Seo` field, at the top level only (never inside a component), and it
cannot be `unique` or carry nested `fields`. Validation, reference extraction, GraphQL (an object
type such as `ArticleSeo`) and codegen read it as a component of `SEO_FIELDS`. `setEntrySeo`
(`packages/application/src/seo.ts`) changes one locale of it (a part left out keeps its value,
`null` clears it) and saves a new draft through the same path as `updateEntry`; it is refused
(`422`) for a type with no `Seo` field, and for a non-default locale on an unlocalized one.

**The sitemap** lists published entries of every published content type with a `urlPattern`.
`entrySitemapUrls` gives each entry its URLs: one per locale of the space when the pattern names
`{locale}` or a localized slug, else the default locale only. Each locale reads the named slugs and
the `Seo` value through the fallback chain, as Delivery does; a path two locales share is listed
once, under the first. A locale is left out when its `Seo` value says `noindex`, or names a
canonical URL whose path is not the entry's own. Paths compare in one spelling
(`normalizeSitePath`: each segment percent-encoded, one trailing slash dropped). A path canonical is
a site path, like the pattern's; an absolute one, given the site (`SiteLocation`: origin and path
prefix, from `base`), is elsewhere on another origin or outside the prefix, and has the prefix taken
off before comparing. The store reads only `sitemapFieldsOf` (the pattern's slugs and the `Seo` field) from
each `entry_published` body, picked out in SQL, by entry id. `lastmod` is the live version's
`publishedAt`. A sitemap file holds `sitemapPageSize(locales)` entries (at most 5,000, and few
enough that one URL per locale stays under `SITEMAP_MAX_URLS`, 50,000); past one file, the XML
sitemap is an index of pages, each named by a token for its range of entry ids (`<first>,<next
page's first>`, the first page open at its start and the last at its end), so an entry published
after the index was read still lands in a page. A key with content grants sees only the types it may
read, and never a type whose pattern names a field it may not read; a type whose `Seo` field it may
not read is listed as if it had none (no `noindex` or canonical exclusions, which would reveal the
field's values).

## Webhooks

```ts
interface Webhook {
  id: string;
  url: string;
  topics: readonly (EventType | '*')[]; // subscribed event types; "*" = all
  secret: string; // HMAC signing secret
  active: boolean;
  headers?: Record<string, string>; // extra headers per delivery
  environmentId: string | null; // the one environment it hears; null = every environment
}
```

`matchesTopic(webhook, type)` is true when the webhook is active and its topics include `*` or the
exact event type. `coversEnvironment(webhook, environmentId)` is true when the webhook is
space-wide (`environmentId: null`) or scoped to that environment; dispatch and every webhook read
under a scope apply it. Delivery attempts are recorded as `WebhookDelivery` rows for observability.

## Domain events

`DomainEvent` (`packages/domain/src/events.ts`) is a discriminated union appended to the
transactional outbox. All share a `BaseEvent` of `{ id, scope, occurredAt }`. The types are
`entry.published`, `entry.unpublished`, `entries.published_bulk`, `asset.published`,
`asset.unpublished`, `asset.deleted`, `asset.ingested`, `asset.file_replaced`, `asset.rights_changed`, `asset.expired`, `content_type.published`, `release.published`, `redirects.changed`, `environment_alias.changed`,
`environment.deleted`, `promotion.awaiting_approval`, `environment.promoted`, `bulk.job_completed`,
the `workflow_run.*` end states,
`workflow.task_opened` and `workflow.webhook`, plus control messages for background work
(`search.reindex_requested`, `bulk.chunk_due`, `environment.purge_due`). Every type and its payload
is in [Events & webhooks](./events-and-webhooks.md#event-payloads).

`EventType = DomainEvent['type']`. The stable `id` makes dispatch idempotent.

## Platform aggregates

Beyond core content types and entries, the domain (and store) model several platform capabilities.
See [API reference](./api-reference.md) for HTTP shapes.

| Aggregate                                     | Purpose                                                                                                                              |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **Release**                                   | Bundle entries/assets for coordinated publish (`release.published` event)                                                            |
| **ScheduledAction**                           | Deferred publish/unpublish at a future time                                                                                          |
| **Comment / Task**                            | Editorial collaboration on entries                                                                                                   |
| **WorkflowGraphDefinition / WorkflowVersion** | An editable workflow graph (the draft) and its immutable versions; the latest's `gatesPublish` lets only its runs publish its types. |
| **WorkflowRun / WorkflowTask**                | A durable run pinned to one version, and the approvals, event waits and agent reviews it opens                                       |
| **WorkflowDefinition** (legacy)               | Ordered `steps`, each gated by a scope; per-entry `EntryWorkflowState`. Kept for existing rows; `legacyStepsToGraph` converts it     |
| **ConceptScheme / Concept / Tag**             | Controlled vocabulary and free-form tags, each term with a slug, description and localized labels (see [Taxonomy](#taxonomy))        |
| **EntryMetadata**                             | Tags and concept associations on an entry                                                                                            |
| **Role / ContentTypeGrant**                   | Granular RBAC (see [Auth & RBAC](./auth-and-rbac.md))                                                                                |
| **AiAction**                                  | Configurable prompt templates runnable against entries                                                                               |
| **Function**                                  | User-defined HTTP endpoint invoked on domain events                                                                                  |
| **AppExtension**                              | iframe panel registration for the admin UI                                                                                           |
| **AgentRun**                                  | Audit record for agent workflow executions                                                                                           |
| **AuditLogEntry**                             | Space-level change audit                                                                                                             |
| **EnvironmentAlias**                          | Map a path alias to a concrete environment id                                                                                        |
| **Plugin** (`InstalledPlugin`)                | A sandboxed write-path plugin: manifest, checksum, approved capabilities (see [Plugins](./plugins.md))                               |
| **PluginSettings**                            | An operator's values for the settings a plugin's manifest declares; secret ones sealed at rest, never returned by a read API         |
| **BulkJob**                                   | A durable bulk publish, unpublish or import: N items in claimable chunks, with a report                                              |
| **AgentSchedule**                             | A recurring agent job: workflow, UTC cron, content-type filter, `autoApply`                                                          |
| **AgentReview**                               | A pending agent proposal a human approves or rejects                                                                                 |
| **SpaceMember**                               | A person on a space's team: email, linked SSO subject, role, `disabled`                                                              |
| **PreviewToken**                              | An expiring, entry-scoped token behind a shareable preview link (stored hashed)                                                      |
| **OAuthClient / OAuth grant**                 | A dynamically registered client (not space-scoped) and the code, device and refresh grants a person approves                         |

### Taxonomy

`packages/domain/src/taxonomy/taxonomy.ts`. A `ConceptScheme` is a vocabulary; a `Concept` belongs
to one and may nest under a `broaderId` (cycles refused); a `Tag` is flat. Both kinds of term carry:

- **`slug`**: normalized like a Slug field (`normalizeSlug`), unique among the environment's tags
  or within the concept's scheme (unique indexes in D1). Made from the label when none is given
  (`termSlug`), numbered past the taken ones (`uniqueTermSlug`: `news`, `news-2`). A slug asked
  for that another term holds is a `ConflictError`. It never follows the label: a rename keeps it.
- **`description`**: plain text or null.
- **`labels`**: labels in the space's other locales. The term's own label (`Tag.name`,
  `Concept.prefLabel`) is the default locale's, so nothing that reads the label changed.
  `resolveTermLabel` walks the space's fallback chain to it.

`EntryMetadata` (an entry's tag and concept ids) is copied into the published snapshot. **Usage**
(`TermUsage`: per term and content type, how many published entries carry it) counts snapshots
only: a draft's terms count once it is published and stop counting when it is unpublished or
trashed. The store keeps it as it writes snapshots (`TaxonomyRepo.listUsage`, `recountUsage`; see
[Consistency](./consistency.md#d1-limits-as-design-inputs)); `summarizeUsage` sums it per term,
leaving out the content types a key may not read. Every term change emits `taxonomy.changed`.


## RBAC types

See [Auth & RBAC](./auth-and-rbac.md) for the full model. The domain owns: the `SCOPES` map,
`scopesForKind(kind)`, the `Principal` type, and the `authorize` / `inScope` decisions.

## Errors

All extend `DomainError` (`{ code, message, details? }`) and carry a stable, client-facing `code`:

| Class                                 | `code`              | HTTP | Meaning                                                          |
| ------------------------------------- | ------------------- | ---- | ---------------------------------------------------------------- |
| `NotFoundError(resource, id)`         | `not_found`         | 404  | Resource missing                                                 |
| `ValidationError(issues)`             | `validation_failed` | 422  | Carries `issues: FieldIssue[]`                                   |
| `ConflictError(message, details?)`    | `conflict`          | 409  | Uniqueness or identity violation (e.g. duplicate apiId); `details` on the wire |
| `TransactionConflictError` (ports)    | `conflict`          | 409  | A compare-and-set lost inside a unit of work; nothing committed  |
| `LastAdminError`                      | `last_admin`        | 409  | Would leave the space with no active administrator               |
| `PublishGatedError(entries)`          | `publish_gated`     | 409  | A publish of an entry a gated workflow covers, outside its runs  |
| `AssetInUseError(assetId, usage)`     | `asset_in_use`      | 409  | Entries still link to the asset (`usage`, `total`)               |
| `InvalidStateError(message)`          | `invalid_state`     | 400  | Illegal state-machine transition                                 |
| `QueryTooBroadError(scanLimit)`       | `query_too_broad`   | 400  | A field query matched more candidates than the store evaluates   |
| `UnauthorizedError(message?)`         | `unauthorized`      | 401  | Invalid/missing credentials                                      |
| `ForbiddenError(scope)`               | `forbidden`         | 403  | Missing the required scope                                       |
| `HookRejectedError(hook, reason)`     | `hook_rejected`     | 422  | A write-path hook refused the operation                          |
| `RateLimitedError(message, retry?)`   | `rate_limited`      | 429  | A per-space rate or budget ceiling was exceeded                  |
| `NotConfiguredError(capability, msg)` | `not_configured`    | 501  | The deployment has not bound the capability the request needs    |
| `SecretUnreadableError(context)`      | `secret_unreadable` | 500  | A stored secret no configured key opens (never treated as unset) |

`OAuthError` (`oauth_<error>`) carries its own wire code and status for the OAuth endpoints, and
`PluginCapabilityDeniedError` (`capability_denied`) refuses a plugin call outside its grant.

`toHttpError` (`packages/http/src/api/http.ts`) does the mapping above, and the response body is in the [API reference](./api-reference.md#error-handling).
