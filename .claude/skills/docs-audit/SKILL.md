---
name: docs-audit
description: Full audit of the ContentWorker docs (apps/docs and docs/) against the code, page by page. Use for a periodic sweep, before a release, or when many changes have landed without doc updates. Slower and broader than docs-sync, which follows a diff; this reads every page and checks every claim.
disable-model-invocation: true
---

# Auditing the docs

Run this deliberately (`/docs-audit`); it reads the whole docs tree and a lot of source. For a
single change, use `docs-sync` instead. To keep your context small, delegate to the `docs-sync`
agent, one section per agent: Start, Working with content, Integrating, Reference, and the
maintainer docs in `docs/`.

## Procedure

1. **Build first:** `pnpm docs:build`. Fix anything it reports before reading prose.
2. **For each page in `apps/docs/src/content/` and `docs/`** (all of them, including `index.mdx`
   and `docs/README.md`):
   - List its checkable claims: identifiers, defaults, routes and status codes, scopes, field
     types, node types, env vars, file paths, commands, numbers (timeouts, retries, limits).
   - Grep each one in the source. Mark it confirmed, wrong (and fix it) or unverifiable (flag it).
   - Check that commands in code blocks still exist in a `package.json` script or `AGENTS.md`'s
     Commands.
3. **Coverage, the other direction.** Walk the source surfaces in
   `.claude/skills/docs-sync/references/surface-map.tsv` and ask what a reader would need that no
   page says: a new route in `packages/http/src/api/routes`, a new MCP tool in
   `packages/http/src/mcp/tools/`, a new table in `packages/db/migrations`, a new binding or var
   in an `apps/*/wrangler.jsonc` or `EdgeEnv`, a new registry field in `scripts/fleet.ts`. Also check
   for source files that should be in the map but aren't.
4. **Repo docs.** Compare `README.md`, `AGENTS.md` (the rules) and `ROADMAP.md` with the docs; they
   must not disagree. A roadmap item that has shipped is a doc change in two places.
5. **Embed.** `pnpm --filter @contentworker/docs generate` and `pnpm --filter @contentworker/docs test`.
6. **Styling.** Diff the colour and font values in `apps/docs/src/styles/brand.css` (hand-written)
   and the generated `theme.css` against `apps/web/app/app.css`; record what changed in
   `apps/docs/DESIGN.md`.
7. **Build again.**

## Report

A table per section: page, claims checked, fixed, flagged. Then the coverage gaps, the files
edited, the final build result, and the list of code-side discrepancies you found but did not fix
(a docs audit doesn't change runtime code).
