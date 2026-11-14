---
name: ci-triage
description: Diagnose a failed ContentWorker GitHub Actions run (CI's verify or devices job, or a run of the optional Deploy workflow on a fork), classify it as a code failure, a flake, a Cloudflare API blip, a missing resource, setting or secret, or a smoke-test rollback, and take the one safe next step. Use when a PR's checks are red, a Deploy run failed or didn't start, or the user asks why CI failed.
argument-hint: "[run-id | PR number | branch]"
allowed-tools: Bash(gh run list *) Bash(gh run view *) Bash(gh pr checks *) Bash(gh pr view *)
---

# Triage a CI failure

Workflows: `.github/workflows/ci.yml` (on every push and PR: `verify`; on PRs, nightly and by hand:
`devices`, as three `devices (<part>)` jobs) only verifies: merging deploys nothing from this repo.
`.github/workflows/deploy.yml` is the optional deploy-on-merge for a fork: it runs after CI passes
on `main` (or by hand) only when the repository variable `DEPLOY_ON_MERGE` is `true`, with the
install's settings as repository variables and its secrets as repository (or `production`
environment) secrets. A skipped Deploy run means the variable isn't set, not a failure. It runs
`scripts/deploy.sh` (what an operator runs as `pnpm cw:deploy`), whose log groups carry the
`deploy:` names below and whose log ends with "failed at: <group>", repeated after any rollback. It
renders the config, collects secrets, records a D1 bookmark, migrates D1, deploys engine → media →
api → delivery → web, smoke-tests, and rolls back (engine first) on a failure.
`docs/deployment.md` describes them.

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
| verify: Test scripts                                | `scripts/install.test.ts`, `deploy.test.ts`, `do-migrations.test.ts` or `catalog.test.ts` | **code**           | `pnpm test:scripts` locally; a DO-migration or catalog failure names the rule                                                                                                                   |
| verify: Test toolkit                                | `.claude/scripts/toolkit-check.sh` or a hook test                                        | **code**           | `pnpm test:toolkit` locally                                                                                                                                                                    |
| verify: Audit dependencies                          | an advisory at high or critical                                                          | **dependency**     | Bump it in the pnpm catalog (`pnpm-workspace.yaml`); say which advisory                                                                                                                        |
| devices                                             | a Playwright failure in `devices (<part>)`; the `device-test-traces-<part>` artifact                                  | **code** or flake  | `E2E_PART=<part> pnpm --filter @contentworker/web e2e -- <spec>` (`testing` skill). CI retries twice, so a failure here failed three times                                                                    |
| devices: Install WebKit system dependencies         | apt timeouts, dpkg lock                                                                  | **platform blip**  | Re-run the failed job                                                                                                                                                                           |
| deploy: Render config                               | "no D1 database … / no KV namespace …: run scripts/setup.sh first", a settings error (`DOMAIN must be …`) | **setup**          | The install's resources don't exist or a repository variable is wrong: the user runs `pnpm cw:setup` or fixes the variable. Nothing changed                                                   |
| deploy: Check deploy credentials / Collect secrets  | missing `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `PRINCIPAL_KEY`, `DATA_KEY`, …  | **secrets**        | The user adds it as a repository (or `production` environment) secret (`scripts/setup.sh --github` sets the generated ones). Nothing was migrated                                             |
| deploy: any `wrangler` step                         | Cloudflare API codes `7403`, `10013`, 5xx after the `retry` helper's three attempts       | **platform blip**  | Re-run the failed jobs                                                                                                                                                                          |
| deploy: Migrate D1                                  | a SQL error from a new migration                                                         | **code**           | D1 may be partly migrated; nothing deployed yet. Fix forward with a new migration; never edit the applied one. If data is damaged, point the user at the bookmark and docs/backup-and-restore.md |
| deploy: Deploy (any Worker)                         | "queue … does not exist", a binding to a missing resource                                | **setup**          | The release binds a resource the install doesn't have yet: the user re-runs `pnpm cw:setup` (`infra-change`), then re-runs the failed job                                                     |
| deploy: Smoke test, then "Roll back" ran            | `/health`, `/health/deep`, `/login`, the api's `/health` or `/openapi.json`, delivery's `/health`, or an anonymous delivery read not answering 401 | **smoke rollback** | Workers are back on the previous version (engine first); **D1 stayed migrated**. Read which check failed and the Worker logs; fix forward in a PR. Never restore D1 yourself |
| deploy: Roll back reports the engine couldn't go back | "a Durable Object migration since its last version prevents it"                         | **fix forward**    | Every Worker stays on the new commit by design. Fix forward in a PR; tell the user                                                                                                             |
| deploy: Latency check                               | a `Latency budget` warning annotation                                                    | **not a failure**  | It only warns; nothing rolled back. Mention it if it recurs                                                                                                                                    |

## 3. Act

- **Allowed:** reading runs and logs; reproducing locally; fixing on a branch; re-running failed
  jobs with `gh run rerun <run-id> --failed` after the user agrees.
- **Never:** `wrangler deploy`, `wrangler rollback`, remote migrations, a Time Travel restore,
  `pnpm cw:deploy`, `gh workflow run` to redeploy, or pushing to `main` to "kick" CI. The `guard-bash` hook denies or
  asks for these.

## 4. Report

The run and job, the class, the evidence (the log lines, verbatim, trimmed), what you did, and what
the user still has to do (a secret or setting to add, `pnpm cw:setup` to re-run, a re-run to approve).
