---

name: regen
description: Rerun every code generator in contentworker (the docs embed, the MCP skills embed and the docs and diagram themes, which are gitignored build outputs, plus the committed web Worker's types) and show what drifted. Use before committing edits to docs/*.md, packages/http/skills/**, packages/design/src/tokens.ts or apps/web/wrangler.jsonc, or when a drift test (docs, http, design) fails in CI.
---

# Regenerate generated files

Regenerate every generated artifact and report drift. Never hand-edit the outputs (the
`block-generated` hook denies it). The two embeds and the themes are gitignored: `pnpm install` and turbo's
`generate` task (a dependency of `check-types`, `test`, `build` and `dev`) write them, so they
never appear in a diff and never need committing. Only the Worker types are committed.

| Output                                                   | Source                                            | Command                                        | Drift test                                     |
| -------------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------- |
| `packages/docs/src/generated.ts` (gitignored)            | `docs/*.md`                                       | `pnpm generate`                                | `pnpm --filter @contentworker/docs test`       |
| `packages/http/src/mcp/skills.generated.ts` (gitignored) | `packages/http/skills/**`                         | `pnpm generate`                                | `pnpm --filter @contentworker/http test`       |
| `apps/docs/src/styles/theme.css` (gitignored)            | `packages/design/src/tokens.ts`                   | `pnpm sync:theme`                              | `pnpm --filter @contentworker/design test`     |
| `docs/diagrams/themes/ledger-{light,dark}.json` (gitig.) | `packages/design/src/tokens.ts`, `src/mermaid.ts` | `pnpm sync:theme`, then re-render the diagrams | `pnpm --filter @contentworker/design test`     |
| `apps/web/worker-configuration.d.ts`                     | `apps/web/wrangler.jsonc`                         | `pnpm --filter @contentworker/web types`       | `pnpm --filter @contentworker/web check-types` |

`apps/docs/src/generated/openapi.json` is rewritten by every `pnpm docs:build` from the api's
routes; nothing to run by hand.

1. Run the commands for the sources that changed (all four if unsure).
2. `git status --short apps/web/worker-configuration.d.ts` and `git diff --stat` over it (the
   embeds and themes are gitignored and never show; re-render the diagram SVGs if the Mermaid
   themes changed).
3. Run the matching drift tests.

Report each generator as `in sync` or `regenerated: <files>`, and the drift tests' results.
