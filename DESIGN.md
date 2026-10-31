---

name: contentworker admin
description: The editors' and developers' console. Ledger on a desktop, an iPad and an iPhone, in a tab or on the Home Screen.
colors:
paper: "oklch(1 0 0)"
ink: "oklch(0.145 0 0)"
primary: "oklch(0.205 0 0)"
primary-foreground: "oklch(0.985 0 0)"
muted: "oklch(0.97 0 0)"
muted-foreground: "oklch(0.52 0 0)"
rule: "oklch(0.922 0 0)"
input: "oklch(0.922 0 0)"
ring: "oklch(0.556 0 0)"
link: "oklch(0.47 0.13 256)"
destructive: "oklch(0.577 0.245 27.325)"
ok: "oklch(0.455 0.105 152)"
wait: "oklch(0.49 0.115 62)"
bad: "oklch(0.5 0.185 28)"
undo: "oklch(0.485 0.135 42)"
idle: "oklch(0.48 0 0)"
ai: "oklch(0.49 0.16 310)"
sidebar: "oklch(0.985 0 0)"
sidebar-accent: "oklch(0.945 0 0)"
paper-dark: "oklch(0.145 0 0)"
card-dark: "oklch(0.205 0 0)"
ink-dark: "oklch(0.985 0 0)"
muted-dark: "oklch(0.269 0 0)"
muted-foreground-dark: "oklch(0.708 0 0)"
link-dark: "oklch(0.76 0.11 250)"
typography:
title:
fontFamily: "Inter Variable, ui-sans-serif, system-ui, sans-serif"
fontSize: "1.75rem"
fontWeight: 600
lineHeight: 1.25
letterSpacing: "-0.015em"
section-title:
fontFamily: "Inter Variable, ui-sans-serif, system-ui, sans-serif"
fontSize: "15px"
fontWeight: 600
lineHeight: 1.3
body:
fontFamily: "Inter Variable, ui-sans-serif, system-ui, sans-serif"
fontSize: "0.875rem"
fontWeight: 400
lineHeight: 1.43
ui:
fontFamily: "Inter Variable, ui-sans-serif, system-ui, sans-serif"
fontSize: "0.8125rem"
fontWeight: 400
caption:
fontFamily: "Inter Variable, ui-sans-serif, system-ui, sans-serif"
fontSize: "0.6875rem"
fontWeight: 500
lineHeight: 1.4
letterSpacing: "0.05em"
mono:
fontFamily: "IBM Plex Mono, ui-monospace, SF Mono, Menlo, monospace"
fontSize: "0.75rem"
fontWeight: 400
rounded:
sm: "0.375rem"
md: "0.5rem"
lg: "0.625rem"
xl: "0.875rem"
2xl: "1.125rem"
3xl: "1.375rem"
4xl: "1.625rem"
full: "9999px"
spacing:
gutter-phone: "1rem"
gutter: "1.5rem"
page-width: "87.5rem"
measure: "55ch"
components:
button-primary:
backgroundColor: "{colors.primary}"
textColor: "{colors.primary-foreground}"
rounded: "{rounded.4xl}"
height: "2.25rem"
padding: "0 0.75rem"
button-outline:
backgroundColor: "{colors.paper}"
textColor: "{colors.ink}"
rounded: "{rounded.4xl}"
height: "2.25rem"
padding: "0 0.75rem"
input:
textColor: "{colors.ink}"
rounded: "{rounded.4xl}"
height: "2.25rem"
padding: "0.25rem 0.75rem"
card:
backgroundColor: "{colors.paper}"
textColor: "{colors.ink}"
rounded: "{rounded.2xl}"
tile:
backgroundColor: "{colors.muted}"
rounded: "{rounded.xl}"
padding: "1rem"
status-badge:
rounded: "{rounded.full}"
padding: "0.125rem 0.5rem"
---

# Design System: contentworker admin

## Overview

The console where editors write, review and publish content, and developers model it and wire it
up. Its visual system is **Ledger**, ported from OrderLoop (the same owner's product; its
`apps/web/DESIGN.md` and `app/app.css` are the source): shadcn's base-maia preset (neutral greys,
Inter, pill buttons and fields) on Radix primitives in `apps/admin/src/components/ui`, with status
tokens (`ok`, `wait`, `bad`, `undo`, `run`, `idle`, `ai`) that mean one thing each. The tokens live
in `apps/admin/src/index.css`; this file is about how the admin is laid out and operated across
screens. PRODUCT.md holds the users, register and principles.

## Colors

Neutral greys with no tint carry everything; colour is reserved for one blue and for status.

### Primary

- **Ink** (`primary`, near-black): primary buttons, the New entry button, the current page's
  marker. Ink is the brand; there is no accent colour behind it.

### Secondary

- **Work blue** (`link`): links, live work (`run`), the slow-page bar and the caret. Never a fill
  for a button.

### Neutral

- **Paper** (`paper`): the page and the card. In dark the page is near-black and cards lift a step
  (`card-dark`).
- **Sidebar** (`sidebar`): half a step under the paper, so the page reads as the surface and the
  sidebar as its frame; the current page is `sidebar-accent`, a step deeper.
- **Muted** (`muted`): tiles, segmented tracks, hover fills.
- **Muted text** (`muted-foreground`): secondary text and captions. Set to hold 4.5:1 on paper,
  on muted and on a tile.
- **Rule** and **Input** (`rule`, `input`): hairlines, and the edge and faint fill of fields.
- **Ring** (`ring`): the focus edge on fields and buttons, dark enough to hold 3:1 on paper and on
  muted fills. The page-wide focus outline is ink.

### Status

Each contentworker status maps to one token (`lib/format.ts` `statusTone`), and every badge, dot
and chart series for a status reads it through `var()`, so it switches with the theme:

| Token             | Means                       | contentworker statuses                                                      |
| ----------------- | --------------------------- | --------------------------------------------------------------------------- |
| `ok`              | succeeded, live             | published, active, completed, delivered, enabled, merged                    |
| `wait`            | waits on a person           | changed (edited since publish), pending, in review, paused, unsaved changes |
| `run` (work blue) | in progress or on a clock   | scheduled, running, queued, processing                                      |
| `idle`            | at rest, or ended otherwise | draft, open (release), archived, revoked, expired, disabled, cancelled      |
| `bad`             | failed                      | failed, error, rejected, removed                                            |
| `undo`            | taken back                  | rolled back, reverted                                                       |
| `ai`              | a model's work              | proposed, suggested, generated (agent output awaiting review)               |

### Named Rules

**The Green Means Done Rule.** `ok` is the only green, and it means "succeeded" or "live". No green
brand, no green button, no green decoration.

**The One Meaning Rule.** A status colour is never used decoratively. If it isn't a status, it is
grey.

## Typography

**Body Font:** Inter Variable (with the system sans)
**Label/Mono Font:** IBM Plex Mono, for ids, API ids, keys, versions, URLs and code

**Character:** one quiet sans for everything, set small and dense for people who live in the tool,
with Plex Mono only where a value must be read character by character.

### Hierarchy

- **Title** (600, 1.75rem, 1.25, -0.015em, `tracking-title`): a page's h1. It wraps; it is never
  truncated (an entry's title included).
- **Section title** (600, 15px, 1.3, `section-title`): a card's heading, in sentence case.
- **Body** (400, 0.875rem): running text, rows, fields.
- **UI** (400, 0.8125rem, `text-ui`): the header's controls, segmented controls, compact controls.
- **Caption** (500, 0.6875rem: 11px, 0.05em, UPPERCASE, `caption`): field, column and fact labels,
  and the group labels in the sidebar, menus and sheets. The only uppercase in the product.
- **2xs** (0.6875rem, `text-2xs`): counts and key hints in the bars.

### Named Rules

**The Sentence Case Rule.** Titles, buttons and menu items are sentence case ("New entry", "Publish
selected"). Only captions are uppercase, and never in mono. Status words are humanized
("In review", "Rolled back").

**The Scale Lives In The Theme Rule.** Sizes come from the theme (`text-ui`, `text-2xs`,
Tailwind's steps), not hand-written pixel values, so they grow with the reader's text size.

**The Measure Rule.** Running text, a page's intro under its title (`PageHeader`) and helper lines
alike are held to `max-w-measure` (55ch), not a hand-written `max-w-[…ch]`.

## Screens and breakpoints

Tailwind's default breakpoints, read as devices:

| Width                     | Typically                 | What changes                                                                                                                         |
| ------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| below `sm` (640px)        | iPhone upright            | Header shows the mark, the scope pill and Search as icons                                                                            |
| below `md` (768px)        | phones, either way up     | Bottom tab bar, no sidebar; tables stack into cards; the content-type list leaves the Content pages (their overview lists the types) |
| `md` to `lg` (768–1023px) | iPad upright              | The sidebar is an icon rail beside the page and opens over it                                                                        |
| `lg` and up (1024px)      | iPad on its side, desktop | The full sidebar (the reader can collapse it); the entry editor's panels beside the form; the assistant as a column                  |
| `xl` and up (1280px)      | desktop                   | The space, environment and locale switchers sit in the header; the full sidebar and the assistant's column side by side              |

Size and hint by what is pointing, not by width: `touch:` is a coarse pointer (a finger), `fine:` a
mouse or trackpad. `short:` is a phone on its side (landscape, under 32rem tall, under 64rem wide).

## The shell

`components/layout/AppShell.tsx`, a port of OrderLoop's `routes/shell.tsx`; `components/layout/
nav.ts` is the one source of the pages, their order, names, icons and G-letters.

- **Sidebar (from md):** shadcn's Sidebar (radix-maia, as adapted by OrderLoop), in
  `components/ui/sidebar.tsx`. Full height on its own ground, with a rule. From the top: the brand
  row on the header's line, whose mark is the `SidebarTrigger` (named "Sidebar", ⌘\ or Ctrl+\);
  the day's work (Overview, Content, Approvals when on, Releases) with no label; then groups
  labelled as captions: **Build** (Workflows), **Library** (Media, Taxonomy) and **Settings**
  (Access, Automation, Extensions, Workspace: Settings' own section groups, each opening its first
  section and reading as current on any of its sections); the account at its foot; `SidebarRail`
  on its edge. The page you're on is `sidebar-accent` and 500 with `aria-current`, marked as soon
  as it is chosen, not when its page arrives. On touch every row is 44px.
- **Expanded or a rail:** 16rem, or a 3.25rem rail of icons. The reader's choice is the
  `cw_sidebar_state` cookie. Below lg, and beside the assistant's column below xl, the sidebar stays a
  rail and its toggle opens it over the page (`peek`, `shadow-overlay`); Escape, a press outside it
  or a navigation closes it. As a rail, names go to screen readers and a tooltip, group labels keep
  their height as hairlines, and icons stay at the same x.
- **Header:** 3rem plus the status bar's inset (`--shell-h`), sticky, with a rule under it. Below
  md it starts with the mark (a link to Overview). From md it holds the breadcrumbs (where you are:
  an entry reads as its title, never its id), then what acts on the page: the scope, Search (⌘K),
  Assistant (when on) and New entry.
- **Scope (contentworker's):** every page works in a space, an environment (a branch) and a locale.
  From xl the three switchers sit in the header; below xl a pill names the environment (the space
  and locale in its accessible name and `title`) and opens them in a sheet; the phone's More sheet
  holds them too. It is never more than one press away.
- **New entry:** in the place OrderLoop gives New order. An entry needs a content type: on a content
  type's pages it links straight to that type's new entry; anywhere else it opens a menu of the
  space's content types. Ink, except on Approvals and Workflows, where it steps back to an outline.
  On a phone it is a floating pill (`shadow-float`) above the tab bar on Overview and the Content
  pages; main pads its foot so the last row clears it.
- **Account:** the sidebar's foot. Its menu holds who is signed in (the person, else the kind of
  key), Connection, Keyboard shortcuts (with a fine pointer), the theme (Light, Dark, Match system)
  and Sign out. Its accessible name is that name plus "account menu".
- **Shortcuts** are written for the device (⌘ on Apple, Ctrl elsewhere). G then a letter goes to a
  page (H Overview, C Content, A Approvals, R Releases, W Workflows, M Media, T Taxonomy, S
  Settings); ? opens the list of every shortcut (a sheet, with whatever the page registers); ⌘K is
  the command palette; ⌘J the assistant when it is on; ⌘\ the sidebar. Single keys go through
  `plainKeyAllowed` (not with a modifier, while typing, or with a dialog, menu or inline confirm
  open) and run before a page's own keys.
- **Transitions** in the bars name their properties (`tint`), never `transition-colors`. The
  shared controls do too, and never animate opacity: a control enabled after a fetch is at full
  contrast in the frame it becomes enabled, not faded up from its disabled 50% (`transition-all`
  once did that, and axe caught an enabled outline button under 4.5:1 mid-fade).
- **One order everywhere:** the sidebar, the tab bar, More, the palette and the G-letters list pages
  in `NAV`'s order.
- **Tab bar (below md):** Overview, Content, Approvals (when on, with its count), Releases, and
  More: the day's work in thumb reach. 3.5rem plus the home indicator (`--tabbar-h`); in `short:`
  2.75rem with the labels for screen readers only. **More reads as the current page** while you're
  on one of its pages. More is a bottom sheet grouped like the sidebar (Pages, Settings), then the
  scope, the theme, the install hint and Sign out. It closes when a page is chosen.
- **Approvals count:** a filled `wait` pill, 99+ past two digits, in the sidebar, tab bar and More
  alike (a `wait` dot on the rail): the shell's one call for attention. Approvals is behind the
  `approvals` feature (`VITE_CW_APPROVALS`) until its inbox ships.
- **Main** pads its foot by `--tabbar-h` and lays every page in `Body` (the page width and
  gutters). Never hard-code the bar heights.
- **Assistant:** behind the `assistant` feature (`VITE_CW_ASSISTANT`, off until its server side
  ships). A column beside the page at lg; below that a sheet between the header and the tab bar,
  taking exactly the area above an on-screen keyboard. Both slide in 200ms on
  `cubic-bezier(0.16,1,0.3,1)` by transform and opacity only: the column takes its 400px at once
  and slides its content in, and gives the width back only after the content has slid out.
  Reduced motion shows and hides it at once. An action waiting for confirmation is pinned above the
  composer in the `wait` tint. ⌘J toggles it (`aria-keyshortcuts`).
- **Slow pages:** a navigation that takes over 400ms draws a link-blue rule sweeping under the
  header and marks main `aria-busy`. Quicker ones show nothing.
- **Route announcer:** after a client-side navigation, the new page's h1 is read out in a polite
  live region. Focus stays where it was.

## Safe areas

`index.html` sets `viewport-fit=cover`, so the installed app and a phone on its side draw under the
status bar, the notch and the home indicator. The insets are `--safe-top`, `--safe-right`,
`--safe-bottom` and `--safe-left` (0 elsewhere). Pad with `pt-safe-*`, `pb-safe-*`, `px-safe-*`,
`pr-safe-*`, `pl-safe-*`: a page's own spacing or the inset, whichever is bigger. Read the insets
through the variables, never `env()` directly.

## Touch

- **Targets:** 44px for a finger. A small control keeps its drawn size and gets `hit-area`, an
  invisible box grown to 2.75rem on a coarse pointer. The shared buttons have it at every size;
  raw buttons and links in the bars add it.
- **Fields:** 16px on a touch screen whatever their classes say (an unlayered rule in index.css),
  so iOS never zooms into one. Search fields get `enterKeyHint="search"` and no autocorrect.
- **No** tap highlight, double-tap delay, text inflation or rubber-band at the page's edges.
- **Keyboard hints** (⌘K, J/K, ?) show only with `fine:`.

## Tables

Every data table is `Table` from `components/ui/table.tsx` (OrderLoop's, with shadcn's part names
kept: `TableHeader` is the `<thead>`, `TableHead` a column header, `TableRow`, `TableCell`,
`TableEmpty`; `Th`/`Td`/`Tr` are aliases).

- **Cells** are padded by the table (index.css, at zero specificity). `edge="card"` runs edge to
  edge inside a card, its outer columns inset 1rem; `edge="flush"` lines them up with the text of
  a padded panel.
- **Headers** are captions, `scope="col"`. A column without a name (row actions) still gets one for
  screen readers.
- **Figures** (`numeric`) are right-aligned, tabular and unbroken. Ids, API ids and keys are mono.
- **Status** in a cell is a badge (`StatusBadge`, or `ToneBadge` for another vocabulary), never
  coloured text alone.
- **Empty:** no rows at all is `Empty` in place of the table; a search that missed is a
  `TableEmpty` row.
- **Phones:** `stack="cards"` turns each row into a card, the first cell on its own line and the
  rest named by their `label`; `stack="rows"` leaves the row's layout to the caller (the entries
  list, whose rows lay out as a grid with their checkbox and actions). Either way the header stays
  for screen readers and the parts keep their table roles.
- **Long lists** (`sticky`) keep the header under the shell's header; the card clips with
  `overflow-clip`, never `overflow-hidden`.
- **Keyboard:** the entries list moves with J/K, opens with Enter and ticks with X (`EntriesTable`);
  the hint shows only with `fine:` from md.

## Screens

- **Overview** (`components/Dashboard.tsx`): what needs attention as cards (not yet published,
  coming up, agent proposals, live activity), then search, AI usage and recent agent runs.
- **Content:** the content types as cards (`PageHeader` with New content type); a content type's
  entries beside the list of types (from md); the entry editor: the title wraps, the status, version
  and save state sit under it, and the actions wrap beside it; below md the secondary actions fold
  into a ghost ⋯ menu ("More entry actions"). From lg the editor's panels sit beside the form, as
  OrderLoop's order page puts its panels beside the graph.
- **Releases, Workflows, Taxonomy, Media:** `PageHeader` with the page's one "New …" (a `Plus` and
  the noun), then cards or a stacked table. A media card's name is its control, stretched over the
  card, with the card's own actions above it.
- **Settings:** one page, its section nav beside the section (a grouped select on a phone); each
  section is cards and stacked tables. The install hint sits at the top of Connection.
- **Workflows list:** each workflow a muted Item in one card: its live version as the tile (a
  pencil while it is a draft never published), its name the link stretched over the item, then
  what it covers (content types), whether it gates publishing and its steps; Duplicate and Delete
  (in-place confirm) in the footer. "New workflow" is a form sheet (template or blank) and "Draft
  with AI" a dialog whose proposal is reviewed in a Confirmation before a draft is created.

## Screens that change shape

- **Workflow editor** (`routes/WorkflowEditor.tsx`, from OrderLoop's flow editor): at lg it builds,
  palette | canvas | inspector. On touch, a palette item is tapped in (dragging is offered only to
  a fine pointer: iPadOS drag is unreliable), node handles grow and carry a 32px target, and a
  connection snaps from 40px. Below lg it is review-only, saying so in place ("Building workflows
  needs a wider screen…"): the canvas, the checks and each step's settings show read-only, and
  nothing on screen can change the workflow. Every wire can also be made from the keyboard: a
  selected step's Connections list offers only targets that wouldn't close a cycle. A Loop's
  second input, `next`, is a hollow ink ring on the node's bottom edge, named under the outputs,
  and its back-edge is dashed ink labelled `next`: colour on the canvas is for status only (The
  One Meaning Rule); node categories colour only their icon (`--cat-*`). A selected node is an ink
  edge with the focus ring, never the link blue. A workflow too wide to read whole opens framed on
  its first loop or wait, never below 0.7 zoom; Fit view (⇧1) stops at the zoom that keeps a 13px
  label at 10px. Every canvas with a loop or a wait has **Jump to**. React Flow's credit stays, at
  caption size. Publish asks in place about the draft on screen (any edit withdraws the question)
  and, while the checks have errors, refuses and lists them instead.

## Elevation & Depth

Flat. A card sits on the page edged by a faint ring and no shadow; inside it, depth is tonal: tiles
are a muted step. Shadows are kept for what floats over the page.

### Shadow Vocabulary

- **Card** (`box-shadow: 0 0 0 1px color-mix(in oklch, var(--foreground) 10%, transparent)`): every
  panel (`card`), a ring rather than a shadow.
- **Raised segment** (`shadow-sm`): the chosen segment of a segmented control.
- **Float** (`shadow-float`): a control over a scrolling page (a phone's New entry, a toast). None
  in dark.
- **Overlay** (`shadow-overlay`): the sidebar opened over the page.

### Named Rules

**The No Nested Cards Rule.** Inside a card, group with tiles or rows, never another card.

## Motion

Quiet and exact. Things move only when state changes, and only to say what changed and where:
opacity, colour and a few pixels of travel.

- **Durations** (index.css, mirrored in `lib/motion.ts`, a test keeps them equal):
  `--motion-instant` 100ms (feedback, anything leaving), `--motion-move` 180ms (something appearing
  or changing state), `--motion-travel` 240ms (pages and panels).
- **Easing:** `ease-arrive` (`cubic-bezier(0.16,1,0.3,1)`) for arrivals, `ease-leave` for exits.
- **Arrival:** `animate-arrive`, a fade and a 4px rise, for a toast, a confirm or a new row
  (`useArrivals` decides what is new).
- **Pages** cross-fade with View Transitions while the header, the sidebar and the tab bar hold
  still.

**The Reduced Motion Rule.** With reduced motion nothing travels, but nothing that carries meaning
is lost: colours still change, arrivals and overlays fade without rising, and page changes happen
at once.

## Shapes

Generous and round. The radius base is 0.625rem on a multiplying scale: cards are 2xl, tiles xl,
one-line fields 4xl, text areas xl, menus 2xl. Buttons, one-line fields, badges, segmented controls
and icon buttons are pills. Hairlines divide rows inside a card; cards have no border.

**The Pill Rule.** Anything you press or that labels a status is fully round. Square corners are
for code and data blocks only.

## Components

- **Buttons** (`ui/button.tsx`): pills. Primary is an ink fill with paper text; outline is a rule
  over a faint `input` fill; ghost fills muted on hover; link is the work blue. Every size carries
  `hit-area`.
- **Fields** (`ui/input.tsx`, `ui/textarea.tsx`, `ui/native-select.tsx`): pills with an `input`
  hairline over an `input` fill. Focus: the `ring` edge and halo. Invalid: the destructive edge.
- **Segmented** (`ui/segmented.tsx`): a radio group drawn as a muted pill track; the chosen
  segment is raised on paper.
- **Card** (`ui/card.tsx`): `Card`, `CardHeader`, `CardTitle`, `CardDescription`, `CardAction`,
  `CardContent`, `CardFooter`. `Section` (`components/page.tsx`) is a Card with a section title, an
  optional description and action, and `flush` content under a rule.
- **Page** (`components/page.tsx`): `PageHeader` (the h1, an intro held to the measure, the page's
  actions), `Body`, `Section`, `Empty` (with an `icon` and `title` where the empty state is the
  news).
- **Item, Field, Kbd, Spinner, Badge, Skeleton, Separator, Breadcrumb, Tooltip, Sheet, Dropdown
  menu, Alert, Alert dialog** (`components/ui`): OrderLoop's radix-maia ports, unchanged but for
  import paths. Dialog, Select, Tabs, Checkbox and Avatar are contentworker's own, on the same
  tokens.
- **Status badge** (`components/status.tsx`): a pill tinted 11% in the status colour with a dot; an
  ending that went badly is ruled in the colour with a mark (✕ or undo) instead of tinted, so it
  reads apart without colour. `ToneBadge` for another vocabulary (a diff's change, a finding's
  severity); `StatusDot` alone where the word sits beside it.
- **Inline confirm** (`components/InlineConfirm.tsx`): an "are you sure?" where the action was,
  never a modal. The safe choice has focus, Escape backs out of the newest one, and focus goes back
  to what asked.
- **Toasts** (`lib/toast.tsx`): a card above the tab bar with a status dot and the words; an undo
  toast carries its Undo action.
- **Form sheet** (`components/form-sheet.tsx`): a list page's create form behind one "New …"
  button, in a sheet from the side (from the bottom on a phone).
- **Relative time** (`components/ago.tsx`): "3m ago" that stays true, the full time in its tooltip.
- **Copy and share** (`components/copy-button.tsx`, `components/share-button.tsx`): copy says so
  for a moment; share uses the system sheet where there is one.
- **Install hint** (`components/install-hint.tsx`): on an iPhone or iPad in Safari, in More and on
  Connection, until it's dismissed.
- **Rich text editor** (signature): TipTap styled as content, not chrome; entry and asset
  reference links in the work blue with dotted underlines; code in mono on muted.

## Installed

`public/manifest.webmanifest` and the apple-touch-icon put the admin on the Home Screen as its own
app (`standalone`). The icons are rendered from the mark by `apps/admin/scripts/icons.sh`, ink on
paper and opaque. `theme-color` follows the chosen theme (`public/theme.js`, a file so the CSP's
`script-src 'self'` allows it). There is no service worker: actions must reach the API.

## Do's and Don'ts

### Do

- **Do** keep text at 4.5:1 and focus edges at 3:1, in both themes, on the surface they sit on.
- **Do** take sizes from the theme (`text-ui`, `text-2xs`, `max-w-page`, `max-w-measure`).
- **Do** check a layout change with `pnpm --filter @contentworker/admin e2e` (the shell spec runs
  desktop and phone, light and dark, through axe).
- **Do** give a small control `hit-area` rather than growing it.
- **Do** put a phone's most frequent action within thumb reach: the tab bar, a bottom sheet.
- **Do** pair every status colour with words.

### Don't

- **Don't** fade the focus ring below 3:1, or remove the outline without drawing an edge.
- **Don't** put a status colour on something that isn't a status.
- **Don't** read `env(safe-area-inset-*)` directly, or hard-code the header or tab bar height.
- **Don't** set a field under 16px for touch, or show a keyboard shortcut to a finger.
- **Don't** recreate the legacy enterprise CMS admin: no crowded chrome, no nested settings mazes,
  no boxes-in-boxes.
- **Don't** import the SaaS-gradient look: no gradients, glassmorphism or marketing energy.
- **Don't** scatter sparkle icons or "AI" buttons; AI lives inside flows and, when it ships, in the
  one summonable assistant.
- **Don't** use coloured side-stripes as accents, or solid saturated fills for status.
- **Don't** make a person wait on motion: an action responds at once.
