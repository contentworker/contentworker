---

paths:

- docs/**
- apps/docs/**
- README.md
- ROADMAP.md

---

# Documentation

- Two doc sets. `docs/*.md` are the maintainer docs: unpublished, indexed by `docs/README.md`, and
  embedded into `packages/docs/src/generated.ts` for the MCP and HTTP docs tools. The embed is
  gitignored and rebuilt by `pnpm install` and turbo's `generate` task before every check-types,
  test, build and dev; never commit or hand-edit it. `apps/docs`
  (`@contentworker/docs-site`, Starlight) is the public site at `docs.contentworker.app`.
- The site's reference pages render from `@contentworker/domain` (node catalog, workflow
  templates, scopes) and the api's OpenAPI at build time: fix the source, not the rendered page.
  Its theme is generated from `packages/design/src/tokens.ts` (`pnpm sync:theme`). Verify with
  `pnpm docs:build` (fails on broken links).
- A new site page goes in `sidebar` in `apps/docs/astro.config.mjs`; a new maintainer page in
  `docs/README.md`; both get rows in `.claude/skills/docs-sync/references/surface-map.tsv`
  (`docs-page` skill).
- Document only behaviour verified in the code; planned work goes in `ROADMAP.md`, phrased as
  planned.
- Never name a competing CMS; say "the surveyed CMS" or describe the behaviour.
- Code fences must run: real `@contentworker/*` package names, real env vars, real commands.
