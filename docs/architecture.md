# Architecture

contentworker is a **ports & adapters (hexagonal)** monorepo that runs entirely on Cloudflare.
D1 is the system of record; Workers, Queues, KV, R2, Durable Objects, Workflows, Vectorize,
Workers AI (through AI Gateway), Images, Stream, Email Sending and Worker Loader do the rest.
The guiding constraint is the **dependency rule**: dependencies point inward, toward the domain,
and infrastructure is bound only at the edges.

```
   apps/web ─────(API service binding, signed x-cw-principal)────▶ apps/api
   apps/delivery (public CDA, cached)                             apps/engine (queues, cron, DOs, Workflows)
        │                                                              │
        └──────────────┬───────────────────────────────────────────────┘
                       │ thin composition entries over
                       ▼
     @contentworker/http (Hono surface)    @contentworker/platform (env, config, wireEdge, DOs, Workflows)
                       │                                   │ binds
                       ▼                                   ▼
          @contentworker/application  ◀── implements ── @contentworker/adapters (Cloudflare, one subpath each)
          (use-cases over ports)                         @contentworker/db (D1 ContentStore)
                       │
            ┌──────────┴───────────┐
            ▼                      ▼
   @contentworker/domain   @contentworker/ports
   (depends on nothing)    (interfaces only)
```

## Workers, split by traffic profile

Each deployment runs four Workers (plus the docs site on contentworker's own deployment). They
are split by how their traffic behaves, so each has its own CPU limit, placement, sampling rate
and failure blast radius. Routes are rendered per deployment by `scripts/fleet.ts`
(`hosts()`): the admin at `<domain>`, the api at `api.<domain>`, delivery at `cdn.<domain>`.

| Worker          | Route            | Role                                                                                         | Config highlights (`apps/*/wrangler.jsonc`)                                                             |
| --------------- | ---------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `apps/web`      | `<domain>`       | Admin UI (React Router 8 SSR) and human auth: passwords, passkeys, TOTP, OIDC SSO, SCIM, `/setup` | `cpu_ms` 5000; binds `DB` (auth tables), `API` and `DELIVERY` (service bindings to the api and delivery) |
| `apps/api`      | `api.<domain>`   | Management + Preview REST, MCP, OAuth 2.1, media (`/media/*`), live SSE                      | Smart Placement, `cpu_ms` 5000; `ROLE=management,preview,delivery`; binds engine DOs/Workflows by script |
| `apps/delivery` | `cdn.<domain>`   | Public Content Delivery API (REST, GraphQL, search, live); drains the purge queue           | No Smart Placement, `cpu_ms` 2000, head sampling 0.05, Workers Caching on the `Delivery` entrypoint     |
| `apps/engine`   | none             | Queue consumers, the every-minute cron, every Durable Object and Workflow class              | Smart Placement, `cpu_ms` 30000; owns DO migrations                                                     |
| `apps/docs`     | docs host        | Public docs (Astro Starlight, static assets)                                                 | Deployed only by the deployment with `docs: true`                                                       |

### apps/web: the admin and the gateway

`apps/web/workers/app.ts` answers `/health` and `/health/deep` (its D1 plus the api's
`/health` over the binding), forwards the api's surfaces, serves SCIM, refuses cross-origin
state-changing requests, and otherwise renders React Router.

The gateway (`apps/web/app/lib/gateway.server.ts`) forwards these paths to the api over the
`API` service binding, so the admin, REST, GraphQL, MCP, OAuth and the API docs share one
origin: `/spaces`, `/spaces/*`, `/preview/*`, `/delivery/*`, `/oauth/*`,
`/.well-known/oauth-*`, `/media/*`, `/mcp`, `/openapi.json`, `/docs`, `/docs/*`, `/guides*`,
`/health/api`. Credentials never cross the binding as the browser sent them:

1. A request with `Authorization: Bearer …` (API key, personal access token, OAuth token) goes
   through unchanged except that any caller-supplied `x-cw-principal` and cookies are removed. A
   bearer `/delivery/*` call goes to the delivery Worker over the `DELIVERY` binding instead, so it
   gets the same gateway, cache, ETag and purge as on the `cdn.` host.
2. Otherwise a same-origin request with a live web session has its cookies removed and a signed
   `x-cw-principal` added (`@contentworker/security/principal`): HMAC-SHA256 under
   `PRINCIPAL_KEY`, payload `{ sub, email, name, role, iat, exp, path }`, valid for 60 seconds
   and for that exact path.
3. Otherwise it goes through with no credentials, and the api answers 401 where it needs one.

`x-cw-bookmark` passes through both ways untouched. While a deployment has no people yet, every
page redirects to `/setup` (see [Auth & RBAC](./auth-and-rbac.md#first-run-setup-and-recovery)).

### apps/api: the synchronous HTTP surface

`apps/api/src/index.ts` is a thin entry over `@contentworker/http`. Per request it:

- opens a D1 session from the `x-cw-bookmark` header, or `first-primary` for a mutating method
  and `first-unconstrained` for a read, and returns the session's new bookmark on the response
  (see [Consistency](./consistency.md));
- pins every Durable Object namespace to `DATA_JURISDICTION` when one is set (`withJurisdiction`
  in `packages/platform/src/env.ts`; the delivery and engine entry points and `wireEdge` do the
  same);
- mounts media routes, the DO-backed live route (when `LIVE_HUB` is bound), MCP (only with an
  explicit `MCP_TOKEN` on a persistent deployment) and the REST app from `createApp`;
- after a mutating request, drains the outbox onto `contentworker-events` in `waitUntil` (the
  "nudge"; the engine's cron covers anything it misses).

`ROLE` is `management,preview,delivery`: delivery routes are mounted here so the admin's own
reads of published content (compare, search, live), signed by the web principal, work through
the web origin. Public delivery clients use the delivery Worker.

### apps/delivery: the public CDA

`apps/delivery/src/index.ts` is an **uncached gateway** in front of a **cached `Delivery`
entrypoint** (`exports` in its wrangler config: `default` has cache disabled, `Delivery` enabled,
with `cross_version_cache`). Per request the gateway:

1. rate-limits by client IP (`RATE_LIMIT_READ`, 1200/min);
2. authenticates the bearer CDA/CPA key with `authenticateCached`
   (`packages/application/src/auth.ts`): the principal is held in KV under the tag
   `principals:<spaceId>` (`principal-cache.ts`) and dropped on any key or role change in that
   space, so the steady state reads no database;
3. reduces the principal to a **visibility profile** (`apps/delivery/src/profile.ts`): a hash of
   space, key kind, sorted scopes and content grants, nothing else;
4. forwards a canonical URL, `https://delivery.internal/_p/<profile>/<path>?<sorted query>`, with
   the principal in an internal header, to `Delivery`.

Equal readers therefore share one cache entry, and authorization runs on every request even when
the body comes from cache. The live SSE stream and `/graphiql/*` are answered by the gateway
itself, and GraphQL `POST` is served uncached (`private, no-store`).

On a miss, `Delivery` (`apps/delivery/src/delivery.ts`) runs the same delivery routes the api
mounts against a D1 read-replica session (`first-unconstrained`), sets a strong ETag, answers
`304` on `If-None-Match`, and caches 200s with
`public, max-age=60, stale-while-revalidate=86400, stale-if-error=604800` and a `cache-tag` for
the path's environment and the environment it resolves to (so alias repoints purge too).

Its queue consumer drains `contentworker-purge` (`apps/delivery/src/purge.ts`): up to 100 tags
per purge call, one call every 12 s (Cloudflare allows 5 a minute), at most 40 calls per batch,
handing the rest back with exponential backoff.

### apps/engine: async and stateful work

`apps/engine/src/index.ts` exports every Durable Object and Workflow class (the api and delivery
bind them by `script_name`) and handles:

- **Queues**: `contentworker-events` (batch 25, concurrency 10), `contentworker-bulk` (batch 1),
  `contentworker-agents` (batch 25, concurrency 4), and `contentworker-events-dlq` (logged and
  acked). The events consumer runs `consumeEvent` per message (webhooks, KV cache tags, search
  and vector indexing, functions, reindex slices, bulk chunks, live fan-out), forwards
  `entry.published` to the agents queue when it is bound, and sends one coalesced purge message
  per batch for every space:environment touched by an event in `PURGING_EVENTS`
  (`entry.published`, `entry.unpublished`, `entries.published_bulk`, `asset.published`,
  `asset.unpublished`, `content_type.published`, `release.published`,
  `environment_alias.changed`).
- **Cron** (`* * * * *`): due scheduled actions, the outbox relay sweep, bulk-job stall recovery,
  agent schedules (`AGENTS_SCHEDULES=true`), retention at the top of each hour, and the daily
  secret reseal at 03:30 UTC.

| Durable Object  | Keyed by                         | Purpose                                                                  |
| --------------- | -------------------------------- | ------------------------------------------------------------------------ |
| `LiveHubDO`     | space:environment                | Live Content SSE fan-out                                                 |
| `SearchShardDO` | space:environment:shard (8 default, `SEARCH_SHARDS`) | FTS5 lexical index (`packages/platform/src/do/search-shard.ts`) |
| `CostGuardDO`   | space                            | AI request/token budget windows (interactive and background)             |
| `RateLimiterDO` | client IP                        | Failed-authentication limiter                                            |

Workflows: `AgentWorkflow` (`contentworker-agent`) and `EditorialWorkflow`
(`contentworker-editorial`), in `apps/engine/src/workflows/`.

DO migration tags only ever append (`apps/engine/wrangler.jsonc`, checked by
`scripts/do-migrations.test.ts`).

### Editorial workflow runs

A workflow run is one Cloudflare Workflows instance of `EditorialWorkflow`
(`apps/engine/src/workflows/editorial-workflow.ts`, binding `EDITORIAL_WF`, workflow name
`contentworker-editorial`). Its payload is the run's `WorkflowRunParams`; its id is the run id, or
`${runId}-g${n}` after a continue-as-new. The class wires exactly as a request does (`wireEdge`:
the D1 store, AI, cost guard, plugin hooks, Email Sending, webhook sender) and hands Cloudflare's
`WorkflowStep` to the graph interpreter (`runGraph` in `@contentworker/agent-runtime`), which owns
every step name.

`CloudflareWorkflowEngine` (`packages/platform/src/workflows.ts`) implements the `WorkflowEngine`
port over the binding, so the same use-cases drive real instances from REST and MCP: start is
`create({ id, params })` (idempotent), decisions and business events are `sendEvent`, cancel is
`terminate()` followed by compensation in the request. Approval deadlines, event-wait timeouts and
`control.wait` timers are durable Workflows waits; no cron is involved. Without the binding, run
actions answer 501 while definitions and reads keep working. An instance has a step ceiling
(about 1024), so long loops should pass through a `control.continue_as_new` node.

`content.notify` nodes send through Email Sending when the engine has the `EMAIL` binding and
`EMAIL_FROM` (rendered from the registry's `email`); unbound, they fail with "email sending is not
configured".

### Media: R2, Images, Stream

Served by the api (`packages/http/src/routes/media.ts`, `@contentworker/adapters/blob-r2`):

- **R2 (`MEDIA_BUCKET`)**: the binding has no presigned URLs, so the api issues its own.
  `createAsset` returns a signed `PUT /media/<key>?…&sig=…` URL (HMAC with
  `MEDIA_SIGNING_SECRET`, short expiry, bound to the content type), and the stored `file.url` is a
  signed `GET /media/<key>` capability URL on `MEDIA_BASE_URL` (`https://api.<domain>`). Uploads
  are capped at 100 MiB; user bytes are served with `nosniff` and `CSP: sandbox`. Rotating
  `MEDIA_SIGNING_SECRET` invalidates every stored asset URL.
- **Images (`IMAGES`)**: transform params (`w,h,fit,fm,q,g`) are covered by the signature, so
  clients cannot mint arbitrary transforms; `fm=auto` picks AVIF/WebP from `Accept`; the focal
  point becomes gravity when `fit=crop`.
- **Stream (`STREAM`)**: `POST …/assets/videos` creates a draft asset and a one-time direct
  upload; `POST /webhooks/stream` verifies `Webhook-Signature` (`STREAM_WEBHOOK_SECRET`) and then
  re-reads the video from the Stream API; `POST …/assets/:id/video/refresh` does the same on
  demand.

## Data placement

| Store                            | Holds                                                                                                                                          |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **D1** (`DB`, primary + replicas) | Everything authoritative: spaces, environments, aliases, content types, entries and versions, published read models, assets, releases, schedules, taxonomy, workflows, roles, team, API keys, OAuth, webhooks, the outbox, audit; plus the web app's auth tables (`0002_auth.sql`) |
| **R2** (`MEDIA_BUCKET`)          | Asset bytes, import staging (`imports/`, 7-day lifecycle), plugin bundles, dead letters (`dlq/`, 30-day lifecycle)                            |
| **KV** (`KV_CACHE`)              | Tag-versioned delivery cache and the authenticated-principal cache (shared by api, engine and delivery)                                        |
| **DO SQLite**                    | Search shards, live hubs, AI budgets, auth-failure counters                                                                                    |
| **Vectorize**                    | Embeddings (768 dims, cosine), metadata-indexed on `spaceId` and `environmentId`                                                               |
| **Analytics Engine** (`METRICS`) | Operational counters (`contentworker_*`)                                                                                                       |
| **Workers Caching**              | Delivery responses, keyed by visibility profile and canonical URL                                                                              |

## The layers

### `packages/domain`: the core

Pure TypeScript that depends on nothing: content types and field types, the entry publish state
machine, validation (`validateEntryFields`, the single source of truth for human and AI writes),
locale fallback, references, assets, webhooks, domain events, RBAC (`SCOPES`, `scopesForKind`,
`authorize`, `Principal`), and `DomainError` subclasses with stable codes. See
[Domain model](./domain-model.md).

### `packages/ports`: the interfaces

Interfaces only:

- `content-store.ts`: the **single database seam**. `ContentStore` exposes per-aggregate repos
  and `withTransaction`, documented as a **unit of work** (read first, then write; reads inside
  the unit do not see its own writes; a lost compare-and-set surfaces at commit as
  `TransactionConflictError`). No SQL, ORM or driver type crosses this boundary.
- `infra.ts`: `Queue`, `EventBus`, `BlobStore`, `Cache`, `WebhookSender`, `AIProvider`,
  `EmbeddingsProvider`, `VectorStore`, `SearchIndex`, `HookDispatcher`, `WorkflowEngine` and
  friends.
- `support.ts`: `Clock`, `IdGenerator`, `Hasher`, which keep use-cases deterministic.

### `packages/application`: the use-cases

Functions that orchestrate the domain over the ports. Every use-case takes an `AppContext`
(`store`, `clock`, `ids`, optional `cache`, `hooks` and more) and a `Scope`. One module per
capability (`entries`, `publishing`, `releases`, `scheduling`, `workflows`, `taxonomy`, `assets`,
`delivery`, `preview`, `webhooks`, `roles`, `team`, `auth`, `oauth`, `setup`, `snapshots`,
`rag`, `search-index`, `generation`, `agent-*`, `events/*`, …). These modules are the **only**
way state changes: the HTTP API, MCP, and the queue consumers all call them.

### `packages/db`: the D1 store

- `schema.ts` and `auth-schema.ts` (drizzle `sqlite-core`) mirror the hand-written migrations
  `migrations/0001_init.sql` (content) and `0002_auth.sql` (the web app's users, sessions,
  passkeys, SCIM groups, admin audit). Timestamps are epoch milliseconds; JSON is `TEXT`.
- `exec.ts`: `directExec` and the `UnitOfWork` behind `withTransaction`: writes are buffered and
  sent as one `db.batch()`; `expectChanged()` adds a guard statement
  (`INSERT INTO _guard SELECT changes() = n`, with `CHECK (ok = 1)`) so a lost compare-and-set
  aborts the whole batch and maps to `TransactionConflictError`. `chunked` / `selectChunked`
  keep statements under D1's 100-parameter cap.
- `store.ts`: `createD1Store`, every repo, and the lease-claimed outbox (`OUTBOX_LEASE_MS`
  = 60 s).
- `query-pushdown.ts`: JSON field filters as `json_each` SQL with the filter values bound as one
  JSON parameter.

### `packages/adapters`: Cloudflare implementations

One subpath per adapter, each implementing a port against one binding:

| Subpath             | Port(s)                                  | Technology                                     |
| ------------------- | ---------------------------------------- | ---------------------------------------------- |
| `ai-workers`        | `AIProvider`, `EmbeddingsProvider`       | Workers AI, through AI Gateway when configured |
| `blob-r2`           | `BlobStore`, media URL signer            | R2 binding + signed `/media/*` route           |
| `cache-kv`          | `Cache`                                  | Workers KV, tag-versioned                      |
| `queue-cf`          | `Queue`                                  | Cloudflare Queues producer                     |
| `vector-vectorize`  | `VectorStore`                            | Vectorize                                      |
| `images-cf`         | image transformer                        | Cloudflare Images binding                      |
| `video-stream`      | video host                               | Cloudflare Stream binding                      |
| `email-cf`          | `EmailSender`                            | Email Sending (`send_email`)                   |
| `plugins-cf-loader` | plugin runtime                           | Worker Loader isolates                         |
| `http-effects`      | `WebhookSender`, function invoker, fetch | `fetch`                                        |
| `import-structured` | import sources                           | CSV / JSON / WordPress parsers                 |

### `packages/platform`: wiring

`env.ts` (the `EdgeEnv` bindings and vars), `config.ts` (`loadConfig`), `wire.ts` (`wireEdge`,
the only place adapters are bound to ports, run per request / batch / tick), ids, metrics, queue
message shapes (`messages.ts`, including `deliveryScopeTag`), the Durable Object classes and
their clients (`do/`), and the Workflow clients. Every binding is optional; an absent binding
selects a dev fallback (in-memory store, fake blob, stub AI, in-memory vectors), and
`assertNoFakeAdapters` refuses those on a persistent deployment (one with `DB`) unless
`ALLOW_FAKE_ADAPTERS` names them.

### Other packages

- `@contentworker/http`: the Hono surface as a library (REST routes, auth middleware, OpenAPI
  3.1 + Scalar, the OAuth 2.1 authorization server, MCP server and skills, media, live). It has no
  setup routes and no sign-in of its own: people reach it through the web principal.
- `@contentworker/security`: the signed principal (`principal.ts`) and deployment roles.
- `@contentworker/agent-runtime`: engine-agnostic agent workflow logic and the in-process
  executor (the engine runs the same workflows durably on Workflows).
- `@contentworker/graphql-gen`: the GraphQL delivery schema from published content types.
- `@contentworker/seed`: the demo dataset (`SEED_DEV`, `SEED_SCALE`).
- `@contentworker/test-kit`: in-memory `ContentStore` (enforcing the same unit-of-work rule),
  fake blob store, in-memory vectors, deterministic clock and ids.
- `@contentworker/telemetry`: structured JSON logs on `console` (Workers Logs).
- `@contentworker/redaction`: credential redaction for logged errors.
- `@contentworker/docs`: `docs/*.md` embedded for the MCP and HTTP docs tools.
- `@contentworker/design`, `@contentworker/ui`: the Ledger design system for `apps/web`.
- `packages/sdk/*`: see [SDKs](./sdks.md).

## The key invariant: one set of use-cases, every caller

```
   Admin (apps/web) ──signed principal──▶ api: REST ───┐
   HTTP client ───────────bearer────────▶ api: REST ───┤
   AI agent ──────────────bearer/OAuth──▶ api: /mcp ───┼─▶ application use-cases ─▶ ports ─▶ adapters
   Delivery client ───────bearer────────▶ delivery ────┤
   events ─────────────────────────────▶ engine queue ─┘
```

Because REST, MCP, delivery and the queue consumers all go through the same application
functions, validation and RBAC have one enforcement point. **An AI agent can never do something
a human API client can't**, and the reverse.

## Multi-tenancy

Each customer gets its own deployment (`deployments/<id>.jsonc`): its own D1, R2, KV, Vectorize
index, queues, AI Gateway and Workers. Inside a deployment, every store and use-case operation
carries a `Scope` of `{ spaceId, environmentId }`; `(space_id, environment_id)` leads the primary
key or a unique index on every content table.

## Request flow (write → deliver)

1. The admin `POST`s to `/spaces/...` on the web origin; the gateway signs `x-cw-principal`
   (or an API client sends a CMA bearer token to `api.<domain>`).
2. The api's auth middleware resolves a `Principal`; `requireScope` authorizes it.
3. The route calls a use-case (e.g. `publishEntry`), which reads what it needs, then commits one
   D1 batch: the aggregate, the published read model and the **outbox row** together.
4. The response carries `x-cw-bookmark`. In `waitUntil`, the api relays the outbox onto
   `contentworker-events`.
5. The engine consumes the event: webhooks, functions, cache tags, search shards and vectors,
   live fan-out, agents; and enqueues one purge tag for the space:environment.
6. The delivery Worker purges the tag (rationed). The next CDA read misses, reads a D1 replica,
   and is cached again.

See [Events & webhooks](./events-and-webhooks.md) for the async half.

## Hooks: the synchronous write-path seam

Everything reactive goes through the **transactional outbox**: it commits with the write,
retries, and cannot fail the request. What the outbox cannot do is _change or refuse_ a write.
`HookDispatcher` (`ports/infra.ts`) is the seam for that:

| hook                  | fires                                          | mutate | veto |
| --------------------- | ---------------------------------------------- | ------ | ---- |
| `entry:beforeSave`    | `createEntry` / `updateEntry`                  | ✅     | ✅   |
| `entry:beforePublish` | in `publishEntryTx`, before the unit commits   | —      | ✅   |
| `entry:beforeTrash`   | `trashEntry`                                   | —      | ✅   |
| `entry:beforePurge`   | `purgeEntry`                                   | —      | ✅   |
| `asset:beforeCreate`  | `createAsset`, before the upload URL is minted | ✅     | ✅   |

Rules the seam holds:

- **Absent means absent.** With no dispatcher the write path is untouched.
- **A veto writes nothing.** `entry:beforePublish` runs before the unit of work commits, so a
  refusal discards the aggregate, read model and outbox row together. Hooks are pre-commit only:
  nothing can roll back after D1 commits the batch.
- **Hooks never see the store**, run sequentially in registration order, and
  `entry:beforeSave` runs before normalization and validation.
- **Failure policy is per handler**: `onError: 'ignore'` (default) logs and continues;
  `onError: 'reject'` turns a failure or timeout into a veto.

A veto with field issues surfaces as `ValidationError` (422); anything else as
`HookRejectedError` (422) naming the handler.

Hooks are registered by installing plugins. With a `PLUGIN_LOADER` binding, `wireEdge` sets
`AppContext.hooks` to `createPluginHookDispatcher` over the Worker Loader runtime; without it,
installed plugins never execute. Manifests, grants and checksums live in D1 (`plugins`); bundle
bytes in R2 at `plugins/<space>/<id>/<checksum>.js`, with the checksum verified on every load.
See [Plugins](./plugins.md).

## Why these choices

- **Workers split by traffic profile**: the delivery hot path is cache-first with no Smart
  Placement; the api and engine make several D1 round-trips and run near the primary.
- **Ports & adapters** keep the domain testable with zero infrastructure.
- **UUIDv7 IDs** are time-ordered, always minted through the injected `IdGenerator`, never
  `crypto.randomUUID`.
- **Transactional outbox**: an event is enqueued **iff** its state change commits, because the
  outbox row rides in the same D1 batch.
- **Denormalized read models** (`entry_published`, `asset_published`) make a delivery read a
  single-row lookup.
- **Derived indexes off D1**: search lives in Durable Object FTS5 shards, so search maintenance
  never competes with content writes for D1's single writer.
