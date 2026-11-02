# contentworker roadmap

**v2: Cloudflare-only on D1 (2026-10-31).** contentworker was rebuilt on Cloudflare end to end.
D1 replaced Postgres as the system of record, and the single platform Worker became five Workers
split by traffic profile: `apps/web` (admin + human auth), `apps/api` (Management and Preview
REST, MCP, OAuth, uploads and signed reads, live), `apps/delivery` (the cached public Delivery
API), `apps/media` (published asset files at the edge) and `apps/engine` (queues, cron, Durable
Objects, Workflows). Tenancy is one isolated deployment per
customer (`deployments/*.jsonc`, rendered by `scripts/fleet.ts`). The domain and application
layers, and their tests, carried over.

Removed in v2, and not coming back:

- Postgres, its hosted provider and connection pooling, the Node migrator and its container: D1
  with hand-written, expand-only SQL migrations (`packages/db/migrations`) applied by CI.
- The managed multi-tenant control plane and hostname dispatch: one deployment per customer.
- External AI providers and external vector and search stores: Workers AI through AI Gateway,
  Vectorize, and FTS5 search shards in Durable Objects.
- Per-request payment for delivery content, the email SDK, and the S3-API blob adapter (R2 is
  bound natively).
- The Vite admin SPA with bearer-token sign-in: the React Router admin in `apps/web`, with
  passwords, passkeys, TOTP, OIDC single sign-on, SCIM and a one-time `/setup` code.
- The load-test suite, until it is rewritten (below).

## Shipped

Everything below is built and tested on v2.

- **Content.** Spaces, environments (create, delete) and aliases; locales with fallback chains; typed fields with
  validations, components and unique values; the entry lifecycle (draft → published → archived,
  trash, purge, duplicate); versions with diff and restore; references and `include`; rich text
  with HTML import; slugs; redirects (delivery data a front end or edge Worker applies: exact and
  pattern sources, import and export, loop checks, and an automatic `301` when a publish changes a
  slug a content type's URL pattern names).
- **Publishing.** Releases (atomic multi-entry publish), scheduled actions, bulk actions as
  resumable jobs, branch compare and merge, environment promotion with a risk check and approval,
  environment snapshots (export, plus import and clone as resumable jobs; a clone's export and
  checks run in the engine too), CSV, JSON and WordPress import, and whole-space import from the
  JSON space export format (model, locales, tags, entries with links remapped, asset files copied).
- **Assets.** Signed R2 uploads, Images transforms, Stream video, localized alt text and focal
  point, AI alt text and auto-tagging, asset usage; a library with folders, filters and keyset
  paging, bulk moves, archive and restore, and delete refused while entries link to an asset.
  Published files on the media Worker at stable, immutable URLs with per-space renditions and a
  width ladder for `srcset`, revoked on unpublish; one delivered-asset shape for REST, embeds,
  GraphQL and Preview; short-lived signed URLs for Management and Preview reads. Ingest on upload
  (R2 notification → Workflow): content hash and duplicate marker, dimensions, AI alt text and
  tags where empty, text from documents and audio; hybrid asset search with facets in
  Management, MCP and Delivery, and a reindex job for older assets. File versions with replace
  and restore (the old version's URLs retired on republish), usage rights with an expiry the
  engine enforces and an embargo that blocks publishing, and move, tag, publish, unpublish and
  archive as resumable bulk jobs. Collections (named, ordered, many-to-many, carried by export,
  import and clone, served by Delivery), expiring revocable share links on the media origin
  (published assets only, optional password), multipart uploads past 100 MiB (up to 5 GiB), and zip
  downloads built by a Workflow.
- **Taxonomy and collaboration.** Concept schemes, concepts and tags, each with a slug, description
  and localized labels, served on Delivery with published usage counts and filterable by slug for
  archive pages; comments, tasks, legacy
  workflow steps, and editorial workflow graphs on Cloudflare Workflows (runs, timeline,
  approvals with separation of duties, the copilot).
- **AI.** Generation, canvas authoring, translate, summarize, autofill, tags, governed AI
  actions, the enrich/moderate/curate/repurpose agents and the review watcher on Cloudflare
  Workflows, agent schedules and reviews, per-space budgets (a Durable Object), provenance,
  related and duplicate detection, hybrid and semantic search, RAG.
- **Integration.** Signed webhooks with a delivery log, event-triggered functions, app
  extensions, sandboxed plugins on Worker Loader (with per-plugin `kv:storage` and
  operator settings, secrets sealed), the transactional outbox with lease-claimed relay.
- **Access.** CMA/CDA/CPA keys, eight scopes, roles with per-type and per-field grants and
  presets, the last-administrator guard, OAuth 2.1 with the device flow for MCP clients, personal
  access tokens, preview links, rate limits, the audit log, secrets sealed at rest with a daily
  reseal sweep. Human sign-in in the web app: passwords, passkeys, TOTP, OIDC, SCIM, setup and
  recovery codes, with the person forwarded to the api as a signed `x-cw-principal`.
- **APIs.** Management, Preview and Delivery REST, GraphQL, live SSE through a Durable Object,
  OpenAPI 3.1 with a Scalar explorer, and the MCP server (184 tools, plus skills and the docs
  tools).
- **Delivery at the edge.** An uncached gateway that authenticates every request (principal
  cached in KV) in front of a Workers Caching entrypoint keyed by visibility profile, with ETags,
  `stale-while-revalidate`, and one coalesced purge tag per space and environment, drained
  rationed from a queue. Reads use D1 read-replica sessions.
- **Read-your-writes.** The api returns the D1 Sessions bookmark in `x-cw-bookmark`; a client that
  sends it back reads at least that fresh.
- **SDKs.** `@contentworker/sdk-core`, `sdk-web`, `sdk-vue`, `sdk-edge`, `sdk-rich-text`, `sdk-react-native`,
  `sdk-management` and `sdk-codegen`.
- **Operations.** The fleet registry and renderer, idempotent provisioning, CI ring deploys
  (engine → media → api → delivery → web) with a D1 Time Travel bookmark before each migration, smoke and
  latency checks, and ordered rollback.

## Planned

- [ ] **R2 publish projection.** Render per-locale delivery documents to R2 (and list cards to KV)
  on publish, so a cache miss is served without D1. Deferred: Workers Caching, the KV tag cache
  and D1 replicas already keep delivery reads off the D1 primary.
- [x] **Separate media Worker.** Published asset files, renditions and the width ladder are served
  by their own edge-cached Worker at `media.<domain>`, gated by KV entries the engine writes.
  Signed uploads and Stream stay on the api.
- [ ] **Load testing, rewritten.** A delivery and management load profile against a seeded
  deployment (`SEED_SCALE`), confirming cache hits never reach D1.
- [ ] **Version history without the bodies.** Store a content hash and a change summary on each
  version at write time, so history lists need no archived bodies from R2 (one read per version
  today) and identical bodies can share an object.
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
     waits with callbacks, a per-app limiter Durable Object, compensations.
  5. **Host interface.** `content.resolve` projections, the asset calls (signed URLs, upload
     targets, import or replace from a URL), `asset.created`, event subscriptions.
  6. **Dogfood.** The in-house HTML renderer and a social campaigns package, built only on steps
     1–5 with no change to core.
  7. **Adobe packages.** PDF Services first, then Express once beta access is confirmed and it
     accepts R2-signed URLs.

  Open before step 2: package operations in MCP without one tool per operation per install, a
  deployment-level install for per-company credentials, and the 2 s sync cap against provider
  token exchanges.
