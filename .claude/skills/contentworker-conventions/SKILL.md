---
name: contentworker-conventions
description: The invariants contentworker's code must keep, each with why it holds and how to check it. Background knowledge for any change to the domain, ports, application use-cases, the HTTP and MCP surfaces, the SQL store and its migrations, adapters, the platform wiring, the edge workers (web, api, delivery, engine) or CI; preloaded by the engineer, test-engineer, code-reviewer, hexagonal-guardian and ai-reviewer agents. Use when writing or reviewing code here and you need the rule behind an AGENTS.md line, or the grep or test that proves a change keeps it.
user-invocable: false
---

# contentworker conventions

AGENTS.md (imported by CLAUDE.md) states the rules in one line each. This skill is the working
version: what each rule protects, where it lives in the code, and how to tell whether a change
keeps it. The full list is in [references/invariants.md](references/invariants.md); read the
sections your change touches. Path-specific reminders live in
[references/rules-map.tsv](references/rules-map.tsv), which the `rules-impact` hook reads.

## The shape of the system

One isolated stack per customer (`deployments/*.jsonc`, rendered by `scripts/fleet.ts`), an edge
SQL database as the system of record, five edge workers split by traffic profile:

| Worker          | Entry                    | Job                                                                                                                    |
| --------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `apps/web`      | `workers/app.ts`, `app/` | Admin UI (React Router 8 SSR) and human auth; fronts the api over the `API` binding, signs `x-cw-principal`            |
| `apps/api`      | `src/index.ts`           | Management + Preview REST, MCP, OAuth, media, live. HTTP only, placed near the database                                |
| `apps/delivery` | `src/index.ts`           | Public Delivery API: uncached gateway (auth every request) → cached `Delivery` entrypoint on database replicas         |
| `apps/media`    | `src/index.ts`           | Published asset files: uncached gateway (canonical URL) → cached `Media` entrypoint; reads the engine's key-value gate |
| `apps/engine`   | `src/index.ts`           | Queue consumers, cron, every stateful-object and durable-workflow class; no route                                      |

Shared code lives in packages, never in another app:

- `packages/domain` → `packages/ports` → `packages/application`: the pure core (types and rules;
  interfaces; one use-case per capability taking `AppContext` + `Scope`).
- `packages/db`: the SQL `ContentStore` (`src/store.ts`, `src/exec.ts`), the Drizzle mirror of
  the schema (`src/schema.ts`, `src/auth-schema.ts`) and the hand-written `migrations/`.
- `packages/adapters`: edge-platform implementations of the ports, one subpath each
  (`@contentworker/adapters/ai-workers`, `/queue-cf`, `/vector-vectorize`, …).
- `packages/platform`: env (`EdgeEnv`), config, `wireEdge` (`src/wire.ts`, the composition
  root), ids, metrics, queue messages, stateful-object classes (`src/do/`) and durable-workflow
  clients.
- `packages/http`: the Hono surface: routes (`src/api/routes/`), auth, OpenAPI, MCP
  (`src/mcp/server.ts`, its tools one file per area in `src/mcp/tools/`) and the embedded MCP
  skills (`skills/`). Management routes are one file per area in `src/api/routes/management/`.
- `packages/test-kit` (in-memory store and fakes), `packages/security` (signed principal, roles),
  `packages/agent-runtime`, `packages/sdk/*` (public clients), `packages/design` + `packages/ui`
  (the "Ledger" design system).

## Rules a hook enforces

These fail fast, so you'll hear about them; the reasons are in invariants.md.

| Rule                                                                                                | Hook                                                              |
| --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| No hand deploys, rollbacks, resource deletes, point-in-time restores, `pnpm … deploy`               | `guard-bash.sh` denies                                            |
| No remote database migrations (`--remote`, `db:migrate:remote`)                                     | `guard-bash.sh` denies                                            |
| Pushing `main`, force pushes, merging a PR, remote database SQL, secrets, provisioning              | `guard-bash.sh` asks                                              |
| An applied migration (on `origin/main`) is never edited; a new one that drops or renames asks first | `guard-invariants.sh` denies / asks                               |
| Every external dependency version comes from the pnpm catalog (`catalog:` / `workspace:`)           | `guard-invariants.sh` denies; `scripts/catalog.test.ts` fails     |
| Stateful-object migration tags are append-only                                                      | `guard-invariants.sh` asks; `scripts/do-migrations.test.ts` fails |
| No new z-suffixed endpoints (`/health`, not `/healthz`)                                             | `guard-invariants.sh` denies                                      |
| Generated files aren't hand-edited (docs embed, MCP skills embed, docs theme, OpenAPI snapshot)     | `block-generated.sh` denies                                       |
| Path-specific rules when you edit a file                                                            | `rules-impact.sh`, from rules-map.tsv                             |

## Rules only a reader can check

In the order reviews most often find them broken:

1. **Unit of work.** `withTransaction` commits one database batch: reads first, then writes; a
   read in the unit doesn't see its own writes; a lost compare-and-set surfaces at commit as
   `TransactionConflictError`. The outbox row rides in the same unit.
2. **Database limits.** ≤ 100 bound parameters per statement (`chunked`, `selectChunked`, or one
   JSON parameter with `json_each`); one writer per database (no writes on read paths); 10 GB.
3. **Both surfaces.** A capability added to the HTTP API also exists as an MCP tool (and the
   reverse), calling the same use-case with the same authorization.
4. **Scope and determinism.** Every store call carries the caller's `Scope`; ids from
   `ctx.ids.newId()`, time from `ctx.clock.now()`; durable-workflow effects only inside `step.do`.
5. **Expand-only data.** A migration works with the code already deployed; `schema.ts` mirrors it;
   stateful-object tags append only.
6. **Trust boundaries.** `x-cw-principal` only signed, path-bound and fresh; the `Delivery`
   entrypoint is never routable; no trusted header on a publicly routed handler.
7. **Env parity.** A new var or binding is in `EdgeEnv`, config, every `wrangler.jsonc` that reads
   it, `scripts/fleet.ts` when it varies per deployment, and `docs/configuration.md`.
8. **Structured content.** Content is typed fields and `RichTextDocument` trees, never an HTML
   or Markdown string: HTML is converted on the way in (`richTextFromHtml`) and rendered by the
   consumer on the way out.
9. **Completeness.** A documented surface has its docs updated in the same change (`docs-sync`).

## Before you say a change is done

Run the `preflight` skill. If the change touched a documented surface, the docs move in the same
change (`docs-sync`).
