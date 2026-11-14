# ContentWorker Claude Code toolkit

Project-scoped agents, skills, rules and hooks for this repo, version-controlled and reviewed like
source. AGENTS.md states the rules (CLAUDE.md imports it). This toolkit splits how they're kept:

- **Hooks** enforce what a machine can check: they deny, ask or remind, every time.
- **Skills** carry the procedures and the reasons behind the rules.
- **Rules** (`rules/*.md`) load path-scoped context when Claude reads files under their `paths`.
- **Subagents** do the work that needs judgement (building, testing, reviewing, operating,
  documenting) in their own context, with tools scoped to the job.

Skills follow the [Agent Skills](https://agentskills.io/specification) format. Agents and hooks
follow Claude Code's [subagents](https://code.claude.com/docs/en/sub-agents) and
[hooks](https://code.claude.com/docs/en/hooks-guide).

## Which tool for which job

| You want to…                                                          | Use                                                                                  |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Build a feature or fix a bug                                          | `engineer` agent (or the main session), with `contentworker-conventions`             |
| Add a capability, an adapter, a migration, a binding                  | `/new-use-case`, `/new-adapter`, `/d1-migration`, `/infra-change`                    |
| Write, run or de-flake tests; audit coverage                          | `test-engineer` agent, `testing` skill (`/testing <pkg> [file]`)                     |
| Regenerate the docs embed, MCP skills embed, theme, types             | `/regen`                                                                             |
| See it running locally                                                | `/run-stack`                                                                         |
| Know whether it's green                                               | `/preflight`                                                                         |
| Review before a PR                                                    | `/review-change`, which fans out to the reviewers below in parallel                  |
| Open the PR                                                           | `/ship` (worktree, preflight, commit, push the branch, `gh pr create`; never merges) |
| Find out why CI is red                                                | `/ci-triage`, or the `devops` agent                                                  |
| Change CI, the install scripts or settings                            | `devops` agent                                                                       |
| Check the repo's instructions still match reality                     | `dx-reviewer` agent                                                                  |
| Check the toolchain and agent setup are current with the docs         | `toolchain-auditor` agent                                                            |
| Audit an install's production readiness on Cloudflare                 | `readiness-auditor` agent                                                            |
| Check a feature is really done, end to end, with a test               | `completeness-auditor` agent                                                         |
| Find where data can be lost, duplicated or orphaned, and if we'd know | `data-integrity-auditor` agent (pair it with `readiness-auditor`)                    |
| Decide go/no-go for a launch under a feature freeze                   | `launch-reviewer` agent (pair it with `readiness-auditor`)                           |
| Review Workers AI, AI Gateway and search: gaps, robustness            | `ai-reviewer` agent                                                                  |
| Keep the docs true                                                    | `docs-sync` agent or skill, `/docs-page`, `/docs-audit`                              |

## Subagents (`agents/`)

| Agent                    | Tools                                                                                             | Preloads                                      | Use it for                                                                                                                                                                                                                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `engineer`               | all                                                                                               | `contentworker-conventions`, `testing`        | Implementing a scoped change within the invariants, with tests and preflight. Never deploys or merges                                                                                                                                                                                     |
| `test-engineer`          | Read, Grep, Glob, Edit, Write, Bash                                                               | `testing`, `contentworker-conventions`        | Tests only: coverage, failure paths, de-flaking, coverage-gap audits. Reports production bugs instead of fixing them                                                                                                                                                                      |
| `code-reviewer`          | Read, Grep, Glob, Bash                                                                            | `contentworker-conventions`                   | Ranked correctness findings with a failure scenario each (unit of work, D1 limits, scope, migrations, idempotency). **Read-only**                                                                                                                                                         |
| `hexagonal-guardian`     | Read, Grep, Glob, Bash                                                                            | `contentworker-conventions`                   | The dependency rule and both surfaces (HTTP route + MCP tool per use-case). **Read-only**                                                                                                                                                                                                 |
| `security-reviewer`      | Read, Grep, Glob, Bash                                                                            | `security-model`                              | Findings per trust boundary with attacker, scenario and fix. **Read-only**                                                                                                                                                                                                                |
| `workers-reviewer`       | Read, Grep, Glob, Bash                                                                            | `infra-change`                                | wrangler/EdgeEnv parity, `script_name` bindings, DO tags, delivery cache, install rendering and setup, Workers pitfalls, dry-run bundles. **Read-only**                                                                                                                                   |
| `admin-ui-reviewer`      | Read, Grep, Glob, Bash                                                                            | none                                          | apps/web against PRODUCT.md and DESIGN.md (Ledger), accessibility, layering, tests. **Read-only**, may run tests                                                                                                                                                                          |
| `devops`                 | Read, Grep, Glob, Edit, Write, Bash                                                               | `infra-change`, `ci-triage`                   | Workflows (CI, the optional Deploy), `install.ts`, `setup.sh`, `deploy.sh`, `.env.example`, `wrangler.jsonc`, rollout order, CI triage. Never deploys                                                                                                                                     |
| `docs-sync`              | Bash, Read, Grep, Glob, Edit, Write                                                               | `docs-sync`, `docs-page`                      | Mapping a change to doc pages, verifying claims against the source, regenerating the embed, rebuilding                                                                                                                                                                                    |
| `dx-reviewer`            | Read, Grep, Glob, Bash                                                                            | none                                          | Instructions vs reality: README, AGENTS.md, `docs/development.md`, scripts, this toolkit. **Read-only**                                                                                                                                                                                   |
| `toolchain-auditor`      | Read, Grep, Glob, Bash, WebFetch, Cloudflare docs MCP                                             | `contentworker-conventions`                   | Cloudflare toolchain currency (versions, config shape, local dev, workerd tests, versioned deploys) and agent steerability (AGENTS.md, hooks, permissions, skills, MCP, the PR loop), each finding cited to today's Cloudflare or Claude Code docs, with acceptance checks. **Read-only** |
| `readiness-auditor`      | Read, Grep, Glob, Bash, WebFetch, Cloudflare API MCP (GET only) and docs MCP                      | `infra-change`                                | Template and live-account audit grounded in current Cloudflare docs: DNS, TLS, edge, config, DOs and Workflows, durability, rollback, performance, alerting, cost, plus a DR runbook skeleton. **Read-only**                                                                              |
| `launch-reviewer`        | Read, Grep, Glob, Bash, WebFetch, Cloudflare API MCP (read-only) and docs MCP                     | `contentworker-conventions`, `security-model` | Feature-freeze go/no-go: spec-to-code traceability, backlog classification, ASVS 5.0, OWASP LLM and agentic Top 10s, AI-generated-code failure modes, resilience, data, operability, delivery, tests. **Read-only**, may run tests                                                        |
| `completeness-auditor`   | Read, Grep, Glob, Bash                                                                            | `contentworker-conventions`, `testing`        | Spec-to-code traceability matrix (ROADMAP Shipped → route, MCP tool, SDK, screen → side effect → test), then a sweep for TODOs, flags, stubs, dead code, half-wired integrations and error, empty and edge states. **Read-only**, may run tests                                           |
| `data-integrity-auditor` | Read, Grep, Glob, Bash, WebFetch, Cloudflare API MCP (GET, config and metadata only) and docs MCP | `contentworker-conventions`, `d1-migration`   | Data inventory, then write and delete paths, consistency across stores, migrations, backup and restore, detection and operator risk, with loss scenarios, restore runbook skeletons and proposed RPO/RTO. **Read-only**, may run tests, never reads live content                          |
| `ai-reviewer`            | Read, Grep, Glob, Bash, Cloudflare API MCP (GET, plus read-only GraphQL analytics)                | `contentworker-conventions`                   | Model calls and tiers, AI Gateway settings, model choice against the current catalog, live error and usage numbers. **Read-only**                                                                                                                                                         |

The reviewers can't edit, so their findings don't depend on a fix they made. Give them the base
ref and the changed files, not your conclusions.

## Skills (`skills/`)

Invoke with `/<name>`, or let Claude pick them by description. Background skills don't appear in
the `/` menu; they load when relevant and are preloaded by agents.

| Skill                       | Kind        | Use it for                                                                                                                            |
| --------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `contentworker-conventions` | background  | Each invariant: what it is, why, where, and the command that checks it (`references/invariants.md`). Holds `references/rules-map.tsv` |
| `security-model`            | background  | Trust boundaries and the rules at each; `references/checklist.md` per boundary                                                        |
| `testing`                   | model + `/` | Where a test goes, how the workerd suites and the Playwright projects work, running one package, file or test                         |
| `preflight`                 | model + `/` | The verify job's checks, scoped to what changed with `turbo --filter=...[origin/main]`                                                |
| `new-use-case`              | model + `/` | Use-case, test, route + OpenAPI, MCP tool, store and D1, SDK, docs                                                                    |
| `new-adapter`               | model + `/` | A new `@contentworker/adapters` subpath, its tests, the wiring in `packages/platform`, parity                                         |
| `d1-migration`              | model + `/` | Next number, expand-only SQL, `schema.ts`, local apply, D1 tests, expand/contract                                                     |
| `infra-change`              | model + `/` | `wrangler.jsonc` → `EdgeEnv` → `install.ts` → `setup.sh` → scripts tests, dry-run bundles, rollout order                              |
| `regen`                     | model + `/` | The docs embed, the MCP skills embed, the docs theme and the web Worker's types, with their drift tests                               |
| `ci-triage`                 | model + `/` | Classify a failed run and take the one safe next step                                                                                 |
| `docs-sync`                 | model + `/` | After a change: what's generated, what drifts, the procedure, the embed, the build                                                    |
| `docs-page`                 | model + `/` | Adding or moving a page: section, frontmatter, sidebar or index, components, voice                                                    |
| `review-change`             | `/` only    | Parallel reviews plus mechanical checks, merged into one ranked list                                                                  |
| `ship`                      | `/` only    | Worktree → preflight → commit → push the branch → open the PR. Stops there                                                            |
| `docs-audit`                | `/` only    | A full page-by-page sweep                                                                                                             |
| `run-stack`                 | `/` only    | Boot `pnpm dev` (web + api + engine + delivery on a local D1) and smoke-test it                                                       |

`/` only means `disable-model-invocation: true`: these skills act on the repo (fan out agents,
push, start servers), so Claude runs them only when you ask.

## Rules (`rules/`)

| File         | Paths                                                                                         | Says                                                                         |
| ------------ | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `web.md`     | `apps/web/**`, `packages/ui/**`, `packages/design/**`                                         | Ledger design context, the gateway boundary, test placement, a11y traps      |
| `workers.md` | `apps/{api,delivery,media,engine}/**`, `packages/{platform,adapters}/**`, the install scripts | Traffic split, `script_name`, install rendering, deploy order, runtime rules |
| `sdk.md`     | `packages/sdk/**`                                                                             | SDK-only dependencies, public API stability, runtime-agnostic core           |
| `docs.md`    | `docs/**`, `apps/docs/**`, `README.md`, `ROADMAP.md`                                          | The two doc sets, the embed, generated reference pages, voice                |

## Hooks (`hooks/`, wired in `settings.json`)

| Event                      | Script                | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SessionStart`             | `session-context.sh`  | Adds the branch, uncommitted count and whether this is a worktree. On `main` in the shared checkout, says to branch in a worktree instead of switching                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `PreToolUse` (Bash)        | `guard-bash.sh`       | **Denies** `wrangler deploy` (but allows `--dry-run`) / `versions deploy` / `versions upload` / `preview` / `triggers deploy` / `rollback` / `delete` (also through `sh -c`, `wrangler@<v>` and global flags such as `-c`), shell edits to an applied migration, remote D1 migrations (`--remote`, `db:migrate:remote`), Time Travel restores, deleting D1, KV, R2 or queues, `pnpm contentworker:deploy`, `scripts/deploy.sh` and `pnpm … deploy`. Catches them chained after another command too. **Asks** before pushing `main`, force or `+refspec` pushes, `gh pr merge`, `gh workflow run`, remote D1 SQL, `wrangler secret`, and `pnpm contentworker:setup` / `scripts/setup.sh` / `pnpm contentworker:setup-code` / `scripts/setup-code.sh` |
| `PreToolUse` (Edit/Write)  | `block-generated.sh`  | **Denies** hand edits to generated files: `packages/docs/src/generated.ts`, `packages/http/src/mcp/skills.generated.ts`, `apps/docs/src/styles/theme.css`, `apps/docs/src/generated/openapi.json`, `worker-configuration.d.ts`; each refusal names the generator                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `PreToolUse` (Edit/Write)  | `guard-invariants.sh` | **Denies** editing a migration in `packages/db/migrations` already on `origin/main`, new text with a z-suffixed route (`/healthz`…), and a `package.json` dependency with its own version instead of `"catalog:"`/`"workspace:"`. **Asks** before a migration that drops or renames, an edit to `scripts/do-migrations.test.ts`, and an edit to an app's `wrangler.jsonc` that changes, removes or reorders a Durable Object migration on `origin/main` or adds a deleted, renamed or transferred class                                                                                                                                                                                                                                             |
| `PostToolUse` (Edit/Write) | `format.sh`           | Runs `biome check --write` on the edited file. Silent when clean; passes back errors Biome can't fix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `PostToolUse` (Edit/Write) | `docs-impact.sh`      | Logs the edit for this session; names the docs pages for a documented surface, once per file. Advisory                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `PostToolUse` (Edit/Write) | `rules-impact.sh`     | Names the rules an edit to that path must keep (from `rules-map.tsv`), once per file. Advisory                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `Stop`                     | `docs-drift.sh`       | **Blocks once** per drift-set when this session changed documented surfaces, still uncommitted, and no docs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

All hooks are bash + `jq` (required: without it every hook is a silent no-op, and the session
start says so), fail open (exit 0, silent) on anything unexpected, and share `lib.sh` (`field`,
`deny`, `ask`, `context`, `once`, `repo_path`, `after_edit`), except the docs hooks, which stand
alone. The docs hooks keep their edit log per git root, so another session's uncommitted work in a
shared checkout never trips them. Edits made through Bash (`sed`, heredocs) reach neither the edit
log nor the Edit/Write guards. `guard-bash.sh` splits on `; & |` without parsing quotes, so it errs
toward asking (a quoted `&&` before `wrangler deploy` in a script argument is denied too).

## Two maps, one source of truth each

| Map                                                                                                                      | Read by                                                      | Rows                                         |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ | -------------------------------------------- |
| [`skills/docs-sync/references/surface-map.tsv`](skills/docs-sync/references/surface-map.tsv)                             | `docs-impact`, `docs-drift`, `docs-sync`, `review-change`    | source regex → docs pages → `gen` or `prose` |
| [`skills/contentworker-conventions/references/rules-map.tsv`](skills/contentworker-conventions/references/rules-map.tsv) | `rules-impact`, `contentworker-conventions`, `review-change` | source regex → the rule to keep              |

When you add a documented surface or a path-specific rule, add its row. Every matching row is
said, so keep regexes narrow. `pnpm test:toolkit` fails when a regex matches no file in the repo or
a page the surface map names doesn't exist, so the maps can't silently go stale when code or docs
move.

## Permissions (`settings.json`)

- **Allow:** the checks (`pnpm lint`, `check-types`, `test`, `test:scripts`, `test:toolkit`,
  `turbo run`, each package's `test` by name), local D1, the docs build, `sync:theme`,
  `install.ts names`, read-only `gh run` and `gh pr`, and the toolkit tests.
- **Ask:** `git push`, `gh pr merge`, `gh run rerun`, `gh workflow run`, `scripts/setup.sh`, `scripts/setup-code.sh`,
  `pnpm contentworker:setup*`.
- **Deny:** `pnpm deploy`, `pnpm run deploy`, `pnpm contentworker:deploy`, `scripts/deploy.sh`, `wrangler deploy`, `wrangler rollback`, remote
  migrations. The hooks back these up for chained, filtered, quoted, version-pinned and
  global-flag forms. A deny rule outranks a hook, so `Bash(wrangler deploy*)` also refuses a bare
  `wrangler deploy --dry-run`: check a bundle with
  `pnpm --filter @contentworker/<app> exec wrangler deploy --dry-run --outdir <dir>`.

Personal settings (notifications, extra allows) go in `settings.local.json`, which is gitignored.

Secrets are denied too: `Read` rules cover `.secrets/**`, `.dev.vars` and `.env` or `.env.*` at any
depth, for the Read tool and for reads through Bash such as `cat`. `.dev.vars.example` stays readable.

## Testing the toolkit

```bash
pnpm test:toolkit
```

This runs `.claude/scripts/toolkit-check.sh` (skill and agent frontmatter against the Agent Skills
spec, preloads that exist, hook scripts executable and parseable, map regexes that compile and
match a file, surface-map pages that exist, CLAUDE.md importing AGENTS.md), then the two hook
suites in `hooks/tests/`. CI runs it in the verify job. Changes to `settings.json` take effect in a
new session; skills and agents reload on their own.

## Adding to the toolkit

- **A rule a machine can check** goes in a hook. Add a case to `guard-invariants.sh` or
  `guard-bash.sh`, with tests for deny, ask and allow in `hooks/tests/guard-hooks.test.sh`.
- **A rule that needs judgement** goes in `contentworker-conventions/references/invariants.md`,
  with a check command, and in `rules-map.tsv` if it's tied to a path.
- **A procedure** becomes a skill. Write the `description` as what plus when. Keep `SKILL.md`
  under 500 lines with detail in `references/`. Use `disable-model-invocation` if it acts on the
  repo.
- **A role** becomes an agent. Give it the fewest tools that do the job, preload its skills, and
  end its prompt with the output format the caller needs.
