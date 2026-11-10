# Live preview channel

Status: **built** (M6, "Live preview channel" in `ROADMAP.md`). The frontend half is built
(`@contentworker/sdk/live-preview`, see Extensions); so is the admin half (the entry editor's
Site view and the canvas, `apps/web/app/cms/lib/live-preview/host.ts`), Coworker's proposals
included (see "Coworker's proposals, as the admin sends them").
This file sits in `docs/specs/`, which the docs embed does not read (it takes `docs/*.md` only),
so MCP clients never mistake it for a description of shipped behaviour.

## What it is

The canvas editor frames the customer's real frontend and draws its overlays on top of it. The
live preview channel is how the two windows talk:

- **admin → frontend:** the editor's unsaved form state, as patches, so the page re-renders
  before anything is saved; which field or block is selected; Coworker's proposed blocks.
- **frontend → admin:** what was clicked or hovered, which entries the page shows, where it
  navigated, and whether a patch was applied.

It ships as `@contentworker/sdk/live-preview`. The frontend half runs in the customer's page
(wired in by `@contentworker/frontend`, or by hand for other frameworks). The admin half runs in
`apps/web`. It is a browser `postMessage` protocol between two windows: no Worker, route or
store change, and neither side can write content through it. Saving is the admin's ordinary
save.

## Terms

- **Admin**: the `apps/web` window that holds the iframe. Called the host in code.
- **Frontend**: the customer's page inside the iframe. Called the guest in code.
- **Session**: one connected page load. Navigating inside the iframe ends it, and the new
  page connects again.
- **Connect**: how a session starts: `connect.offer`, then `connect.accept` or
  `connect.reject`. (Never "handshake".)

## Connecting the preview

```
frontend                                   admin
   │  connect.offer {versions, capabilities, channel}
   │ ───────────────────────────────────────▶ │  check origin + source, pick a version
   │                                          │
   │  connect.accept {version, capabilities}  │  or connect.reject {reason, versions}
   │ ◀─────────────────────────────────────── │
   │  … session messages, all stamped {v, channel} …
```

1. The admin builds the iframe URL from the content type's preview URL template, adds a preview
   token for the entry (the existing per-entry preview tokens), and frames it.
2. When the page loads, the frontend half checks that it is framed and that
   `connectPreview({ adminOrigin })` was configured. If either is missing, it does nothing: a
   page that isn't being edited behaves exactly as it does today.
3. It generates a random `channel` (128 bits from `crypto.getRandomValues`, base64url) and
   posts `connect.offer` to `window.parent`, targeted at `adminOrigin` (never `'*'`).
4. The admin checks the offer (below), picks the highest version both sides speak, narrows the
   capabilities, and answers `connect.accept`. From then on the admin pins `channel`, the
   iframe's `contentWindow` and its origin for the rest of the session.
5. If no version is shared, the admin answers `connect.reject { reason: 'unsupported-version',
   versions }`. The frontend logs one actionable console error naming both version lists, and
   the admin shows "This site's ContentWorker SDK is too old (or too new) for live preview"
   instead of waiting on a timeout.
6. The frontend resends the offer up to three times, 1 s apart. If nothing answers, the admin
   reports "This site isn't connected for live preview" with a link to the setup screen.

### The three checks

Every message, in both directions, is dropped unless all three hold. Each check catches
something the other two miss.

| Check | Admin side | Frontend side |
| --- | --- | --- |
| Origin | `event.origin` equals the origin of the URL the admin framed (updated on `navigated`, see below) | `event.origin` equals the configured `adminOrigin` |
| Sender | `event.source === iframe.contentWindow` | `event.source === window.parent` |
| Channel | `data.channel` equals the pinned channel (on an offer: new, well formed) | `data.channel` equals its own channel |

The checks run in one function per side (`acceptMessage`), and every handler goes through it.
After the checks, the message shape is validated (below), and only then dispatched.

### Version negotiation

- The protocol version is an integer, `v`, stamped on every message.
- The frontend offers every version it can speak, newest first. The admin answers with one of
  them and stamps it on everything after.
- **The admin never drops an old version without notice.** Customers install the SDK into their
  own sites and update it on their own schedule, so the admin must keep speaking every version
  a supported SDK release offers. Removing one is a breaking change, called out in the
  changelog, and the admin's `SUPPORTED_VERSIONS` list carries a comment naming the last SDK
  release that needs each entry.
- An additive change (a new optional field, or a new message kind both sides can ignore) does
  **not** bump the version. A new message kind that one side must understand does, and
  is sent only on sessions that negotiated that version.
- Unknown message kinds are ignored, not errors, so a newer frontend can talk to an older admin
  at their shared version.

### Capabilities

The offer declares what the page allows. They are fixed at connect time: there is no runtime
grant.

| Capability | Lets the admin |
| --- | --- |
| `select` | Receive clicks and hovers on marked elements, and send `select` to outline one |
| `patch.fields` | Send unsaved field values for entries on the page |
| `patch.blocks` | Send key-addressed block operations (create, update, move, remove) |
| `proposals` | Send Coworker's proposed blocks, rendered as ghosts (see `patch.blocks`) |
| `scroll` | Ask the page to scroll a marked element into view |

`connect.accept` echoes the subset the admin will use: the offer, narrowed by the space's
admin config (for example a role that may only select). The admin can narrow, never widen: a
capability the page did not offer is never used, and the frontend refuses any message that
needs a capability missing from the accepted set.

## Messages

Every message is `{ v, channel, kind, ... }`. A message that fails its schema is dropped and
counted (a debug counter on each side). It is never partially applied.

### Admin → frontend

- `connect.accept { version, capabilities }` and `connect.reject { reason, versions }`.
- `entry.state { rev, entryId, locale, fields }`: the whole unsaved state of one entry. Sent
  right after connect, and after any gap the admin can't fill with patches.
- `entry.patch { rev, entryId, locale, fields }`: changed top-level field values since `rev - 1`.
- `blocks.patch { rev, entryId, locale, field, ops }`: the same key-addressed operations as the
  `patchBlocks` use-case (M6 "Layout patches"), so the editor and agents share one vocabulary.
  An op may be `proposed: true`, which the frontend renders as a ghost block that is never
  part of saved state.
- `select { ref | null }` and `scroll { ref }`.

### Frontend → admin

- `connect.offer { versions, capabilities, channel, sdk: { name, version } }`.
- `page { url, entries: [{ entryId, contentType, locale }] }`: what this page renders. It
  tells the admin which entries' state to send.
- `navigated { url }`: sent on navigation. The new page then connects again with a new
  channel. The admin accepts it only if the URL matches a preview URL template of this space.
- `pointer { kind: 'hover' | 'click', ref, rect }`: a marked element. `rect` is in iframe
  viewport coordinates, so the admin can draw its outline outside the page.
- `applied { rev }` and `failed { rev, reason }`: whether a patch rendered.

### Content values

Values cross the channel exactly as the Management API types them: rich text as a
`RichTextDocument`, blocks as `{ _type, _key, ... }`, references as links. No message carries
HTML or Markdown. The frontend renders from the same structures it gets from Delivery or
Preview, with the unsaved values layered on top.

### Ordering and gaps

`rev` increases by one per entry per session. The frontend applies a patch only when its `rev`
is exactly one more than the last it applied for that entry. Otherwise it replies
`failed { reason: 'gap' }` and the admin sends a fresh `entry.state`. A reload or navigation
starts from `entry.state` again, never by replaying patches.

## Content refs inside blocks

Clicks map back to fields through the existing `data-cw-ref` attribute
(`packages/sdk/core/src/content-ref.ts`), which today names one top-level field. Blocks need a
path. The `field` part of a ref becomes a path, using the same notation as `blocks.ts`, with
the block's `_key` in brackets: `title`, `body[0192f…].heading`, `body[0192f…].ctas[0192e…].label`.

This stays compatible in both directions. A ref is still six parts, so an older parser reads a
path as a field name, and `adminEditUrl` passes it through as `?field=`, where the entry
form falls back to the top-level field before the first `[`. A key, not an index, names each
block, so a path still points at the same block after a reorder.

## Untrusted input

- **The admin treats every frontend message as untrusted.** A ref must name an entry the page
  reported in `page` and the signed-in person may read. Otherwise it is dropped. Selection only
  moves focus in the admin. No frontend message saves, publishes or calls a use-case.
- **Page text is data, not instructions.** If Coworker later reads what the page reports (for
  example labels in `page`), it goes into the prompt as quoted, untrusted context, under the
  same rules as other content.
- **No styling crosses as CSS.** Token props are enums: the admin sends a token name
  (`"spacing.lg"`, `"tone.brand"`), the frontend resolves it from the block manifest, and drops
  a value that isn't in the manifest. As a second line, any value written into a CSS custom
  property passes `isSafeTokenValue`, which rejects `url(`, `@import`, `expression(`,
  `javascript:`, `<`, `>`, `\` and any function call except `var`, `calc`, `clamp`, `min`,
  `max`, `rgb`, `hsl`, `oklch`. It rejects the whole value, never escapes part of it.
- **Only the admin may frame the preview.** The frontend runtime sends
  `Content-Security-Policy: frame-ancestors <adminOrigin>` on preview responses (those carrying
  a preview token), so another site can't frame a customer's draft page.
- **Origins must differ.** `connectPreview` refuses an `adminOrigin` equal to the page's own
  origin. The iframe is sandboxed with `allow-scripts allow-same-origin allow-forms
  allow-popups`. `allow-same-origin` grants the frontend only its own origin (it needs its own
  cookies and storage), which is safe only because that origin is never the admin's.
- **No remote control.** The channel has no way to run script, read the DOM, take screenshots or
  trigger clicks in the page. Coworker changes the page only through `blocks.patch` proposals.

## Page-side API

```ts
import { connectPreview } from '@contentworker/sdk/live-preview';

const preview = connectPreview({
  adminOrigin: 'https://admin.example.com',
  capabilities: ['select', 'patch.fields', 'patch.blocks', 'proposals', 'scroll'],
  onState(entryId, locale, fields) { /* re-render with these values */ },
});

preview.on('select', (ref) => { /* … */ });
preview.emit('page', { url: location.href, entries });
preview.close();
```

- `connectPreview` returns a no-op handle when the page isn't framed or isn't configured, so a
  site can call it on every page.
- `@contentworker/frontend` wires it in for blocks it renders. A site only sets `adminOrigin`,
  which the "connect a frontend" screen prints with the delivery key.
- When connected, `mountInlineEditor` (`inline-edit.ts`) is driven by the channel. Its
  toggle is hidden, the admin turns editing on and off, and clicks go to `pointer` instead of
  opening a new tab. The overlay draws nothing in the page, since the admin draws the outline.
- Before the page unloads, a final `navigated` is posted. If the parent is gone, nothing is
  retried: the next page's `connect.offer` is the recovery.

## Where the code goes

| Part | Location |
| --- | --- |
| Message types, schemas, `acceptMessage`, version list, `isSafeTokenValue` | `packages/sdk/core/src/live-preview/` |
| Frontend half (`connectPreview`) | same, exported as the `@contentworker/sdk/live-preview` subpath (`packages/sdk/sdk`: exports, `src/`, `tsup.config.ts`, `scripts/types.ts`, subpath test) |
| Admin half (`usePreviewChannel`, the framed canvas) | `apps/web/app/cms/...`, importing the protocol from `@contentworker/sdk-core` (`workspace:*`) so both sides share one definition |
| Ref paths | `content-ref.ts` (format and parse helpers for paths) |
| Runtime wiring and `frame-ancestors` | `contentworker/site` (`@contentworker/frontend`) |
| `blocks.patch` ops | shared with the `patchBlocks` use-case, which is exposed over HTTP and MCP (M6 "Layout patches") |

The channel adds no use-case of its own: it moves unsaved form state and focus between two
windows. Every change it previews is saved through the existing entry update, and agents get
the same edits through `patchBlocks` over HTTP and MCP.

## Test plan

- **Checks** (`sdk-core`, node): a message with the wrong origin, the wrong sender, the wrong
  channel, a missing or malformed channel, or an unknown version is dropped, on both sides.
  Table-driven, one row per factor, so removing a check fails a named test.
- **Negotiation**: the matrix of frontend offers × admin version lists, covering a shared version, no
  shared version (reject with both lists), unknown versions in the offer, and an empty offer.
- **Capabilities**: the admin never sends a message needing a capability that wasn't accepted,
  and the frontend refuses one that arrives anyway.
- **Ordering**: in-order patches apply, a gap answers `failed: gap`, and `entry.state` resets.
- **Schemas**: fuzzed and malformed messages are dropped whole. Values are typed structures. A
  string of HTML in a rich-text field fails validation.
- **Token values**: `isSafeTokenValue` accepts the allowed functions and rejects every listed
  pattern, including nested and mixed-case forms (`URL(`, `u\rl(`).
- **Refs**: path refs round-trip. An old six-part ref still parses. `adminEditUrl` with a path
  opens the top-level field.
- **Two windows** (jsdom): a host and a guest wired through real `MessageEvent`s, from connect to
  patch to `applied`.
- **End to end** (Playwright, `apps/web/e2e`): the admin on one origin frames a fixture frontend
  on another. It connects, a typed heading appears in the frame before saving, clicking the
  heading focuses the field, and an SDK fixture that offers only an unsupported version shows
  the reject message. Plus an axe pass on the canvas states.

## Out of scope

The canvas UI (toolbox, seams, dock, inspector, undo), the `patchBlocks` use-case itself, block
renderers, and per-breakpoint overrides each have their own M6 item. This spec only fixes the
channel they use.

## Extensions

Additive, so they need no version bump (see "Version negotiation"): optional fields and message
kinds either side may ignore. The frontend half in `@contentworker/sdk/live-preview` speaks all of
them; an admin that doesn't simply never sends or reads them.

| Extension | What it adds |
| --- | --- |
| `layout` capability and `layout` message | Frontend → admin: `{ blocks: [{ ref, rect }], slots: [{ ref, rect, gaps }], fields: [{ ref, rect }], scroll, viewport, docHeight, truncated? }`, the geometry the canvas editor draws seams (insertion points) from. A slot is the element marked `data-cw-slot` with the slot's ref (`body`, `body[<key>].items`); each gap is `{ index, rect, axis, after?, before? }`, naming the blocks on either side by `_key`. Sent on change, at most once an animation frame. Fitted to the message limit, on-screen boxes first; `truncated: true` when some were left out. At most 2,000 of each list and 4,000 gaps. |
| `align` and `inset` on `scroll` | Admin → frontend: where the element lands, `center` (the default) or `start` / `end`, kept `inset` CSS pixels clear of that edge: the canvas keeps a chosen seam out from under its dock. A page that ignores them centres the element, as before; a value outside the list, or an inset that isn't a number from 0 to 4,000, drops the message. |
| `editing { on }` | Admin → frontend, needs `select`: turns in-page editing (and the inline editor) on or off. On when a session connects with `select`. |
| `pointer` with `ref` and `rect` `null` | A hover that left every marked element, so the admin can clear its outline. |
| `entryId` on `applied` and `failed` | `rev` counts per entry, so the acknowledgement names the entry. |
| `failed` reasons `invalid`, `conflict`, `render` | Beside `gap`: a patch or state that failed its schema (answered when its `entryId` and `rev` are readable; a state that fails is not resent, since it would fail again: the admin says the entry can't be previewed), block ops the page couldn't place, and an `onState` that threw. Each is answered, like `gap`, with a fresh `entry.state`. `invalid` and `conflict` leave the entry's `rev` where it was, so no later patch lands on stale fields; after `render` the patch stays applied (its `rev` counts) and nothing is acknowledged until a later render succeeds, whose `applied { rev }` covers every rev up to it. |
| `disconnect` event | `preview.on('disconnect')`: the session ended (client-side navigation) and the page is offering again on a new channel; every entry's unsaved state is gone. The page reports `page` again to the new session. |
| `view` argument to `onState` | `(entryId, locale, fields, view)`: `fields` stays the unsaved state without proposals; `view.withProposals` is what to render and `view.ghosts` (`inserted`, `changed`, `removed`) names the ghost blocks by `_key`. A proposed op must name every block it brings by `_key` (a proposed insert with a keyless block anywhere in its slots, or a proposed `duplicate`, is `invalid`), so the admin can always name a ghost; `ref`s among one message's proposals resolve to those keys. A proposed `remove` of a proposed block takes it back, with everything proposed in or beside it; a fresh `entry.state` clears all proposals. An entry holds at most 200, since each render lays every one over the fields (past that, `conflict`). `proposals` is offered only with `patch.blocks`. |

Behaviour the spec leaves open, as the frontend implements it:

- **A fresh offer replaces the session.** A page that calls `connectPreview` again in one load (a
  remount, React's development double effect) offers a new channel from the same window. The admin
  should take a well-formed offer from the pinned `contentWindow` as replacing the session, as it
  does after `navigated`. Pages should keep one connection: the frontend reports each connection
  to the inline editor separately, so one closing doesn't wake the overlay while another is live.
- **Ref paths escape keys.** A block `_key` may be any stored string, so a path writes its `[`, `]`
  and `%` as `%5B`, `%5D` and `%25`; any key round-trips, and keys without them read as before.
- **`isSafeTokenValue` also refuses `&`, `"`, `'`, a backtick, `;`, `{`, `}`, comments and control
  characters**, so a value can't end or rewrite an HTML attribute when a renderer builds `style`
  as text (`ur&#108(` would decode to `url(`). Write values through `style.setProperty` or a
  framework's style object.
- **`isRichTextDocument` checks the whole tree**: every node an object with a `nodeType`, every
  `content` a list of nodes, every text node's `value` a string.
- **Parsing is bounded before anything is measured**: no list longer than 10,000 and no holes in
  one, at most 200,000 values, plain objects and lists only, then the byte cap. An entry beyond
  those can't be previewed. A 100-byte message holding a list of a
  hundred million holes, or a typed array, is refused at once.

### Coworker's proposals, as the admin sends them

- **When.** Capabilities are fixed at connect, so the admin accepts `proposals` (offered with
  `patch.blocks`) for a person who may write content while Coworker is on, and uses it only while a
  Coworker card proposing a block patch for the entry waits for an answer (and, after Confirm, until
  the save lands). With Coworker off, or for a role that only selects, it is never accepted.
- **What.** The ops are the card's dry run's `applied` ops (`POST …/entries/blocks/validate`), in the
  locale the page shows, never the model's own: every block they bring is keyed, so each ghost has
  a name. A card the dry run refuses (a locked region, the block config, another version) shows no
  ghosts. Inserts, updates, moves and removes only; a patch with anything else is reviewed in the
  card alone.
- **Taking back.** Not now, a failed save, or a newer request replacing the card takes the ghosts
  back with a fresh `entry.state`. Every whole state is followed by the proposal again while it
  waits, so a gap, a reload or a new session keeps showing it. A `failed` on a proposal's rev (other
  than `gap`) drops the proposal, so it isn't resent to fail again, and the admin says the page
  couldn't show it.
- **Confirm** saves through the card, as ever (the dry-run-checked call with its `expectedVersion`);
  then the editor reads the entry again and sends it whole. Nothing on the channel saves.
- **Untrusted.** A proposal's values are a model's, unconfirmed, and may have been shaped by
  content it read: a page renders them as it renders any field (as text, never as markup).
- **Marked.** The admin outlines each ghost the page reports in its `layout` in `ai` (the brand),
  dashed, with "Proposed" (or "Proposed change", "Proposed removal") in words; Layers lists proposed
  blocks after their slot's blocks, not as tree items.

Two wire details differ from the text above, because it can't be written as stated: `pointer`'s
hover/click field travels as `pointer`, since the envelope's `kind` already holds `'pointer'`; and
`entry.state` and `entry.patch` carry one locale's values (not locale-keyed), as the message names
the locale.

## Decisions

The owner settled these on 2026-11-07; the first implementation already follows them.

1. **Allowed frontend origins** are the origins of the space's preview URL templates. The admin
   pins the frontend's origin from the framed preview URL's template, and follows `navigated`
   only to a URL that matches one of the space's templates. There is no separate origin list on
   the "connect a frontend" screen.
2. **What the page reports** is the entry being edited and its direct references, at most 50
   (`PAGE_REPORT_LIMIT`), the first the site lists. The admin accepts up to 200
   (`MAX_PAGE_ENTRIES`), because sites on `@contentworker/sdk` 0.3.0 send that many; a wider set
   can come later without a version bump.
3. **Frame height is fixed:** the canvas scrolls inside the frame and offers viewport-width
   presets for breakpoints. There is no `resize` message.
