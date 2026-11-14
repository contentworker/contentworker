---

name: infra-change
description: Change ContentWorker's Cloudflare configuration safely, and validate that an install still deploys. Covers adding or changing a binding, var, queue, bucket, KV namespace, Vectorize index, Durable Object, Workflow, route or compatibility flag in an app's wrangler.jsonc (web, api, delivery, media, engine, docs); typing it in EdgeEnv; rendering it for the install in scripts/install.ts; creating it in scripts/setup.sh; install settings (.env.example) and secrets; dry-run bundles and env parity; and ordering a release so a deploy never needs a resource that doesn't exist yet. Use for any edit to wrangler.jsonc, scripts/install.ts, scripts/setup.sh, scripts/deploy.sh, .env.example, .github/workflows/deploy.yml or packages/platform/src/env.ts.
---

# Changing infrastructure

ContentWorker is self-hosted: an **install** is one stack in the operator's own Cloudflare account
(a D1 database, a KV namespace, an R2 bucket, a Vectorize index, queues, an AI Gateway and five
Workers: engine, media, api, delivery, web). Its settings are env names (`.env.example`: `DOMAIN`
required; `DATA_JURISDICTION`, `AI_MAX_TIER`, `AI_GATEWAY_LOGS`, `AI_MODE=mock`, `DEMO_STARTERS`,
`OIDC_*`, `EMAIL_FROM*`, and `INSTANCE` + `RATE_LIMIT_SLOT` for a second install in one account),
read from the environment, then `.env`. The base config is each app's `wrangler.jsonc`;
`node scripts/install.ts render` writes `apps/<app>/wrangler.deploy.json`
(`wrangler.deploy-<instance>.json` for a named instance, gitignored) with the install's names, ids,
hosts and vars, and `scripts/deploy.sh` deploys those. `node scripts/install.ts names` prints the
resource names as shell variables (`shellVars`) for `setup.sh` and `deploy.sh`.
`docs/deployment.md` (setup, secrets, migrations, deploying, rollback, upgrades) and
`docs/configuration.md` (vars, secrets, bindings) are the references; read the relevant section
first.

| Worker          | Owns                                                                                    |
| --------------- | --------------------------------------------------------------------------------------- |
| `apps/engine`   | Queue consumers, the cron sweeper, every Durable Object and Workflow class; no route    |
| `apps/api`      | HTTP only; binds the engine's DOs and Workflows by `script_name`; Smart Placement       |
| `apps/delivery` | Public delivery gateway + cached `Delivery` entrypoint; reads D1 replicas; purge queue  |
| `apps/media`    | Published asset files at `media.<domain>`; cached `Media` entrypoint; media purge queue |
| `apps/web`      | The admin and human auth; `API` service binding to the api                              |
| `apps/docs`     | Static docs site; not part of an install's deploy                                       |

## Checklist for a wrangler.jsonc change

1. **Edit the base** `apps/<app>/wrangler.jsonc`, in every Worker that reads the binding. Wrangler
   has no env blocks here; an install's differences come from `scripts/install.ts`.
2. **Type it** in `EdgeEnv` (`packages/platform/src/env.ts`) and read it in `config.ts` or
   `wire.ts`. If local development needs a value, add it to `LOCAL_STACK_VARS` in
   `apps/web/vite.config.ts` (never an install's secret).
3. **Regenerate types** where the app has them: `pnpm --filter @contentworker/web types`. Never
   hand-edit `worker-configuration.d.ts` (the `block-generated` hook denies it).
4. **Render it for the install** in `scripts/install.ts`: a new account-wide resource name goes in
   `names` (with the instance suffix) and, if a script needs it, `shellVars`; a new id is looked up
   by `deploy.sh`; a setting that varies per install is parsed and validated in `toInstall`,
   rendered in `common()` or the app's `render*`, and added to `.env.example` and the job env of
   `.github/workflows/deploy.yml`.
5. **Create it** in `scripts/setup.sh` if it must exist before deploy (D1, KV, R2, queues,
   Vectorize, AI Gateway, R2 notifications). Keep the script re-runnable: find-or-create, never
   replace a secret that's set.
6. **Test the scripts:** `pnpm test:scripts` (`scripts/install.test.ts`, `deploy.test.ts`,
   `do-migrations.test.ts`, `catalog.test.ts`, …). It checks the rendered configs, that bad
   settings are refused and that `deploy.yml` passes every setting in `.env.example`.
7. **Validate deployability** (read-only):
   - `pnpm --filter @contentworker/<engine|media|api|delivery> exec wrangler deploy --dry-run --outdir /tmp/bundle-<app>`
     for each touched Worker (what those Workers' `build` runs in CI's verify job), and `pnpm --filter @contentworker/web build`.
   - `node scripts/install.ts names --env-file <file>` for the names; to read a rendered config,
     render with placeholder ids (`DOMAIN=cms.example.com D1_ID=<uuid> KV_ID=<32 hex>`) and delete
     the `wrangler.deploy.json` files afterwards.
   - Parity: every binding `EdgeEnv` declares and a Worker's code path uses exists in that
     Worker's config; DO and Workflow bindings in api and delivery carry
     `script_name: "contentworker-engine"`; only the engine declares DO `migrations`.
8. **Document** it in `docs/configuration.md` (and `docs/deployment.md` for a setting, a resource
   or a secret). Keep bindings, vars and `wrangler` out of the published `apps/docs`.

## Rollout order

Merging to `main` deploys nothing from this repo: CI only verifies. The operator deploys a release
with `pnpm contentworker:deploy` (or the optional Deploy workflow on a fork, on when the repo variable
`DEPLOY_ON_MERGE` is `true`), which migrates D1 and then deploys engine → media → api → delivery →
web, smoke-tests, and rolls back engine first on a failure. Nothing creates resources during a
deploy.

- **A new resource a deploy needs** (a queue the engine consumes, a bucket, an index) must exist
  **before** the release that binds it is deployed: add it to `scripts/setup.sh`, and operators
  re-run `pnpm contentworker:setup` (safe to re-run) before deploying. Say so in the PR description and in
  `docs/deployment.md`'s upgrade notes. The `guard-bash` hook asks before you run setup; it is the
  user's to run.
- A deploy whose D1 or KV namespace can't be found stops before it changes anything ("run
  scripts/setup.sh first").
- **A renamed binding or resource** is expand/contract like a migration: add the new one, deploy,
  move reads and writes, then remove the old one in a later change.
- **Durable Object classes** live in the engine: a new class gets a `migrations` entry with a new
  tag (`new_sqlite_classes`) appended at the end of `apps/engine/wrangler.jsonc` and to `APPLIED`
  in `scripts/do-migrations.test.ts` in the same change; never edit, remove or reorder an existing
  tag. That test fails CI on any of those, and on `deleted_classes`, `renamed_classes` or
  `transferred_classes` unless allowlisted (`DESTRUCTIVE_ALLOWED`) after the data is planned with
  the user. The engine can't roll back past a DO migration, so `scripts/deploy.sh` then leaves every
  Worker on the new version: fix forward.
- **Workflow names** are unique per account, which is why they carry the instance suffix.
- **Jurisdiction** (`DATA_JURISDICTION`) is fixed at creation for D1, R2 and Durable Objects; never
  change it for an install that has data.

## Secrets

Secrets aren't in `wrangler.jsonc` or `.env`. `scripts/setup.sh` generates the required ones into
`.secrets/secrets.env` (gitignored, 0600; `--github` also sets them as Actions secrets), and each
deploy writes them per Worker (`node scripts/install.ts secrets <app> <out>`, the `SECRETS` map in
`scripts/install.ts`): `PRINCIPAL_KEY`, `DATA_KEY`, `TOKEN_PEPPER`, `MEDIA_SIGNING_SECRET`,
`PASSWORD_PEPPER`, `SETUP_TOKEN`, the `*_PREVIOUS` keys during a rotation, and the optional ones. A
new secret means: add it to `SECRETS` for each app that reads it (and to the loop in
`scripts/setup.sh` and `GENERATED_SECRETS` if setup should generate it), to the env of `deploy.yml`'s Deploy step and the `unset` list in
`scripts/deploy.sh`, and to `docs/configuration.md`. Never commit a secret or write one outside
`.secrets/`.

## Never

`wrangler deploy` (without `--dry-run`), `wrangler versions deploy`, `wrangler rollback`,
`wrangler d1 migrations apply --remote`, deleting one of the install's resources, `pnpm contentworker:deploy`,
`scripts/deploy.sh` or `pnpm … deploy`. The `guard-bash` hook denies them; the operator runs them.

## Report

What changed by file; each validation command with pass/fail (first failure verbatim); the steps
operators must take before deploying the release (re-run `pnpm contentworker:setup`, set a new setting or
secret).
