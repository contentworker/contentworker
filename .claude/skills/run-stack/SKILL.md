---
name: run-stack
description: Boot contentworker's whole local stack (web, api, engine and delivery in one Vite session on a local database) and smoke-test it with the dev tokens. Use to see a change working against a real running stack rather than only tests.
disable-model-invocation: true
---

# Run the local stack

`pnpm dev` runs `apps/web` under Vite with the platform's Vite plugin and the api, engine and
delivery workers as auxiliary workers (`apps/web/vite.config.ts`), all on one local database under
`apps/web/.wrangler`. The auxiliary workers get `LOCAL_STACK_VARS`: mock AI, local hash
embeddings, in-memory vectors, fakes allowed, and dev secrets that are never a deployment's.

## Start

1. Migrate the local database: `pnpm --filter @contentworker/web db:migrate:local`.
2. Start in the background (never foreground a server): `pnpm dev`. Note the URL Vite prints
   (React Router's dev server, `http://localhost:5173` unless taken).
3. Wait for `GET /health` to answer 200.

A fresh database has no people, so the admin is open until someone signs up (the first sign-up
turns sign-in on). The api's paths (`/spaces/…`, `/delivery/…`, `/preview/…`, `/mcp`,
`/openapi.json`, `/oauth/…`, `/media/…`) are served on the same origin through the web gateway
(`isApiPath` in `apps/web/app/lib/gateway.server.ts`). Cron doesn't fire on its own locally.

## Smoke tests

Dev tokens (from `LOCAL_STACK_VARS`): `dev-admin-token` (`ADMIN_TOKEN`, every scope in every
space) and `dev-mcp-token` (`MCP_TOKEN`).

1. `GET /health` and `GET /health/deep` (the database and the api over the service binding).
2. `GET /openapi.json` returns JSON.
3. One management call with `Authorization: Bearer dev-admin-token` (e.g. `GET /spaces`) answers
   200; the same call with no credentials answers 401.
4. MCP: an `initialize` to `/mcp` with `Bearer dev-mcp-token` answers.
5. A delivery read with no key answers 401 (auth runs before the cache).

Discover concrete routes from `packages/http/src/api/routes` or `/openapi.json`; don't guess URL
shapes. Report each probe: method, path, token, status, and a one-line verdict.

## Teardown

Stop the background `pnpm dev`. The local database stays under `apps/web/.wrangler`; delete it
only if the user wants the data wiped. The e2e suite uses its own database under `.wrangler/e2e`.
