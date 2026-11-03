---
name: docs-sync
description: Keep the published Starlight docs in apps/docs and the maintainer docs in docs/ true to contentworker's code after a change. Use when a change touches a documented surface (workflow nodes and templates, permission scopes, REST routes and OpenAPI, MCP tools and skills, content model, publishing, webhooks, auth, D1 schema, wrangler config, the fleet, Ledger tokens), when the docs-drift hook fires, or when docs look stale. Maps changed files to pages, separates generated reference pages from hand-written prose, regenerates the docs embed and verifies with the docs build.
---

# Syncing the docs

Two doc sets describe contentworker as it is at this commit:

- **`apps/docs`** (`@contentworker/docs-site`): Starlight on Astro, static assets, served by the
  `contentworker-docs` Worker at `docs.contentworker.app`. For people who work in a space and
  developers who integrate with one (Start, Working with content, Integrating, Reference).
- **`docs/*.md`**: the maintainer docs, plain Markdown, unpublished but embedded into
  `packages/docs/src/generated.ts` and served to agents over MCP and HTTP. How contentworker is
  built, configured, deployed and tested; indexed by `docs/README.md`.

The `docs-page` skill says which material goes where.

## What syncs itself, and what doesn't

**Generated at build time. Never hand-copy these into prose:**

| Output                                   | Source                                                        | Component                                |
| ---------------------------------------- | ------------------------------------------------------------- | ---------------------------------------- |
| Node catalog (`reference/nodes`)         | `NODE_SPECS`, `packages/domain/src/workflow/nodes.ts`          | `NodeCatalog.astro`, `NodeIcon.astro`    |
| Workflow templates (`reference/workflow-templates`) | `WORKFLOW_TEMPLATES`, `packages/domain/src/workflow/templates.ts` | `WorkflowTemplates.astro`       |
| Permission scopes (`reference/scopes`)   | `SCOPES`, `scopesForKind`, `packages/domain/src/auth/auth.ts`  | `Scopes.astro`                           |
| `/openapi.json`, the `/api/` explorer, the endpoint index on `reference/rest-api` | the routes the api registers (`packages/http/src/api`), via `apps/docs/scripts/openapi.ts` → `src/generated/openapi.json` | `src/pages/openapi.json.ts`, `EndpointIndex.astro` |
| Docs theme (`src/styles/theme.css`)      | `packages/design/src/tokens.ts`                               | `pnpm sync:theme`                        |
| `packages/docs/src/generated.ts`         | `docs/*.md`                                                   | `pnpm --filter @contentworker/docs generate` |

Rebuilding refreshes the site's generated pages. The prose _around_ them still makes claims (a
node's behaviour, a scope named in a sentence, a status code in an example), and those are yours
to check.

**Hand-written, so they drift:** everything else in `apps/docs/src/content/`, every page in
`docs/`, `apps/docs/src/styles/brand.css` (the admin's components carried into Starlight),
`apps/docs/DESIGN.md`, and the repo-level `README.md`, `AGENTS.md` and `ROADMAP.md`.

## Procedure

1. **Scope.** Use the files named in the request. Otherwise take
   `git diff --name-only origin/main...HEAD` plus uncommitted changes (`git status --porcelain`).
2. **Map files to pages** with [references/surface-map.tsv](references/surface-map.tsv), the same
   table the hooks use (`git diff --name-only origin/main...HEAD | .claude/hooks/docs-map.sh`). A
   changed file with no row is probably undocumented; say so rather than guessing a page. If it is a
   documented surface the map misses, add a row (`pnpm test:toolkit` checks the regex and pages).
3. **Read the diff, then the page.** For each page, find every sentence the change could falsify:
   names, defaults, routes, status codes, scopes, field types, env vars, table columns, examples.
   Grep the docs for the old identifier: `grep -rn '<old name>' apps/docs/src docs`.
4. **Verify against source, not memory.** Every identifier, default, route and status code you
   write must be grepped from the code at this commit. Nothing type-checks prose.
5. **Edit surgically** in the existing voice (see `docs-page`): dense, factual, present tense,
   identifiers in backticks, sentence-case headings, no marketing prose. Prefer one changed sentence
   over a rewritten section. If you would restate an enum the domain exports, render it with a
   component instead.
6. **New page?** Follow `docs-page`. A site page is invisible until it is in `sidebar` in
   `apps/docs/astro.config.mjs`; a maintainer page needs a row in `docs/README.md`.
7. **The embed rebuilds itself.** `packages/docs/src/generated.ts` is gitignored; turbo's
   `generate` task rewrites it before every check-types, test and build (`pnpm generate` by hand).
   Never hand-edit or commit it.
8. **Ledger tokens.** If `apps/web/app/app.css` changed a token, make the same change in
   `packages/design/src/tokens.ts` and run `pnpm sync:theme`; `pnpm --filter @contentworker/design test`
   fails until both agree. If an admin component the docs mirror changed, update its counterpart in
   `apps/docs/src/styles/brand.css` and `apps/docs/DESIGN.md`.
9. **Repo-level docs.** If the change falsifies `README.md`, `AGENTS.md` (the rules; `CLAUDE.md`
   only imports it) or `ROADMAP.md`, fix them too (a shipped roadmap item moves out of the
   roadmap).
10. **Build:** `pnpm docs:build`. It regenerates the OpenAPI snapshot and fails on bad frontmatter,
    an unknown sidebar slug, an MDX syntax error, a broken import, and (via
    `apps/docs/scripts/check-links.mjs`) any internal link or `#anchor` that doesn't resolve. It does
    not catch a wrong claim.

## Things that bite

- Prose is at `apps/docs/src/content/`, not `src/content/docs/`; `content.config.ts` uses a `glob`
  loader. Don't move files to "fix" it.
- MDX treats `{` and `<` as code. Write `{{path}}` templates and `<id>` placeholders inside
  backticks or code blocks.
- Node catalog anchors are node types. Renaming a node type breaks links; the link check names them.
- Never name a competing CMS in either doc set; say "the surveyed CMS".
- The live site only changes when CI deploys the docs Worker after a merge. Never run the docs
  deploy yourself.

## Report

List each drift as `source → page`: what was stale and what it says now. Then the files edited,
the regenerate and build results (paste failures verbatim), and anything you deliberately left
alone or could not verify, flagged for a human.
