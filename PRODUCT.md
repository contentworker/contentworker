# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Content editors first: writers, marketers, and content ops people who live in entries,
assets, releases, and publishing workflows for hours at a stretch. They are not
necessarily technical; they need the state machine (draft → published, releases,
workflows, branch merges) to feel legible without reading docs.

Developers second: they model content types, wire webhooks and functions, connect
API keys and MCP clients, and inspect delivery behavior. They visit the same admin
but in shorter, tool-shaped sessions.

Operators third: the person who installs and runs a self-hosted ContentWorker in their own
Cloudflare account. Their sessions are short and high-stakes: setup, settings, sign-in and
security, keys, recovery. They need to know exactly what a change does before they make it.

Context: a browser tab that stays open all day, usually alongside the site or app
whose content is being edited. It also runs on an iPad and an iPhone, in a tab or added
to the Home Screen as its own app: a phone is for keeping up and deciding (the overview,
content, releases, approvals and quick edits through a bottom tab bar); the full editor
and building workflows are for wider screens. The theme follows the system until the
reader picks light or dark.

## Product Purpose

The admin UI for ContentWorker, an API-first, AI-agentic-first headless CMS. It is
the human surface over the same application use-cases the HTTP API and MCP tools
call: content modeling, entry editing (rich text via TipTap), publishing and
releases, assets, taxonomy, workflows, webhooks, functions, AI generation and
enrichment review. Success looks like an editor shipping content changes quickly
and confidently, and trusting what the AI agents did on their behalf.

## Positioning

Agents and people are equal clients of one product. The HTTP API, the MCP tools and the admin
call the same application use-cases, with the same validation and permissions, so an agent can
never do what a person can't, or the reverse; and what an agent produces arrives as a reviewable
proposal with its provenance, not a silent change. Behind that: ContentWorker is self-hosted, one
install in the customer's own Cloudflare account, and content is structured (typed fields and
rich-text trees each channel renders for itself), never stored or delivered as HTML.

## Operating Context

- The admin stays open all day beside the site or app being edited; the canvas editor frames the
  customer's own page and edits it in place.
- Editors move content through drafts, releases, scheduled actions, workflow stages and
  approvals, often with Coworker (the assistant) proposing changes for them to confirm.
- Developers work in the admin and in code at once: content types, block definitions, webhooks,
  functions, API keys, MCP clients and the public docs site (`apps/docs`).
- Operators set an install up and deploy it from the command line (`pnpm contentworker:setup`,
  `pnpm contentworker:deploy`), then manage it from the admin's settings.

## Capabilities and Constraints

- Admin capabilities mirror the API and MCP surfaces: every capability exists on both, and the
  admin is one more client of it.
- Content is never markup: HTML is converted on the way in (imports) and rendered by the consumer
  on the way out.
- Permissions are per space, per type and per field; the admin shows what a role may not change
  as read-only, and says why.
- The phone is for keeping up and deciding; the full editor, the canvas and building workflows
  need a wider screen and say so.
- Not in production yet: no live customer installs.

## Brand Commitments

- The product is **ContentWorker** (one word, capital C and W). The in-product assistant is
  named **Coworker**.
- The admin's visual system is Ledger (DESIGN.md), shared across the owner's products through
  `packages/design` and `packages/ui`.
- Competing CMSs are never named in the product, code, comments or docs; comparisons say "the
  surveyed CMS". Import formats (WordPress WXR) may be named.

### Personality

Calm, precise, fast. Quiet confidence: dense but legible, keyboard-friendly,
nothing decorative. The interface should feel like a well-made tool that gets out
of the way; the content being edited is the star, not the chrome around it.

## Anti-references

- Legacy enterprise CMS admin: crowded chrome, nested settings mazes, visual noise.
- SaaS-gradient startup aesthetic: gradient heroes, glassmorphism, marketing energy
  leaking into a work tool.
- The unthemed gray shadcn default that reads as a template rather than a product.
  The admin's look is Ledger (DESIGN.md), a named system with its own status tokens,
  shared across the owner's products through `packages/design` and `packages/ui`.
- AI-everything clutter: sparkle icons and "AI" buttons on every surface. AI is
  woven into flows (generation dialogs, enrichment review, assist panel), never
  shouting for attention.

## Product Principles

1. **Content is the interface.** Chrome recedes; the entry, the asset, the diff is
   what gets visual weight. Density serves reading, never decoration.
2. **State is always legible.** Draft/changed/published, release membership,
   workflow stage, agent proposals: an editor should never wonder what will happen
   when they hit publish.
3. **AI earns trust through review.** Agent output arrives as reviewable proposals
   with clear provenance, not silent mutations. Human-in-the-loop is the default
   posture of the UI.
4. **Fast hands, fast feedback.** Keyboard-friendly flows, optimistic-feeling
   interactions, no spinner where a skeleton or instant response is possible.
5. **One system, no snowflakes.** New surfaces compose the existing token/component
   system (Ledger: shadcn's base-maia preset on the project's tokens, see DESIGN.md);
   a screen should never look like it came from a different product.

## Evidence on Hand

- No real customers, testimonials, case studies, logos, usage numbers or benchmarks exist yet.
  Never invent them; a surface that needs proof says so and waits.
- Demo content to show the product with: the dev seed corpus (`packages/seed`), the sample
  starter a new space can begin from, and the enterprise demo starter for a fictional firm,
  Aldermoor. All of it is fictional and must read as sample content.

## Accessibility & Inclusion

WCAG 2.1 AA: body text ≥4.5:1 against its background (including the dark theme and
muted/placeholder text), full keyboard navigation, visible focus states, and
`prefers-reduced-motion` alternatives for every animation. Status must never be
conveyed by color alone (badges pair color with text).
