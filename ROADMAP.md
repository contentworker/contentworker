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
  workflows, agent schedules and reviews, per-space budgets (a stateful edge object), per-space
  AI settings per capability (on or off, tier, fenced guidance), provenance,
  related and duplicate detection, hybrid and semantic search, RAG.
- **Integration.** Signed webhooks with a delivery log, event-triggered functions, app
  extensions, sandboxed plugins in isolated edge workers (with per-plugin `kv:storage` and
  operator settings, secrets sealed), the transactional outbox with lease-claimed relay.
- **Access.** CMA/CDA/CPA keys, ten scopes (`assets:read` and `assets:write` held by
  implication with `preview:read` and `content:write`), roles with per-type and per-field grants (read,
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
- [x] **Refuse a stale content-type save.** A save sends every detail field, so a dialog opened
  before someone else's save overwrote it (`group`, `description`, `agentInstructions`). A save
  now carries the `expectedVersion` it read (REST, MCP, the management SDK and `model apply`) and
  is refused with a `409` naming the stored version when it changed; the admin's dialog keeps the
  edits and offers to load the latest or copy them.
- [ ] **Extension runtime: apps as packages.** Grow sandboxed plugins into installable packages
  that bring their own operations, workflow nodes, content types and admin UI, so integrations
  ship as packages on the runtime rather than in core. Seven PRs, each usable on its own:
  1. ~~**Asset scopes.**~~ Shipped: `assets:read` and `assets:write`, implied by `preview:read`
     and `content:write` when scopes resolve, so no stored key, role or token changes.
  2. **Manifest v2 and operations.** Schema validation, the approval screen, sync operations, and
     REST, OpenAPI and MCP generated from one manifest. Shipped: manifest v2 with typed sync
     operations (`app_operations_list`, `app_operation_invoke`, `POST …/apps/:plugin/operations/:op`,
     a per-space OpenAPI document), run with the plugin's grant narrowed to the caller's, and a
     hook's fetch capped at its remaining budget. Still planned: `async` operations on a durable
     workflow returning a job id, and deployment-level connections with host-managed token
     exchange (`caps.connection.fetch`).
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

  Decided (2026-11-10), shaping step 2 onward:
  - **Operations on MCP** go through two generic tools, `app_operations_list` (each installed
    package's operations with their input and output schemas) and `app_operation_invoke`
    (package, operation, input), mirrored in REST as `POST …/apps/:package/operations/:op`. The
    tool list stays fixed per deploy, and scope filtering and audit apply unchanged.
  - **Shared credentials** live in deployment-level connections (provider, sealed credentials,
    the spaces allowed to use them), created once by a deployment administrator. Code, grants and
    enablement stay per space; a space binds a connection and still approves its own capabilities.
  - **Time.** Hooks keep the 2 s cap, since they block a save, and a plugin's fetch timeout is
    capped at the budget remaining (it can be 5 s today). The host runs token exchange and
    refresh for connections in the engine and caches tokens; a plugin calls
    `caps.connection.fetch` with auth injected and never sees the secret. Sync operations get
    about 10 s; longer work is declared `async` and runs on a durable workflow that returns a
    job id.
- [ ] **Attribute-based access to assets (ABAC).** Administrators govern assets by the attributes
  each one carries (classification, brand, region, client, license, kind), not by the folder it
  sits in. Roles gain asset grants beside their content grants: each grant has an effect
  (`allow` or `deny`), actions (`read`, `download` of the original, `write`, `publish`,
  `delete`) and a condition, a small JSON expression over asset attributes (`all`, `any`,
  `not`, `eq`, `in`, `contains`, `exists`, before and after for dates). A role without asset
  grants stays unrestricted, so no stored role changes; a space policy can add deny rules every
  role but Administrator obeys (no one reads an asset whose license expired). Changing a governed
  attribute needs the policy to allow the asset both before and after, so no one relabels an
  asset out of a rule. One domain decision, `assetAccess(principal, asset, action)`, and a
  compiler from a condition to D1 filters serve both surfaces. Six PRs, each usable on its own:
  1. **Asset metadata schema.** Typed, validated custom asset fields per environment in place of
     free-form `metadata.fields`, with expression indexes on the governed ones and an admin
     editor. Rules need typed attributes to be written against.
  2. **Policy and Management reads.** The grant model, the evaluator and the condition compiler,
     `asset_grants` on roles (an expand-only migration), enforced on asset get and list over REST
     and MCP, paging and counts filtered in the query (within the 100-parameter cap).
  3. **Every other asset path.** Search (over-fetched, then filtered, with facets and totals
     counted after filtering), versions, usage, zips, collections, share links, bulk jobs, and
     the AI paths (alt text, image search for layouts, RAG, Coworker). An entry that links an
     asset the reader can't see shows a restricted stub, with no title or file.
  4. **Delivery, Preview and media.** Asset grants join the visibility profile the delivery cache
     is keyed by. A restricted published asset leaves the public canonical URL: the media gate
     marks it signed-only and it is served through short-lived signed URLs, as draft reads are.
  5. **Admin.** A rule builder under Roles, a "test as role" preview of which assets match, and
     who can see an asset on its detail screen; policy changes and denied reads in the audit log.
  6. **Person attributes.** Conditions on the reader as well as the asset (department or region
     from SCIM or OIDC, as in `user.region == asset.region`).

  Open before step 2, with the option recommended first: whether rules apply to roles only to
  start (recommended, person attributes in step 6) or to person attributes from the start;
  whether a restricted asset's published file becomes signed-only (recommended, the only way the
  rules hold against someone holding the URL) or stays public; whether asset grants deny by
  default once a role has any (recommended, an allowlist) or allow by default (a denylist); and
  whether a key with content grants keeps reading no assets unless its asset grants allow them
  (recommended, nothing widens) or that rule is relaxed.
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

  Decided (2026-11-10): it ships on today's five hooks, without waiting for apps as packages.
  Agents may draft, test and install a generated plugin disabled, but only a signed-in person
  can enable one whose `source` is `generated`: a deliberate, documented exception to both
  surfaces, because prompt-injected code must not go live without a human.

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

- [x] **Re-check a running job's starter.** A bulk job records who started it (`config.startedBy`:
  a key id, a membership id, or the deployment) and resolves them again before each chunk, so a
  trash or purge job whose key is revoked, or whose person is disabled or re-roled, stops as
  `cancelled` (`starter_lost_access`) and is audited; system jobs and older rows run as before.
- [x] **Audit promotion and cross-space clone.** Requesting, approving and rejecting a promotion
  take every content type alike with no field rules, as merge does, and `lock` to copy entries
  (a merge of entries takes `lock` too)
  (the approver's grants are the ones in force at apply); a role limited per type sees only the promotions whose types it can
  read in full; a clone checks its target space in the use-case.
- [x] **Delegated bearers and people.** Refuse invitations and member role changes from personal
  access tokens and OAuth tokens, so a short-lived token can't create a lasting admin.
- [x] **Environment-wide checks in the use-cases.** Snapshot export and import, clone, merge and
  space export import check `authorizeEveryContentType` (and a clone's target space, and
  `addLocales`) in the use-case, with a required caller (`SYSTEM_CALLER` for work already
  authorized), so a new surface can't skip it.
- [x] **Admin saves for read-only roles.** Confirmed: the editor sends every field it read, so a
  role with `readOnlyFields` got a 403 on save. An update and its dry run now pass the stored
  fields to `assertWritableFields`, which lets a read-only field through when every locale sent
  holds its stored value (the save keeps it anyway); a changed value, or a denied field at any
  value, is still refused. REST and MCP alike, so the form and canvas need no change.
- [x] **Linear email checks.** Replace the quadratic pattern in `isEmail` (`domain/auth/team.ts`) and
  `security/credentials.ts`, as the `email` preset already was.
- [x] **Role version check.** A `version` on every role and an optional `expectedVersion` on
  `PUT /roles/:id` and `role_update` (a stale one is a `409` naming the version in force), with the
  save a compare-and-set on it, so the Access sheet's save can't undo someone else's.
- [x] **Person version check.** A `version` on every team member, with each save, removal and SSO
  first-sign-in link a compare-and-set on it (the update never inserts, so a removed person stays
  removed), and an optional `expectedVersion` on `PATCH /members/:id` and `role_preset_assign`, so
  a change that read someone before an admin disabled, demoted or removed them can't undo it.
- [x] **SDK paging.** `entries.list` sends `skip`, which the Preview list refuses; use `cursor` and
  return `nextCursor`.
- [ ] **Flaky browser tests.** Find the cause of the webhook dialog, webhook deliveries and asset
  library tests that fail under a full parallel run and pass alone.
- [x] **Unused api email config.** Dropped `EMAIL_FROM`, `EMAIL_FROM_NAME` and the `send_email`
  comment from `apps/api/wrangler.jsonc`: the fleet binds `EMAIL` only on the engine and web, so
  the api's `makeEmail` never had a sender to read them for.
- [ ] **Last admin across rows.** Two demotions, disables or removals of the last two admins, made
  at once, can both land: each member's compare-and-set guards only its own row. A team-level
  version, bumped in the same unit as every write that changes who is an admin, would close it.

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
- [x] **AI settings per capability.** Per space: enabled, `ModelTier`, and guidance appended to the
  built-in prompt.
  - [x] **Deployment tier cap.** `AI_MAX_TIER` (the registry's `aiMaxTier`) holds every model call
    to at most that tier, whatever its source; settings above it are kept and reported as
    `effectiveTier`, and the admin's select disables the tiers above it.
- [ ] **Change summaries.** A narrative summary of a version diff, over the existing deterministic
  diff.

#### M6. Visual editing

Built on Blocks and the frontend runtime. Layouts stay a typed tree; rich text stays a
`RichTextDocument`; styling is design tokens and enum props, never raw CSS.

- [x] **Live preview channel.** `@contentworker/sdk/live-preview`: the admin frames the customer's
  frontend and pushes unsaved form state as patches; clicks select fields back. Spec:
  [`docs/specs/live-preview-channel.md`](docs/specs/live-preview-channel.md). The page side
  (`connectPreview`), the admin side (the entry editor's Site view and the canvas) and Coworker's
  proposals as ghost blocks are in place: while a Coworker block-patch card waits for an answer,
  the page shows its blocks as ghosts (`proposals`, `proposed: true`), the admin marks them
  "Proposed", Not now takes them back and Confirm saves through the card.
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
- [x] **Layout-aware generation.** Generation that knows a field's block catalog and resolves images
  through asset search: `generateBlocks` composes one blocks field or slot
  from the blocks the rules allow there (a JSON schema per place, `blocksSchemaFor`), finds images
  by description in the asset library, and answers insert ops judged by the block patch's dry run,
  refusing locked or full places before the model is called (REST `…/entries/blocks/generate`, MCP
  `entry_blocks_generate`, the management SDK, and Coworker's tools). Drafts and Canvas fill
  top-level blocks fields too, and no longer fail on required fields they can't fill. The admin
  composes from both ends: the Generate dialog outlines the drafted blocks and names the images
  the library had no match for, and the canvas asks Coworker to fill a seam, its proposal shown as
  ghosts until confirmed. Rich text inside generated blocks is not generated yet.
- [x] **Layout model.** Deeper nesting than three levels, and per-breakpoint overrides of token
  props. (Slots, `allowedChildren` and `allowedParents` shipped with blocks from code.) Deeper
  nesting shipped: blocks slots nest six levels (the page's blocks field counting as 1,
  `MAX_BLOCK_DEPTH`), plain components keep three among themselves, the AI layout schema stays
  inline and shares a repeated block shape through `$defs` only past a size budget, RAG indexes
  text at the full depth, and the admin's blocks trees indent half a step past the third level.
  Per-breakpoint overrides (`docs/specs/breakpoint-overrides.md`): the backend shipped. The
  catalog push declares `breakpoints` and each block's `responsive` props; blocks store overrides
  in `_responsive`, validated as their props, with stale ones dropped on save and counted by the
  push (`staleOverrides`); block patches, frozen regions, copies, REST, MCP, GraphQL
  (`_responsive`), codegen and `resolveBlocks` / `responsiveProp` carry them. The canvas edits them:
  its width presets are Base and the catalog's breakpoints, the Look tab sets an override at the
  breakpoint in view (inherited values say where from; Reset inherits again), Layers marks a block
  that carries one, and the entry form lists them read-only; an undo that spans a save keeps its
  carried overrides (the save reads the version before once).
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
  the push and set checks in its report). Promotions copy both, pinned on both sides, and wait for
  approval when they change which blocks go where, a slot's counts or locks, or remove blocks a
  type holds; environment compare reports how they differ, as a promotion judges it (a merge
  never copies them). Release note: after a rollback past this, reject waiting promotions
  requested with blocks (older code applies them without the blocks).
- [x] **Canvas editor.** A toolbox, selection overlay and undo in `apps/web` over the preview channel.
  The canvas (`/content/:typeId/:entryId/canvas`) is in place: seams from the page's `layout`, a
  dock offering exactly what a slot takes, an inspector (Content, Data, Look), Layers as the
  keyboard path, undo by inverse block-patch ops, a save held to `expectedVersion`, and
  Coworker's "Ask Coworker to fill this" at a seam (the slot's allowed blocks, bounds and the
  blocks around it, quoted to the model; the card holds the patch to that slot) with its proposal
  shown as ghosts on the page and in Layers until it is confirmed or declined. Block thumbnails
  are drawn where blocks are picked (the dock, the entry form's Add block menu, Build → Blocks)
  for a manifest's `{ assetId }`, all of a catalog's read in one `GET …/assets?ids=` lookup; a
  `{ url }` thumbnail isn't drawn (the admin's `img-src` takes no other origin). With a fine
  pointer the selected block drags by its grip to a seam of its slot or another that takes it,
  held to the dock's judgement (the slot's blocks, the block config's narrowing and counts, locks
  and locked regions) and the save's, as one `move` op that undo inverts; touch and the keyboard
  move blocks with the inspector's Move up, Move down and Move to, and Layers. A move stays within
  its blocks field. Per-breakpoint overrides are edited in the Look tab at the width in view (see
  Layout model).
- [x] **Frontend SDK extras.** `client.live()` over the live stream (reconnecting with backoff,
  stopping when the key is refused) with `useLiveEntry` / `useLiveEntries` for React and Vue; a
  Next.js draft-mode helper (`@contentworker/sdk/next`: a route that checks the preview token, and a
  client that, in draft mode, reads only the preview link's entry with the link's own token, and
  everything else from Delivery, so a site needs no Preview key); the preview URL template per
  content type, now settable alone (`PUT …/content-types/:apiId/preview`,
  `model_set_content_type_preview`); and Settings →
  Connect a frontend, which mints a Delivery key (and a Preview key) through `connectFrontend`
  (`POST …/frontend-connections`, `frontend_connect`), prints the config for the frontend runtime,
  the SDK, Next.js and live preview, sets the preview URLs, and checks a page connects through the
  Site frame. Ships to sites in the next SDK release. Runtime sites connect for live preview
  from `@contentworker/frontend` 0.5.0 (contentworker/site #7): `/__preview` pages may be framed
  only by the admin's origin (`CONTENTWORKER_ADMIN`, else the deployment's own domain).

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
- [x] **Token values checked everywhere.** The frontend runtime runs `isSafeTokenValue` on every
  value it writes into a CSS custom property, on every render, public or preview, not only on live
  preview patches (`ctx.cssVars`, `@contentworker/frontend` 0.5.0).
- [x] **Block config as code.** Build → Blocks' Rules card switches between Rules, **Code** and
  **Narrowed from code**. Code is the config as `PUT …/block-config` takes it (`{ targets, blocks }`,
  normalized, in the catalog's order), read-only JSON with line numbers, folding and Copy. Narrowed
  from code diffs each place's code rule against the one in force (side by side from md, one
  column on a phone; − and + beside changed lines), only the places that differ unless Show all
  is on, ignored parts listed where they lie. With unsaved edits both show the draft, marked
  Unsaved: the exact request before Save. CodeMirror 6 (`@codemirror/*`, `@lezer/highlight`) is a
  lazy chunk fetched when a code view opens; no route ships it.
- [ ] **Merge holds to the locks it read.** A merge's entry write (`applyEntry` in
  `packages/application/src/branching.ts`) doesn't carry the block-lock guard `saveEntryDraft`
  does, so a lock set between the merge's read and its write is overwritten without a `409`. Not
  a hole (the merger holds `lock` and could lift it), but a lost race should be a conflict. Pass
  the guard, with a test that sets a lock mid-merge.

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
