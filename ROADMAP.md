# contentworker roadmap

**v2: edge-only (2026-10-31).** contentworker was rebuilt on edge workers end to end. An edge
SQL database replaced Postgres as the system of record, and the single platform worker became five
edge workers
split by traffic profile: `apps/web` (admin + human auth), `apps/api` (Management and Preview
REST, MCP, OAuth, uploads and signed reads, live), `apps/delivery` (the cached public Delivery
API), `apps/media` (published asset files at the edge) and `apps/engine` (queues, cron, stateful
edge objects, durable workflows). Tenancy is one isolated deployment per
customer (`deployments/*.jsonc`, rendered by `scripts/fleet.ts`). The domain and application
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
  validations, components and unique values; the entry lifecycle (draft → published → archived,
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
- **Access.** CMA/CDA/CPA keys, eight scopes, roles with per-type and per-field grants and
  presets, the last-administrator guard, OAuth 2.1 with the device flow for MCP clients, personal
  access tokens, preview links, rate limits, the audit log, secrets sealed at rest with a daily
  reseal sweep. Human sign-in in the web app: passwords, passkeys, TOTP, OIDC, SCIM, setup and
  recovery codes, with the person forwarded to the api as a signed `x-cw-principal`.
- **APIs.** Management, Preview and Delivery REST, GraphQL, live SSE through a stateful edge object,
  OpenAPI 3.1 with a Scalar explorer, and the MCP server (184 tools, plus skills and the docs
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
