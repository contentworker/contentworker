# Development

How to run contentworker locally, test it, and extend it: setup, suites, adding a use-case, changing
the D1 schema and the schema reference.

## Prerequisites

- Node.js ≥ 24 (`.nvmrc`) and pnpm 10 (`packageManager` in the root `package.json`).
- No Cloudflare account: local development runs every Worker in workerd through the Cloudflare
  Vite plugin and Miniflare, with a local D1.

## Running locally

```bash
pnpm install
pnpm dev     # applies packages/db/migrations to the local D1 (db:migrate:local), then starts the stack;
             # the api seeds the demo dataset into space-1 on its first request
```

`pnpm db:migrate:local` is also the way to apply a new migration without restarting, and
`pnpm dev:reset` deletes `apps/web/.wrangler/state` and migrates again, for a fresh database.

`pnpm dev` runs `react-router dev` in `apps/web` (Vite, http://localhost:5173; `PORT=5174 pnpm
dev` for another port). The port is fixed rather than "the next free one": the local OAuth issuer
(`OAUTH_ISSUER`, so MCP clients can connect with OAuth as on a deployment), the MCP smoke scripts
and these docs all name it, so a busy port fails fast. The web
Worker's Vite config (`apps/web/vite.config.ts`) starts the **api, engine, media and delivery Workers as
auxiliary Workers** in the same session, all on one local D1, with the queues, cron, Durable
Objects and Workflows emulated. The media Worker isn't routable from the browser locally and
`MEDIA_PUBLIC_URL` stays empty, so delivered assets keep the api's signed URLs (no renditions or
srcset); its suite (`pnpm --filter @contentworker/media test`) runs it in workerd instead. Asset
ingest still runs after an upload: with no R2 notifications locally, the api's signed `PUT` is its
one trigger ([Architecture](./architecture.md#asset-ingest-and-search)). Their vars are overridden with `LOCAL_STACK_VARS`:

| Var                               | Local value                                   | Why                                                                 |
| --------------------------------- | --------------------------------------------- | ------------------------------------------------------------------- |
| `REQUIRE_SECURE_SECRETS`          | `false`                                       | Allow the dev tokens below                                          |
| `ADMIN_TOKEN`                     | `dev-admin-token`                             | Root bearer token                                                   |
| `CMA_KEY` / `CDA_KEY` / `CPA_KEY` | `dev-cma-key` / `dev-cda-key` / `dev-cpa-key` | The seeded space's Management, Delivery and Preview keys            |
| `MCP_TOKEN`                       | `dev-mcp-token`                               | Mounts `/mcp`                                                       |
| `TOKEN_PEPPER`                    | `dev-pepper`                                  |                                                                     |
| `MEDIA_SIGNING_SECRET`            | `dev-media-signing-secret`                    |                                                                     |
| `PRINCIPAL_KEY`                   | `contentworker-local-dev-principal-key`       | The same `DEV_PRINCIPAL_KEY` the web Worker uses locally            |
| `ASSISTANT_PRINCIPAL_KEY`         | `DEV_ASSISTANT_PRINCIPAL_KEY`                 | Derived from the dev `PRINCIPAL_KEY`, for the engine                |
| `OAUTH_ISSUER`                    | `http://localhost:<port>`                     | OAuth for MCP clients on the admin origin, as on a deployment       |
| `AI_MODE`                         | `mock`                                        | No model calls                                                      |
| `AI_GATEWAY_ID`                   | empty                                         | No AI Gateway                                                       |
| `EMBEDDINGS_PROVIDER`             | `local`                                       | Hash embeddings                                                     |
| `VECTOR_STORE`                    | `kv`                                          | Vectorize has no local emulator; KV is shared by the Workers        |
| `ALLOW_FAKE_ADAPTERS`             | `all`                                         | Accept every dev fake                                               |
| `SEED_DEV`                        | `true` (`false` under the e2e harness)        | Load the demo dataset; refused wherever secure secrets are required |
| `SEED_SCALE`                      | `1`, or the shell's `SEED_SCALE`              | Demo size (~550 entries); raise it for a benchmark corpus           |

Local dev always runs on the demo dataset (`@contentworker/seed`): on its first request the api
seeds a space, dev API keys and a corpus covering every capability (content model, entries,
assets, taxonomy, releases, workflows, automation, agents). Seeded images and documents have real
files in the local bucket (gradient PNGs and one-page PDFs generated by
`packages/seed/src/placeholders.ts`), so the media library and image transforms work; videos are
metadata only. Seeding is idempotent, so restarts
keep the data; to start over, run `pnpm dev:reset`.

The same package holds the **sample starter** a real space can start with (`installStarter` and
`createSpaceWithStarter` in `packages/seed/src/starter.ts`, behind `POST /spaces` `starter:
"sample"` and the `space_create` MCP tool): the demo content model, a 39-entry slice of the corpus,
the taxonomy, eight sample images and documents when a blob store is bound, and one open release.
None of the dev-only rest (API keys, comments and tasks, webhooks and functions, agent runs,
schedules, reviews, audit entries). It installs inside the request: about 550 D1 calls, held under
a 600-call budget by `packages/db/test/starter.test.ts` against the 1,000 queries one invocation
may make. If it has to grow past that, it becomes a background job.

For a larger corpus, seed it into a database of its own so the everyday one stays small:

```bash
cd apps/web
npx wrangler d1 migrations apply DB --local --persist-to .wrangler/scale
SEED_SCALE=10 CONTENTWORKER_STATE=.wrangler/scale pnpm dev   # ~4,500 entries, seeded in ~25 s
```

The api relays the seed's events right after seeding (local dev has no cron sweep), so search
indexing and cache purges start at once; at `SEED_SCALE=10` the engine takes a while to work
through them one entry at a time.
While the database has no people, the admin on localhost is open (no sign-in); adding the first
person through `/setup` turns sign-in on.

Everything the api serves is reachable on the same origin through the web gateway, with a
bearer token: e.g. `curl -H 'authorization: Bearer dev-admin-token' http://localhost:5173/spaces`,
and MCP at `http://localhost:5173/mcp` with `dev-mcp-token`.

The docs site runs on its own: `pnpm docs:dev`.

## Common commands

```bash
# Test / typecheck / lint everything (what CI's verify job runs; turbo, cached)
pnpm check-types && pnpm test && pnpm lint

# One package
pnpm --filter @contentworker/application test

# A single test file or test name (vitest)
pnpm --filter @contentworker/application exec vitest run test/releases.test.ts -t "publishes"

# Fleet registry and DO-migration golden tests
node --test scripts/*.test.ts

# Bundle check for a Worker (nothing is uploaded)
pnpm --filter @contentworker/api exec wrangler deploy --dry-run --outdir /tmp/api

# Rebuild the docs and MCP skills embeds (gitignored; install and every turbo
# check-types, test, build and dev already do this)
pnpm generate
```

### Where each suite runs

| Package                        | Environment                                                                                                                                       | What it covers                                                                                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@contentworker/domain`        | node                                                                                                                                              | Pure rules                                                                                                                                                         |
| `@contentworker/application`   | node, `@contentworker/test-kit` fakes                                                                                                             | Every use-case                                                                                                                                                     |
| `@contentworker/db`            | workerd (`@cloudflare/vitest-plugin`), Miniflare D1 with the migrations applied                                                                   | The D1 store contract, unit of work and guards, query pushdown equivalence, secrets at rest, D1 statements per request                                             |
| `@contentworker/http`          | node, in-memory fakes                                                                                                                             | REST routes, auth, OpenAPI, MCP tools, the skills embed                                                                                                            |
| `@contentworker/engine`        | workerd                                                                                                                                           | Durable Objects (search shard, live hub, cost guard, rate limiter), real Workflow runs with `AI_MODE=mock`, the media gate and both purge queues                   |
| `@contentworker/media`         | workerd, Miniflare KV, R2 and D1, a fake Images binding                                                                                           | The media Worker end to end: gate and replica fallback, 404/410, `Accept` negotiation, purge drain, signed draft reads                                             |
| `@contentworker/docs`          | node                                                                                                                                              | The `docs/` embed (built, not committed) matches disk                                                                                                                                     |
| `@contentworker/adapters`      | node, fakes of each binding                                                                                                                       | One suite per adapter subpath (`test/<adapter>/`), including the structured and WXR import parsers                                                                 |
| `@contentworker/agent-runtime` | node                                                                                                                                              | The agent workflows and the graph interpreter, without Cloudflare                                                                                                  |
| `@contentworker/security`      | node                                                                                                                                              | The signed principal, the derived assistant key, roles and session lifetimes                                                                                       |
| `@contentworker/delivery`      | node                                                                                                                                              | Visibility profiles, canonical URLs, client cache headers and the purge drain                                                                                      |
| `@contentworker/web`           | vitest, two projects: `node` (`tests/**/*.test.ts`) and `dom` (jsdom, `tests/**/*.test.tsx`); Playwright (`pnpm --filter @contentworker/web e2e`) | Auth and lib units; CMS screens; device and CMS e2e with axe in WebKit and Chromium                                                                                |
| `packages/sdk/*`               | node (vitest)                                                                                                                                     | The Delivery and Management clients, `contentworker-codegen`                                                                                                       |
| `scripts/*.test.ts`            | `node --test` (`pnpm test:fleet`)                                                                                                                 | Fleet registry rendering, DO migration tags (append-only), the pnpm catalog, assistant key derivation, and a guard on names that must not appear in the repository |

`@contentworker/platform` has no suite of its own: its wiring is exercised through the http, db and
engine suites. Also `@contentworker/graphql-gen`, `seed`, `redaction`, `design` and `docs` run
`vitest` in node.

The web e2e harness starts its own dev server on port 5390 with a fresh local D1 in
`.wrangler/e2e` (`CONTENTWORKER_E2E=1`: offline, no remote bindings, and unseeded: the tests
create what they need; the first-run spec sees a deployment with no spaces by filtering
`GET /spaces` to the space it creates, since the database is shared), so it coexists with a
`pnpm dev` session. Install browsers once with
`pnpm --filter @contentworker/web exec playwright install webkit chromium`.

### D1 query counts

`packages/db/test/query-counts.test.ts` runs representative Delivery and Management requests
(entry by id, with a locale and with `include`, filtered and searched lists, a link list past the
100-parameter cap, GraphQL entry, collection and asset queries, asset delivery, create, publish,
get and list entries) through their use-cases over the real D1 store (GraphQL through the
route's own resolvers, `deliveryGraphResolvers`), with no delivery cache, and
counts the statements and round trips each sends to D1 (a `batch()` is one round trip). The
counts are compared with the committed `packages/db/test/query-counts.json`; any change fails the
`@contentworker/db` suite with a report of what moved and, for an increase, the SQL the request now
runs. When the change is intended, rewrite the snapshot and commit it:

```bash
pnpm --filter @contentworker/db test:query-counts:update
```

Delivery read counts may only go down. A PR that raises one says why in its description; a
decrease is committed the same way, so the next increase is measured from it.

### MCP smoke scripts

Against a running `pnpm dev` stack; both default to `http://localhost:5173/mcp` (override the URL
with `MCP_URL`, the token with `MCP_TOKEN`):

```bash
node apps/api/scripts/mcp-smoke.mjs          # tool surface end-to-end
node apps/api/scripts/mcp-search-smoke.mjs   # search tools
```

## Conventions

The rules every change keeps (strict TypeScript, ESM import specifiers, TypeScript 7 having no JS
API, the pnpm catalog, Biome, UUIDv7 ids from `ctx.ids`, time from `ctx.clock`, scoped operations,
workerd-only code, and the unit of work) are in `AGENTS.md`; see also
[Consistency](./consistency.md) for the unit-of-work rule.

## Adding a use-case

1. Add the function to the right module in `packages/application/src/` (exported from
   `index.ts`). It takes `AppContext` and a `Scope`.
2. Keep pure rules (state transitions, validation) in `packages/domain`.
3. If it needs a new persistence capability, add a method to the port in
   `packages/ports/src/content-store.ts`, implement it in `packages/db/src/store.ts` **and** the
   test-kit in-memory store, and add a contract test in `packages/db/test/`.
4. Test it in `packages/application/test/<capability>.test.ts` with `@contentworker/test-kit`
   fakes. Name tests for the capability, never for a roadmap phase.
5. Expose it on **both** surfaces: an HTTP route in its area's file,
   `packages/http/src/api/routes/management/<area>.ts` (with its OpenAPI doc, response schemas in
   `packages/http/src/api/docs/schemas/<area>.ts`), and an MCP tool in
   `packages/http/src/mcp/tools/<area>.ts`; a new area adds its own file. Or an event handler in
   `consumeEvent` when it is reactive.

## Changing the database schema

1. Add a new numbered file, `packages/db/migrations/NNNN_<what>.sql`. Expand-only: new tables,
   new nullable or defaulted columns, new indexes. Never edit an applied migration; drop or
   rename only in a later change once no deployed code reads the old shape.
2. Mirror it in `packages/db/src/schema.ts` (or `auth-schema.ts` for web auth tables).
   Timestamps are `integer` epoch milliseconds (`mode: 'timestamp_ms'`), JSON is `text`
   (`mode: 'json'`), booleans are `integer` 0/1.
3. Apply locally with `pnpm db:migrate:local` (`pnpm dev` does it too). The
   `@contentworker/db` tests apply the migrations to Miniflare D1 themselves.
4. Remote databases are migrated only by CI, before the new code deploys
   ([Deployment](./deployment.md#migrations)); never by hand.

Keep the D1 limits in mind: at most 100 bound parameters per statement (`chunked`,
`selectChunked`, or one JSON parameter with `json_each`), one writer per database (no writes on
read paths), 10 GB per database.

## D1 schema reference

`(space_id, environment_id)` leads the primary key or a unique index of every content table.
`0001_init.sql` creates:

| Tables                                                                                                                                            | Purpose                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `spaces`, `environments`, `environment_aliases`                                                                                                   | Spaces, branches, alias → environment                                                     |
| `content_types`                                                                                                                                   | Content-type definitions (`fields` JSON)                                                  |
| `entries`, `entry_versions`, `entry_published`, `entry_metadata`, `entry_unique_values`                                                           | Entry aggregate, version ledger, published read model, tags/concepts, unique-field claims |
| `assets`, `asset_published`                                                                                                                       | Asset metadata and its published read model                                               |
| `references`                                                                                                                                      | Link graph (reverse lookups for invalidation and usage)                                   |
| `api_keys`, `roles`, `space_members`, `oauth_clients`, `oauth_grants`, `preview_tokens`, `deployment_settings`                                    | Access                                                                                    |
| `webhooks`, `webhook_deliveries`, `functions`, `app_extensions`, `plugins`, `plugin_settings`, `plugin_kv`                                        | Integrations (`plugin_kv`: a plugin's `kv:storage`, per environment)                      |
| `releases`, `release_items`, `scheduled_actions`, `bulk_jobs`, `bulk_job_chunks`                                                                  | Publishing at scale                                                                       |
| `comments`, `tasks`                                                                                                                               | Collaboration                                                                             |
| `workflow_definitions`, `workflow_versions`, `workflow_runs`, `workflow_node_runs`, `workflow_tasks`, `workflow_timeline`, `entry_workflow_state` | Editorial workflows                                                                       |
| `concept_schemes`, `concepts`, `tags`                                                                                                             | Taxonomy                                                                                  |
| `redirects`, `redirect_sets` (`0017`)                                                                                                             | Redirects and their revision                                                              |
| `ai_actions`, `agent_runs`, `agent_reviews`, `agent_schedules`                                                                                    | AI actions and the agent ledger                                                           |
| `audit_log`                                                                                                                                       | Per-space audit trail                                                                     |
| `outbox`                                                                                                                                          | Transactional outbox (`claimed_until` lease, `relayed_at`)                                |
| `_guard`                                                                                                                                          | Always empty; its `CHECK (ok = 1)` aborts a batch whose compare-and-set lost              |

`0008_asset_renditions.sql` adds `asset_renditions` (`space_id`, `name`, `width`, `height`, `fit`,
`format`, `quality`, `created_at`, `updated_at`; primary key `(space_id, name)`): a space's
rendition presets, not environment-scoped. `0009_asset_published_delivery.sql` adds `version`,
`r2_key`, `kind` and `rights` to `asset_published` (backfilled from each snapshot's asset row), with
the indexes `asset_published_by_time` (publish order, keyset paging) and
`asset_published_by_kind`; the delivery list's folder filter reads `assets.folder_id` live.
`0010_asset_published_backfill_again.sql` changes no schema: it runs 0009's backfill again, only
for snapshots still holding the column defaults (`kind` `'other'` or no `r2_key`) whose asset row
knows better, which the pre-0009 api wrote while a deployment rolled out.

`0012_scheduler_jobs.sql` adds `scheduler_jobs` (`job` primary key, `last_run_at`,
`last_success_at`, `last_error_at`, `last_error`): the engine cron's heartbeat, one row per sweep
plus `tick`, written in one batch at the end of each tick and nowhere else. Not space-scoped. The
upsert merges in SQL (a success keeps the last error, and an older run never moves a timestamp
back), so the cron never reads before it writes.

`0014_asset_upload_sweep.sql` adds only the partial index `assets_awaiting_upload` on
`assets(created_at)` where `status = 'draft'`, `ingest_status` and `size` are NULL and `r2_key` is
set: the drafts whose presigned upload never landed, for the engine's hourly abandoned-upload sweep
(see [Architecture](./architecture.md#asset-ingest-and-search)). Nothing is backfilled. The
placeholder ingest computes lives in the `file` JSON, so it needs no migration.

`0015_asset_expiry.sql` adds `asset_published.expires_at` (epoch ms, the snapshot's
`rights.expiresAt`, written on every snapshot write), backfills it from existing snapshots' rights,
and indexes it (`asset_published_by_expiry`, only where set) for the engine's expiry sweep.

`0016_asset_collections.sql` adds five new tables and touches no existing one: `asset_collections`,
`asset_collection_items` (a membership per row, ordered by `position`), `asset_share_links`
(`password_hash` is PBKDF2, `revoked_at` is set once), `asset_zip_jobs` (indexed by `expires_at`
for the engine's hourly zip sweep) and `asset_uploads` (multipart uploads in progress, indexed by
`created_at` for the abandoned-upload sweep). Every table is environment-scoped, and the environment purge clears it. Nothing is backfilled (see
[Architecture](./architecture.md#collections-share-links-multipart-uploads-and-zips)).

`0017_redirects.sql` adds two environment-scoped tables (the environment purge clears them) and one
column, and backfills nothing. `redirects` holds one row per redirect (`source`, `locale`,
`destination`, `status`, `enabled`, `note`, `origin`, `entry_id`, epoch-ms `created_at` and
`updated_at`); `locale` is `''` for a redirect that applies to every locale, because SQLite treats
NULLs as distinct and the unique index `redirects_by_source` on `(space_id, environment_id, source,
locale)` must hold one redirect per source per locale. `redirects_by_destination` serves a slug
change's read of the redirects pointing at an old path. `redirect_sets` holds one `revision` per
environment, bumped by every write to the set: the compare-and-set that keeps two writers, each of
which checked the set for loops and the cap, from both committing (a loser surfaces as
`TransactionConflictError`). `content_types.url_pattern` (nullable) is a type's
[URL pattern](./domain-model.md#content-type); existing types have none, so no slug redirects
until someone sets one.

`0007_dam.sql` adds the asset library's columns to `assets` (`kind`, `mime`, `size`, `width`,
`height`, `content_hash`, `folder_id`, `version`, `r2_key`, `created_at`, `created_by`,
`archived_at`, `rights`, backfilled from the `file` JSON, with indexes for filtering and sorting)
and two tables: `asset_folders` (materialized `path`, sibling names unique) and `asset_versions`
(the files an asset had before its current one).

`0005_webhook_environments.sql` adds `webhooks.environment_id` (the one environment a webhook
receives events from; `NULL`, as every existing row stays, means every environment) and the
`webhooks_by_environment` index on `(space_id, environment_id)` (see
[Events & webhooks](./events-and-webhooks.md#webhooks)).

`0006_environment_promotions.sql` adds `environment_promotions`: promotions between environments
with their pinned entries, risk check, status and result (see [API reference](./api-reference.md)).

`0004_version_bodies.sql` adds `entry_versions.body_key` (a superseded version's body moves to R2
under that key, and `fields` becomes `{}`) and `version_archive_queue` (versions waiting to move,
queued as they are superseded and due a day later), backfilling the queue with every version already
superseded (see [Consistency](./consistency.md)).

`0003_environment_purges.sql` adds `environment_purges`: deleted environments whose rows the engine
is still removing in bounded steps (their ids can't be reused until it finishes).

`0002_auth.sql` adds the web app's tables: `users`, `sessions`, `recovery_codes`,
`sign_in_challenges`, `passkeys`, `passkey_challenges`, `scim_groups`, `scim_group_members`,
`workspace_settings`, `auth_failures`, `admin_audit`.

The lexical search index is not in D1: it lives in `SearchShardDO` (FTS5). Vectors live in
Vectorize. See [AI, agents & search](./ai-agents-and-search.md).

## Testing approach

The application layer is tested against `@contentworker/test-kit` fakes: an in-memory
`ContentStore` that enforces the same unit-of-work rule as D1 (no reading your own uncommitted
writes), fake blob, vector and embeddings stores, and deterministic `Clock` and `IdGenerator`.
The D1 store runs the same contract suite in workerd, plus concurrency tests (racing publishes:
exactly one wins; outbox leases never double-claim). Because the fakes implement the same ports
as the real adapters, a passing application test exercises the real use-case logic.
