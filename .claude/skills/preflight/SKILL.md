---
name: preflight
description: Run the checks CI's verify job runs (lint, type-check, build, tests, worker bundles, fleet tests, toolkit tests), scoped to the packages a change touches, and report pass or fail verbatim. Use before saying a change is done, before committing, before opening a PR, or when asked whether something is green.
argument-hint: "[base-ref, default origin/main]"
allowed-tools: Bash(git diff *) Bash(git status *) Bash(git merge-base *) Bash(pnpm turbo run *) Bash(pnpm lint) Bash(pnpm check-types) Bash(pnpm test) Bash(pnpm build) Bash(pnpm test:fleet) Bash(pnpm test:toolkit) Bash(pnpm docs:build)
---

# Preflight

CI's `verify` job (`.github/workflows/ci.yml`) runs lint, type-check, build, test, the worker
bundles (`wrangler deploy --dry-run` for engine, api and delivery), the fleet tests, the toolkit
tests and `pnpm audit --prod --audit-level high`, each even when an earlier one failed. A separate
`devices` job runs the apps/web Playwright suite. Run the same locally, scoped to what changed, so a
PR is green the first time.

## What changed

Committed since `origin/main`:
!`git diff --name-only origin/main...HEAD`

Uncommitted:
!`git status --short`

## Steps

1. **Base.** Use `$ARGUMENTS` as the base ref if given, else `origin/main`.
2. **Workspace checks, scoped.** Turbo's `...[ref]` filter takes every package changed since the
   ref plus everything that depends on one:

   ```bash
   pnpm turbo run lint check-types test --filter='...[origin/main]' --continue
   ```

   `--continue` reports every failure in one go, as CI does. If the changed files include the
   root `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `turbo.json`, `biome.json` or
   anything under `packages/typescript-config`, run the unscoped `pnpm lint`, `pnpm check-types`
   and `pnpm test` instead.
3. **Bundles.** If anything a worker imports changed (any `packages/*` the apps depend on, or
   `apps/{engine,api,delivery}`), bundle each touched worker the way CI does:

   ```bash
   pnpm --filter @contentworker/<engine|api|delivery> exec wrangler deploy --dry-run --outdir /tmp/bundle-<app>
   ```

   `apps/web` bundles through `pnpm --filter @contentworker/web build`.
4. **Fleet.** If anything under `deployments/` or `scripts/` changed, an `apps/*/wrangler.jsonc`,
   or any `package.json` (the catalog test): `pnpm test:fleet`.
5. **Toolkit.** If anything under `.claude/` changed: `pnpm test:toolkit`.
6. **Generated files.** If `docs/*.md`, `packages/http/skills/**` or `packages/design/src/tokens.ts`
   changed, run the `regen` skill: a stale embed or theme fails the docs, http or design tests.
7. **Docs site.** If anything under `apps/docs/` changed, or a source a reference page renders
   from (`packages/domain/src/workflow/{nodes,templates}.ts`, `packages/domain/src/auth/auth.ts`,
   `packages/http/src/api/**`): `pnpm docs:build` (includes the link check).
8. **Admin flows.** If `apps/web/app/**` changed a route, a screen or a dialog, run the device
   tests (`testing` skill, "Device and accessibility tests") or say you didn't.
9. **Worker config.** If `apps/web/wrangler.jsonc` changed, confirm `worker-configuration.d.ts`
   was regenerated (`pnpm --filter @contentworker/web types`); a stale one fails type-check.

## Report

One line per check: the command, `pass` or `FAIL`. For each failure, paste the first error
verbatim with its file and line, then say whether the change caused it or it fails on the base
too (check with `git stash` only if the user agrees; otherwise say you didn't check). Never report
green for a check you didn't run.
