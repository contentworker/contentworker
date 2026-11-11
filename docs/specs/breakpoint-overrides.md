# Per-breakpoint overrides

Status: **decided** 2026-11-10, not built (M6, "Layout model" in `ROADMAP.md`). Overrides sit
beside the props in a `_responsive` key, and the owner took all five proposals under Decisions.
This file sits in `docs/specs/`, which the docs embed does not read (it takes `docs/*.md` only),
so MCP clients never mistake it for a description of shipped behaviour.

## What it is

A per-breakpoint override gives a block's token prop a different value from some screen width
up: a hero that is `size: md` on phones and `size: xl` from `lg`, a grid with `columns: 1` on
phones and `columns: 3` from `md`, or a banner hidden on phones. Editors set it on the canvas at
the width they are looking at; the frontend applies it with its own CSS.

It answers "this block looks right on desktop but needs a different setting on a phone" without
a second block, a second entry, or a raw CSS prop. Styling stays design tokens.

## What is already in place

- **Token props.** A block's style props are Symbols (or Integers, Numbers) with
  `validations.in`, declared in code (`contentworker blocks push`) and stored as bare scalars on
  the block: `{ "_type": "hero", "_key": "…", "size": "md" }`. Validation checks each against its
  options; a JSON prop or a raw `style`/`className` prop is refused.
- **The canvas** has width presets (desktop 1280, tablet 768, phone 390,
  `apps/web/app/cms/lib/live-preview/frame-channel.ts`) and the Inspector's Look tab sets token
  props through `update` block-patch ops.
- **Renderers** (`@contentworker/sdk` `resolveBlocks`, React and Vue `<Blocks>`) pass the stored
  block to the customer's component as it is.
- **No notion of breakpoints** exists in the domain, the manifest or the SDK.

## The model

### Breakpoints are declared in code

The catalog push gains a top-level `breakpoints` list: the site's CSS breakpoints, mobile-first.

```json
{
  "breakpoints": [
    { "id": "md", "name": "Tablet", "minWidth": 768 },
    { "id": "lg", "name": "Desktop", "minWidth": 1280 }
  ],
  "blocks": [ … ],
  "targets": [ … ]
}
```

- The base value (the bare prop) applies below the first breakpoint; each breakpoint applies from
  its `minWidth` up until the next one overrides it.
- `id` is a letter, then letters, digits or `_`, and never `base`. `minWidth` is a whole number of
  CSS pixels, 1 to 10,000, strictly increasing in list order. At most 6 breakpoints.
- Breakpoints belong to the catalog because they are the site's CSS. The admin never adds one;
  the block config can't widen or narrow them.

### A block opts its props in

```json
{ "id": "hero", "name": "Hero", "responsive": ["size", "align", "hidden"], "fields": [ … ] }
```

`responsive` names the block's props that take overrides. Each must be a top-level prop of the
block that is a token (Symbol, Integer or Number with `validations.in`) or a Boolean. Anything else
is refused at push, with its place in the file (`blocks[hero].responsive[1]`). A block without
`responsive` takes no overrides. The push carries `responsive` onto the block's variant
(`ComponentVariant.responsive`), so validation needs only the content type.

### Stored beside the props

```json
{
  "_type": "hero",
  "_key": "…",
  "size": "md",
  "_responsive": { "lg": { "size": "xl" }, "md": { "hidden": false } }
}
```

- `_responsive` maps a breakpoint id to the props it overrides. Each value passes the same check
  as the prop itself (its `in`, its type). Not localized: overrides are layout, like `_key`.
- The bare prop is the base and stays required as before, so a frontend that knows nothing of
  breakpoints renders the base and keeps working. That is why the value is never turned into an
  object (decided 2026-11-10).
- An empty map or an empty breakpoint is removed on save; a breakpoint whose values all equal what
  it inherits is kept (the editor said so on purpose).
- Delivery serves `_responsive` as stored, REST and GraphQL alike. It is a new key that only
  appears on blocks someone gave an override, so no existing response changes.

### Stale overrides

A push can remove a breakpoint, or a prop from `responsive`, while stored blocks still carry
overrides for it. Those overrides are **stale**:

- A save never fails over them: they are dropped from the block on its entry's next save, the
  way a renamed block takes its new id.
- Reads serve them as stored until then; the renderer helper ignores ids the catalog doesn't
  declare.
- The push (and its dry run) reports how many blocks carry overrides it makes stale, by
  breakpoint and prop, as it reports block usage for removed blocks. It does not refuse the push.

## Enforcement

- **Validation** (`validate.ts`): `_responsive` is allowed on a block whose variant has
  `responsive`; each key must be a declared breakpoint (or stale, see above), each prop in the
  variant's list, each value valid for that prop. Any other `_`-prefixed key is refused as now.
- **Block patch**: an `update` op may `set` or `unset` `_responsive` as a whole; its inverse is the
  old map. Live preview's `blocks.patch` carries it unchanged (no protocol version bump).
- **Locks**: a frozen region (`freeze: true`) refuses `_responsive` changes like any content
  change; a structure-only lock leaves them open.
- **Block config**: untouched. It narrows which blocks go where, not their props.
- **Copies** (snapshots, clones, promotions, version restores) carry `_responsive` with the block;
  promotions and compare report a changed `breakpoints` list as a catalog change.

## Surfaces

- **REST / MCP / SDK**: no new endpoints. The push body, `GET /blocks/catalog` and
  `blocks_catalog_get` carry `breakpoints` and each block's `responsive`; entries carry
  `_responsive`; `patchBlocks` and `entries_blocks_patch` set it.
- **GraphQL**: a block type with responsive props gains a `responsive` field of type
  `<BlockType>Responsive`, with one nullable field per breakpoint holding the overridable props.
  Additive; no type is renamed.
- **Codegen**: each block type gets `_responsive?: { readonly md?: { readonly size?: 'sm' | … } }`
  and the module exports `breakpoints`.
- **Renderers**: `resolveBlocks` gives each resolved block `responsive` (the declared overrides,
  stale ids dropped) and the SDK exports `responsiveProp(block, 'size', catalog)`, which answers
  `{ base: 'md', lg: 'xl' }`. Applying it is the frontend's: a class per breakpoint
  (`size-md lg:size-xl`), a CSS custom property per media query, or a container query. A
  server-rendered page can't know the screen width, so the SDK never picks one value for it.
- **Coworker**: may set overrides through `patchBlocks`; layout-aware generation doesn't produce
  them yet.

## The canvas

- **Width presets come from the catalog** when it declares breakpoints: one preset per breakpoint
  at its `minWidth`, plus Base at 390. Without breakpoints the presets stay as they are.
- **The Look tab edits the breakpoint in view.** At Base it sets the bare prop, as now. At a
  breakpoint, a responsive prop shows the value it inherits (and from where: "From Base", "From
  Tablet") until the editor sets one; a set override is marked, with **Reset** to inherit again.
  A prop not in `responsive` reads "Same at every width" and stays editable only at Base.
- **Layers** marks a block that carries overrides; the entry form shows them read-only under the
  block's props, with a link to the canvas.
- Undo, ghosts and save work as for any `update` op.

## Decisions

Made by the owner on 2026-11-10, all as proposed (and the storage shape above):

1. **Breakpoints are declared in code only**, on the catalog push. The admin shows them, never
   edits them.
2. **Mobile-first `minWidth`**: the bare prop is the base, overrides apply from a width up.
3. **Which props**: tokens (`in`) and Booleans a block lists in `responsive`. Not text, numbers
   without `in`, links, assets or slots.
4. **Stale overrides never block a save**: dropped on the next save, reported by the push.
5. **The SDK hands the frontend every value**, never one value for "the current width".

## Out of scope

- Overrides of content (text, images per breakpoint): a different layout is a different block.
- Hiding or reordering a slot's blocks per breakpoint beyond a block's own Boolean prop.
- Container queries in the canvas: the presets resize the frame, nothing else.
- Generating overrides in layout-aware generation.
