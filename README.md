# contentworker

A composable, **API-first, AI-agentic-first** headless CMS: the AI surface is a first-class
client rather than a bolt-on. Model structured content once and deliver it anywhere (web, mobile,
kiosks, email).

It runs entirely on **Cloudflare**. D1 is the system of record, with Workers, Queues, KV, R2,
Durable Objects, Workflows, Vectorize, Workers AI (through AI Gateway), Images, Stream, Email
Sending and Worker Loader behind it. The core is strict **ports & adapters**, so every platform
service sits behind an interface and the business logic never touches a binding. Each customer
gets one isolated deployment (its own D1, R2, KV, queues and Workers); spaces and environments
live inside that deployment's D1.

---

## Highlights

- **Workers split by traffic profile.** The admin (`apps/web`), the Management and Preview API
  (`apps/api`), the public Delivery API (`apps/delivery`) and the asynchronous engine
  (`apps/engine`) are separate Workers, each with its own CPU limit, placement and failure blast
  radius.
- **Hexagonal core.** `domain` depends on nothing; `application` depends only on `ports`;
  Cloudflare adapters (`@contentworker/adapters`, one subpath each) and the D1 store
  (`@contentworker/db`) are bound in one place, `@contentworker/platform`'s `wire.ts`.
- **One set of use-cases, every caller.** The HTTP API, the MCP server (122 tools), the queue
  consumers and the agents call the _same_ application use-cases, so an AI agent can never do
  what a human API client couldn't, and every write goes through the same validation and RBAC.
- **Structured content model.** Typed fields with validations, localization with fallback
  chains, references with referential integrity, components, and assets in R2.
- **Three API surfaces.** Management (CMA), Delivery (CDA) and Preview (CPA), each gated by
  scoped, hashed API keys and roles with per-type and per-field grants. Delivery is REST plus a
  per-environment **GraphQL** schema generated from the model, served from a cache keyed by what
  the caller may see; the key is checked on every request, before the cache.
- **Event-driven backbone.** Every write commits one D1 batch that includes its domain event in a
  transactional outbox. A post-commit nudge (plus a one-minute cron sweep) relays it to Queues,
  whose engine consumer fans it out to webhooks, functions, search indexing, live SSE, delivery
  cache purges and the agents.
- **AI built in.** Tiered model selection (`flagship`/`balanced`/`fast`) on Workers AI,
  schema-validated generation, hybrid search (FTS5 shards in Durable Objects plus Vectorize),
  and durable enrich/moderate/curate/repurpose agents and editorial workflows on **Cloudflare
  Workflows**.
- **Sandboxed plugins.** Third-party write-path plugins run in per-plugin Worker Loader isolates
  with no network and only the capabilities a person approved.

---

## Documentation

The public docs (guides for editors and integrators) are the Starlight site in `apps/docs`. The
maintainer docs live in [`docs/`](./docs) (start at [the index](./docs/README.md)):

| Doc                                                   | What's in it                                                                    |
| ----------------------------------------------------- | ------------------------------------------------------------------------------- |
| [Architecture](./docs/architecture.md)                | The Workers, the hexagonal layers, the package map, request and event flows     |
| [Domain model](./docs/domain-model.md)                | Field types, validation, entry state machine, locales, references, events       |
| [API reference](./docs/api-reference.md)              | Every HTTP endpoint, the query language, hybrid search, live SSE                |
| [Auth & RBAC](./docs/auth-and-rbac.md)                | Web sign-in, the signed principal, API key kinds, scopes, roles, OAuth for MCP  |
| [AI, agents & search](./docs/ai-agents-and-search.md) | Generation, hybrid search, MCP tools, the agent runtime                         |
| [Events & webhooks](./docs/events-and-webhooks.md)    | Outbox → relay → queue consumers, functions, scheduled actions, live updates    |
| [Consistency](./docs/consistency.md)                  | The D1 unit of work, read replicas and bookmarks, delivery staleness bounds     |
| [SDKs](./docs/sdks.md)                                | Delivery clients (core, web, vue, edge, react-native), Management client, codegen |
| [Deployment](./docs/deployment.md)                    | The fleet registry, provisioning, CI's ring deploys, rollback                   |
| [Configuration](./docs/configuration.md)              | Every var, secret and binding, and which Worker uses it                         |
| [Backup & restore](./docs/backup-and-restore.md)      | D1 Time Travel, environment snapshots, outbox replay                            |
| [Development](./docs/development.md)                  | Workspace commands, local stack, testing, adding a use-case                     |
| [Admin UI](./docs/admin-ui.md)                        | The React Router admin in `apps/web`                                            |
| [Plugins](./docs/plugins.md)                          | Sandboxed write-path plugins on Worker Loader                                   |

For coding agents, the rules every change keeps are in [`AGENTS.md`](./AGENTS.md).

---

## Repository layout

```
apps/
  web/            admin UI (React Router 8, SSR) + human auth: passwords, passkeys, TOTP,
                  OIDC single sign-on, SCIM, /setup. Fronts the api over the API service
                  binding, signing the signed-in person into x-cw-principal
  api/            Management + Preview REST, MCP, OAuth, media, live (HTTP only; Smart Placement)
  delivery/       public Content Delivery API: uncached gateway (auth on every request) →
                  cached Delivery entrypoint (Workers Caching); drains the purge queue
  engine/         queue consumers, cron, every Durable Object and Workflow (no route)
  docs/           public docs (Astro Starlight, static assets)
packages/
  domain/         framework-agnostic core: content types, fields, entry state machine,
                  validation, RBAC, locales, domain events
  ports/          interfaces only: ContentStore (with the withTransaction unit of work) + infra seams
  application/    use-cases orchestrating domain + ports over an AppContext
  db/             D1 schema, hand-written migrations, the D1 ContentStore
  adapters/       Cloudflare implementations of the ports, one subpath each
  platform/       env, config, wire, ids, metrics, queue messages, DO classes, Workflow clients
  http/           the Hono surface as a library: routes, auth, OpenAPI, MCP (+ its skills)
  security/       the signed web principal, deployment roles
  agent-runtime/  engine-agnostic agent workflows + the in-process runtime
  graphql-gen/    builds the GraphQL Delivery schema from published content types
  seed/           dev/demo dataset (SEED_SCALE)
  test-kit/       in-memory ContentStore + deterministic clock/id/blob/vector fakes
  redaction/      strips credentials from log output
  telemetry/      structured console logging
  docs/           docs/*.md embedded for the MCP and HTTP docs tools
  design/ ui/     Ledger: design tokens and the shared components
  sdk/            core, web, vue, edge, react-native, management, codegen
deployments/      one registry file per customer deployment
scripts/          fleet.ts (render configs, CI matrix, secrets), provision.sh, setup-code.sh
```

**The dependency rule:** `domain` → (nothing); `application` → `domain` + `ports`; adapters →
`ports`; only `@contentworker/platform`'s `wire.ts` and the app entries bind adapters to ports.
IDs are **UUIDv7**, always minted through the injected `IdGenerator`.

---

## Quick start

Requires **Node ≥ 24** and **pnpm 10**. No Cloudflare account is needed for local development.

```bash
pnpm install

# What CI's verify job runs
pnpm check-types && pnpm test && pnpm lint

# The local D1 (shared by every Worker in the dev session)
cd apps/web && npx wrangler d1 migrations apply DB --local && cd ../..

# The whole stack in one Vite session: web, plus api, engine and delivery as auxiliary Workers
pnpm dev

# Open http://localhost:5173: the first request seeds the demo dataset into space-1
# To start over with a fresh seed: rm -rf apps/web/.wrangler/state, then the migrations again
```

The dev session runs offline: models are mocked (`AI_MODE=mock`), embeddings are local and vectors
are held in memory. On localhost the admin is open without signing in until someone creates an
account, and the api accepts the bootstrap token `dev-admin-token` (all scopes, all spaces).
It always runs on the demo dataset (`@contentworker/seed`, about 550 entries with releases,
workflows and agent runs in `space-1`), seeded idempotently on the first request.

## End-to-end example

Create a space, model a content type, author and publish an entry, and read it back, through the
admin's origin (it forwards API paths to the api Worker):

```bash
B=http://localhost:5173
AUTH='Authorization: Bearer dev-admin-token'
M=$B/spaces/demo/environments/main

curl -s -X POST $B/spaces -H "$AUTH" -H 'content-type: application/json' \
  -d '{"spaceId":"demo","name":"Demo","defaultLocale":"en-US"}'

curl -s -X POST $M/content-types -H "$AUTH" -H 'content-type: application/json' -d '{
  "apiId":"article","name":"Article","displayField":"title",
  "fields":[{"apiId":"title","name":"Title","type":"Symbol","localized":false,"required":true,"position":0}]}'
curl -s -X POST $M/content-types/article/published -H "$AUTH"

curl -s -X POST $M/entries -H "$AUTH" -H 'content-type: application/json' \
  -d '{"contentTypeApiId":"article","fields":{"title":{"en-US":"Hello"}}}'
curl -s -X POST $M/entries/<id>/published -H "$AUTH"
curl -s $B/delivery/demo/main/entries/<id> -H "$AUTH"
```

The same operations are MCP tools (`entries_create`, `entries_publish`, …) at `/mcp`, so an agent
drives the CMS through the identical use-cases. See
[AI, agents & search](./docs/ai-agents-and-search.md).

## Deploy

Merging to `main` is releasing: CI migrates each deployment's D1 (after recording a Time Travel
bookmark) and deploys engine → api → delivery → web, ring by ring, rolling back in order on a
failed smoke test. A deployment answers at `<domain>` (admin), `api.<domain>` and `cdn.<domain>`.
Add one with a `deployments/<id>.jsonc` file and `./scripts/provision.sh <id>`; see
[Deployment](./docs/deployment.md).

---

## Status

Shipped and planned work is tracked in [`ROADMAP.md`](./ROADMAP.md).
