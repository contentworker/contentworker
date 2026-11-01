# Design System: contentworker docs

This file describes `apps/docs`: the Starlight site at docs.contentworker.app and the Scalar page at
`/api/`. The system is the admin's, Ledger (`DESIGN.md` at the repo root; tokens as data in
`packages/design`, held to `apps/web/app/app.css`); this file records what the docs do with it. It
is derived from the shipped code (`src/styles/brand.css`, `src/components/`, the generated
`src/styles/theme.css`).
When the code and this file disagree, fix whichever is wrong and say which in the commit.

## North star: the admin's reading copy

The admin is neutral paper and ink, with colour kept for links and status. The docs are the same
material for the moments you're not in the admin: modeling a type, wiring a webhook, looking up a node or a route.
Most of the chrome is Starlight's, recoloured and re-set from the admin's tokens rather than
redrawn. What is contentworker's own is small: the page header, ruled sections, the top bar's
pill, state badges, node cards, and the endpoint index.

- **Match system by default**, as the admin; Light and Dark are one select away. The choice is
  stored as `starlight-theme` and read by the explorer too.
- **Achromatic neutrals.** Every neutral is chroma 0; ink is the brand. Links are Ledger's work
  blue (`link`), underlined.
- **Colour means status** (Ledger's One Meaning Rule), in state badges and callouts: `ok`
  (published, tip), `wait` (changed, caution), `bad` (danger), `idle` (draft, archived).
  Starlight's hue slots are filled from them: green ok, orange wait, red bad, blue the work blue,
  purple ai.
- **Inter Variable** for everything, self-hosted; IBM Plex Mono for code where installed, else the
  system monospace.
- **Pills and panels.** Controls (buttons, search, the current sidebar item) are pills; cards are
  24px panels on the card step with a 10% ink ring; node cards and code blocks use `--cw-radius`.

## Tokens

`packages/design/src/tokens.ts` holds Ledger as data, value for value with the custom properties
`apps/web/app/app.css` declares; `apps/web/tests/ledger.test.tsx` fails when the two disagree, so a
token changed in one place fails until the other follows. `pnpm sync:theme`
(`packages/design/scripts/sync-theme.ts`) writes Starlight's variables plus every token as
`--cw-<name>` to `src/styles/theme.css` from `starlightThemeCss()`. That file is generated: never
hand-edit it. `packages/design/tests/tokens.test.ts` fails when it is stale.

## Components

- **Page header** (`PageTitle.astro`): the title in Inter 600, the page's `description` muted
  under it.
- **Top bar**: the lowercase wordmark, search as the admin's input pill, **API explorer** as the
  one primary pill, the theme select.
- **Sidebar**: group labels 14px 600 ink; links 14px muted; the current page is the admin's active
  nav item (muted fill, ink), not an inverted pill.
- **Sections and tables**: an h2 opens on a hairline; table column labels are the admin's label
  style (12px 500 muted, sentence case, never uppercase).
- **Callouts**: a 1px border at 30% of the hue and a 6% tint; never a coloured side stripe.
- **State badge** (`.cw-badge[data-state]`): the admin's `StatusBadge`, a pill tinted in its
  status colour with its label always present.
- **Node card** (`NodeCatalog.astro`, `WorkflowTemplates.astro`): icon (lucide, pinned to the
  admin's lucide-react version), label, type in mono, `undo · waits` tags, outputs, fields.
- **Endpoint index** (`EndpointIndex.astro`): the OpenAPI document's tag groups as collapsible
  tables of method, path and summary.
- **OpenAPI explorer** (`src/pages/api.astro`): Scalar under a 48px top bar, its palette from
  `scalarThemeCss()`; its own dark-mode toggle is hidden.

## Don'ts

- Don't hand-edit `src/styles/theme.css`.
- Don't add colour that isn't a link or a status, gradients, glass, or shadows beyond the ring.
- Don't name a competing product anywhere on the site.
