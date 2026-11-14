---
name: review-change
description: Review the current branch's change before a PR or merge. Runs the code-reviewer, hexagonal-guardian, security-reviewer, workers-reviewer and admin-ui-reviewer agents in parallel where the diff warrants each, checks docs drift and the mechanical invariants, then merges the findings into one ranked list. Use when asked to review a change, before /ship, or after a large edit.
argument-hint: "[base-ref, default origin/main]"
disable-model-invocation: true
allowed-tools: Bash(git diff *) Bash(git log *) Bash(git status *) Bash(.claude/hooks/docs-map.sh)
---

# Review a change

## The change (against origin/main)

!`git log --oneline origin/main..HEAD`

!`git diff --stat origin/main...HEAD`

Uncommitted:
!`git status --short`

## Steps

1. **Base.** `$ARGUMENTS` if given, else `origin/main`. The change is the committed diff
   `git diff <base>...HEAD` plus anything uncommitted (`git diff HEAD`). If both are empty, say so
   and stop.
2. **Fan out, in one message, in parallel.** Give each agent the base ref and the list of changed
   files. Don't give them your own opinion of the change; their read should be independent.
   - `code-reviewer`: always. Correctness and the ContentWorker invariants.
   - `hexagonal-guardian`: when the diff touches `packages/{domain,ports,application,test-kit,agent-runtime,http,platform,sdk}`
     or an app entry. The dependency rule and both surfaces.
   - `security-reviewer`: when a changed file matches the trust-boundary row of
     `.claude/skills/contentworker-conventions/references/rules-map.tsv`, or touches routes, auth,
     webhooks, outbound fetches, model prompts, secrets, `wrangler.jsonc` or workflows.
   - `workers-reviewer`: when the diff touches an `apps/*/wrangler.jsonc`, `packages/platform`,
     `apps/{api,delivery,media,engine}/src`, `scripts/install.ts`, `scripts/setup.sh` or
     `.env.example`.
   - `admin-ui-reviewer`: when the diff touches `apps/web/app/**` or `packages/ui`.
   Say which you skipped and why.
3. **Meanwhile, the mechanical checks yourself:**
   - Docs: `git diff --name-only <base>...HEAD | .claude/hooks/docs-map.sh` lists documented
     surfaces; check whether their pages changed in the same diff.
   - The `Check` commands in the contentworker-conventions invariants for the sections the diff
     touches (dependency greps, migrations only added, DO tags appended, generated files
     regenerated).
4. **Merge.** De-duplicate findings that point at the same line and cause. Drop anything that
   isn't tied to a line in this diff, or that is style Biome already enforces. Keep a finding only
   when you can state the failure scenario; mark the ones you couldn't confirm.
5. **Report**, most severe first:

   ```
   [severity] file:line — one-sentence defect
     Scenario: concrete input/state → wrong result
     Fix: the smallest change that addresses it
     Source: code-reviewer | hexagonal-guardian | security-reviewer | workers-reviewer | admin-ui-reviewer | docs | invariant check
   ```

   Severity: **blocker** (data loss, a security hole, a broken invariant that hurts a running
   deployment), **major** (wrong behaviour in a reachable path), **minor** (edge case, missing
   test), **docs**. End with what was _not_ reviewed and why, and whether `preflight` has been run.

Don't edit anything in this skill; fixes are a separate step the user asks for.
