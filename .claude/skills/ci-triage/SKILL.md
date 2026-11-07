---
name: ci-triage
description: Diagnose a failed contentworker GitHub Actions run (CI's verify or devices job, the fleet plan, or one deployment's deploy job), classify it as a code failure, a flake, a Cloudflare API blip, missing provisioning or secrets, or a smoke-test rollback, and take the one safe next step. Use when a PR's checks are red, a merge to main didn't reach a deployment, or the user asks why CI failed.
argument-hint: "[run-id | PR number | branch]"
allowed-tools: Bash(gh run list *) Bash(gh run view *) Bash(gh pr checks *) Bash(gh pr view *)
---

# Triage a CI failure

Workflows: `.github/workflows/ci.yml` (on every push and PR: `verify` and `devices`; on `main`
also `release`, which dispatches the commit to the private `contentworker/fleet` repo, where `release.yml`
runs `plan` and the rings `staging` → `internal` → `canary` → `general`, each calling
`deploy.yml` once per deployment; read those runs there with `gh run list --repo contentworker/fleet`). `deploy.yml` runs `scripts/deploy.sh`, whose log groups carry the
`deploy:` names below and whose log ends with "failed at: <group>", repeated after any rollback. It renders the config, collects secrets, records a D1
bookmark, migrates D1, deploys engine → api → delivery → web, smoke-tests, and rolls back (engine
first) on a failure; then the docs for the deployment with `"docs": true`. `docs/deployment.md`
describes them.

## 1. Find the run

```bash
gh run list --branch <branch> --limit 5            # or: gh pr checks <pr>
gh run view <run-id>                                # jobs and which failed
gh run view <run-id> --log-failed | tail -200       # the failing steps' logs
```

`$ARGUMENTS` may be a run id, a PR number or a branch.

## 2. Classify

| Where                                               | Signal                                                                                   | Class              | Next step                                                                                                                                                                                       |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| verify: Lint, type-check and build / Test           | a compiler, Biome or vitest error with a file and line (turbo's summary names the task)  | **code**           | Reproduce with the same command (`preflight`), fix on the branch                                                                                                                                |
| verify: Test                                        | passes locally, fails in CI, timing-sensitive (a workerd suite's window, a DO alarm)      | **flake**          | Re-run once (`gh run rerun <id> --failed`, the user approves). Twice is code: shared state between tests, a real timer, ordering                                                                |
| verify: …build (an engine, api or delivery `#build`) | `wrangler deploy --dry-run` fails for engine, api or delivery                             | **code**           | Same command locally (`infra-change`, step 7)                                                                                                                                                  |
| verify: Test fleet                                  | `scripts/fleet.test.ts`, `do-migrations.test.ts` or `catalog.test.ts`                     | **code**           | `pnpm test:fleet` locally; a DO-migration or catalog failure names the rule                                                                                                                     |
| verify: Test toolkit                                | `.claude/scripts/toolkit-check.sh` or a hook test                                        | **code**           | `pnpm test:toolkit` locally                                                                                                                                                                    |
| verify: Audit dependencies                          | an advisory at high or critical                                                          | **dependency**     | Bump it in the pnpm catalog (`pnpm-workspace.yaml`); say which advisory                                                                                                                        |
| devices                                             | a Playwright failure; the `device-test-traces` artifact                                  | **code** or flake  | `pnpm --filter @contentworker/web e2e -- <spec>` (`testing` skill). CI retries twice, so a failure here failed three times                                                                    |
| devices: Install WebKit system dependencies         | apt timeouts, dpkg lock                                                                  | **platform blip**  | Re-run the failed job                                                                                                                                                                           |
| fleet repo: plan                                    | a registry validation error, "missing d1Id / kvId"                                       | **provisioning**   | The deployment isn't provisioned: the user runs `./scripts/provision.sh <id>`, or sets `"hold": true`                                                                                         |
| deploy: Check deploy credentials / Collect secrets  | missing `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `PRINCIPAL_KEY`, `DATA_KEY`, …  | **secrets**        | The user adds it to the deployment's GitHub environment. Nothing was migrated                                                                                                                  |
| deploy: any `wrangler` step                         | Cloudflare API codes `7403`, `10013`, 5xx after the `retry` helper's three attempts       | **platform blip**  | Re-run the failed jobs                                                                                                                                                                          |
| deploy: Migrate D1                                  | a SQL error from a new migration                                                         | **code**           | D1 may be partly migrated; nothing deployed yet. Fix forward with a new migration; never edit the applied one. If data is damaged, point the user at the bookmark and docs/backup-and-restore.md |
| deploy: Deploy (any Worker)                         | "queue … does not exist", a binding to a missing resource                                | **provisioning**   | Provision for that deployment (`infra-change`), then re-run                                                                                                                                    |
| deploy: Smoke test, then "Roll back" ran            | `/health`, `/health/deep`, `/login`, the api's `/health` or `/openapi.json`, delivery's `/health`, or an anonymous delivery read not answering 401 | **smoke rollback** | Workers are back on the previous version (engine first); **D1 stayed migrated**. Read which check failed and the Worker logs; fix forward in a PR. Never restore D1 yourself |
| deploy: Roll back reports the engine couldn't go back | "a Durable Object migration since its last version prevents it"                         | **fix forward**    | Every Worker stays on the new commit by design. Fix forward in a PR; tell the user                                                                                                             |
| deploy: Latency check                               | a `Latency budget` warning annotation                                                    | **not a failure**  | It's `continue-on-error`; nothing rolled back. Mention it if it recurs                                                                                                                         |
| deploy: Deploy docs / Smoke test docs               | docs build or the docs smoke checks                                                      | **docs**           | Only the docs rolled back; the app is live. `pnpm docs:build` locally                                                                                                                          |

A ring that failed stops the later rings (`!failure()`); a re-run of the failed jobs continues
from there.

## 3. Act

- **Allowed:** reading runs and logs; reproducing locally; fixing on a branch; re-running failed
  jobs with `gh run rerun <run-id> --failed` after the user agrees.
- **Never:** `wrangler deploy`, `wrangler rollback`, remote migrations, a Time Travel restore,
  `gh workflow run` to redeploy, or pushing to `main` to "kick" CI. The `guard-bash` hook denies or
  asks for these.

## 4. Report

The run and job, the class, the evidence (the log lines, verbatim, trimmed), what you did, and what
the user still has to do (a secret to add, a deployment to provision, a re-run to approve).
