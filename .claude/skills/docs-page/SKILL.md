---
name: docs-page
description: Add or restructure a page in the contentworker docs (the published apps/docs site, or the maintainer docs in docs/ that are embedded for MCP). Use when a new feature, API surface or integration needs its own page, or when a page should split or move. Covers where the page goes, frontmatter, sidebar and index registration, the generated components, the surface map, the writing voice and the checks.
---

# Adding a docs page

## Who it is for

The published site (`docs.contentworker.app`) is for two readers: people who work in a space
(model content, edit and publish, run workflows and approvals, manage the team) and developers
who integrate with one (API keys, the Delivery, Management and Preview APIs, webhooks, SDKs,
MCP). It is not for people who deploy, configure or develop contentworker.

Material only someone with the source or a Cloudflare account needs goes in the repo-root `docs/`
folder instead: plain Markdown, indexed by `docs/README.md`, embedded into
`packages/docs/src/generated.ts` so agents can read it over MCP. That covers source paths and
function names, bindings, env vars and secrets, `wrangler`, D1 tables, R2 keys, Workflow and
Durable Object mechanics, the fleet, deploys, CI and local development. On the site, describe a
deployment setting by what it does and say the deployment's administrator sets it, never by its
variable name.

## Where it goes

| Section             | Directory                                  | For                                                    |
| ------------------- | ------------------------------------------ | ------------------------------------------------------ |
| Start               | `apps/docs/src/content/start/`             | Reading in order: getting started, concepts            |
| Working with content | `apps/docs/src/content/guides/`           | A task or feature in the admin, end to end             |
| Integrating         | `apps/docs/src/content/guides/`            | Keys, reading content, webhooks, SDKs, MCP             |
| Reference           | `apps/docs/src/content/reference/`         | Things you look up: routes, nodes, templates, scopes   |
| Maintainer docs     | `docs/` (repo root)                        | How it is built, configured, deployed and tested       |

A maintainer page is `docs/<slug>.md` with an `#` title and a one-line summary under it, an entry
in `docs/README.md`, and relative links between maintainer pages; it links site pages as
`https://docs.contentworker.app/…/`. Site pages never link into `docs/`.

Before adding a page, check whether the content belongs as a section of an existing one. A new
page earns its place when it has its own reader and its own question.

## Steps

For a site page:

1. Create `apps/docs/src/content/<section>/<slug>.mdx` with frontmatter:

   ```mdx
   ---
   title: Sentence case title
   description: One sentence saying what the page covers; it is the search snippet.
   ---
   ```

2. Register it in `sidebar` in `apps/docs/astro.config.mjs`, in reading order (the group labels
   are Start, Working with content, Integrating, Reference). A page that isn't listed builds but
   can't be found.
3. Add a row to `.claude/skills/docs-sync/references/surface-map.tsv` for the source files the page
   describes, so the hooks and the docs-sync skill know to check it.
4. Link to it from the pages a reader would come from (Concepts, the related guide, the home
   page's cards if it is a main entry point).
5. `pnpm docs:build`, which includes the internal link check, and `pnpm test:toolkit` for the map.

For a maintainer page: write it, add it to `docs/README.md`, add its surface-map rows, then
`pnpm generate` (the embed is gitignored and rebuilt by every check-types, test and build;
never commit it).

## Use the source, not a copy of it

Render from `@contentworker/domain` rather than restating it:

```mdx
import Scopes from '../../components/Scopes.astro';

<Scopes show="kinds" />
```

`NodeCatalog` (optionally one `category`), `WorkflowTemplates`, `Scopes` (`show="scopes"` or
`"kinds"`) and `EndpointIndex` (from the generated OpenAPI) are the generated components. A new
component reads `@contentworker/domain` or `@contentworker/design` only; the docs never import api
or engine source. The OpenAPI document is the exception, built by `apps/docs/scripts/openapi.ts`
from the api's in-memory wiring so it matches the routes the api registers.

## Voice

- Dense and factual, present tense, second person where an instruction needs one.
- Identifiers, routes and values in backticks. On the site, name routes, fields, headers and
  values a reader can see or send, not source files; in `docs/`, paths are repo-relative.
- Sentence-case headings. No marketing words ("powerful", "seamless", "simply").
- Say what happens and why, then stop. A table beats a paragraph listing five fields.
- Examples are real: routes that exist (`/spaces/:space/environments/:env/…`), scopes from
  `SCOPES`, node types from `NODE_SPECS`, package names from `packages/sdk/*`.
- Never name a competing CMS; say "the surveyed CMS".
- Styling follows `apps/docs/DESIGN.md`. Colours come from the generated `src/styles/theme.css`
  (never hand-edited); hand-written rules go in `src/styles/brand.css`. Don't add per-page CSS.
