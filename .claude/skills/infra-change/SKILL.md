---
name: infra-change
description: Change contentworker's edge-platform configuration safely across the fleet, and validate that it still deploys. Covers adding or changing a binding, var, queue, bucket, key-value namespace, vector index, stateful edge object, durable workflow, route or compatibility flag in an app's wrangler.jsonc (web, api, delivery, engine, docs); typing it in EdgeEnv; rendering it per deployment in scripts/fleet.ts; creating it in scripts/provision.sh; registry fields in deployments/*.jsonc; secrets; dry-run bundles and env parity; and ordering the rollout so CI's deploy never needs a resource that doesn't exist yet. Use for any edit to wrangler.jsonc, deployments/, scripts/fleet.ts, scripts/provision.sh or packages/platform/src/env.ts.
---

# Changing infrastructure

Every customer is its own deployment (`deployments/<id>.jsonc`: `id`, `ring`, `slot`, `domain`,
`suffix`, `environment`, `d1Id`, `kvId`, `hold`, `demo`, `docs`, …), with its own database,
key-value store, object storage, vector index, queues, durable workflows, AI gateway and edge
workers, named with the deployment's suffix. The base config is each app's `wrangler.jsonc` (its
names are the `contentworker` deployment's, suffix `""`); `node scripts/fleet.ts render <id>`
writes `wrangler.<id>.json` next to it with that deployment's names, ids and hosts (gitignored),
and CI deploys those. `docs/deployment.md` (provisioning, secrets, migrations, deploying, rollback)
and `docs/configuration.md` (vars, secrets, bindings) are the references; read the relevant section
first.

| Worker          | Owns                                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------------------- |
| `apps/engine`   | Queue consumers, the cron sweeper, every stateful-object and durable-workflow class; no route           |
| `apps/api`      | HTTP only; binds the engine's stateful objects and workflows by `script_name`; placed near the database |
| `apps/delivery` | Public delivery gateway + cached `Delivery` entrypoint; reads database replicas; purge queue            |
| `apps/media`    | Published asset files at `media.<domain>`; cached `Media` entrypoint; media purge queue                 |
| `apps/web`      | The admin and human auth; `API` service binding to the api                                              |
| `apps/docs`     | Static docs site (deployed only by the deployment with `"docs": true`)                                  |

## Checklist for a wrangler.jsonc change

1. **Edit the base** `apps/<app>/wrangler.jsonc`, in every worker that reads the binding. The
   config has no env blocks here; a deployment's differences come from `fleet.ts`.
2. **Type it** in `EdgeEnv` (`packages/platform/src/env.ts`) and read it in `config.ts` or
   `wire.ts`. If local development needs a value, add it to `LOCAL_STACK_VARS` in
   `apps/web/vite.config.ts` (never a deployment's secret).
3. **Regenerate types** where the app has them: `pnpm --filter @contentworker/web types`. Never
   hand-edit `worker-configuration.d.ts` (the `block-generated` hook denies it).
4. **Render per deployment** in `scripts/fleet.ts`: a new resource name gets the suffix, a new id
   comes from the registry, a new per-customer setting becomes a registry field with validation and
   a default.
5. **Create it per deployment** in `scripts/provision.sh` if it must exist before deploy (database,
   key-value namespace, object storage bucket, queues, vector index, AI gateway). Keep the script
   re-runnable: find-or-create, never replace a secret that's set.
6. **Test the fleet:** `pnpm test:fleet` (`scripts/fleet.test.ts`, `do-migrations.test.ts`,
   `catalog.test.ts`). It checks that rendering `contentworker` returns the base config and that
   bad registry values are refused.
7. **Validate deployability** (read-only):
   - `pnpm --filter @contentworker/<engine|api|delivery> exec wrangler deploy --dry-run --outdir /tmp/bundle-<app>`
     for each touched worker (what those workers' `build` runs in CI's verify job), and `pnpm --filter @contentworker/web build`.
   - `node scripts/fleet.ts render <id>` for an affected deployment and read the rendered file.
   - Parity: every binding `EdgeEnv` declares and a worker's code path uses exists in that
     worker's config; stateful-object and workflow bindings in api and delivery carry
     `script_name: "contentworker-engine"`; only the engine declares stateful-object `migrations`.
8. **Document** it in `docs/configuration.md` (and `docs/deployment.md` for a registry field, a
   resource name or a secret). Keep bindings, vars and `wrangler` out of the published `apps/docs`.

## Rollout order

CI deploys every deployment from `main` in ring order (`staging` → `internal` → `canary` →
`general`), and within one deployment engine → media → api → delivery → web. Nothing provisions during CI.

- **A new resource a deploy needs** (a queue the engine consumes, a key-value id a render needs)
  must exist in every deployment **before** the merge that binds it. The user runs
  `./scripts/provision.sh <id>` for each existing deployment (the `guard-bash` hook asks before
  you do), or the deployment is merged with `"hold": true`. Say this in the PR description, listing
  the deployments.
- A deployment missing `d1Id` or `kvId` stops CI's plan.
- **A renamed binding or resource** is expand/contract like a migration: add the new one, deploy,
  move reads and writes, then remove the old one in a later change.
- **Stateful-object classes** live in the engine: a new class gets a `migrations` entry with a new
  tag (`new_sqlite_classes`) appended at the end of `apps/engine/wrangler.jsonc` and to `APPLIED`
  in `scripts/do-migrations.test.ts` in the same change; never edit, remove or reorder an existing
  tag. That test fails CI on any of those, and on `deleted_classes`, `renamed_classes` or
  `transferred_classes` unless allowlisted (`DESTRUCTIVE_ALLOWED`) after the data is planned with
  the user. The engine can't roll back past a stateful-object migration, so `deploy.yml` then
  leaves every worker on the new version: fix forward.
- **Durable workflow names** are unique per account, which is why they carry the suffix.
- **Jurisdiction** is fixed at creation for the database, object storage and stateful objects;
  never change it for a deployment that has data.

## Secrets

Secrets aren't in `wrangler.jsonc` or the registry. CI writes them per worker from the
deployment's GitHub environment (`node scripts/fleet.ts secrets <app> <out>`, the `SECRETS` map in
`scripts/fleet.ts`): `PRINCIPAL_KEY`, `DATA_KEY`, `TOKEN_PEPPER`, `MEDIA_SIGNING_SECRET`,
`PASSWORD_PEPPER`, `SETUP_TOKEN`, the `*_PREVIOUS` keys during a rotation, and the optional ones. A
new secret means: add it to `SECRETS` for each app that reads it, to `deploy.yml`'s "Collect
secrets" env, to the environment (the user does, or `provision.sh` for generated ones), and to
`docs/configuration.md`. Never commit a secret or write one outside `.secrets/` (gitignored).

## Never

`wrangler deploy` (without `--dry-run`), `wrangler versions deploy`, `wrangler rollback`,
`wrangler d1 migrations apply --remote`, deleting a deployment's resource, or `pnpm … deploy` by
hand. The `guard-bash` hook denies them; CI does them.

## Report

What changed by file; each validation command with pass/fail (first failure verbatim); the rollout
steps that must happen before merge, by whom, for which deployments.
