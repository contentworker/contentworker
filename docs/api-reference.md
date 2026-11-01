# HTTP API reference

> **Interactive docs:** every deployment serves its own OpenAPI 3.1 spec at
> `GET /openapi.json` (a complete inventory of the mounted routes — the spec
> reflects the deployment's `ROLE`) and a browsable Scalar UI at `GET /docs`. The page loads
> Scalar from the deployment's own admin origin (`/vendor/scalar/standalone.js`, copied out of
> node_modules by `apps/web/scripts/vendor-scalar.mjs` on every web `dev` and `build`), with
> Scalar's default fonts and "Ask AI" off, so it makes no third-party requests.

The API is a [Hono](https://hono.dev) app (`createApp` in `packages/http/src/api/app.ts`) mounted by
two Workers. It exposes three role-based surfaces:

- **Management (CMA)** — authoring, publishing, space administration, AI, releases, workflows.
- **Delivery (CDA)** — read-only published content, hybrid search, Live Content SSE, GraphQL.
- **Preview (CPA)** — read-only draft/current content.

Which surfaces mount is controlled by `ROLE` (see [Configuration](./configuration.md)):

| `ROLE`          | Mounted                         |
| --------------- | ------------------------------- |
| `all` (default) | Management + Delivery + Preview |
| `management`    | Management only                 |
| `delivery`      | Delivery only                   |
| `preview`       | Preview only                    |

`ROLE` may also be a comma-separated union. Where each surface is served:

| Host                         | Worker          | `ROLE`                          | Serves                                                                                   |
| ---------------------------- | --------------- | ------------------------------- | ---------------------------------------------------------------------------------------- |
| `api.<domain>`               | `apps/api`      | `management,preview,delivery`   | Management, Preview, MCP, OAuth, `/media/*`; delivery routes for the admin's own reads   |
| `cdn.<domain>`               | `apps/delivery` | `delivery`                      | The public Delivery API (`/delivery/*`, `/graphiql/*`), cached; auth on every request    |
| `<domain>` (admin origin)    | `apps/web`      | —                               | Forwards `/spaces*`, `/preview/*`, `/delivery/*`, `/mcp`, `/oauth/*`, `/.well-known/oauth-*`, `/media/*`, `/docs*`, `/guides*`, `/openapi.json` to the api; OAuth's issuer on a fleet deployment |

Public delivery clients should use `cdn.<domain>`; it answers only `GET`/`HEAD` (cached) and
`POST` for GraphQL (uncached), and anonymous reads get 401 before the cache.

**Read-your-writes.** Every api response carries `x-cw-bookmark`, the D1 Sessions API bookmark
after the request's queries. Send it back on the next request and that read is at least as fresh
as your last response, even from a read replica. Without it, a `GET` may be served by any replica.
See [Consistency](./consistency.md).

## Authentication

Every endpoint except `/health`, `/ready`, and `/graphiql/:space/:env` requires
`Authorization: Bearer <token>`.

1. If the token equals the configured **admin token**, the request gets a wildcard admin
   `Principal` (`spaceId: '*'`, all CMA scopes) — used for provisioning/bootstrap.
2. Otherwise the token is SHA-256 hashed and looked up as an API key; the matched key's space,
   scopes, and optional role grants become the `Principal`. OAuth access tokens and personal
   access tokens are the same lookup — they are API keys with a different issuance — and resolve
   to a `user` principal carrying the human's `subject`.
3. An unknown/missing token → **401**.

When `OAUTH_ISSUER` is configured the API also runs an OAuth 2.1 authorization server at
`/oauth/*` plus `/.well-known/oauth-authorization-server`, so MCP clients authenticate through a
consent flow rather than a static key. A fleet deployment serves it on the admin host
(`OAUTH_ISSUER=https://<domain>`, forwarded by the web gateway), and a person approves after
signing in to the web app. See [Auth & RBAC](./auth-and-rbac.md#oauth-21-for-mcp-clients).

Each route then calls `requireScope(scope)`, which runs `authorize(principal, scope, :space)`.
Delivery and Preview list/get endpoints additionally filter by granular `contentGrants` when the
key is role-bound. See [Auth & RBAC](./auth-and-rbac.md).

## Environment aliases

Path segment `:env` in Management, Delivery, and Preview routes is resolved through
**environment aliases** (`environment_aliases` table) before use. This supports blue/green-style
routing without changing client URLs.

MCP tools resolve their `environment` argument the same way (except `environment_delete`, which
takes the name as given, and `audit_log_list`, so a deleted environment's history stays readable).

A write must name an alias or an environment that exists. Anything else is `404`, so a typo'd or
deleted environment never collects rows that no environment owns. A read of an unknown environment
is just empty. A caller who can't act in the space gets `403` before that check, so they can't tell
which environments exist there. Snapshot import and clone also need their target environment to
exist (create it first).

Setting an alias and deleting its target can't race: each write re-checks inside its own batch.
An alias set after a deletion's check aborts the deletion (`409`), and an alias whose target was
deleted after its check is refused (`404`).

## System endpoints

| Method | Path                    | Auth | Response                                             |
| ------ | ----------------------- | ---- | ---------------------------------------------------- |
| GET    | `/health`               | none | `{ "status": "ok" }`                                 |
| GET    | `/ready`                | none | `{ "status": "ready", "role": "<role>" }`            |
| GET    | `/graphiql/:space/:env` | none | GraphiQL HTML shell (queries still need a CDA token) |

---

## Shared query language

Delivery and Preview entry list endpoints, and GraphQL resolvers, share the query parser in
`packages/http/src/api/query.ts`. In addition to `content_type`, `locale`, `limit`, `skip`, `since`, and
`include`:

| Parameter         | Syntax                                | Meaning                                                               |
| ----------------- | ------------------------------------- | --------------------------------------------------------------------- |
| Field filter      | `fields.<apiId>=v`                    | Equals                                                                |
| Field filter (op) | `fields.<apiId>[op]=v`                | `op` ∈ `ne`, `in`, `nin`, `gt`, `gte`, `lt`, `lte`, `exists`, `match` |
| System field      | `sys.publishedAt[gt]=<iso>`           | Filter on `sys.*` pseudo-fields                                       |
| Sort              | `order=fields.title,-sys.publishedAt` | Comma-separated; `-` prefix = descending                              |
| Projection        | `select=fields.title,fields.body`     | Return only listed field apiIds                                       |
| Full-text         | `query=foo`                           | FTS over string fields (published model on Delivery)                  |

---

## Management API (CMA)

Base paths: `/spaces` and `…` = `/spaces/:space/environments/:env`.

### Spaces & environments

| Method | Path                                        | Scope            | Description                                     |
| ------ | ------------------------------------------- | ---------------- | ----------------------------------------------- |
| GET    | `/spaces`                                   | auth             | List spaces (admin: all; scoped key: own space) |
| POST   | `/spaces`                                   | `space:admin`    | Create a space                                  |
| GET    | `/spaces/:space/environments`               | `preview:read`   | List environments                               |
| POST   | `/spaces/:space/environments`               | `space:admin`    | Create environment `{ id, name }`               |
| DELETE | `/spaces/:space/environments/:env?confirm=` | `space:admin`    | Delete an environment and everything in it      |
| GET    | `/spaces/:space/environment-aliases`        | `preview:read`   | List aliases                                    |
| PUT    | `/spaces/:space/environment-aliases/:alias` | `space:admin`    | Set alias → environment id                      |
| DELETE | `/spaces/:space/environment-aliases/:alias` | `space:admin`    | Remove alias                                    |
| GET    | `/spaces/:space/audit-log`                  | `space:admin`    | Space audit log (`?limit`, `?skip`)             |
| GET    | `/spaces/:space/compare`                    | `preview:read`   | Compare two environments (`?from`, `?to`)       |
| POST   | `/spaces/:space/merge`                      | `content:manage` | Merge environment branch                        |

### Environment snapshots

| Method | Path       | Scope            | Description                                                                            |
| ------ | ---------- | ---------------- | -------------------------------------------------------------------------------------- |
| GET    | `…/export` | `content:manage` | Export the environment as portable JSON                                                |
| POST   | `…/import` | `content:manage` | Replay a snapshot into this environment, as a job (`202`; `?dryRun=true` reports, `200`; `?publish=false`) |
| POST   | `…/clone`  | `content:manage` | Copy this environment into another, entirely as jobs (`202`) `{ targetSpaceId?, targetEnvironmentId, publish? }` |

A snapshot carries the content model, entries (with taxonomy metadata), taxonomy, workflows,
asset **metadata** and the asset folders. It deliberately never carries **credentials** — API keys, OAuth clients and
grants, preview tokens, webhook signing secrets — because a snapshot is a file people move around.
Asset **binaries** stay in the blob store: a restore into a space pointing at the same bucket
works, and one pointing elsewhere has dangling files, which is visible rather than silent. The
import report names everything it did not carry.

**Import replays domain operations** rather than injecting rows: entries go through `createEntry`
and are republished through `publishEntry`. That is slower than a bulk insert, and deliberate —
validation, the reference graph, the delivery read model, the outbox and the search index all reach
the state they would have reached organically. A snapshot is therefore not a back door: content the
current model would reject fails the import loudly.

What an import preserves:

- **Ids.** Entries and asset records keep their ids (every table is keyed per environment), so
  links between them resolve in the target unchanged, and comparing or merging the copy against
  its source matches entries one to one. Taxonomy ids are remapped.
- **Every entry.** The export reads every page of entries and assets, not the store's first page.
- **Live and draft versions.** A `changed` entry (published, with edits since) carries its live
  version's fields too: the import publishes those, then applies the draft, so the copy has the
  same live content and the same pending edits. Snapshots from before this carry no live version,
  and their changed entries land as drafts.
- **Assets** as records, published as they were; their files stay where they are. An archived
  asset arrives as a draft.
- **Asset folders**, with their ids and paths, so each asset lands in the same folder. A snapshot
  from before folders carries none, and its assets land at the library root.

**Deleting an environment** (`DELETE …/environments/:env?confirm=:env`, MCP `environment_delete`)
removes it and everything in it (content model, entries and versions, assets, references,
releases, schedules, workflows and runs, taxonomy, comments, tasks, jobs); its audit history stays.
`confirm` must repeat the environment id. It takes a person holding `space:admin` in that space
(signed in, or through their OAuth or personal access token) or the deployment admin token; a
plain API key gets `403`, even one with `space:admin`. It refuses `main` (`422`) and any environment an alias
points at (`409`: repoint or remove the alias first).

One atomic write takes the environment out of the registry, so from that moment it answers `404`
to reads and writes on every surface. The same write records an `environment.deleted` audit row
naming the caller (on both surfaces, so a deletion never commits unrecorded), appends
`environment.deleted` events (published entry ids in chunks of 500) and the first
`environment.purge_due`. From the first, the engine removes the entries' search documents and
vectors and purges the delivery cache. Search results only ever include entries published now, so
an index document that outlives its entry is never served.

The rows themselves go afterwards, in bounded steps: D1 refuses one statement that modifies
hundreds of thousands of rows. Each step deletes at most 500 rows from each of the environment's
tables, and each `environment.purge_due` runs up to 20 steps before handing on to the next. When
nothing is left, the environment's asset files go from the blob store (keeping any another
environment's asset records still point at, as a clone's do) and its id is free again. Until then,
creating an environment with that id is refused (`409`). A purge whose event is lost is restarted by
the engine's cron after five minutes without progress.

**An import checks before it writes.** Every entry is validated against the snapshot's content
model and the target space's locales, every link in what will be published must point at an
entry or asset the snapshot carries, and every asset folder needs a valid name and a parent the
snapshot carries. Any problem refuses the import with a `422` that lists them
(up to 50, each naming its entry) and writes nothing, so the target stays empty and a corrected
retry works. `?dryRun=true` runs the same checks. A failure the checks can't foresee (a plugin
hook refusing an entry, an infrastructure error) is reported per entry in the job's report.

**Import and clone run as jobs.** Replaying every entry through the use-cases is far more than one
request can hold for an environment of any size. After the checks, the request writes the content
model, asset folders, taxonomy and workflows (small, and everything else depends on them) and answers `202` with
`{ report, job, publishJobId }`. The assets and entries are staged in the blob store in chunks of
100 before the model is written (so a staging failure leaves the target empty and a retry works),
and written by bulk jobs, with progress at `…/bulk/jobs/:id` and per-item failures at
`…/bulk/jobs/:id/report` in the **target** environment:

1. `job` creates the asset records and entries, as drafts, under their own ids.
2. `publishJobId` starts when `job` completes, in the same write that finalizes it: it publishes
   what the snapshot had published (assets, then entries), then lays each changed entry's draft on
   top. It waits because publishing an entry needs every entry and asset it links to to exist, and
   chunks run concurrently. It starts only if `job` completes with no failures (otherwise `job`'s
   report names what failed, and nothing is published); it never starts if `job` is cancelled, and
   it is `null` when nothing is published (`?publish=false`, or a snapshot of drafts).

Staged work is removed as each chunk finishes, and whatever is left (a chunk that failed for good, a
publishing job that never started, a cancelled job) when the job completes or is cancelled. Each
imported entry is created and published through the use-cases, so it emits its own events (webhooks,
search and vector indexing) as an entry written by hand would.

Every chunk step is safe to run again after a crash: an entry already created isn't created twice,
and one already published (or already carrying its draft) isn't published again. A snapshot with no
entries or assets answers `job: null`. Without a blob store (local fakes), import and clone run
synchronously and answer `201` with the report.

**A clone runs entirely as jobs.** An import's snapshot arrives in the request body, so its checks
run there; a clone's source is read from the database, so even the export and the checks move off
the request. `POST …/clone` checks only that both environments exist and the target holds no
content types, and answers `202` with `{ job, createJobId, publishJobId }`. `job` (one chunk, in the
engine) exports the source, runs every check, stages the work, writes the model and starts
`createJobId`, as an import's request would. A snapshot the checks refuse fails `job`, and its
report (`…/bulk/jobs/:id/report`) names the problems; nothing is written. `publishJobId` starts when
`createJobId` completes cleanly, and only exists if anything is published. A dry run
(`dryRun: true` on the MCP tool) still exports and checks in the request.

### Importing from elsewhere

Snapshots move content between contentworker environments. This moves it _in_, from a format
someone else produced.

| Method | Path                | Scope           | Description                                    |
| ------ | ------------------- | --------------- | ---------------------------------------------- |
| GET    | `…/imports/sources` | `content:write` | Formats this deployment can read               |
| POST   | `…/imports/analyze` | `content:write` | Report what an import would do. Writes nothing |
| POST   | `…/imports`         | `content:write` | Run it                                         |

Both POSTs take the same body, so analyzing and running are the same request to two paths:

```jsonc
{
  "source": "csv", // or "json", "wxr"
  "payload": "sku,title\nA-1,Widget\n", // the file, as text
  "mapping": {
    "contentTypeApiId": "product",
    "fields": { "name": "title", "sku": "sku" }, // target apiId -> source field
    "identityField": "sku", // what makes a re-run recognise its own work
    "locale": "en-US" // default: the space's default locale
  },
  "sourceOptions": { "identityField": "sku" },
  "conflicts": "skip" // skip (default) | update | fail
}
```

The admin drives exactly this, from the entries list of any content type. It reads a file by
analyzing it with an **empty mapping** — every source field then comes back as unmapped, which is the
column list — rather than parsing it locally, so the names offered for mapping cannot disagree with
the names the import sees.

**Two phases, one computation.** `analyze` and the run share the same planner, so the report is not
a prediction — it is the run, without the commit. A migration is irreversible in practice, and the
decision to start one should be made while looking at its consequences.

The analysis reports what would be created, updated and skipped, plus three things that are only
findable beforehand:

- **`unmappedSourceFields`** — columns nothing maps to. This is the data the import throws away.
- **`missingRequiredFields`** / **`unknownTargetFields`** — a mapping that cannot work at all.
  These block execution; per-record failures do not.
- **`issues`** — a bounded sample of records that would fail, each named by its source id.

**Re-running is safe when `identityField` is set.** With it, a second run matches what the first
created and skips (or updates) it. Without it, every run creates everything again — which the
analysis makes visible rather than leaving to be discovered.

Entries arrive as **drafts**. Publishing them is the existing bulk job, which is resumable,
cancellable and reportable — none of which a flag on the import would be. A record that fails
validation is skipped and reported rather than aborting the run, and trashed entries are never
matched as conflicts: an import must not silently revive something someone deleted.

**Text for a RichText field is read as HTML.** Paragraphs, headings, lists, quotes, code blocks,
rules, links and inline marks map to their rich-text nodes; a blank-line-separated block of plain text
becomes paragraphs, as WordPress renders it. The reader is lenient — unclosed tags and stray end tags
are recovered the way a browser recovers them — and keeps the text of any element it does not know.
Images and embeds become **links to their source**, since there is no asset to point an embed at yet;
a link is visible and fixable, where a dropped image is neither. A value that is already a rich-text
document is left alone.

#### WordPress exports (`wxr`)

The file from WordPress's _Tools → Export_. It holds posts, pages, attachments, menu items and
revisions in one list, and a mapping targets one content type, so the source reads one kind at a time:

```jsonc
"sourceOptions": {
  "postType": "page",           // default "post"; a list reads several
  "statuses": ["publish"]       // default: everything except auto-draft and trash
}
```

What it passed over is **named in `warnings`** — "Not read (other post types): page (12),
attachment (40)" — along with comments, which are not imported. An export where the pages silently did
not come across is the failure this guards against.

Each item becomes flat fields: `id` (the WordPress post id — the identity, so map it to a field and
set `identityField` to make re-runs safe), `title`, `slug`, `content` (the post's HTML as stored),
`excerpt`, `status`, `date`/`modified` (ISO-8601; the GMT time when WordPress recorded one),
`author`/`authorName`, `link`, `parentId`, `menuOrder`, `sticky`, `categories` and `tags` (lists of
names), `terms.<taxonomy>` for custom taxonomies, `featuredImage` (the attachment's URL, resolved
within the file), `attachmentUrl` when reading attachments, and `meta.<key>` for custom fields.
WordPress's own bookkeeping meta (`_edit_lock` and the like) is left out; other underscore keys are
kept, since plugins store real content that way, and show up in `unmappedSourceFields` for you to
decide on.

The XML reader does not process a document type's internal subset, so a file cannot define entities —
the mechanism behind entity-expansion and local-file-read attacks — and an error names the line it
happened on, and says when the file looks truncated.

Payload size is bounded by `MAX_BODY_BYTES` (default 5 MB) on HTTP, and by the source's own 20 MB
cap elsewhere. The synchronous run refuses a file with more than 10,000 records; past that, use the
durable path.

#### Bigger than one request

| Method | Path            | Scope           | Description                                          |
| ------ | --------------- | --------------- | ---------------------------------------------------- |
| POST   | `…/imports/job` | `content:write` | Same body, same report, chunked into a resumable job |

`202` with `{ job, analysis }`: the analysis is the same one `analyze` returns, and the job is an
ordinary bulk job — so progress polls at `…/bulk/jobs/:id`, per-record failures at
`…/bulk/jobs/:id/report`, and cancellation at `…/bulk/jobs/:id/cancel`, exactly as for a bulk publish.
Reading those requires `content:write` rather than `content:publish`, because someone who can start
an import must be able to watch it.

Planning is still one pass over the whole file — a report describing only part of a file is worse
than no report — so the durable path bounds memory, not time, at 250,000 records. What it chunks is
the writing. Records the report already counted as skipped are never staged: a job whose progress bar
counts work it will refuse reads as slower than it is.

Chunk work is staged in the blob store at plan time, once. Every chunk re-reading and re-parsing the
source file would make a 40,000-row import quadratic. **A consumer without a blob store leaves import
chunks claimable** rather than reporting an import that did not run — visible as a job that does not
progress. On a deployment that means `MEDIA_BUCKET` (R2), where chunks are staged under `imports/`.

Import requires a target environment with **no content types**. Merging two content models is a
different and much harder operation; use `compare`/`merge` for the intra-space case. Cloning is the
cross-space case those cannot cover, and the target space is authorized separately so a clone
cannot cross a tenancy boundary.

### API keys & roles

| Method | Path                          | Scope         | Description                                             |
| ------ | ----------------------------- | ------------- | ------------------------------------------------------- |
| GET    | `/spaces/:space/api-keys`     | `space:admin` | List keys                                               |
| POST   | `/spaces/:space/api-keys`     | `space:admin` | Mint key (`kind`, optional `roleId`) — raw `token` once |
| DELETE | `/spaces/:space/api-keys/:id` | `space:admin` | Revoke key                                              |
| GET    | `/spaces/:space/roles`        | `space:admin` | List roles                                              |
| POST   | `/spaces/:space/roles`        | `space:admin` | Create role                                             |
| GET    | `/spaces/:space/roles/:id`    | `space:admin` | Get role                                                |
| PUT    | `/spaces/:space/roles/:id`    | `space:admin` | Update role                                             |
| DELETE | `/spaces/:space/roles/:id`    | `space:admin` | Delete role (refused if keys bound)                     |

`DELETE /deployment/people/:subject/credentials` revokes every OAuth grant and token, personal
access token and setup credential a person (`subject`, their web user id) holds, in every space,
and answers `{ revokedTokens, revokedGrants }`. Only a deployment administrator (a wildcard
principal) may call it; the web app does when it ends a person's access (see
[Auth & RBAC](./auth-and-rbac.md#ending-a-persons-access)).

### Space config & content types

| Method | Path                               | Scope             | Description                        |
| ------ | ---------------------------------- | ----------------- | ---------------------------------- |
| GET    | `…/space-config`                   | `preview:read`    | Space settings for the environment |
| GET    | `…/content-types`                  | `preview:read`    | List content types                 |
| POST   | `…/content-types`                  | `content:manage`  | Create/update content type         |
| GET    | `…/content-types/:apiId`           | `preview:read`    | Get one                            |
| POST   | `…/content-types/:apiId/published` | `content:publish` | Publish definition                 |

### Entries — CRUD & publishing

| Method | Path                               | Scope             | Description                                                                                |
| ------ | ---------------------------------- | ----------------- | ------------------------------------------------------------------------------------------ |
| POST   | `…/entries`                        | `content:write`   | Create draft `{ contentTypeApiId, fields }`                                                |
| GET    | `…/entries/:id`                    | `preview:read`    | Get current entry (RBAC-filtered fields)                                                   |
| PUT    | `…/entries/:id`                    | `content:write`   | Save new draft version                                                                     |
| POST   | `…/entries/:id/published`          | `content:publish` | Publish                                                                                    |
| DELETE | `…/entries/:id/published`          | `content:publish` | Unpublish                                                                                  |
| GET    | `…/entries/:id/reverse-references` | `preview:read`    | Entries linking to this one                                                                |
| DELETE | `…/entries/:id`                    | `content:write`   | Move to the trash (unpublishes first if live; idempotent)                                  |
| POST   | `…/entries/:id/restore`            | `content:write`   | Restore from the trash, as a draft                                                         |
| DELETE | `…/entries/:id/permanent`          | `content:publish` | **Irreversible** delete of a trashed entry. `?force=true` overrides the inbound-link guard |
| POST   | `…/entries/:id/duplicate`          | `content:write`   | Copy fields + taxonomy metadata into a new draft                                           |

**Held to a version.** Publish, unpublish and version restore take an optional
`?expectedVersion=N`: the entry's `currentVersion` as the caller read it. If someone has saved a
newer draft since, the call returns **409** and changes nothing, rather than publishing or
overwriting content the caller never saw. The MCP tools `entries_publish`, `entries_unpublish` and
`entries_restore_version` take the same `expectedVersion` argument.

**Unique fields.** Creating or updating an entry whose `unique` field collides returns **409**
with a message naming the field, the value and the entry holding it. Trashing an entry frees its
unique values; restoring re-claims them and can therefore fail with 409 if the value was taken in
the meantime.

**The trash.** Deleting an entry is two deliberate steps. `DELETE …/entries/:id` archives it —
unpublishing first when it is live, so delivery stops serving it and the usual
`entry.unpublished` event clears the delivery cache and the entry's embeddings. Archived entries
are hidden from every list unless a request asks for them with `?trashed=true`, which is the trash
view. Only an archived entry can be permanently deleted, and that route needs `content:publish`
rather than `content:write` because it is the one entry action with no way back.

Permanent deletion is refused with **409** while _published_ entries still link to the target,
naming them in `details.referencedBy` — those are the links delivery resolves per request, so
removing the target under them would break live pages. Reference edges are recorded at publish
time, so a link from an unpublished draft does not block the delete.

### Entries — AI & semantics

| Method | Path                         | Scope           | Description                       |
| ------ | ---------------------------- | --------------- | --------------------------------- |
| POST   | `…/entries/generate`         | `content:write` | Generate draft fields from prompt |
| POST   | `…/entries/canvas`           | `content:write` | Multi-field canvas generation     |
| POST   | `…/entries/:id/translate`    | `content:write` | Translate fields to locales       |
| POST   | `…/entries/:id/summarize`    | `content:write` | Summarize entry text              |
| POST   | `…/entries/:id/autofill`     | `content:write` | Fill empty fields                 |
| POST   | `…/entries/:id/suggest-tags` | `content:write` | Suggest taxonomy tags             |
| POST   | `…/entries/:id/apply-tags`   | `content:write` | Persist a reviewed tag suggestion |
| POST   | `…/entries/:id/audit`        | `content:write` | AI content audit                  |
| POST   | `…/entries/:id/moderate`     | `content:write` | Run moderation agent              |
| GET    | `…/entries/:id/related`      | `search:read`   | Semantically related entries      |
| GET    | `…/entries/:id/duplicates`   | `search:read`   | Near-duplicate detection          |
| GET    | `…/entries/:id/embedding`    | `search:read`   | Embedding vector metadata         |

### Entries — versioning & bulk

| Method | Path                                      | Scope             | Description                        |
| ------ | ----------------------------------------- | ----------------- | ---------------------------------- |
| GET    | `…/entries/:id/versions`                  | `preview:read`    | Version list                       |
| GET    | `…/entries/:id/versions/diff`             | `preview:read`    | Diff two versions (`?from`, `?to`) |
| GET    | `…/entries/:id/versions/:version`         | `preview:read`    | Get specific version               |
| POST   | `…/entries/:id/versions/:version/restore` | `content:write`   | Restore version as new draft       |
| POST   | `…/bulk/entries`                          | `content:write`   | Bulk create/update                 |
| POST   | `…/bulk/entries/publish`                  | `content:publish` | Bulk publish                       |
| POST   | `…/bulk/entries/unpublish`                | `content:publish` | Bulk unpublish                     |

### Entry metadata & taxonomy associations

| Method | Path                     | Scope           | Description              |
| ------ | ------------------------ | --------------- | ------------------------ |
| GET    | `…/entries/:id/metadata` | `preview:read`  | Tags + concepts on entry |
| PUT    | `…/entries/:id/metadata` | `content:write` | Set tags/concepts        |

### Assets

| Method | Path                         | Scope             | Description                                                                       |
| ------ | ---------------------------- | ----------------- | --------------------------------------------------------------------------------- |
| GET    | `…/assets`                   | `preview:read`    | List assets: `kind`, `mime` (`image/*`), `tag`, `folder` (id or `root`), `status` (archived hidden unless `archived`/`all`), `sort` (`updatedAt`, `createdAt`, `size`), `order`, `limit`, `cursor` → `{ items, nextCursor? }` |
| POST   | `…/assets`                   | `content:write`   | Create draft + presigned upload URL (optional `folderId`)                         |
| POST   | `…/assets/move`              | `content:write`   | `{ ids (≤ 500), folderId \| null }` → `{ moved }`; 404 for an unknown folder      |
| GET    | `…/assets/:id`               | `preview:read`    | Get asset                                                                         |
| POST   | `…/assets/:id/archive`       | `content:publish` | Archive (leaves Delivery when published); idempotent                              |
| POST   | `…/assets/:id/restore`       | `content:write`   | Restore an archived asset as a draft; idempotent                                  |
| DELETE | `…/assets/:id`               | `content:publish` | Delete permanently (204); `409 asset_in_use` with `error.usage` (first 50, titled) and `error.total` while linked |
| GET    | `…/asset-folders`            | `preview:read`    | List folders, in path order                                                       |
| POST   | `…/asset-folders`            | `content:write`   | Create `{ name, parentId? }` (201); 409 for a sibling of the same name            |
| PATCH  | `…/asset-folders/:id`        | `content:write`   | Rename and/or move `{ name?, parentId? \| null }`, subtree along                  |
| DELETE | `…/asset-folders/:id`        | `content:write`   | Delete an empty folder (204); 409 when it holds subfolders or assets              |
| PATCH  | `…/assets/:id/metadata`      | `content:write`   | Update alt text / tags metadata                                                   |
| GET    | `…/assets/:id/usage`         | `preview:read`    | Reference usage                                                                   |
| GET    | `…/assets/:id/transform`     | `preview:read`    | Image transform URL (`w,h,fit,fm,q`; `fm=auto` → AVIF/WebP)                       |
| POST   | `…/assets/videos`            | `content:write`   | Create a video asset + one-time direct upload to the video host (501 without one) |
| POST   | `…/assets/:id/video/refresh` | `content:write`   | Refresh a video asset's status, playback URLs and poster                          |
| POST   | `…/assets/:id/alt-text`      | `content:write`   | AI alt-text generation                                                            |
| POST   | `…/assets/:id/auto-tag`      | `content:write`   | AI auto-tagging                                                                   |
| POST   | `…/assets/:id/published`     | `content:publish` | Publish asset                                                                     |
| DELETE | `…/assets/:id/published`     | `content:publish` | Unpublish asset                                                                   |

### Releases

| Method | Path                             | Scope             | Description            |
| ------ | -------------------------------- | ----------------- | ---------------------- |
| GET    | `…/releases`                     | `preview:read`    | List releases          |
| POST   | `…/releases`                     | `content:write`   | Create release         |
| GET    | `…/releases/:id`                 | `preview:read`    | Get release            |
| DELETE | `…/releases/:id`                 | `content:write`   | Delete draft release   |
| POST   | `…/releases/:id/items`           | `content:write`   | Add entity to release  |
| DELETE | `…/releases/:id/items/:entityId` | `content:write`   | Remove item            |
| POST   | `…/releases/:id/published`       | `content:publish` | Publish release bundle |

### Scheduled actions

| Method | Path                      | Scope             | Description                      |
| ------ | ------------------------- | ----------------- | -------------------------------- |
| GET    | `…/scheduled-actions`     | `preview:read`    | List scheduled publish/unpublish |
| POST   | `…/scheduled-actions`     | `content:publish` | Schedule action                  |
| DELETE | `…/scheduled-actions/:id` | `content:publish` | Cancel scheduled action          |

### Agent schedules

Recurring agent jobs (cron-cadence workflow runs over newly-published entries) — see
[AI, agents & search](./ai-agents-and-search.md#agent-schedules).

| Method | Path                    | Scope             | Description                                                                                 |
| ------ | ----------------------- | ----------------- | ------------------------------------------------------------------------------------------- |
| GET    | `…/agent-schedules`     | `preview:read`    | List recurring agent jobs                                                                   |
| POST   | `…/agent-schedules`     | `content:publish` | Create schedule `{ workflow, cron (5-field UTC), contentTypeApiId?, enabled?, autoApply? }` |
| PATCH  | `…/agent-schedules/:id` | `content:publish` | Update cron / enabled / autoApply / content-type filter                                     |
| DELETE | `…/agent-schedules/:id` | `content:publish` | Delete schedule                                                                             |

### Agent reviews

Human-in-the-loop decisions on agent proposals — see
[AI, agents & search](./ai-agents-and-search.md#human-in-the-loop-reviews).

| Method | Path                          | Scope           | Description                                                                 |
| ------ | ----------------------------- | --------------- | --------------------------------------------------------------------------- |
| GET    | `…/agent-reviews`             | `preview:read`  | List reviews (`?status=pending`, `?entryId=`)                               |
| POST   | `…/agent-reviews/:id/approve` | `content:write` | Approve: applies the proposal exactly once (or signals the durable watcher) |
| POST   | `…/agent-reviews/:id/reject`  | `content:write` | Reject: nothing is applied                                                  |

### Collaboration

| Method | Path                     | Scope           | Description                 |
| ------ | ------------------------ | --------------- | --------------------------- |
| GET    | `…/entries/:id/comments` | `preview:read`  | List comments               |
| POST   | `…/entries/:id/comments` | `content:write` | Add comment                 |
| DELETE | `…/comments/:id`         | `content:write` | Delete comment              |
| GET    | `…/entries/:id/tasks`    | `preview:read`  | List tasks                  |
| POST   | `…/entries/:id/tasks`    | `content:write` | Create task                 |
| PUT    | `…/tasks/:id`            | `content:write` | Update task status/assignee |
| DELETE | `…/tasks/:id`            | `content:write` | Delete task                 |

### Workflows

| Method | Path                                | Scope            | Description                                                                                                                                                                                                                |
| ------ | ----------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `…/workflows`                       | `preview:read`   | List workflows (legacy `steps` plus the draft `graph`, `latestVersion`)                                                                                                                                                    |
| POST   | `…/workflows`                       | `content:manage` | Create: legacy `{ name, steps }` is converted and published as v1 (answers the workflow); `{ name, description?, contentTypes?, graph?, gatesPublish? }` creates an unpublished draft (answers `{ workflow, validation }`) |
| GET    | `…/workflows/:id`                   | `preview:read`   | Get workflow                                                                                                                                                                                                               |
| DELETE | `…/workflows/:id`                   | `content:manage` | Delete workflow (published versions are kept for pinned runs)                                                                                                                                                              |
| PUT    | `…/workflows/:id/draft`             | `content:manage` | Save the draft `{ name?, description?, contentTypes?, graph?, gatesPublish? }`; omitted fields are kept. Answers `{ workflow, validation }`                                                                                |
| POST   | `…/workflows/:id/versions`          | `content:manage` | Publish the draft as the next immutable version (422 while validation has errors); `publishedBy` is the caller                                                                                                             |
| GET    | `…/workflows/:id/versions`          | `preview:read`   | Published versions, newest first                                                                                                                                                                                           |
| GET    | `…/workflows/:id/versions/:version` | `preview:read`   | One published version with its graph                                                                                                                                                                                       |
| POST   | `…/workflows/validate`              | `preview:read`   | Validate `{ graph }` without saving → `{ ok, errors, warnings }`                                                                                                                                                           |
| POST   | `…/workflows/copilot`               | `content:manage` | Propose a graph from `{ prompt, graph?, contentTypes? }`. Read-only (never saves); answers `{ graph, explanation, errors, warnings, changes, summary, provenance }`                                                        |
| GET    | `…/entries/:id/workflow`            | `preview:read`   | Entry workflow state (legacy steps)                                                                                                                                                                                        |
| POST   | `…/entries/:id/workflow/transition` | `preview:read`   | Transition step (legacy; step scope enforced in use-case)                                                                                                                                                                  |

#### Workflow runs and tasks

Runs execute on Cloudflare Workflows (`EDITORIAL_WF`, see [Architecture](./architecture.md#editorial-workflow-runs)).
Without that binding the run actions below answer **501** (`not_configured`); reads still work.
A run acts as whoever started it: every node is authorized as if they made the call. Run and task
reads also need `read` on the entry's content type (role-bound keys); lists leave out what the
caller can't read. A run never exposes its starter's resolved principal, only `startedBy.id`.

| Method | Path                            | Scope           | Description                                                                                                                                                                                                                         |
| ------ | ------------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `…/entries/:id/workflow-runs`   | `content:write` | Start a run `{ workflowId, version?, input?, vars? }` of a published `trigger.manual` workflow. One active run per workflow and entry (409)                                                                                         |
| GET    | `…/workflow-runs`               | `preview:read`  | List runs; `entryId`, `workflowId`, `status`, `limit` (≤ 200)                                                                                                                                                                       |
| GET    | `…/workflow-runs/:id`           | `preview:read`  | Run: status, plan, node detail, what it waits on                                                                                                                                                                                    |
| GET    | `…/workflow-runs/:id/timeline`  | `preview:read`  | Timeline, oldest first                                                                                                                                                                                                              |
| GET    | `…/workflow-runs/:id/node-runs` | `preview:read`  | Finished node runs (timing, output, who it ran as)                                                                                                                                                                                  |
| POST   | `…/workflow-runs/:id/cancel`    | `content:write` | Cancel `{ reason? }`: terminate, undo finished compensable steps newest first, close tasks → `{ ok, undone }`                                                                                                                       |
| POST   | `…/workflow-runs/:id/events`    | `content:write` | Deliver `{ event, payload? }` to the waiting `control.wait_event` node; an early event is held (`buffered: true`)                                                                                                                   |
| GET    | `…/workflow-tasks`              | `preview:read`  | Approvals, event waits and agent reviews; `status`, `runId`, `entryId`, `kind`, `limit`                                                                                                                                             |
| GET    | `…/workflow-tasks/:id`          | `preview:read`  | One task                                                                                                                                                                                                                            |
| POST   | `…/workflow-tasks/:id/decide`   | `preview:read`  | `{ decision: approved\|rejected, note? }`. Also needs the task's `requiredScope` (default `workflow:approve`) and content-type grant; with separation of duties the starter can't decide and an API token can't decide at all (403) |
| GET    | `…/workflow-settings`           | `preview:read`  | `{ separateDuties }`                                                                                                                                                                                                                |
| PUT    | `…/workflow-settings`           | `space:admin`   | Set the space default for approvals that leave `separateDuties` unset                                                                                                                                                               |

### Taxonomy

| Method | Path                              | Scope            | Description               |
| ------ | --------------------------------- | ---------------- | ------------------------- |
| GET    | `…/taxonomy/schemes`              | `preview:read`   | List concept schemes      |
| POST   | `…/taxonomy/schemes`              | `content:manage` | Create scheme             |
| DELETE | `…/taxonomy/schemes/:id`          | `content:manage` | Delete scheme             |
| GET    | `…/taxonomy/concepts`             | `preview:read`   | List concepts (`?scheme`) |
| POST   | `…/taxonomy/concepts`             | `content:manage` | Create concept            |
| PUT    | `…/taxonomy/concepts/:id/broader` | `content:manage` | Set broader concept       |
| DELETE | `…/taxonomy/concepts/:id`         | `content:manage` | Delete concept            |
| GET    | `…/taxonomy/tags`                 | `preview:read`   | List tags                 |
| POST   | `…/taxonomy/tags`                 | `content:manage` | Create tag                |
| DELETE | `…/taxonomy/tags/:id`             | `content:manage` | Delete tag                |

### Platform configuration

| Method | Path                   | Scope            | Description                         |
| ------ | ---------------------- | ---------------- | ----------------------------------- |
| GET    | `…/functions`          | `preview:read`   | List event-triggered HTTP functions |
| POST   | `…/functions`          | `content:manage` | Register function                   |
| DELETE | `…/functions/:id`      | `content:manage` | Delete function                     |
| GET    | `…/app-extensions`     | `preview:read`   | List admin iframe extensions        |
| POST   | `…/app-extensions`     | `content:manage` | Register extension                  |
| DELETE | `…/app-extensions/:id` | `content:manage` | Delete extension                    |
| GET    | `…/ai-actions`         | `preview:read`   | List AI action templates            |
| POST   | `…/ai-actions`         | `content:manage` | Create AI action                    |
| DELETE | `…/ai-actions/:id`     | `content:manage` | Delete AI action                    |
| POST   | `…/ai-actions/:id/run` | `content:write`  | Run AI action on an entry           |
| GET    | `…/agent-runs`         | `space:admin`    | List agent run audit records        |
| GET    | `…/agent-runs/usage`   | `space:admin`    | Token usage aggregates              |

### Webhooks

| Method | Path                        | Scope         | Description    |
| ------ | --------------------------- | ------------- | -------------- |
| GET    | `…/webhooks`                | `space:admin` | List webhooks  |
| POST   | `…/webhooks`                | `space:admin` | Create webhook |
| PUT    | `…/webhooks/:id`            | `space:admin` | Update webhook |
| DELETE | `…/webhooks/:id`            | `space:admin` | Delete webhook |
| GET    | `…/webhooks/:id/deliveries` | `space:admin` | Delivery log   |

---

## Delivery API (CDA)

Base path: `/delivery/:space/:env`. Reads the denormalized **published** read model (through the Workers KV
delivery cache when `KV_CACHE` is bound; up to ~60 s cross-location staleness after a publish). List/get responses apply granular RBAC when the key is role-bound.

| Method   | Path                                         | Scope           | Description                    |
| -------- | -------------------------------------------- | --------------- | ------------------------------ |
| GET      | `/delivery/:space/:env/entries`              | `delivery:read` | List published entries         |
| GET      | `/delivery/:space/:env/entries/:id`          | `delivery:read` | Get one published entry        |
| GET      | `/delivery/:space/:env/assets`               | `delivery:read` | List published assets          |
| GET      | `/delivery/:space/:env/assets/:id`           | `delivery:read` | Get one published asset        |
| GET      | `/delivery/:space/:env/search`               | `search:read`   | Search — **hybrid by default** |
| GET      | `/delivery/:space/:env/live`                 | `delivery:read` | **SSE** Live Content stream    |
| GET      | `/delivery/:space/:env/assets/:id/transform` | `delivery:read` | Image transform redirect       |
| GET/POST | `/delivery/:space/:env/graphql`              | `delivery:read` | GraphQL Delivery endpoint      |

**Common query parameters:** shared [query language](#shared-query-language) plus `locale`,
`include` (reference depth 0–5), `limit`, `skip`, `since` (delta sync).

**Search parameters:** `q` (required), `top_k`, `mode` = `hybrid` (default) | `semantic` |
`lexical`.

A delivered entry is `{ id, contentType, fields, publishedAt }`; with `?locale=` fields flatten to
that locale; with `?include=N` linked entries embed up to depth N (cycle-guarded). Links are
resolved wherever they sit: `Link` and array fields, `Component` values, and rich-text reference
nodes, whose `data.target` is replaced by the embedded entry or asset. An unpublished, missing or
cyclic target stays a `{ id, linkType }` stub.

### GraphQL Delivery

`ALL /delivery/:space/:env/graphql` serves a schema **generated from published content types** by
`@contentworker/graphql-gen`. Cached per `(space, environment)` keyed on content-type versions.

- Query via `?query=` (GET) or JSON body `{ query, variables?, operationName? }` (POST).
- Resolvers call the same use-cases as REST with locale flattening and link resolution.

### Live Content (SSE)

`GET /delivery/:space/:env/live` opens a Server-Sent Events stream. The route authorizes like any
Delivery route, then hands the connection to the `LiveHubDO` Durable Object for that
space/environment (named by `liveHubName`, each id percent-encoded so no id can reach another
scope's hub), stamping the request with the authorized scope and the principal's content grants
(`x-cw-live-access`; the object refuses a request without it, and sends a subscriber only events
of its stamped scope). A stream ends after `LIVE_STREAM_MAX_MS` (10 minutes) so the client
reconnects and is authorized again: a revoked key or narrowed role stops receiving within that
bound. After the queue consumer
dispatches a domain event, it publishes the event to that object, which sends each connected
client only what `liveEventFor` (`packages/application/src/delivery.ts`) allows, filtered by
`?types=`:

- Published-content facts only (`LIVE_EVENT_TYPES`): entry, asset, bulk-publish, content-type,
  release and alias events. Workflow runs and tasks, bulk-job control and reindex requests never
  reach a subscriber.
- A key with content grants sees entries only of the types it may read, with its denied fields
  masked, content-type publishes for those types and alias changes, and no asset, bulk or release
  facts: the same rules as its REST reads.

Without a `LIVE_HUB` binding the in-process stream applies the same rules. Use it for real-time
cache invalidation or live previews on the read side.

---

## Preview API (CPA)

Base path: `/preview/:space/:env`. Reads **draft/current** versions. Supports the same
[query language](#shared-query-language) as Delivery. Granular RBAC applies on list/get.

| Method | Path                               | Scope          | Description           |
| ------ | ---------------------------------- | -------------- | --------------------- |
| GET    | `/preview/:space/:env/entries`     | `preview:read` | List current entries  |
| GET    | `/preview/:space/:env/entries/:id` | `preview:read` | Get one current entry |

---

### Types from the live model

`GET …/content-types?format=typescript` returns the content model as a TypeScript module — one type
per content type in both the delivery (locale-flattened) and management (locale-keyed) shapes, plus
the apiId union and lookup maps. Same output as the codegen CLI, served from the model as it is right
now.

```bash
curl -H "Authorization: Bearer $CMA_KEY" \
  "$API/spaces/$SPACE/environments/main/content-types?format=typescript" > src/contentworker.d.ts
```

The point is that CI and coding agents need nothing installed, and cannot type against a stale file:
the banner carries the space, environment and generation time, so a checked-in copy that has drifted
says so. `preview:read` — the same scope as listing content types, since it is the same information
in another shape.

MCP exposes it as `model_typescript`, returning the source as text rather than JSON: it is something
a caller pastes into a file, and wrapping it in a JSON string only makes it something to unescape.

### Finding an entry by name

`GET /preview/:space/:env/suggest?q=…` returns entries whose display field matches what someone is
typing: `{ id, title, contentType, status }` — what a chooser renders, not whole entries.

| Parameter      | Meaning                                                            |
| -------------- | ------------------------------------------------------------------ |
| `q`            | What has been typed so far. Empty returns recent entries           |
| `content_type` | Restrict to one type, which is what a reference field always wants |
| `locale`       | Locale the title resolves in                                       |
| `limit`        | Default 20, capped at 50                                           |

This exists because a chooser cannot be built by listing entries and filtering in the browser. The
list endpoint is capped at 100, so on a space with more entries than that, the ones past the cap are
not slow to find — they are **impossible to pick**. Matching where the data is turns a silent ceiling
into an ordinary query.

Each content type is matched on **its own** display field, so a type that displays `name` is found by
name rather than missed. Trashed entries are excluded: offering one as a link target would create a
reference to content somebody deleted. Content-type grants apply, so a chooser cannot reveal types
the caller cannot read.

Cross-type search over every field is a different question; `…/search` answers it.

MCP exposes this as `entries_suggest` — the tool an agent needs to turn a name it was given into an
id it can use.

## Reading the spec

`GET /openapi.json` is generated from the routes actually mounted, so it reflects this deployment's
`ROLE` rather than a checked-in file that can drift.

Operations documented with a request body take their schema from the _same_ zod schema the handler
parses with, so the document cannot describe something the route would reject. Bodies are rendered
from the schema's **input** side: a field with a default is optional to send, which is what a client
needs to know, even though the handler always sees it.

Coverage is partial and worth stating plainly: **20 of 75 write operations carry a request body**.
Those are the routes documented richly enough to have a summary and a tag. The rest appear in the
spec through route introspection — path, method and auth — but describe neither what they accept nor
what they return, because they have no description attached at all. Closing that gap means writing
those descriptions, not extending this mechanism.

## Error handling

The `onError` middleware maps domain errors to HTTP responses. The body is always
`{ "error": { "code", "message", ... } }`.

| Error                             | Status     | Body extras                      |
| --------------------------------- | ---------- | -------------------------------- |
| `NotFoundError`                   | 404        | —                                |
| `ValidationError`                 | 422        | `issues` (the `FieldIssue[]`)    |
| `ConflictError`                   | 409        | —                                |
| `DomainError` code `unauthorized` | 401        | —                                |
| `DomainError` code `forbidden`    | 403        | —                                |
| other `DomainError`               | 400        | —                                |
| Hono `HTTPException`              | its status | code `http_error`                |
| anything else                     | 500        | code `internal`, generic message |

## Documentation (Guides)

The product's own documentation, served over the API so an agent can look up conventions with
the token it already holds. Requires **any valid token** — there is no space in the path and
nothing tenant-specific in a response — and is distinct from `/docs`, which serves the
generated OpenAPI browser.

| Method | Path             | Returns                                                         |
| ------ | ---------------- | --------------------------------------------------------------- |
| `GET`  | `/guides`        | Every page with its headings and size                           |
| `GET`  | `/guides/:path`  | One page as Markdown; `?section=<heading-slug>` for one section |
| `GET`  | `/guides/search` | `?q=` full-text search; optional `?path=` and `?limit=`         |

Search requires **every** term on the same line, and each match names the page, the nearest
heading above it, and the line number — so a hit can be followed with a section read rather
than pulling tens of KB into context. `?section=` returns a heading down to the next one of
the same or shallower depth.

The same three are exposed as the `docs_list`, `docs_read`, and `docs_search` MCP tools.

Pages are embedded into the build rather than read from disk: the endpoints have to answer
identically from a Cloudflare Worker, which has no filesystem, and from a container image that
may not have shipped the Markdown. A test fails if the embedded copy drifts from `docs/`.


## Notes

- All write bodies are JSON; set `Content-Type: application/json`.
- Field values are always locale-keyed maps, e.g. `"fields": { "title": { "en-US": "Hello" } }`,
  even for non-localized fields (use the default locale).
- The same operations are exposed as **MCP tools** for AI agents — see
  [AI, agents & search](./ai-agents-and-search.md).
- The [Admin UI](./admin-ui.md) is a browser client of these Management endpoints.
