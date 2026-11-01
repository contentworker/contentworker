# contentworker roadmap

**v2: Cloudflare-only on D1 (2026-10-31).** contentworker was rebuilt on Cloudflare end to end.
D1 replaced Postgres as the system of record, and the single platform Worker became four Workers
split by traffic profile: `apps/web` (admin + human auth), `apps/api` (Management and Preview
REST, MCP, OAuth, media, live), `apps/delivery` (the cached public Delivery API) and
`apps/engine` (queues, cron, Durable Objects, Workflows). Tenancy is one isolated deployment per
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
  with HTML import; slugs.
- **Publishing.** Releases (atomic multi-entry publish), scheduled actions, bulk actions as
  resumable jobs, branch compare and merge, environment snapshots (export, plus import and clone
  as resumable jobs; a clone's export and checks run in the engine too), CSV, JSON and WordPress
  import.
- **Media.** Signed R2 uploads and downloads, Images transforms, Stream video, localized alt text
  and focal point, AI alt text and auto-tagging, asset usage.
- **Taxonomy and collaboration.** Concept schemes, concepts and tags; comments, tasks, legacy
  workflow steps, and editorial workflow graphs on Cloudflare Workflows (runs, timeline,
  approvals with separation of duties, the copilot).
- **AI.** Generation, canvas authoring, translate, summarize, autofill, tags, governed AI
  actions, the enrich/moderate/curate/repurpose agents and the review watcher on Cloudflare
  Workflows, agent schedules and reviews, per-space budgets (a Durable Object), provenance,
  related and duplicate detection, hybrid and semantic search, RAG.
- **Integration.** Signed webhooks with a delivery log, event-triggered functions, app
  extensions, sandboxed plugins on Worker Loader, the transactional outbox with lease-claimed
  relay.
- **Access.** CMA/CDA/CPA keys, eight scopes, roles with per-type and per-field grants and
  presets, the last-administrator guard, OAuth 2.1 with the device flow for MCP clients, personal
  access tokens, preview links, rate limits, the audit log, secrets sealed at rest with a daily
  reseal sweep. Human sign-in in the web app: passwords, passkeys, TOTP, OIDC, SCIM, setup and
  recovery codes, with the person forwarded to the api as a signed `x-cw-principal`.
- **APIs.** Management, Preview and Delivery REST, GraphQL, live SSE through a Durable Object,
  OpenAPI 3.1 with a Scalar explorer, and the MCP server (123 tools, plus skills and the docs
  tools).
- **Delivery at the edge.** An uncached gateway that authenticates every request (principal
  cached in KV) in front of a Workers Caching entrypoint keyed by visibility profile, with ETags,
  `stale-while-revalidate`, and one coalesced purge tag per space and environment, drained
  rationed from a queue. Reads use D1 read-replica sessions.
- **Read-your-writes.** The api returns the D1 Sessions bookmark in `x-cw-bookmark`; a client that
  sends it back reads at least that fresh.
- **SDKs.** `@contentworker/sdk-core`, `sdk-web`, `sdk-vue`, `sdk-edge`, `sdk-react-native`,
  `sdk-management` and `sdk-codegen`.
- **Operations.** The fleet registry and renderer, idempotent provisioning, CI ring deploys
  (engine → api → delivery → web) with a D1 Time Travel bookmark before each migration, smoke and
  latency checks, and ordered rollback.

## Planned

- [ ] **R2 publish projection.** Render per-locale delivery documents to R2 (and list cards to KV)
  on publish, so a cache miss is served without D1. Deferred: Workers Caching, the KV tag cache
  and D1 replicas already keep delivery reads off the D1 primary.
- [ ] **Separate media Worker.** Move signed transfers, Images transforms and Stream off the api
  Worker onto their own edge-placed Worker at `media.<domain>`.
- [ ] **Load testing, rewritten.** A delivery and management load profile against a seeded
  deployment (`SEED_SCALE`), confirming cache hits never reach D1.
- [ ] **Version history without the bodies.** Store a content hash and a change summary on each
  version at write time, so history lists need no archived bodies from R2 (one read per version
  today) and identical bodies can share an object.
- [ ] **Per-environment content promotion tooling** (diff and promote `main` → `staging`).
- [ ] **Required plugins.** A per-plugin `required` flag so a plugin whose refusal is load-bearing
  blocks the write when it throws or times out, instead of being skipped.
