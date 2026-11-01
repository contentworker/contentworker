# Deployment

contentworker deploys to Cloudflare as **one isolated stack per customer**: each deployment has
its own D1 database, R2 bucket, KV namespace, Vectorize index, queues, AI Gateway and four
Workers (engine, api, delivery, web). Spaces and environments live inside a deployment's D1.
Merging to `main` is releasing: CI migrates D1 and deploys every deployment, ring by ring.
Nobody deploys from a workstation or an agent session.

For bindings and vars, see [Configuration](./configuration.md); for what each Worker does, see
[Architecture](./architecture.md); for restore points, see
[Backup & restore](./backup-and-restore.md).

## The registry: `deployments/*.jsonc`

One file per deployment, parsed by `toDeployment` in `scripts/fleet.ts`:

| Field           | Meaning                                                                                                     |
| --------------- | ----------------------------------------------------------------------------------------------------------- |
| `id`            | Lowercase id; reserved words (`api`, `cdn`, `admin`, `docs`, …) need an explicit `domain`                  |
| `ring`          | `staging`, `internal`, `canary` or `general`                                                                |
| `slot`          | 1–999, unique; keeps each deployment's rate-limit namespaces apart (`slot × 1000 + n`)                     |
| `domain`        | The admin host; default `<id>.contentworker.app`. The api is `api.<domain>`, delivery `cdn.<domain>`        |
| `suffix`        | Appended to every account-wide resource name; default `-<id>` (contentworker's own is `""`)                |
| `environment`   | The GitHub environment holding its secrets; default `deploy-<id>`                                          |
| `d1Id`, `kvId`  | Recorded by `scripts/provision.sh`; required to render                                                       |
| `jurisdiction`  | `eu` or `fedramp`, for D1, R2 and Durable Objects (set at creation)                                         |
| `hold`          | Skipped by CI: stays on what it runs now                                                                     |
| `docs`          | Also deploys the public docs site                                                                            |
| `demo`          | Public demo: models mocked (`AI_MODE=mock`, no AI Gateway), no Vectorize; never in `general`                 |
| `aiGatewayLogs` | Rendered as `AI_GATEWAY_LOGS`: whether AI Gateway logs each call (prompts and answers never)                 |
| `sso`           | `{ issuer, clientId, trustEmail? }`: the customer's OIDC provider for admin sign-in (secret `OIDC_CLIENT_SECRET`) |
| `email`         | `{ from, fromName? }`: Email Sending sender; adds the engine's `send_email` binding                          |

`scripts/fleet.ts` commands:

```sh
node scripts/fleet.ts render <id>          # write apps/{engine,api,delivery,web}/wrangler.<id>.json
node scripts/fleet.ts matrix               # deployments per ring, for CI (holds excluded)
node scripts/fleet.ts secrets <app> <out>  # that app's secrets from the environment, as JSON
node scripts/fleet.ts names <id>           # resource names as shell variables
node scripts/fleet.ts set-d1 <id> <uuid>   # record the D1 id in the registry
node scripts/fleet.ts set-kv <id> <kv id>  # record the KV namespace id
node scripts/fleet.ts status               # /health/deep of every deployment
```

A rendered config is the app's `wrangler.jsonc` with the deployment's names, ids, routes
(custom domains) and vars filled in: `OAUTH_ISSUER=https://<domain>` on the api (OAuth for MCP
clients is served on the admin host, so its consent screen can use the person's web sign-in) and
`MEDIA_BASE_URL=https://api.<domain>`, the AI Gateway id with `AI_GATEWAY_LOGS` on every Worker
that sets `AI_GATEWAY_ID`, `DATA_JURISDICTION`, SSO vars on web, and Email Sending on the engine.

## Provisioning a deployment

1. Add `deployments/<id>.jsonc` (`id`, `ring`, `slot`, optionally `domain`, `sso`, `email`).
2. Run `./scripts/provision.sh <id>` (needs `wrangler login` or `CLOUDFLARE_API_TOKEN`, and
   `gh auth login`). It is safe to re-run; it:
   - creates the D1 database, records its id, and turns on read replication (`mode: auto`;
     with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, else it says how);
   - creates the shared KV namespace and records its id;
   - creates the R2 bucket with lifecycle rules (`imports/` 7 days, `dlq/` 30 days);
   - creates the Vectorize index (768 dimensions, cosine; metadata indexes on `spaceId` and
     `environmentId`), except for a demo;
   - creates the queues (events, events DLQ, bulk, agents, purge, purge DLQ) with 14-day
     retention;
   - creates the AI Gateway (authenticated, rate-limited, retries, logs per `aiGatewayLogs`);
   - creates the GitHub environment and generates `PRINCIPAL_KEY`, `DATA_KEY`, `TOKEN_PEPPER`,
     `MEDIA_SIGNING_SECRET` and `PASSWORD_PEPPER` if absent (refusing to generate a new
     `DATA_KEY`, `TOKEN_PEPPER` or `PASSWORD_PEPPER` when the api Worker already holds one);
   - writes the first administrator's one-time setup code to `.secrets/<id>/setup-code`
     (gitignored) and sets it as `SETUP_TOKEN`.
3. Add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` to the environment if they are not
   repository secrets, commit the registry file, and merge. CI deploys it in its ring.
4. Send the customer's first admin `https://<domain>/setup` and the setup code.

Images and Stream are account features; their bindings need no ids. To receive Stream's
webhook, point it at `https://api.<domain>/webhooks/stream` and set `STREAM_WEBHOOK_SECRET`.

## Secrets

Secrets live in each deployment's GitHub environment and reach the Workers through
`wrangler deploy --secrets-file` (which adds and never removes, so a secret set by hand
survives). Which Worker gets which is `SECRETS` in `scripts/fleet.ts`:

| Worker   | Secrets                                                                                                                                   |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| web      | `PRINCIPAL_KEY`, `PRINCIPAL_KEY_PREVIOUS`, `DATA_KEY`, `DATA_KEY_PREVIOUS`, `SETUP_TOKEN`, `PASSWORD_PEPPER`, `OIDC_CLIENT_SECRET`        |
| api      | `PRINCIPAL_KEY`, `PRINCIPAL_KEY_PREVIOUS`, `DATA_KEY`, `DATA_KEY_PREVIOUS`, `TOKEN_PEPPER`, `MEDIA_SIGNING_SECRET`, `STREAM_WEBHOOK_SECRET`, `MCP_TOKEN`, `ADMIN_TOKEN` |
| engine   | `ASSISTANT_PRINCIPAL_KEY`, `ASSISTANT_PRINCIPAL_KEY_PREVIOUS` (derived from the `PRINCIPAL_KEY` pair; never the pair itself), `DATA_KEY`, `DATA_KEY_PREVIOUS`, `TOKEN_PEPPER`, `MEDIA_SIGNING_SECRET` |
| delivery | `DATA_KEY`, `DATA_KEY_PREVIOUS`, `TOKEN_PEPPER`, `MEDIA_SIGNING_SECRET`                                                                   |

`PRINCIPAL_KEY`, `DATA_KEY`, `TOKEN_PEPPER` and `MEDIA_SIGNING_SECRET` are required
(`REQUIRED_SECRETS`); keys must be at least 32 characters (`openssl rand -hex 32`). Every
Worker of a deployment holds the same value of each. `DATA_KEY`, `TOKEN_PEPPER` and
`PASSWORD_PEPPER` never change once a deployment runs (escrow them); `DATA_KEY` and
`PRINCIPAL_KEY` rotate through their `*_PREVIOUS` companions.

**Rotating `PRINCIPAL_KEY`:** set `PRINCIPAL_KEY_PREVIOUS` to the current key and `PRINCIPAL_KEY`
to a new one in the GitHub environment and deploy; once every Worker runs the new key, remove
`PRINCIPAL_KEY_PREVIOUS` and deploy again. The engine's assistant pair follows on its own: `fleet.ts
secrets` derives `ASSISTANT_PRINCIPAL_KEY` from `PRINCIPAL_KEY` and `ASSISTANT_PRINCIPAL_KEY_PREVIOUS`
from `PRINCIPAL_KEY_PREVIOUS` on every deploy. Because `--secrets-file` never removes a secret,
delete `ASSISTANT_PRINCIPAL_KEY_PREVIOUS` from the engine (`wrangler secret delete`, by hand, with
the user's approval) when you remove `PRINCIPAL_KEY_PREVIOUS`, as for any `*_PREVIOUS`.

### The assistant's principal key

The web gateway signs the assistant's paths (`/agents/*`) with a key derived from `PRINCIPAL_KEY`
(HKDF-SHA256, salt `contentworker/principal-subkeys`, info `contentworker/assistant-principal/v1`,
32 bytes as base64url: `deriveAssistantPrincipalKey` in `@contentworker/security/assistant-key`)
and every other path with `PRINCIPAL_KEY` itself. The api's gate for `/agents/*` derives the key
from `PRINCIPAL_KEY` (and `_PREVIOUS`); its REST surface accepts only the main key. The engine holds
only the derived pair, so a principal it could sign is good for the assistant's socket and nothing
else. Nothing to set by hand: CI derives the pair at each deploy (`fleet.ts secrets`, with
`scripts/derive-assistant-key.ts`; it reads the key from stdin or `PRINCIPAL_KEY`, never an
argument), and `provision.sh` generates nothing new for it.

The api gate and the engine accept only the derived key on `/agents/*`; a principal signed with
`PRINCIPAL_KEY` is refused there, and one signed with the derived key is refused on every other
path. This shipped in one step because no deployment had run the assistant before it: there was no
web Worker still signing `/agents/*` with the main key to stay compatible with. A future change to
how these paths are signed has to roll out in two steps (verifiers accept both, then only the new).

## The pipeline

`.github/workflows/ci.yml`:

- **verify** (every push and pull request): lint, type-check and build in one parallel turbo
  run (the build is `wrangler deploy --dry-run` for engine, api and delivery), then the tests on
  their own (including the engine's Workflow runs in workerd with `AI_MODE=mock`),
  `pnpm test:fleet`, `pnpm test:toolkit`, and `pnpm audit --prod --audit-level high`.
- **devices**: the web app's Playwright suite in WebKit (iPhone, iPad, desktop) and Chromium
  against an offline dev server (`apps/web/e2e`). The `changes` job skips it for a pull request
  that only touches `docs/`, `apps/docs/`, `deployments/`, `.claude/` or top-level Markdown.
- **plan → staging → internal → canary → general** (push to `main` only): `fleet.ts matrix`
  groups deployments by ring; each ring waits for the previous one to finish cleanly and calls
  `deploy.yml` once per deployment (`general` four at a time).

`.github/workflows/deploy.yml`, per deployment:

1. Render the config and collect each app's secrets.
2. **Record a D1 Time Travel bookmark** (the restore point for this deploy).
3. **Migrate D1**: `wrangler d1 migrations apply DB --remote`. Migrations run before the new
   code, so they must be additive (expand).
4. Deploy **engine** (it owns the DO and Workflow classes the others bind), then **api**, then
   **delivery**, then build and deploy **web**.
5. Smoke test: `https://<domain>/health`, `/health/deep` (D1 and the api over the binding),
   `/login`, `https://api.<domain>/health` and `/openapi.json`, `https://cdn.<domain>/health`,
   and an anonymous delivery read must answer 401.
6. Latency check (warns only): `/login` 1.5 s, `/health/deep` 1.0 s, `cdn.<domain>/health` 0.3 s.
7. On any failure after the engine shipped, **roll back in order**: engine first (Cloudflare
   refuses to roll a Worker back past a Durable Object migration; if the engine can't go back,
   nothing else is rolled back and a person decides), then api, delivery and web, each only if
   it deployed. A first deploy has no earlier version and stays. D1 migrations are not rolled
   back.
8. The deployment with `docs: true` then deploys and smoke-tests the docs site, rolling it back
   alone on failure.

All Cloudflare calls retry up to three times; each step is idempotent.

## Migrations

Hand-written SQL in `packages/db/migrations/NNNN_*.sql` (`0001_init.sql`, `0002_auth.sql`, `0003_environment_purges.sql`),
mirrored in `packages/db/src/schema.ts` / `auth-schema.ts`. Expand-only and never edited once
applied: add a table or column now; drop or rename only in a later change once no deployed code
reads it. Locally: `cd apps/web && npx wrangler d1 migrations apply DB --local`. Remote
databases are migrated only by CI.

## Recovering admin access

When no administrator can sign in, `./scripts/setup-code.sh <id>` issues a new one-time setup
code: it writes it to `.secrets/<id>/setup-code`, sets it on the GitHub environment (so the next
deploy keeps it) and on the web Worker (so it works now). The code opens `/setup` once to create
one admin account; its use and every wrong guess go to the audit log.

## Rollback by hand

CI rolls back a failed deploy itself. A later rollback is a revert merged to `main`, which CI
ships like any change. Rolling code back never rolls the schema back; restoring data is a D1
Time Travel restore (see [Backup & restore](./backup-and-restore.md)).

Mind what the older code doesn't know about. Code from before environment purging
(`0003_environment_purges.sql`) ignores the purge markers: while a deleted environment is still
being purged, it would serve the leftovers again, let the same id be created on top of them, and
treat `environment.purge_due` as an ordinary event (so a webhook subscribed to `*` would receive
it). Check `SELECT * FROM environment_purges` is empty before rolling back past that change;
purges normally finish within minutes.

An engine from before snapshot import jobs (environment import and clone) doesn't know their job
kind: it fails their chunks and never starts their publishing job. Re-run such an import after
rolling forward.
