# Invariants: what, why, how to check

Each section: the rule, why it holds, where it lives, and a check you can run from the repo root.
A check that prints nothing passes. Grep the code before quoting a name from here: these notes
describe the code when they were written, and the code wins.

## The dependency rule

**Rule.** `packages/domain` imports nothing from the workspace. `packages/ports` holds interfaces
in domain types. `packages/application` imports domain + ports. `packages/test-kit` and
`packages/agent-runtime` follow the application's restrictions. Adapters are bound to ports only
in `packages/platform/src/wire.ts` and the app entries. No SQL, Drizzle, D1 or driver type crosses
a port. Public SDKs (`packages/sdk/*`) import only `@contentworker/sdk-*`.

**Why.** It is what lets every use-case run against the in-memory test-kit store in Node and the D1
store in workerd, and what keeps the core testable without bindings. One adapter import in an
inner package drags a Cloudflare binding type into every runtime.

**Check.**
- `grep -rn "from '@contentworker/" packages/domain/src`
- `grep -rnE "from '@contentworker/(adapters|platform|http|db|security)" packages/ports/src packages/application/src packages/test-kit/src packages/agent-runtime/src`
- `grep -rnE "from '(drizzle-orm|hono|cloudflare:)" packages/domain/src packages/ports/src packages/application/src`
- `grep -rn "from '@contentworker/" packages/sdk/*/src | grep -v "@contentworker/sdk-"`

`packages/http` is an outer layer and uses a few adapter helpers directly (media signing, image
transforms, the import sources); it still gets its ports from `wireEdge`, never by constructing
adapters per request. The `hexagonal-guardian` agent reviews the rest.

## Both surfaces

**Rule.** Every capability is a use-case in `@contentworker/application`, exposed through both
the HTTP API (`packages/http/src/api/routes/*.ts`) and MCP (`packages/http/src/mcp/server.ts`),
each behind the same authorization.

**Why.** An AI agent must never be able to do what a human API client can't (or skip a check a
client goes through), and the reverse.

**Check.** For a new export in `packages/application/src`, grep its name in
`packages/http/src/api/routes` and `packages/http/src/mcp/server.ts`; both must call it. Tests:
`packages/http/test/api/` and `packages/http/test/mcp/`.

## Scope and determinism

**Rule.** Every store and use-case operation carries a `Scope` (`{ spaceId, environmentId }`).
IDs come from `ctx.ids.newId()` (UUIDv7), time from `ctx.clock.now()`; never
`crypto.randomUUID()` or `new Date()` for "now" in domain or application code.

**Why.** A store call without a scope is a cross-space read waiting to happen; making the scope a
required argument turns it into a type error. Tests inject fixed clocks and ids.

**Check.** `grep -rnE 'randomUUID|new Date\(\)' packages/application/src packages/domain/src`. A
new use-case test in `packages/application/test` writes under one scope and proves another can't
see it.

## The unit of work

**Rule.** `withTransaction` (`packages/ports/src/content-store.ts`) is a unit of work, not an
interactive transaction: D1 commits a batch. Read everything first, then write; a read inside the
unit does not see its own writes. A compare-and-set inside the unit reports its outcome only at
commit, as `TransactionConflictError`; callers retry or treat the lost race as a no-op. A write that
emits a domain event appends its outbox row in the same unit.

**Why.** Code written as if it were an interactive transaction reads stale values mid-unit and
decides wrong. The event exists if and only if the commit did.

**Check.** In the diff, no read after a write inside one `withTransaction` callback whose result
depends on that write; every caller of a conditional write handles `TransactionConflictError`.
The test-kit store (`packages/test-kit/src/in-memory-store.ts`) must keep the same semantics, and a
contract test in `packages/db/test/` proves the D1 store does.

## D1 limits

**Rule.** At most 100 bound parameters per statement (`chunked` / `selectChunked` in
`packages/db/src/exec.ts`, or one JSON parameter with `json_each`); one writer per database, so no
per-request writes on read paths (`lastUsedAt` refreshes are throttled, `packages/application/src/auth.ts`);
10 GB per database (append-heavy data goes to R2, derived indexes to Durable Objects such as
`SearchShardDO`).

**Why.** A list query that binds one parameter per id works in a test with five ids and fails in
production with 200. Writes on the delivery path serialize behind the single writer.

**Check.** A new `IN (…)` or multi-row insert in `packages/db/src` goes through `chunked`; a test
in `packages/db/test` drives it with more than 100 items.

## Transactional outbox and at-least-once handlers

**Rule.** Publish-like writes (publish, unpublish, release, scheduled publish, bulk) append their
event to the outbox in the same unit. The relay and the engine's queue consumers deliver at least
once; every handler in `packages/application/src/events/` is idempotent on the event id.

**Why.** A handler that isn't idempotent double-sends webhooks or double-embeds on redelivery.

**Check.** `grep -n "outbox" packages/application/src/<file>.ts` around the change; a test that
fails the unit and asserts no event, and one that delivers an event twice.

## Workflows and agents

**Rule.** Cloudflare Workflows (`apps/engine/src/workflows/`) do effects, clock reads and model
calls only inside `step.do`, and step names never change once deployed. `packages/agent-runtime`
workflow functions do every side effect through the `Activities` interface.

**Why.** A durable engine replays the workflow function: anything outside a step runs again, and a
renamed step misses its cached result for every running instance.

## D1 migrations

**Rule.** `packages/db/migrations/NNNN_*.sql`, hand-written SQL, mirrored column for column in
`packages/db/src/schema.ts` (or `auth-schema.ts`). Expand-only: add a column or table now; drop or
rename only in a later change once no deployed code reads it. A migration on `origin/main` has been
applied by CI to every deployment and is never edited. Remote databases are migrated only by CI
(`deploy.yml`: bookmark, `wrangler d1 migrations apply DB --remote`, then the Workers).

**Why.** CI migrates before it deploys and never rolls D1 back, so the old code runs on the new
schema during every deploy and after any Worker rollback.

**Check.** `git diff --name-status origin/main...HEAD -- packages/db/migrations` shows only `A`
lines; `pnpm --filter @contentworker/db test` applies every migration to a fresh D1.

## Durable Object migrations

**Rule.** In `apps/engine/wrangler.jsonc` (the owner of every DO class), `migrations` tags only
ever append; no `deleted_classes`, `renamed_classes` or `transferred_classes` without a plan for
the class's data. A new class appends its tag in the config and in `APPLIED` in
`scripts/do-migrations.test.ts`, in the same change; api and delivery bind it by `script_name`.

**Why.** Cloudflare applies a tag once and remembers it; editing it only desyncs the config, and a
delete destroys every object of the class. The engine also can't roll back past a DO migration
(`deploy.yml` stops the rollback there).

**Check.** `pnpm test:fleet` (runs `node --test scripts/*.test.ts`, including do-migrations).

## Generated files

**Rule.** Regenerate, never edit: `packages/docs/src/generated.ts`
(`pnpm --filter @contentworker/docs generate`), `packages/http/src/mcp/skills.generated.ts`
(`pnpm --filter @contentworker/http generate:skills`), `apps/docs/src/styles/theme.css`
(`pnpm sync:theme`). Also `apps/web/worker-configuration.d.ts` (`pnpm --filter @contentworker/web types`)
and `apps/docs/src/generated/openapi.json` (written on every docs build).

**Check.** The `regen` skill; the docs and http test suites fail on drift.

## Trust boundaries

**Rule.** The api believes `x-cw-principal` only when signed with `PRINCIPAL_KEY`, bound to the
request path and under 60 s old (`packages/security/src/principal.ts`, checked in
`packages/http/src/api/auth.ts`; signed by `apps/web/app/lib/gateway.server.ts`). The delivery
`Delivery` entrypoint (`apps/delivery/src/delivery.ts`) trusts `x-cw-delivery-principal` only
because nothing outside the Worker can reach it. Never add a trusted header to a publicly routed
handler. Details: the `security-model` skill.

## Environment parity

**Rule.** A new env var or binding is typed in `EdgeEnv` (`packages/platform/src/env.ts`), read
in `packages/platform/src/config.ts` or `wire.ts`, declared in every `apps/*/wrangler.jsonc` that
reads it (and the local stack's vars in `apps/web/vite.config.ts` when it needs a dev value),
rendered per deployment in `scripts/fleet.ts` when it varies, created in `scripts/provision.sh`
when it is a resource, and documented in `docs/configuration.md`. Secrets are never `vars`: CI
writes them from the deployment's GitHub environment (`SECRETS` in `scripts/fleet.ts`).

**Check.** The `infra-change` skill; the `workers-reviewer` agent.

## Dependencies

**Rule.** Every external dependency version lives in the pnpm catalog (`pnpm-workspace.yaml`,
`catalogMode: strict`); a `package.json` names it `catalog:` (or `workspace:*` for a
`@contentworker/*` package). Only `peerDependencies` keep their own ranges.

**Check.** The `guard-invariants` hook denies the rest; `scripts/catalog.test.ts` in CI.

## Endpoints, deploys, naming

- No trailing "z" in endpoint names: `/health`, `/ready`, never `/healthz` (the
  `guard-invariants` hook denies adding one).
- Deploys and remote migrations never run from an agent session (`guard-bash` denies them);
  `wrangler deploy --dry-run` only bundles and is allowed.
- Never name a competing CMS anywhere; say "the surveyed CMS".
- Test files are named for the capability (`releases.test.ts`), never a roadmap phase.
