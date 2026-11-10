# ContentWorker roadmap

**v2: edge-only (2026-10-31).** ContentWorker was rebuilt on edge workers end to end. An edge
SQL database replaced Postgres as the system of record, and the single platform worker became five
edge workers
split by traffic profile: `apps/web` (admin + human auth), `apps/api` (Management and Preview
REST, MCP, OAuth, uploads and signed reads, live), `apps/delivery` (the cached public Delivery
API), `apps/media` (published asset files at the edge) and `apps/engine` (queues, cron, stateful
edge objects, durable workflows). Tenancy is one isolated deployment per
customer (a registry entry each, rendered by `scripts/fleet.ts`). The domain and application
layers, and their tests, carried over.

Removed in v2, and not coming back:

- Postgres, its hosted provider and connection pooling, the Node migrator and its container: the
  edge SQL database with hand-written, expand-only SQL migrations (`packages/db/migrations`)
  applied by CI.
- The managed multi-tenant control plane and hostname dispatch: one deployment per customer.
- External AI providers and external vector and search stores: edge inference through an AI
  gateway, an edge vector index, and full-text search shards in stateful edge objects.
- Per-request payment for delivery content, the email SDK, and the S3-API blob adapter (object
  storage is bound natively).
- The Vite admin SPA with bearer-token sign-in: the React Router admin in `apps/web`, with
  passwords, passkeys, TOTP, OIDC single sign-on, SCIM and a one-time `/setup` code.
- The load-test suite, until it is rewritten (below).

## Shipped

Everything below is built and tested on v2.

- **Content.** Spaces, environments (create, delete) and aliases; locales with fallback chains; typed fields with
  validations (labelled `in` options, custom messages), guidance for editors and agents (`help`,
  `placeholder`, `description`), conditional field rules (hide or disable a field while a sibling
  matches, judged in the domain on every surface), components and unique values; model
  ergonomics (a group, description and icon per content type, the sidebar grouped by them, an
  editor-only layout of tabs and field groups, date, date-and-time and time-of-day formats with
  `dateRange`, lists of Text, Integer, Number and Date values, asset MIME rules on asset links,
  named pattern presets); the entry lifecycle (draft → published → archived,
  trash, purge, duplicate); versions with a readable diff (per field and locale, by type: words,
  rich-text blocks, list moves) and restore; references and `include`; rich text
  with HTML import; slugs; redirects (delivery data a front end or edge worker applies: exact and
  pattern sources, import and export, loop checks, and an automatic `301` when a publish changes a
  slug a content type's URL pattern names); SEO metadata (a `Seo` field: title, description,
  canonical URL, noindex, social image) and a sitemap from Delivery (JSON, and XML with `hreflang`
  and a sitemap index past 50,000 URLs); navigation menus (named trees of entry, taxonomy-term and
  URL links, live rather than versioned, resolved by Delivery against published entries through
  each type's URL pattern; managed in Settings > Menus with keyboard reorder).
- **Publishing.** Releases (atomic multi-entry publish), scheduled actions, bulk actions as
  resumable jobs, branch compare and merge, environment promotion with a risk check and approval,
  environment snapshots (export, plus import and clone as resumable jobs; a clone's export and
  checks run in the engine too), CSV, JSON and WordPress import, and whole-space import from the
  JSON space export format (model, locales, tags, entries with links remapped, asset files copied).
- **Assets.** Signed uploads to object storage, edge image transforms, streamed video, localized alt
  text and focal point, AI alt text and auto-tagging, asset usage; a library with folders, filters
  and keyset paging, bulk moves, archive and restore, and delete refused while entries link to an
  asset. Published files on the media worker at stable, immutable URLs with per-space renditions and
  a width ladder for `srcset`, revoked on unpublish; one delivered-asset shape for REST, embeds,
  GraphQL and Preview; short-lived signed URLs for Management and Preview reads. Ingest on upload
  (storage notification → durable workflow): content hash and duplicate marker, dimensions, AI alt
  text and tags where empty, text from documents and audio; hybrid asset search with facets in
  Management, MCP and Delivery, and a reindex job for older assets. File versions with replace and
  restore (the old version's URLs retired on republish), usage rights with an expiry the engine
  enforces and an embargo that blocks publishing, and move, tag, publish, unpublish and archive as
  resumable bulk jobs. Collections (named, ordered, many-to-many, carried by export, import and
  clone, served by Delivery), expiring revocable share links on the media origin (published assets
  only, optional password), multipart uploads past 100 MiB (up to 5 GiB), and zip downloads built by
  a durable workflow.
- **Taxonomy and collaboration.** Concept schemes, concepts and tags, each with a slug, description
  and localized labels, served on Delivery with published usage counts and filterable by slug for
  archive pages; comments, tasks, legacy
  workflow steps, and editorial workflow graphs on durable workflows (runs, timeline,
  approvals with separation of duties, the copilot).
- **AI.** Generation, canvas authoring, translate, summarize, autofill, tags, governed AI
  actions, the enrich/moderate/curate/repurpose agents and the review watcher on durable
  workflows, agent schedules and reviews, per-space budgets (a stateful edge object), provenance,
  related and duplicate detection, hybrid and semantic search, RAG.
- **Integration.** Signed webhooks with a delivery log, event-triggered functions, app
  extensions, sandboxed plugins in isolated edge workers (with per-plugin `kv:storage` and
  operator settings, secrets sealed), the transactional outbox with lease-claimed relay.
- **Access.** CMA/CDA/CPA keys, eight scopes, roles with per-type and per-field grants (read,
  write, publish, and delete and unpublish implied unless withheld) and presets, the last-administrator guard, OAuth 2.1 with the device flow for MCP clients, personal
  access tokens, preview links, rate limits, the audit log (filtered by actor, action, target and
  date, with keyset paging, a `detail` of the field paths an entry save changed, and each entry's
  activity in its editor), secrets sealed at rest with a daily
  reseal sweep. Human sign-in in the web app: passwords, passkeys, TOTP, OIDC, SCIM, setup and
  recovery codes, self-service password reset by an emailed code, with the person forwarded to the
  api as a signed `x-cw-principal`.
- **APIs.** Management, Preview and Delivery REST, GraphQL, live SSE through a stateful edge object,
  OpenAPI 3.1 with a Scalar explorer, and the MCP server (245 tools, plus skills and the docs
  tools).
- **Delivery at the edge.** An uncached gateway that authenticates every request (principal
  cached at the edge) in front of an edge-cached entrypoint keyed by visibility profile, with ETags,
  `stale-while-revalidate`, and one coalesced purge tag per space and environment, drained
  rationed from a queue. Reads use read-replica sessions.
- **Read-your-writes.** The api returns the database session bookmark in `x-cw-bookmark`; a client
  that sends it back reads at least that fresh.
- **SDK.** One npm package, `@contentworker/sdk`: Delivery and Preview, rich text, webhooks,
  redirects, inline editing, React, Vue, edge, React Native, Management and codegen as subpaths, and
  the `contentworker` CLI as its binary.
- **Operations.** The fleet registry and renderer, idempotent provisioning, CI ring deploys
  (engine → media → api → delivery → web) with a point-in-time recovery bookmark before each
  migration, smoke and latency checks, and ordered rollback.

## Planned

- [ ] **Publish projection to object storage.** Render per-locale delivery documents to object
  storage (and list cards to the key-value cache) on publish, so a cache miss is served without the
  database. Deferred: the edge cache, the key-value tag cache and read replicas already keep
  delivery reads off the primary database.
- [x] **Separate media worker.** Published asset files, renditions and the width ladder are served
  by their own edge-cached worker at `media.<domain>`, gated by key-value entries the engine
  writes. Signed uploads and video streaming stay on the api.
- [ ] **Load testing, rewritten.** A delivery and management load profile against a seeded
  deployment (`SEED_SCALE`), confirming cache hits never reach the database.
- [ ] **Version history without the bodies.** Store a content hash and a change summary on each
  version at write time, so history lists need no archived bodies from object storage (one read
  per version today) and identical bodies can share an object.
- [ ] **Required plugins.** A per-plugin `required` flag so a plugin whose refusal is load-bearing
  blocks the write when it throws or times out, instead of being skipped.
- [ ] **Refuse a stale content-type save.** A save sends every detail field, so a dialog opened
  before someone else's save overwrites it (`group`, `description`, `agentInstructions`). Check
  the type the caller read against the stored one and answer `409` when it changed, on both
  surfaces.
- [ ] **Extension runtime: apps as packages.** Grow sandboxed plugins into installable packages
  that bring their own operations, workflow nodes, content types and admin UI, so integrations
  ship as packages on the runtime rather than in core. Seven PRs, each usable on its own:
  1. **Asset scopes.** `assets:read` and `assets:write`, implied by `preview:read` and
     `content:write` when scopes resolve, so no stored key, role or token changes.
  2. **Manifest v2 and operations.** Schema validation, the approval screen, sync operations, and
     REST, OpenAPI and MCP generated from one manifest.
  3. **Content models from packages.** Managed and seeded types with an owner, install and upgrade
     with a compatibility check; uninstall leaves every entry in place.
  4. **Workflow nodes.** App node types (`app:<package>/<node>`), the `poll` result, `external`
     waits with callbacks, a per-app limiter stateful edge object, compensations.
  5. **Host interface.** `content.resolve` projections, the asset calls (signed URLs, upload
     targets, import or replace from a URL), `asset.created`, event subscriptions.
  6. **Dogfood.** The in-house HTML renderer and a social campaigns package, built only on steps
     1–5 with no change to core.
  7. **Adobe packages.** PDF Services first, then Express once beta access is confirmed and it
     accepts signed object-storage URLs.

  Open before step 2: package operations in MCP without one tool per operation per install, a
  deployment-level install for per-company credentials, and the 2 s sync cap against provider
  token exchanges.
- [ ] **Plugin copilot: plugins from a prompt.** Describe a rule in plain language ("refuse to
  publish an article without a hero image and alt text") and get a draft plugin (manifest, bundle,
  an explanation and suggested test cases) to test against real entries and install through the
  existing consent screen. Like the workflow copilot it only proposes: it never installs, enables
  or saves, and generated code is one more untrusted author for the sandbox, the grant and the
  checksum. Scope is what plugins already do (logic on the five write hooks); new operations,
  screens and scheduled jobs wait for apps as packages. Five PRs, each usable on its own:
  1. **Install on MCP, and provenance.** `plugin_install` (REST has it, MCP doesn't: a gap in
     both surfaces today), and an expand-only `source` on installed plugins (`generated`, prompt
     id, model, prompt hash, drafted by).
  2. **Draft.** `draftPlugin` (`POST /spaces/:space/plugins/drafts`, `plugin_draft`): a brief
     built from the hooks, the capability → method map and the chosen content types' fields, on
     the `flagship` tier under the space's AI budget with the untrusted-content guard. Capabilities
     are set from the `caps.*` calls the bundle actually makes, not the model's claims; revising
     passes the draft back; `AI_MODE=mock` and off-schema answers fall back to a template.
  3. **Dry run.** `testPluginDraft` (`…/plugins/drafts/test`, `plugin_draft_test`): the draft in
     the real sandbox, keyed `draft:<checksum>`; reads are real as the caller, writes, publish, KV
     and tags are recorded rather than made, network is opt-in within `allowedHosts`. Returns
     pass, mutate or veto with before and after, the call log and the time against the 2 s hook
     budget. A test proves the store sees no write.
  4. **Admin.** "Describe a plugin" on the Plugins screen: code with a diff per revision, the
     manifest, each capability with a plain-language reason, the test panel, install (disabled),
     and "Change with AI" on a generated plugin through `upgradePlugin`'s re-approval rules.
  5. **Docs, skill and eval.** A plugin-authoring MCP skill (so outside coding agents can write
     plugins too), the docs, and an eval set of about 20 prompts scored by the dry run, which
     decides whether the `flagship` tier writes good enough plugins to ship or ship as beta.

  Open before step 2: whether enabling a generated plugin needs a signed-in person (safer, but the
  first deliberate break from both surfaces), and whether to wait and launch it with apps as
  packages.

### Before the first customer

Recovery targets not met yet (`docs/backup-and-restore.md`) and the move to a private fleet repo.

- [x] **Secret escrow.** The `Escrow secrets` workflow encrypts a deployment's secrets to a key held
  outside GitHub and the edge account. Run for the live deployment and decrypted; setting the values
  back joins the restore drill.
- [ ] **Off-account object storage copy.** Asset bytes, plugins and `versions/` have no second copy.
  Deferred until a customer is close; the plan is in the private fleet repo.
- [ ] **Restore drill.** Time a database restore against its 1-hour target.
- [ ] **Assistant recovery.** Nothing calls the conversation object's point-in-time recovery.
- [ ] **Fleet cutover.** Live since 2026-11-07: the registry, rings and every deployment's secrets
  are in the private repo, and this repo only dispatches to it. One deploy token, shared as the
  private repo's repository secrets, serves every deployment. Staging (its own zone) ships first in
  every release, and a registry change ships on its own push. The escrow workflow stays defined
  here and the private repo calls it, so its runs and artifacts aren't public; the first escrow of
  both environments from there succeeded on 2026-11-07. Left, in order:
  - [ ] Download both escrow generations, check they decrypt, keep them offline and delete the
        artifacts (`docs/backup-and-restore.md`).
  - [ ] Delete this repo's `production` environment and its repository-level edge account secrets,
        which any branch can read. Nothing reads them since the cutover.
  - [ ] Tick this item, and mark the cutover done in the private repo's README.
  - [ ] Provision the demo deployment, still held in the registry.

### Parity milestones

Gaps in what a headless CMS is expected to do, checked against this codebase and grouped into
milestones that each ship on their own. Every item is a use-case with an HTTP route and an MCP
tool. Not taken, by design: hierarchical tenancy, external AI providers, an SMTP mailer, an
in-browser model, page-per-language translation, and rich text or styles stored as markup.

#### M1. Quick wins

- [x] **Field guidance.** `help`, `placeholder` and `description` on every field; `in` options as
  `{value, label}`; a custom `message` on each validation rule. Agents read them from the model.
- [x] **Self-service password reset.** An emailed single-use code (hashed, expiring, attempt-capped,
  uniform responses), throttled like sign-in. Replaces "ask an admin to reset it". Human sign-in
  only, like the rest of it, so there is no route or MCP tool (agents don't have passwords).
- [x] **Webhook resend and test.** A stored delivery is re-sent through the outbox, signed afresh
  and logged with `resendOf`; a `webhook.test` event goes to one webhook (REST, MCP, the admin).
- [x] **Validate without saving.** `POST /entries/validate` and `entries_validate`: the save's checks,
  its errors, no write; capability-holding `entry:beforeSave` plugins are skipped and named.
- [x] **API keys on MCP.** `api_keys_list`, `api_key_create` (token shown once), `api_key_update`
  and `api_key_revoke`; minting a personal access token stays HTTP-only, for the reason in
  `docs/mcp.md`.
- [x] **Bulk trash, restore and purge, and trash retention.** `trash`, `restore` and `purge` bulk
  job actions through the single-entry use-cases; an hourly sweep through `purgeEntry` after a
  per-space retention window (off by default; never forced).

#### M2. Model and query parity

- [x] **Filter by referenced entry.** `fields.<link>[ref]=<id>` (`[refIn]` for several) and
  `links_to_entry=<id>` on Delivery, Preview, GraphQL and `entries_query`; Delivery pushes them down
  as an `IN` over the reference edges with one JSON parameter, Preview scans the draft's fields.
- [x] **Singleton types.** At most one entry outside the trash, held by a unique claim on every
  create path; Delivery and Preview `GET /singletons/:apiId`, a GraphQL root without `id`,
  `singleton_get`, the SDK's `getSingleton`; the admin opens the editor directly.
- [x] **Delete and clone a content type.** Delete refuses, naming them, while entries, linking
  types, menus, slug redirects or a URL pattern depend on it, or runs as a resumable
  trash-then-purge job (`content_type_delete`); `content_type.deleted`; clone copies the
  definition under a new `apiId` (REST, MCP, SDK, the admin's type menu).
- [x] **Authorship.** `created_by`, `modified_by`, `created_at` and `first_published_at` on entries
  and `created_by` on versions (0024, expand-only), stamped on every write path from the request's
  principal or the agent, workflow, plugin or scheduler acting; served as `sys` fields in
  Management and Preview (`sys.createdBy=me`), `firstPublishedAt` alone in Delivery; "Created by",
  "Last edited by" and a Mine filter in the admin.
- [x] **Richer queries.** `startsWith` and `between`, OR and AND groups in a `where` JSON parameter
  (≤ 4 deep, ≤ 20 predicates), component subfield paths through `json_tree` with bound keys, and
  distinct field values (`…/content-types/:apiId/fields/:field/values`, `entries_field_values`).
- [x] **Saved views.** Named filters, `where` trees, sort and columns per content type (or every
  type), personal or shared with the space (`content:manage`); space-scoped (`0029_saved_views`),
  validated by the live query's checks, run with the viewer's own grants; HTTP, MCP `views_*`,
  `cma.savedViews`, and the admin's views menu, URL list state and column picker.
- [x] **Delivery locales.** A per-locale "delivered" flag (0025, `locale_settings` beside
  `locales`): an undelivered locale is edited and previewed, while Delivery answers 404 for it,
  fallbacks skip it and the sitemap's `hreflang` alternates leave it out; and a text direction,
  served on the space config and set as `dir` on the admin's inputs.

#### Follow-ups from M1 and M2

Found while building and reviewing M1 and M2. None blocks a release.

- [ ] **Re-check a running job's starter.** Record who started a bulk job and check their access
  again before each chunk, so a trash or purge job stops when its starter loses access.
- [ ] **Audit promotion and cross-space clone.** Check both against per-type and field rules, as
  imports, snapshots and merge now are.
- [ ] **Delegated bearers and people.** Refuse invitations and member role changes from personal
  access tokens and OAuth tokens, so a short-lived token can't create a lasting admin.
- [ ] **Environment-wide checks in the use-cases.** Move `authorizeEveryContentType` from the HTTP
  routes and MCP tools into the use-cases with a required principal, so a new surface can't skip it.
- [ ] **Admin saves for read-only roles.** The editor sends every field, so a role with
  `readOnlyFields` probably gets a 403 on save. Confirm it, and send only what the role may write.
- [ ] **Linear email checks.** Replace the quadratic pattern in `isEmail` (`domain/auth/team.ts`) and
  `security/credentials.ts`, as the `email` preset already was.
- [ ] **Role version check.** A revision on `PUT /roles/:id`, closing the last read-then-write window
  in the Access sheet.
- [ ] **SDK paging.** `entries.list` sends `skip`, which the Preview list refuses; use `cursor` and
  return `nextCursor`.
- [ ] **Flaky browser tests.** Find the cause of the webhook dialog, webhook deliveries and asset
  library tests that fail under a full parallel run and pass alone.
- [ ] **Unused api email config.** Drop `EMAIL_FROM`, `EMAIL_FROM_NAME` and the `send_email` comment
  from `apps/api/wrangler.jsonc`; nothing on the api sends email.

#### Follow-ups from first-run onboarding

Found while building and reviewing the setup flow (`/setup` → `/setup/two-factor` → `/setup/space`).
None blocks a release.

- [ ] **A setup step for a due password change.** A person whose password change is due is held on
  the whole `/account` page inside the shell; give it a bare step like `/setup/two-factor`.
- [ ] **Back to Coworker after skipping.** "Skip for now" leaves the New space dialog as the only
  way to a first space; offer setting up with Coworker from the no-spaces notice too.
- [ ] **No space to reach.** A person whose role covers no space sees the no-spaces notice with
  nothing to do; say who can give them access.
- [ ] **Setup without a model.** Where the assistant has no model, open `/setup/space` on the New
  space form rather than a conversation that can't answer. Check it on a deployment.
- [ ] **Background installs in the conversation.** After Coworker creates a space with a starter
  that installs in the background, follow the install on its card, as the New space dialog does.
- [ ] **Keep recovery codes.** Copy all and download on the recovery codes shown after turning on
  two-factor, the one time they're shown.
- [ ] **Setup at phone width.** Walk the three setup pages on a phone and add them to the device
  tests.
- [ ] **One landing after setup.** Skipping lands on `/dashboard` and finishing lands on `/`; pick
  one.

#### M3. Collaboration

- [ ] **Entry locks.** A stateful edge object per entry: a heartbeat lease, request-unlock, admin
  takeover and a kick pushed over WebSockets; saves check the lock without a database write; agents
  take locks too. Appends a migration tag.
- [ ] **Notifications.** A per-person inbox written from the outbox dispatcher (never on a read
  path), an unread badge over the live stream, read and archive, a retention prune.
- [ ] **Anchored comments.** Comments pinned to a field path or rich-text block, with @mentions
  (feeding notifications), a due date and resolve.
- [ ] **Audit log, finished.** Rows past a per-deployment window archived to object storage as
  NDJSON and pruned, so the log stops growing in the database (the per-entry activity view has
  shipped). Whether people who can only read an entry see its activity, which names who acted and
  how, is still to decide: it takes `space:admin`, as the log does.

#### M4. Access

- [ ] **Teams.** People in many teams, team roles per space, grants unioned; SCIM groups map to
  teams instead of collapsing to one role.
- [ ] **Own entries only.** An `own` flag on a content-type grant, pushed down as a filter on
  `created_by` (needs M2 authorship).
- [ ] **Per-type model management.** A `manage` action on content-type grants instead of the
  space-wide `content:manage`.
- [ ] **View as a role.** A space admin previews the admin as another role; the web worker signs the
  assumed role into `x-cw-principal`, and access can only narrow. Security review first.
- [ ] **Config as code, wider.** `contentworker model apply` also covers roles, webhooks and menus
  (never key secrets).

#### M5. AI context

- [ ] **AI projects.** Reusable instructions, reader and writer personas, and reference assets (their
  extracted text), with a tool to read a reference file; selectable in generation, canvas and agents.
- [ ] **AI settings per capability.** Per space: enabled, `ModelTier`, and guidance appended to the
  built-in prompt.
- [ ] **Change summaries.** A narrative summary of a version diff, over the existing deterministic
  diff.

#### M6. Visual editing

Built on Blocks and the frontend runtime. Layouts stay a typed tree; rich text stays a
`RichTextDocument`; styling is design tokens and enum props, never raw CSS.

- [ ] **Live preview channel.** `@contentworker/sdk/live-preview`: the admin frames the customer's
  frontend and pushes unsaved form state as patches; clicks select fields back. Spec (proposed):
  [`docs/specs/live-preview-channel.md`](docs/specs/live-preview-channel.md). The page side
  (`connectPreview`) and the admin side (the entry editor's Site view) are in place; Coworker's
  proposals as ghost blocks are next.
- [x] **Blocks renderers.** `<Blocks components={…} />` for React, Vue and the frontend runtime, typed
  by codegen. `<Blocks>` in `@contentworker/sdk/react`, `<CwBlocks>` and `useBlock` in
  `@contentworker/sdk/vue`, and `resolveBlocks` / `renderBlocks` in `@contentworker/sdk/blocks`
  for any other renderer: a component per block id, renamed blocks read through the catalog's or
  variants' aliases, a `fallback` for unknown ones, slots rendered with the same components, keys
  from `_key`, ghosts from `view.ghosts`, and `data-cw-ref` / `data-cw-slot` marks only with
  `preview`. Codegen emits a type per block and `BlockTypes` from the catalog in force (or the
  variants), and `contentworker types --blocks` takes a blocks file. Still to come: the frontend
  runtime (`@contentworker/frontend`) rendering with `renderBlocks`, and an SDK release (0.4.0) to
  ship it.
- [x] **Layout patches.** `patchBlocks` with key-addressed create, update, move and remove, for
  agents and the editor alike (#185): insert, update, move, remove and duplicate ops by `_key`,
  held to `expectedVersion`, over REST (`PATCH …/entries/:id/blocks`, an outline at
  `GET …/entries/:id/blocks` and a dry run at `POST …/entries/blocks/validate`), MCP
  (`entry_blocks_patch`, `entry_blocks_outline`, `entry_blocks_validate`) and the management SDK.
  Coworker proposes block changes through it, the canvas applies and undoes its edits with the same
  `applyBlockPatch` (keeping each change's inverse), and live preview sends them as `blocks.patch`.
- [ ] **Layout-aware generation.** Generation that knows a field's block catalog and resolves images
  through asset search. The backend is in place: `generateBlocks` composes one blocks field or slot
  from the blocks the rules allow there (a JSON schema per place, `blocksSchemaFor`), finds images
  by description in the asset library, and answers insert ops judged by the block patch's dry run,
  refusing locked or full places before the model is called (REST `…/entries/blocks/generate`, MCP
  `entry_blocks_generate`, the management SDK, and Coworker's tools). Drafts and Canvas fill
  top-level blocks fields too, and no longer fail on required fields they can't fill. The admin
  side (composing from the canvas and the dock) is next; rich text inside generated blocks is not
  generated yet.
- [ ] **Layout model.** Deeper nesting than three levels, and per-breakpoint overrides of token
  props. (Slots, `allowedChildren` and `allowedParents` shipped with blocks from code.)
- [x] **Blocks from code.** `contentworker blocks push` maps component manifests (JSON data:
  token and enum props, slots with `allowedChildren`, `allowedParents`, aliases for renamed ids,
  thumbnails) to Blocks variants, versioned per environment, over REST, MCP and the management
  SDK, with block usage counts and a read-only catalog screen in Build → Blocks. The block config
  that narrows (never widens) what code allows per target and per slot (fewer blocks, tighter
  counts, locked slots) is in place at the API: REST `/block-config`, MCP `blocks_config_*` and
  the management SDK, with every entry save and block patch held to it. Build → Blocks sets it
  (Rules: per place, the blocks it takes, its bounds and a lock, beside the code's rule; stale
  parts listed and removed on save), and the canvas and the entry form honour it from
  `/block-config/effective`: the dock and Add offer only the allowed blocks, and both judge a save
  as the server will. Exports, snapshot imports and environment clones carry the catalog in force
  and its config (each restarting at version 1 in the copy; an import names what no longer passes
  the push and set checks in its report).
- [ ] **Canvas editor.** A toolbox, selection overlay and undo in `apps/web` over the preview channel.
  The canvas (`/content/:typeId/:entryId/canvas`) is in place: seams from the page's `layout`, a
  dock offering exactly what a slot takes, an inspector (Content, Data, Look), Layers as the
  keyboard path, undo by inverse block-patch ops, and a save held to `expectedVersion`. Still to
  come: Coworker's "Fill this slot" and ghost proposals (`host.propose` is the seam), dragging
  blocks with a fine pointer, block thumbnails (the admin's `img-src` takes no other origin), and
  per-breakpoint overrides.
- [ ] **Frontend SDK extras.** `client.live()` and `useLiveEntry`, a Next.js draft-mode helper, a
  preview URL template per content type, and a "connect a frontend" screen that mints a delivery key
  and prints its config.

#### Follow-ups for M6

From the live preview spec and a review of a second implementation of its channel.

- [x] **Page report cap.** A page reports at most 50 entries (`PAGE_REPORT_LIMIT`), as the owner
  chose; the admin still accepts up to 200 (`MAX_PAGE_ENTRIES`) from sites on SDK 0.3.0. Ships to
  sites in the next SDK release. The other channel decisions are recorded in the spec.
- [x] **One block patch engine.** The page keeps its own engine (`applyLivePatch`), and
  `packages/http/test/live-preview-patch-parity.test.ts` runs the same patches through it and the
  domain's `applyBlockPatch`.
- [x] **Locked regions on the canvas.** Lock a region larger than one slot (a run of blocks, or a
  block and everything inside it) as one unit. Locking one slot is in place: the block config's
  `locked`, set in Build → Blocks, refuses a save that changes that slot's blocks, and the canvas
  and the entry form honour it (no seams; no move, duplicate or remove; Layers shows the lock).
  Design (per-entry locks keyed by `_key`):
  [`docs/specs/locked-regions.md`](docs/specs/locked-regions.md). The backend is in place (the
  `lock` action, `…/entries/:id/block-locks`, `entries_block_locks_*`, every save held to the
  locks), and so are the canvas (Lock and Unlock in the inspector, runs by shift-select, no seams
  inside a region, the lock on its outline and in Layers, stale locks cleared from the Checks) and
  the entry form (the lock on the blocks' cards, frozen fields read only).
- [ ] **Token values checked everywhere.** The frontend runtime runs `isSafeTokenValue` on every
  value it writes into a CSS custom property, not only on live preview patches.
- [x] **Block config as code.** Build → Blocks' Rules card switches between Rules, **Code** and
  **Narrowed from code**. Code is the config as `PUT …/block-config` takes it (`{ targets, blocks }`,
  normalized, in the catalog's order), read-only JSON with line numbers, folding and Copy. Narrowed
  from code diffs each place's code rule against the one in force (side by side from md, one
  column on a phone; − and + beside changed lines), only the places that differ unless Show all
  is on, ignored parts listed where they lie. With unsaved edits both show the draft, marked
  Unsaved: the exact request before Save. CodeMirror 6 (`@codemirror/*`, `@lezer/highlight`) is a
  lazy chunk fetched when a code view opens; no route ships it.

Checked against the merged channel and not needed:
- **An admin-started reconnect.** The frame route creates its host before it gives the iframe a
  `src`, and never revalidates (`shouldRevalidate`), so no host starts after, or is rebuilt under,
  a page that already loaded.
- **JSON-only values on the wire.** The page checks field names, not values, so an `undefined` or a
  date reaches its renderer instead of dropping the message.
- **Session hardening.** A retried offer that crosses the accept is answered again on the same
  channel: one extra round trip, no broken state. Revs count per entry and the canvas edits one
  locale at a time, so replies need no locale.
- **Dropping `allow-popups`.** A popup the framed site opens is the site's own window; the admin
  drops whatever it posts (the sender check), and without popups the site's `target="_blank"`
  links would stop working in preview.

Considered and left out for now: letting an agent drive the customer's page (scripts, clicks,
screenshots; Coworker changes the page only as proposals a person accepts), a block playground
compiled in the browser, and media preparation in the browser (Images and Stream transform on the
server).

#### M7. Organization and assets

- [ ] **Entry folders.** Generalize asset folders with a `kind` and give entries a folder.
- [ ] **Folder permissions.** Owner, editor, viewer and no-access per team or person, inherited down
  the tree with no-access winning, enforced in use-cases; denied prefixes passed as one JSON
  parameter.
- [ ] **Capture metadata.** EXIF and IPTC read in the ingest workflow; credit and copyright pre-fill
  usage rights; camera and capture date become facets.
- [ ] **Typed asset fields.** A per-space schema for asset custom fields, validated, with bulk edit.
- [ ] **Private published assets.** An `access: private` media gate that requires a short-lived
  signed URL issued to an authorized key.
- [ ] **Upload scanning.** A scan step in ingest and a `quarantined` status that blocks publish and
  the media gate.

#### M8. Platform

- [ ] **Space lifecycle.** Rename, disable, and delete as a purge workflow.
- [ ] **One jobs view.** `jobs_list` and `job_cancel` across bulk, import, snapshot and zip jobs.
- [ ] **Workflow bypass.** An audited emergency publish for space admins.
- [ ] **External references.** An `ExternalRef` field (`provider`, `id`, `snapshot`) whose provider
  is a sandboxed plugin with `search` and `get`; resolved by Delivery, pickable by agents. Rides on
  the extension runtime.
- [ ] **More extension points.** `beforeUnpublish`, `asset:beforeDelete` and
  `contentType:beforeSave` hooks; `page` and `dashboard-widget` admin targets with a per-person
  dashboard layout.
- [ ] **Developer setup.** `contentworker mcp setup --client <name>`; developer skills for building a
  plugin, integrating a frontend and configuring SSO; a debug header on the api for principals with a
  debug grant.
- [ ] **Admin branding.** Title and logo per deployment; accents stay within the design tokens.
- [ ] **Experiments.** A/B variants of an entry, bucketed at the edge by cookie without varying the
  cache key, with a workflow that graduates the winner.

#### M9. Parity from the second survey

Gaps found by auditing the surveyed CMS against this codebase. Every item is a use-case with an HTTP
route and an MCP tool unless it says otherwise. Not taken, by design: adapters for other databases,
storage or email; multi-tenancy inside a deployment; code-defined models and admin overrides; and
Markdown or HTML in any API response.

Agents:

- [x] **Tools by scope.** `tools/list` shows a caller only what its scopes can use (`tool-scopes.ts`);
  an unlisted tool stays callable and answers with the scope it needs.
- [x] **Agent instructions.** Plain-text `agentInstructions` on a content type, read with the model
  and never delivered.
- [ ] **MCP prompts and resources.**
- [ ] **Slim write responses.** Return ids by default and full documents on request, if the current
  tools don't already.

Editing:

- [x] **Bulk field edit.** A bulk job action that sets fields across entries, checking validation and
  field grants on each.
- [ ] **Autosave.** Debounced drafts buffered in the M3 entry-lock object, not a version per
  keystroke: the database has one writer and versions are append-only.
- [ ] **Manual entry ordering.** Drag and drop on fractional index keys, with a sort key Delivery can
  order by.
- [ ] **Copy to locale.**

Model and query:

- [ ] **Hierarchical entries.** Parent links with cycle checks, breadcrumbs and full slug paths; a
  path change cascades through a bulk job and leaves automatic `301`s.
- [ ] **Per-locale publishing.** A draft or published status per locale. Changes the entry model,
  Delivery and releases, so settle the design before forms.
- [ ] **Reverse-reference field.** A declared field returning the entries that link here, without
  raising Delivery's read counts unless the change says why.
- [ ] **Geo queries.** `near` and distance on `Location`, over a derived geohash or bounding-box
  index.
- [ ] **Compound uniqueness.** Unique across two or more fields, on the existing unique claims.
- [ ] **Dynamic reference filters.** Limit what a link can pick, enforced on save.
- [ ] **Timezone on date fields.**
- [ ] **Per-request fallback override.** `fallback-locale=none`, as a new optional Delivery input.

Forms:

- [ ] **Form builder.** Forms defined in the admin, stored submissions, emails, and a confirmation or
  redirect. Turnstile against bots, no write on Delivery's read path, and a retention period for
  personal data. No payment fields.

Assets, admin and hardening:

- [ ] **Asset from a URL.** Paste a URL to upload, through the `url-safety.ts` guard.
- [ ] **Saved crop rectangle.**
- [ ] **Entry list export.** A filtered list as CSV or JSON, as a resumable job.
- [ ] **Search-result preview.** Beside the `Seo` field's length hints.
- [ ] **Group-by in the entry list.**
- [ ] **Share a saved view with named people.** After M4 Teams.
- [ ] **Floating admin bar.** An SDK component for customer sites, over `adminEditUrl`.
- [ ] **GraphQL cost limit.** Beside the depth limit.
- [ ] **Admin translations.** Only with non-English customers.

Additions to earlier items: a read-only view for whoever doesn't hold an M3 entry lock, device-size
breakpoints in the M6 preview channel, and a Recently Viewed and Pinned widget on the M8 dashboard.
