# Deployment

ContentWorker is self-hosted: one install in your own Cloudflare account, with its own database,
object storage bucket, key-value namespace, vector index, queues, AI gateway and five edge workers
(engine, media, api, delivery, web). Spaces and environments live inside the install's database.
You run two scripts from a checkout: `pnpm contentworker:setup` creates the resources and the secrets once,
and `pnpm contentworker:deploy` ships the checked-out commit. Merging to `main` of this repository deploys
nothing, and an agent session never deploys.

For bindings and vars, see [Configuration](./configuration.md); for what each worker does, see
[Architecture](./architecture.md); for restore points, see
[Backup & restore](./backup-and-restore.md). The operator's short version is
https://docs.contentworker.app/start/self-hosting/.

## Prerequisites

- A Cloudflare account on the Workers Paid plan, and a zone in it for the install's `DOMAIN`.
- Node 24 and pnpm.
- `wrangler login` (used by setup and by a deploy from your workstation), or `CLOUDFLARE_API_TOKEN`
  and `CLOUDFLARE_ACCOUNT_ID` in the environment (required in CI; see
  [The deploy token](#the-deploy-token)).

## First install

```sh
git clone <your clone of the repository> contentworker && cd contentworker
pnpm install
pnpm --filter @contentworker/engine exec wrangler login
cp .env.example .env        # set DOMAIN, and any optional setting you want
pnpm contentworker:setup               # resources and secrets; safe to re-run
pnpm contentworker:deploy
```

1. **Settings.** `.env.example` lists every setting as a flat environment variable; copy it to
   `.env` (gitignored). A variable already set in the environment wins over the file, and an empty
   one counts as unset. `scripts/install.ts` parses them.
2. **`pnpm contentworker:setup`** (`scripts/setup.sh [--env-file <path>] [--github]`) needs `wrangler login`
   (or the token variables) and is safe to re-run; it keeps what exists. It:
   - creates the database and turns on read replication (`mode: auto`; when the API refuses, it
     says how to do it in the dashboard);
   - creates the shared key-value namespace;
   - creates the object storage bucket with lifecycle rules (`imports/` 7 days, `dlq/` 30 days,
     `zips/` 2 days, and `abort-multipart`, which aborts multipart uploads left unfinished for 2
     days anywhere in the bucket);
   - creates the vector index (768 dimensions, cosine; metadata indexes on `spaceId` and
     `environmentId`), skipped with `AI_MODE=mock`;
   - creates the queues (events, events DLQ, bulk, agents, purge, purge DLQ, media purge, media
     purge DLQ, asset events, asset events DLQ) with 14-day retention;
   - creates the storage event notification rule that sends the bucket's `object-create` events
     to `contentworker-asset-events<suffix>` (asset ingest), unless one to that queue exists;
   - creates the AI gateway (authenticated, rate-limited, retries, logs per `AI_GATEWAY_LOGS`);
   - generates `PRINCIPAL_KEY`, `DATA_KEY`, `TOKEN_PEPPER`, `MEDIA_SIGNING_SECRET`,
     `PASSWORD_PEPPER` and the first administrator's `SETUP_TOKEN` into `.secrets/secrets.env`
     (`.secrets/secrets-<instance>.env` with `INSTANCE`; mode 0600, gitignored, never printed). It
     refuses to generate a new `DATA_KEY`, `TOKEN_PEPPER` or `PASSWORD_PEPPER` while the api or
     web worker already holds one: restore the file from your backup instead;
   - with `--github`, also sets the secrets on the repository's `production` environment, which it
     limits to `main`, for [deploy on merge](#deploy-on-merge) (needs `gh auth login`; not with
     `INSTANCE`, since the workflow ships one install).
3. **Back up `.secrets/`.** `DATA_KEY` seals every stored secret, and `TOKEN_PEPPER` and
   `PASSWORD_PEPPER` are in every API key and password hash. Losing one makes what it protects
   unreadable, and none can be regenerated. Keep a copy outside the machine, in a password manager
   or a secrets store (see [Backup & restore](./backup-and-restore.md#backing-up-secrets)).
4. **`pnpm contentworker:deploy`** (`scripts/deploy.sh [--env-file <path>]`) ships the checked-out commit; see
   [What a deploy does](#what-a-deploy-does).
5. **The first admin.** Open `https://<DOMAIN>/setup` and enter `SETUP_TOKEN` from the secrets file
   to create the first administrator.

Edge image transforms and the video streaming service are account features; their bindings need
no ids. The routes (`<DOMAIN>`, `api.`, `cdn.` and `media.<DOMAIN>`) are custom domains on the
edge workers: the deploy creates each one and its certificate, on a zone in the same Cloudflare
account, so there is no DNS record to add by hand. To receive the video streaming service's
webhook, point it at `https://api.<DOMAIN>/webhooks/stream` and set `STREAM_WEBHOOK_SECRET`.

## Settings

| Variable                                            | Meaning                                                                                                                                                 |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DOMAIN`                                            | Required. The admin host. The api is `api.<DOMAIN>`, Delivery `cdn.<DOMAIN>`, media `media.<DOMAIN>`                                                    |
| `DATA_JURISDICTION`                                 | `eu` or `fedramp`, for the database, object storage and stateful objects. Set before the first setup: it can't change once they exist                   |
| `AI_MAX_TIER`                                       | `flagship`, `balanced` or `fast`: the most capable model tier the install runs (its price ceiling per call). Unset: no cap                              |
| `AI_GATEWAY_LOGS`                                   | Whether the AI gateway logs each call (prompts and answers never). Default `false`                                                                      |
| `AI_MODE`                                           | `mock` runs without Workers AI: models mocked, no AI gateway or vector index, `ALLOW_FAKE_ADAPTERS=ai,vectors` on the api, delivery and engine          |
| `DEMO_STARTERS`                                     | Offer the enterprise sample starter when a space is created (`DEMO_STARTERS=true` on the api)                                                           |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_TRUST_EMAIL` | Admin single sign-on with your OIDC provider; the client secret is the secret `OIDC_CLIENT_SECRET`                                                      |
| `EMAIL_FROM`, `EMAIL_FROM_NAME`                     | Edge email sender (workflow notify nodes, invitations, scheduler alerts; password reset codes on web); adds the engine's and web's `send_email` binding |
| `INSTANCE`, `RATE_LIMIT_SLOT`                       | A second install in the same account; see [Two installs in one account](#two-installs-in-one-account)                                                   |

`scripts/install.ts` renders each app's `wrangler.jsonc` into `apps/<app>/wrangler.deploy.json`
(`wrangler.deploy-<instance>.json` with `INSTANCE`) with the install's names, ids, routes (custom
domains) and vars filled in: `OAUTH_ISSUER=https://<DOMAIN>` on the api (OAuth for MCP clients is
served on the admin host, so its consent screen can use the person's web sign-in) and
`MEDIA_BASE_URL=https://api.<DOMAIN>`, the AI gateway id with `AI_GATEWAY_LOGS` on every worker
that sets `AI_GATEWAY_ID`, `DATA_JURISDICTION`, SSO vars on web, and edge email on the engine and
web. Its commands (each takes `--env-file <path>`):

```sh
node scripts/install.ts render               # write apps/<app>/wrangler.deploy.json
node scripts/install.ts names                # resource names as shell variables
node scripts/install.ts secrets <app> <out>  # that app's secrets, as JSON
```

## Upgrading

```sh
git pull
pnpm install
pnpm contentworker:deploy
```

A deploy migrates the database before the new code ships, so every migration is expand-only
(additive; see [Migrations](#migrations)). Re-run `pnpm contentworker:setup` first when a release adds a
resource (a queue, a bucket rule): it creates only what is missing, and a deploy that needs a
resource that isn't there fails at the step that binds it.

### Upgrade notes

A release that needs more than `pnpm contentworker:deploy` is listed here, newest first, with what to do
before deploying it. A release not listed needs nothing extra.

- None yet.

## What a deploy does

`scripts/deploy.sh` runs from the commit it ships. It refuses to start outside GitHub Actions unless
`CONTENTWORKER_DEPLOY=1` (`pnpm contentworker:deploy` sets it) and removes the secrets from its environment
once they are written to files, so builds never see them. Each step is a titled group in a CI log,
and a failure names the one it stopped at.

1. Check credentials: `wrangler login`, or `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`
   (required in CI).
2. Render the config: the database and key-value ids are looked up by the names setup created them
   with (or taken from `D1_ID` and `KV_ID`), then each app's secrets are collected, from the
   environment first, else the secrets file.
3. **Record a point-in-time recovery bookmark** (the restore point for this deploy).
4. **Migrate the database**: `wrangler d1 migrations apply DB --remote`. Migrations run before
   the new code, so they must be additive (expand).
5. Deploy **engine** (it owns the stateful object and workflow classes the others bind), then
   **media** (so it already verifies the URLs the api and delivery hand out), then **api**, then
   **delivery**, then build and deploy **web**.
6. Smoke test: `https://<DOMAIN>/health`, `/health/deep` (the database and the api over the
   binding), `/login`, `https://api.<DOMAIN>/health` and `/openapi.json`,
   `https://cdn.<DOMAIN>/health`, `https://media.<DOMAIN>/health`; an anonymous delivery read must
   answer 401 and an unknown media URL 404.
7. Latency check (warns only): `/login` 1.5 s, `/health/deep` 1.0 s, `cdn.<DOMAIN>/health` 0.3 s.

On any failure after the engine shipped, the deploy **rolls back in order**: engine first (the
platform refuses to roll a worker back past a stateful-object migration; if the engine can't go
back, nothing else is rolled back and a person decides), then media, api, delivery and web, each
only if it deployed. A first deploy has no earlier version and stays. Database migrations are not
rolled back. All platform API calls retry up to three times; each step is idempotent.

## Scheduler alerts

The engine's per-minute cron runs the sweeps nothing else would notice stopping: the outbox relay,
scheduled actions, asset expiry, retention, the reseal and the rest. Two things watch it:

- **The cron watches its sweeps.** At the end of each tick it checks every sweep the install
  runs; one that has gone two of its runs without a success (five minutes for the every-minute
  sweeps, two hours for the hourly ones, two days for the daily ones) is stale. The install's
  alert recipients get one email when it goes stale and one when it succeeds again, never one per
  tick. Set them with `PUT /deployment/scheduler/alerts` (or the `scheduler_alerts_set_recipients`
  MCP tool) as an install administrator; the emails need `EMAIL_FROM`. With no recipients or no
  sender the engine still logs every episode (`scheduler job stale`), which a platform log alert
  can match. `GET /deployment/scheduler/alerts` shows what is stale and how each email went.
- **Something outside watches the cron.** When the cron itself stops (the engine fails to deploy
  or boot, the trigger is gone) nothing of it runs to say so. Point an uptime monitor (a
  platform health check with a notification, or any external checker) at
  `https://api.<DOMAIN>/health/scheduler`, which answers `503` once the last tick is more than
  five minutes old. `/health` itself stays `200`: it is the api's liveness, and a deploy's smoke
  test reads it right after the deploy, before a new install's first tick. When the cron comes
  back, its first tick emails the recipients that it is ticking again, with how long it was out.

## Secrets

Secrets live in `.secrets/secrets.env` (or the environment, which wins; in CI, repository or
`production` environment secrets) and reach the workers through `wrangler deploy --secrets-file`
(which adds and never removes, so a secret set by hand survives). Which worker gets which is
`SECRETS` in `scripts/install.ts`:

| Worker   | Secrets                                                                                                                                                                                               |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| web      | `PRINCIPAL_KEY`, `PRINCIPAL_KEY_PREVIOUS`, `DATA_KEY`, `DATA_KEY_PREVIOUS`, `SETUP_TOKEN`, `PASSWORD_PEPPER`, `OIDC_CLIENT_SECRET`                                                                    |
| api      | `PRINCIPAL_KEY`, `PRINCIPAL_KEY_PREVIOUS`, `DATA_KEY`, `DATA_KEY_PREVIOUS`, `TOKEN_PEPPER`, `MEDIA_SIGNING_SECRET`, `STREAM_WEBHOOK_SECRET`, `MCP_TOKEN`, `ADMIN_TOKEN`                               |
| engine   | `ASSISTANT_PRINCIPAL_KEY`, `ASSISTANT_PRINCIPAL_KEY_PREVIOUS` (derived from the `PRINCIPAL_KEY` pair; never the pair itself), `DATA_KEY`, `DATA_KEY_PREVIOUS`, `TOKEN_PEPPER`, `MEDIA_SIGNING_SECRET` |
| delivery | `DATA_KEY`, `DATA_KEY_PREVIOUS`, `TOKEN_PEPPER`, `MEDIA_SIGNING_SECRET`                                                                                                                               |
| media    | `MEDIA_SIGNING_SECRET` (verifies published paths' tokens and Preview's short-lived signed reads; it signs nothing)                                                                                    |

`PRINCIPAL_KEY`, `DATA_KEY`, `TOKEN_PEPPER` and `MEDIA_SIGNING_SECRET` are required
(`REQUIRED_SECRETS`); keys must be at least 32 characters (`openssl rand -hex 32`). Every worker of
an install holds the same value of each. `TOKEN_PEPPER` and `PASSWORD_PEPPER` never change once an
install runs (back them up, and `DATA_KEY` with them). `DATA_KEY` and `PRINCIPAL_KEY` rotate
through their `*_PREVIOUS` companions: `DATA_KEY` by the procedure in
[Auth & RBAC](./auth-and-rbac.md#secrets-at-rest), `PRINCIPAL_KEY` below.

**Rotating `PRINCIPAL_KEY`:** set `PRINCIPAL_KEY_PREVIOUS` to the current key and `PRINCIPAL_KEY`
to a new one in the secrets file (or the CI secrets) and deploy; once every worker runs the new
key, remove `PRINCIPAL_KEY_PREVIOUS` and deploy again. The engine's assistant pair follows on its
own: `install.ts secrets` derives `ASSISTANT_PRINCIPAL_KEY` from `PRINCIPAL_KEY` and
`ASSISTANT_PRINCIPAL_KEY_PREVIOUS` from `PRINCIPAL_KEY_PREVIOUS` on every deploy. Because
`--secrets-file` never removes a secret, delete `ASSISTANT_PRINCIPAL_KEY_PREVIOUS` from the engine
(`wrangler secret delete`, by hand) when you remove `PRINCIPAL_KEY_PREVIOUS`, as for any
`*_PREVIOUS`.

### The assistant's principal key

The web gateway signs the assistant's paths (`/agents/*`) with a key derived from `PRINCIPAL_KEY`
(HKDF-SHA256, salt `contentworker/principal-subkeys`, info `contentworker/assistant-principal/v1`,
32 bytes as base64url: `deriveAssistantPrincipalKey` in `@contentworker/security/assistant-key`)
and every other path with `PRINCIPAL_KEY` itself. The api's gate for `/agents/*` derives the key
from `PRINCIPAL_KEY` (and `_PREVIOUS`); its REST surface accepts only the main key. The engine holds
only the derived pair, so a principal it could sign is good for the assistant's socket and nothing
else. Nothing to set by hand: each deploy derives the pair (`install.ts secrets`, with
`scripts/derive-assistant-key.ts`; it reads the key from stdin or `PRINCIPAL_KEY`, never an
argument), and `setup.sh` generates nothing new for it.

The api gate and the engine accept only the derived key on `/agents/*`; a principal signed with
`PRINCIPAL_KEY` is refused there, and one signed with the derived key is refused on every other
path. A change to how these paths are signed has to roll out in two steps (verifiers accept both,
then only the new).

### The deploy token

A deploy from your workstation uses `wrangler login`. In CI (the optional
[deploy on merge](#deploy-on-merge)) it uses `CLOUDFLARE_API_TOKEN`, an account-owned API token,
with `CLOUDFLARE_ACCOUNT_ID`. The token needs exactly what `scripts/deploy.sh` does, and nothing
`scripts/setup.sh` does (setup runs by hand under `wrangler login`). Put your zone on the token:

| Scope              | Permission                        | Used by                                                                      |
| ------------------ | --------------------------------- | ---------------------------------------------------------------------------- |
| Account            | Workers Admin, on **all** Workers | `wrangler deploy`, `--secrets-file` and `wrangler rollback` for every Worker |
| Account            | D1: Edit                          | `d1 time-travel info` (the bookmark) and `d1 migrations apply --remote`      |
| Account            | Queues: Edit                      | registering the engine's and media worker's queue consumers on deploy        |
| Account            | Account Settings: Read            | Wrangler's account lookup                                                    |
| Zone (your domain) | Workers Routes: Edit, Zone: Read  | the custom domains (`<DOMAIN>`, `api.`, `cdn.`, `media.`)                    |

Binding a key-value namespace, bucket, vector index, gateway or other resource needs no permission
on it, so the token carries none. The Workers permission must cover every Worker in the account,
not a list of specified ones: Admin, because a deploy that ships a new Worker has to create it, and
all Workers, because a Worker missing from the list fails its deploy with "No access to the
specified service". A token that lacks a permission fails at the step that needs it, and the log
names the request.

## Deploy on merge

`.github/workflows/deploy.yml` is optional, for a fork that wants a push to its `main` to deploy.
It does nothing until the repository variable `DEPLOY_ON_MERGE` is `true`. Then it runs when `CI`
completes successfully for a push to `main` (a `workflow_run`), or by hand
(`gh workflow run deploy.yml`), checks out the commit CI passed, and runs `scripts/deploy.sh`. Runs
queue one at a time (`deploy-production`) and never cancel each other.

- **Settings** are repository variables with the names in `.env.example` (`DOMAIN` is required).
- **Secrets** are secrets of the `production` environment, limited to `main` (never repository
  secrets, which a workflow on any branch can read; add required reviewers there to approve each
  deploy): the ones `pnpm contentworker:setup --github` sets, the optional
  ones you use (`OIDC_CLIENT_SECRET`, `STREAM_WEBHOOK_SECRET`, `MCP_TOKEN`, `ADMIN_TOKEN`, the
  `*_PREVIOUS` keys during a rotation), and `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`
  ([the deploy token](#the-deploy-token)).

## CI

`.github/workflows/ci.yml` only verifies; it deploys nothing.

- **verify** (every push and pull request): lint, type-check and build in one parallel turbo
  run (the build is `wrangler deploy --dry-run` for engine, media, api and delivery), then the
  tests on their own (including the engine's durable workflow runs in the local runtime with
  `AI_MODE=mock`), `pnpm test:scripts`, `pnpm test:toolkit`, and
  `pnpm audit --prod --audit-level high`. Turbo's task cache is kept between runs
  (`.turbo/cache`, restored and saved with `actions/cache`), so a package no change touched replays
  its lint, type check, build and tests. What a task's hash covers is declared in `turbo.json` (the
  root files every package reads, the `transit` task that carries a dependency's files down the
  whole graph) and the packages' own `turbo.json` (a suite that reads another package's files, the
  docs embed's `docs/*.md`); `scripts/turbo-cache.test.ts` changes each such file in a scratch copy
  and checks the hash moves. Pull requests and the merge queue read the cache; a push to `main`,
  the nightly and the manual run do not read it, so they run every task, and they all write it.
- **devices**: the web app's Playwright suite in WebKit (iPhone, iPad, desktop) and Chromium
  against an offline dev server (`apps/web/e2e`), in three jobs at once, each with its own server:
  `devices (webkit)` (which ends with the sign-in specs), `devices (axe)` and `devices (cms)`,
  split by `E2E_PART` in `apps/web/playwright.config.ts`. A job named `devices` sums them up as the required check.
  They run on pull requests, nightly on `main` and by hand (`gh workflow run ci.yml`), not on the
  push a merge makes: the pull request already ran them. The `changes` job also skips them for a
  pull request that changes nothing the admin or its dev server loads. `scripts/device-paths.ts`
  derives that set: `apps/web` and the Workers its dev server runs beside it (the
  `auxiliaryWorkers` in `apps/web/vite.config.ts`), every workspace package they depend on, the
  files outside a package that feed a generated embed (`docs/*.md`), the lockfile, workspace file
  and root configs, and `ci.yml`; unit-test files and READMEs in those packages are left out
  (`node scripts/device-paths.ts list` prints it).

## Two installs in one account

A second install (a staging copy, say) shares the Cloudflare account. Give it its own settings
file, for example `.env.staging`, with its own `DOMAIN` and:

- `INSTANCE`: a lowercase name (letters, digits and dashes, starting with a letter) appended to
  every account-wide resource name (`contentworker-api-staging`, …) and to the rendered config and
  secrets file names (`wrangler.deploy-staging.json`, `.secrets/secrets-staging.env`).
- `RATE_LIMIT_SLOT`: a number from 2 to 999 that no other install in the account uses. Rate-limit
  namespaces are account-wide and derive from it (`slot × 1000 + n`; slot 1 is the default).

```sh
pnpm contentworker:setup --env-file .env.staging
pnpm contentworker:deploy --env-file .env.staging
```

## Releasing the SDK

One package ships to npm, apart from the deploys: `@contentworker/sdk` (`packages/sdk/sdk`), which
bundles the private workspace SDKs (`packages/sdk/*`) and the CLI (`packages/cli`, its
`contentworker` binary). Nothing else is published (`scripts/sdk-packages.test.ts`).

- `.github/workflows/sdk-packages.yml` (pull requests that touch `packages/sdk/` or
  `packages/cli/`): `node scripts/sdk-packages.ts pack` builds it through turbo and packs it, then
  `check` installs the tarball into an empty project, loads every subpath (ESM and CJS),
  type-checks every subpath against the shipped `.d.ts` files and runs `contentworker help`. That
  is what a user installs: `pnpm pack` applies `publishConfig` (exports and bin pointing at
  `dist/`) and rewrites `catalog:` versions.
- `.github/workflows/sdk-release.yml` (a pushed tag `sdk-v<version>`): checks that the tag
  matches `packages/sdk/sdk/package.json`'s version, runs lint, type-check and tests for it and
  everything it bundles, packs and checks it, then publishes it if npm doesn't already have that
  version, with npm trusted publishing (OIDC, no stored token) and a provenance attestation. It
  runs in the `npm` environment; add required reviewers there to approve each release.

To release: bump `version` in `packages/sdk/sdk/package.json`, merge, then push `sdk-v<version>`.
The package's npm settings name this repo and `sdk-release.yml` as its trusted publisher; its very
first publish is done by an owner of the npm org, before that can be set.

## Migrations

A deploy applies the hand-written migrations in `packages/db/migrations/` to the install's
database with `wrangler d1 migrations apply DB --remote`, after recording the point-in-time
recovery bookmark and before the new code ships (see [What a deploy does](#what-a-deploy-does)).
That ordering is why they are expand-only; the rules for writing one, and applying it locally with
`pnpm db:migrate:local`, are in [Development](./development.md#changing-the-database-schema).
Migrate a remote database only through a deploy.

## Recovering admin access

When no administrator can sign in, `pnpm contentworker:setup-code` (`scripts/setup-code.sh [--env-file <path>] [--github]`; pass `--github` with deploy on merge, or its next deploy puts the old code back)
issues a new one-time setup code: it replaces `SETUP_TOKEN` in the secrets file (so the next deploy
keeps it) and on the web worker (so it works now), and never prints it. Send the person recovering
access `https://<DOMAIN>/setup` and the code. It opens `/setup` once to create one admin account;
its use and every wrong guess go to the audit log. With deploy on merge, update the `SETUP_TOKEN`
secret too.

## Rollback by hand

A failed deploy rolls itself back. To go back later, check out the earlier commit and deploy it
again, or run `wrangler rollback` per worker (engine first, as the deploy does). Rolling code back
never rolls the schema back; restoring data is a point-in-time recovery restore (see
[Backup & restore](./backup-and-restore.md)).

Mind what the older code doesn't know about. Code from before environment purging
(`0003_environment_purges.sql`) ignores the purge markers: while a deleted environment is still
being purged, it would serve the leftovers again, let the same id be created on top of them, and
treat `environment.purge_due` as an ordinary event (so a webhook subscribed to `*` would receive
it). Check `SELECT * FROM environment_purges` is empty before rolling back past that change;
purges normally finish within minutes.

Code from before `0004_version_bodies.sql` reads an archived version's emptied `fields` (`{}`)
as its body, so the archive sweep ships off (`VERSION_ARCHIVE=false`). Turn it on in a later change,
once the release that reads archived bodies runs on every worker. Once it's on, don't
roll back past that release: history views and restores of superseded versions would show empty
content. Current and published versions are never archived, so entries themselves read
correctly.

An engine from before snapshot import jobs (environment import and clone) doesn't know their job
kind: it fails their chunks and never starts their publishing job. Re-run such an import after
rolling forward.
