---
name: regen
description: Rerun every committed code generator in contentworker (the docs embed, the MCP skills embed, the docs theme, the web Worker's types) and show what drifted. Use before committing edits to docs/*.md, packages/http/skills/**, packages/design/src/tokens.ts or apps/web/wrangler.jsonc, or when a drift test (docs, http, design) fails in CI.
---

# Regenerate generated files

Regenerate every committed artifact and report drift. Never hand-edit the outputs (the
`block-generated` hook denies it).

| Output                                    | Source                       | Command                                          | Drift test                         |
| ----------------------------------------- | ---------------------------- | ------------------------------------------------ | ---------------------------------- |
| `packages/docs/src/generated.ts`          | `docs/*.md`                  | `pnpm --filter @contentworker/docs generate`     | `pnpm --filter @contentworker/docs test` |
| `packages/http/src/mcp/skills.generated.ts` | `packages/http/skills/**`  | `pnpm --filter @contentworker/http generate:skills` | `pnpm --filter @contentworker/http test` |
| `apps/docs/src/styles/theme.css`          | `packages/design/src/tokens.ts` | `pnpm sync:theme`                             | `pnpm --filter @contentworker/design test` |
| `apps/web/worker-configuration.d.ts`      | `apps/web/wrangler.jsonc`    | `pnpm --filter @contentworker/web types`         | `pnpm --filter @contentworker/web check-types` |

`apps/docs/src/generated/openapi.json` is rewritten by every `pnpm docs:build` from the api's
routes; nothing to run by hand.

1. Run the commands for the sources that changed (all four if unsure).
2. `git status --short packages/docs/src packages/http/src/mcp apps/docs/src/styles apps/web/worker-configuration.d.ts`
   and `git diff --stat` over those paths.
3. If `generated.ts` changed, make sure the change only reflects the doc edits being committed;
   don't embed another session's uncommitted docs.
4. Run the matching drift tests.

Report each generator as `in sync` or `regenerated: <files>`, and the drift tests' results.
