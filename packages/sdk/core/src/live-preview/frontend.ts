/**
 * The frontend half of the live preview channel (docs/specs/live-preview-channel.md): what a
 * customer's page runs so the admin can frame it, send it the editor's unsaved state and see each
 * edit rendered before anything is saved.
 *
 * Framework-free. It holds each entry's unsaved fields, applies the admin's patches in order and
 * hands the result to `onState`, so the host app re-renders however it renders. It never draws:
 * the admin outlines what is selected or hovered, outside the frame, from the boxes `pointer` (and
 * the `layout` extension) report. The frame keeps its own scrolling.
 *
 * Inert unless the page is framed and an `adminOrigin` is configured, so a site can call it on
 * every page. Listens only to the admin origin, in the parent window, on its own channel; never
 * evaluates anything a message carries; writes nothing back but acknowledgements and focus.
 */
import { blockKeyOf, type ContentRef, formatContentRef, parseContentRef } from '../content-ref.js';
import { fitGeometry, gapsOf, type LayoutBody, rectOf } from './layout.js';
import { setPreviewLink } from './link.js';
import { applyLivePatch, everyBlockKeyed, type LivePatchOp } from './patch.js';
import {
  type AdminMessage,
  acceptMessage,
  type BlocksPatchMessage,
  type Capability,
  capabilityAllows,
  type EntryPatchMessage,
  type FailReason,
  type FrontendMessage,
  isPreviewUrl,
  isRecord,
  isRichTextDocument,
  isWireId,
  isWireRef,
  type LiveBlockBox,
  type LiveFieldBox,
  type LiveFields,
  type LiveRect,
  type LiveSlotBox,
  MAX_MESSAGE_BYTES,
  narrowCapabilities,
  newChannel,
  OFFERED_VERSIONS,
  PAGE_REPORT_LIMIT,
  type PageMessage,
  parseAdminMessage,
} from './protocol.js';

/** The SDK release this runtime ships in, sent in `connect.offer`. Kept equal to @contentworker/sdk's. */
export const LIVE_PREVIEW_SDK_VERSION = '0.5.0';

const REF_ATTRIBUTE = 'data-cw-ref';
/** The attribute on the element directly holding a slot's blocks; it holds the slot's ref. */
export const SLOT_ATTRIBUTE = 'data-cw-slot';
const MAX_ATTRIBUTE = 2048;
/** How often, and how far apart, the offer is sent before the page stops waiting. */
const OFFER_ATTEMPTS = 4;
const OFFER_INTERVAL_MS = 1000;
/**
 * The most proposed ops one entry holds; past it, the admin sends the state again. Each render lays
 * every proposal over the fields one by one, so this bounds the cost of a render, not just memory.
 */
const MAX_PROPOSALS = 200;
/** The most elements of each kind measured per frame for `layout`; what is sent is fitted from them. */
const MAX_MEASURED = 10_000;

/** Spread onto an element rendering one field or block: `<h2 {...refAttrs(ref)}>`. */
export function refAttrs(ref: ContentRef): { readonly 'data-cw-ref': string } {
  return { [REF_ATTRIBUTE]: formatContentRef(ref) } as { readonly 'data-cw-ref': string };
}

/**
 * Spread onto the element directly holding a slot's blocks (the `layout` extension): the ref's
 * field path names the slot, `body` at the top or `body[<key>].items` inside a block.
 */
export function slotAttrs(ref: ContentRef): { readonly 'data-cw-slot': string } {
  return { [SLOT_ATTRIBUTE]: formatContentRef(ref) } as { readonly 'data-cw-slot': string };
}

/** Coworker's proposals for one entry, layered over its fields for rendering. */
export interface LiveView {
  /** The last rev these fields include. */
  readonly rev: number;
  /**
   * The fields with the proposals applied: render these. The same object as `fields` when there
   * are none. Never saved: `fields` is the editor's unsaved state, without them.
   */
  readonly withProposals: LiveFields;
  /** Blocks to render as ghosts, by `_key`: proposed new, proposed changed, proposed removed. */
  readonly ghosts: {
    readonly inserted: readonly string[];
    readonly changed: readonly string[];
    /** Still in `withProposals`, so the page can show what would go. */
    readonly removed: readonly string[];
  };
}

export interface ConnectPreviewOptions {
  /**
   * The admin's exact origin, e.g. `https://admin.example.com`. Without it the page isn't
   * configured for live preview and nothing happens. Messages from any other origin are ignored,
   * and the page posts to this one only, never `*`. Must differ from the page's own origin.
   */
  readonly adminOrigin?: string;
  /** What the page lets the admin do; fixed for the session. */
  readonly capabilities: readonly Capability[];
  /**
   * Re-render one entry with its unsaved values (one locale's, not locale-keyed), and Coworker's
   * proposals on top in `view`. May return a promise: the admin hears `applied` when it settles,
   * `failed` when it throws.
   */
  readonly onState: (
    entryId: string,
    locale: string,
    fields: LiveFields,
    view: LiveView,
  ) => void | Promise<void>;
  /** Mints a `_key` for a block a patch brings without one. Defaults to a random UUID. */
  readonly newKey?: () => string;
  /** The window to run in. Defaults to the global one. */
  readonly window?: Window;
}

export interface PreviewEvents {
  readonly connect: { readonly version: number; readonly capabilities: readonly Capability[] };
  readonly reject: { readonly reason: string; readonly versions: readonly number[] };
  /** The admin selected a ref, or cleared the selection (`null`). */
  readonly select: string | null;
  /** The admin scrolled a ref into view. */
  readonly scroll: string;
  /** The admin turned editing on or off. */
  readonly editing: boolean;
  /**
   * The session ended (client-side navigation): the page offers again on a new channel, and
   * reports what it renders again once connected. Every entry's unsaved state is gone.
   */
  readonly disconnect: undefined;
}

export interface PreviewConnection {
  /** Framed and configured: the page is trying to connect, or has. */
  readonly active: boolean;
  readonly connected: boolean;
  readonly version: number | undefined;
  /** The capabilities the admin accepted; empty until connected. */
  readonly capabilities: readonly Capability[];
  /** Messages dropped for failing their schema or capability (a debug counter). */
  readonly dropped: number;
  on<K extends keyof PreviewEvents>(
    kind: K,
    handler: (value: PreviewEvents[K]) => void,
  ): () => void;
  /** Tells the admin what the page renders, or that it navigated (client-side routing). */
  emit(kind: 'page', body: Omit<PageMessage, 'v' | 'channel' | 'kind'>): void;
  emit(kind: 'navigated', body: { readonly url: string }): void;
  /** Measures `layout` again on the next frame, for changes the observers can't see. */
  refresh(): void;
  /** Ends the session and removes every listener, observer and timer. */
  close(): void;
}

const INERT: PreviewConnection = {
  active: false,
  connected: false,
  version: undefined,
  capabilities: [],
  dropped: 0,
  on: () => () => {},
  emit() {},
  refresh() {},
  close() {},
};

interface EntryRecord {
  locale: string;
  rev: number;
  fields: LiveFields;
  /** Proposed ops, by blocks field, in arrival order, every key given and no ref left. */
  proposals: { field: string; op: LivePatchOp }[];
  dirty: boolean;
}

type Outbound = FrontendMessage extends infer M
  ? M extends FrontendMessage
    ? Omit<M, 'v' | 'channel'>
    : never
  : never;

/**
 * Connects the page to the admin that framed it, or returns a no-op handle when it isn't framed
 * or has no `adminOrigin`. Call `close()` to stop.
 */
export function connectPreview(options: ConnectPreviewOptions): PreviewConnection {
  const win = options.window ?? (globalThis.window as Window | undefined);
  if (!win?.document || !options.adminOrigin) return INERT;
  const parent = win.parent;
  if (!parent || parent === win) return INERT;
  // Checked only when framed and configured, so a mistake breaks previews, not page views.
  const adminOrigin = checkOrigin(options.adminOrigin, win.location.origin);
  const offered = narrowCapabilities(options.capabilities);
  const doc = win.document;
  const newKey = options.newKey ?? (() => win.crypto.randomUUID());

  let closed = false;
  let channel = '';
  let version: number | undefined;
  let connected = false;
  let accepted: Capability[] = [];
  let editing = false;
  let dropped = 0;
  let attempts = 0;
  let timer: number | undefined;
  let rejected = false;
  let lastPage: Omit<PageMessage, 'v' | 'channel' | 'kind'> | undefined;
  let leavingTo: string | undefined;
  const entries = new Map<string, EntryRecord>();
  /** Entries with an `onState` running: one at a time per entry, across a fresh state too. */
  const rendering = new Set<string>();
  /** This connection, in the link the inline editor reads (one per `connectPreview`). */
  const self = Symbol('live preview connection');
  const handlers = new Map<keyof PreviewEvents, Set<(value: never) => void>>();

  const fire = <K extends keyof PreviewEvents>(kind: K, value: PreviewEvents[K]): void => {
    for (const handler of handlers.get(kind) ?? [])
      (handler as (v: PreviewEvents[K]) => void)(value);
  };
  const post = (message: Outbound): void => {
    if (closed) return;
    parent.postMessage({ v: version ?? OFFERED_VERSIONS[0], channel, ...message }, adminOrigin);
  };
  const link = (): void => setPreviewLink(self, { connected, editing: connected && editing });
  const has = (c: Capability) => accepted.includes(c);

  // --- connect ----------------------------------------------------------------------

  const sendOffer = (): void => {
    if (closed || connected) return;
    attempts += 1;
    post({
      kind: 'connect.offer',
      versions: [...OFFERED_VERSIONS],
      capabilities: offered,
      sdk: { name: '@contentworker/sdk', version: LIVE_PREVIEW_SDK_VERSION },
    });
    // Up to three resends, a second apart; after that the admin says the site isn't connected.
    if (attempts < OFFER_ATTEMPTS) timer = win.setTimeout(sendOffer, OFFER_INTERVAL_MS);
  };

  const connect = (): void => {
    if (timer !== undefined) win.clearTimeout(timer);
    const was = connected;
    channel = newChannel(win.crypto);
    version = undefined;
    connected = false;
    accepted = [];
    attempts = 0;
    rejected = false;
    entries.clear();
    // A new session hears everything again, even what didn't change.
    lastLayout = '';
    hovered = null;
    link();
    if (was) fire('disconnect', undefined);
    sendOffer();
  };

  const onAccept = (m: Extract<AdminMessage, { kind: 'connect.accept' }>): void => {
    if (!OFFERED_VERSIONS.includes(m.version) || m.v !== m.version) {
      dropped += 1;
      return;
    }
    if (timer !== undefined) win.clearTimeout(timer);
    version = m.version;
    // Never wider than the offer, whatever the accept says.
    accepted = narrowCapabilities(m.capabilities, offered);
    connected = true;
    editing = has('select');
    link();
    fire('connect', { version, capabilities: accepted });
    if (lastPage) post({ kind: 'page', ...lastPage });
    if (has('layout')) scheduleLayout();
  };

  const onReject = (m: Extract<AdminMessage, { kind: 'connect.reject' }>): void => {
    // Resent offers can draw more than one reject: one console error is enough.
    if (rejected) return;
    rejected = true;
    if (timer !== undefined) win.clearTimeout(timer);
    attempts = OFFER_ATTEMPTS;
    (win as Window & typeof globalThis).console?.error(
      `ContentWorker live preview: the admin speaks protocol versions [${m.versions.join(', ')}] ` +
        `and this site's @contentworker/sdk ${LIVE_PREVIEW_SDK_VERSION} offers ` +
        `[${OFFERED_VERSIONS.join(', ')}]. Update @contentworker/sdk to a release the admin supports.`,
    );
    fire('reject', { reason: m.reason, versions: m.versions });
  };

  // --- receiving ------------------------------------------------------------------------

  const onMessage = (e: MessageEvent): void => {
    if (closed) return;
    const data = acceptMessage(e, {
      origin: adminOrigin,
      source: parent,
      channel,
      ...(connected && version !== undefined ? { version } : {}),
    });
    if (!data) return;
    const parsed = parseAdminMessage(data);
    if (!parsed.ok) {
      // Unknown kinds are a newer admin talking: ignored, not errors.
      if (parsed.reason === 'unknown') return;
      dropped += 1;
      refuseUnread(data);
      return;
    }
    const m = parsed.message;
    if (m.kind === 'connect.accept' || m.kind === 'connect.reject') {
      if (connected) return;
      if (m.kind === 'connect.accept') onAccept(m);
      else onReject(m);
      return;
    }
    if (!connected) return;
    if (!capabilityAllows(m, accepted)) {
      dropped += 1;
      return;
    }
    receive(m);
  };

  /**
   * A patch dropped unread still gets an answer, so the admin resends the state at once. A state
   * dropped unread is answered too, so the admin can say the entry can't be previewed rather than
   * wait; it must not resend that same state, which would fail the same way.
   */
  const refuseUnread = (data: Record<string, unknown>): void => {
    const patchLike =
      data.kind === 'entry.state' || data.kind === 'entry.patch' || data.kind === 'blocks.patch';
    if (!connected || !patchLike) return;
    const { rev, entryId } = data;
    if (!Number.isSafeInteger(rev) || typeof entryId !== 'string' || entryId.length > 256) return;
    fail(entryId, rev as number, 'invalid');
  };

  const fail = (entryId: string, rev: number, reason: FailReason): void =>
    post({ kind: 'failed', rev, reason, entryId });

  const receive = (m: AdminMessage): void => {
    switch (m.kind) {
      case 'entry.state':
        entries.set(m.entryId, {
          locale: m.locale,
          rev: m.rev,
          fields: clone(m.fields),
          // The whole state starts the entry over: the admin sends its proposals again.
          proposals: [],
          dirty: false,
        });
        render(m.entryId);
        return;
      case 'entry.patch':
      case 'blocks.patch': {
        const rec = entries.get(m.entryId);
        // In order or not at all: anything else asks for the whole state again.
        if (!rec || rec.locale !== m.locale || m.rev !== rec.rev + 1) {
          fail(m.entryId, m.rev, 'gap');
          return;
        }
        const reason = m.kind === 'entry.patch' ? patchFields(rec, m) : patchBlocks(rec, m);
        if (reason) {
          if (reason === 'invalid') dropped += 1;
          fail(m.entryId, m.rev, reason);
          return;
        }
        rec.rev = m.rev;
        render(m.entryId);
        return;
      }
      case 'select':
        fire('select', m.ref);
        return;
      case 'scroll': {
        const el = elementFor(m.ref);
        if (el) {
          const reduce = win.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
          const align = m.align ?? 'center';
          const inset = align === 'center' ? 0 : (m.inset ?? 0);
          // Kept `inset` clear of the edge it lands on: what the admin draws over the frame there.
          // At once when there is an inset to add, so the second scroll starts where the first ends:
          // `instant`, never `auto`, which a page's own `scroll-behavior: smooth` would animate.
          el.scrollIntoView({ block: align, behavior: reduce || inset > 0 ? 'instant' : 'smooth' });
          if (inset > 0)
            win.scrollBy?.({ top: align === 'end' ? inset : -inset, behavior: 'instant' });
        }
        fire('scroll', m.ref);
        return;
      }
      case 'editing':
        editing = m.on;
        if (!editing) sendHover(null);
        link();
        fire('editing', editing);
        return;
    }
  };

  /** Applies changed top-level values; `null` clears one. Rich text never becomes a string. */
  const patchFields = (rec: EntryRecord, m: EntryPatchMessage): FailReason | undefined => {
    for (const [name, value] of Object.entries(m.fields)) {
      if (isRichTextDocument(rec.fields[name]) && value !== null && !isRichTextDocument(value)) {
        return 'invalid';
      }
    }
    const next = { ...rec.fields };
    for (const [name, value] of Object.entries(m.fields)) {
      if (value === null) delete next[name];
      else next[name] = clone(value);
    }
    rec.fields = next;
    return undefined;
  };

  /** Applies the real ops to the fields and keeps the proposed ones aside, for `view`. */
  const patchBlocks = (rec: EntryRecord, m: BlocksPatchMessage): FailReason | undefined => {
    const real = m.ops.filter((op) => !op.proposed).map(strip);
    const proposed = resolveRefs(m.ops.filter((op) => op.proposed).map(strip));
    // A proposal must name every block it brings: a key minted here would change on every render,
    // and the admin could never name the ghost to take it back. A duplicate mints by definition.
    if (!proposed) return 'invalid';
    if (rec.proposals.length + proposed.length > MAX_PROPOSALS) return 'conflict';
    if (real.length > 0) {
      const wrapped = { [m.field]: { [m.locale]: rec.fields[m.field] } };
      const result = applyLivePatch(rec.fields[m.field] === undefined ? {} : wrapped, real, {
        newKey,
      });
      if (!result.ok) return 'conflict';
      const next = { ...rec.fields };
      const value = result.fields[m.field]?.[m.locale];
      if (value === undefined) delete next[m.field];
      else next[m.field] = value;
      rec.fields = next;
    }
    for (const op of proposed) {
      if (op.op === 'remove' && insertedKeys(rec).has(op.key)) {
        // Taking back a proposed block takes back everything proposed on it, in it or beside it.
        rec.proposals = rec.proposals.filter((p) => !namesKey(p.op, op.key));
      } else {
        rec.proposals.push({ field: m.field, op });
      }
    }
    return undefined;
  };

  // --- rendering --------------------------------------------------------------------------

  /** The fields with every proposal that still applies laid over them. */
  const viewOf = (rec: EntryRecord): LiveView => {
    if (rec.proposals.length === 0) {
      return {
        rev: rec.rev,
        withProposals: rec.fields,
        ghosts: { inserted: [], changed: [], removed: [] },
      };
    }
    const inserted: string[] = [];
    const changed: string[] = [];
    const removed: string[] = [];
    let localized: Record<string, Record<string, unknown>> = {};
    for (const [name, value] of Object.entries(rec.fields))
      localized[name] = { [rec.locale]: value };
    for (const { field, op } of rec.proposals) {
      if (op.op === 'remove') {
        // Kept in view, so the page can show what would go; unless it is already gone.
        const there = applyLivePatch(localized, [{ ...op, field, locale: rec.locale }]);
        if (there.ok) removed.push(op.key);
        continue;
      }
      const result = applyLivePatch(localized, [{ ...op, field, locale: rec.locale }], { newKey });
      // A proposal the real edits have overtaken (its block gone, its key now real) drops out.
      if (!result.ok) continue;
      localized = result.fields;
      const key = op.op === 'insert' ? (op.block._key as string) : 'key' in op ? op.key : undefined;
      if (key !== undefined) (op.op === 'insert' ? inserted : changed).push(key);
    }
    const withProposals: LiveFields = {};
    for (const [name, byLocale] of Object.entries(localized)) {
      if (byLocale[rec.locale] !== undefined) withProposals[name] = byLocale[rec.locale];
    }
    return { rev: rec.rev, withProposals, ghosts: { inserted, changed, removed } };
  };

  /**
   * Renders an entry, one `onState` at a time: edits that land mid-render are folded into the
   * next call, and each call that settles is acknowledged with the last rev it held. One that
   * throws answers `failed` and acknowledges nothing; the fields stay applied, so the next call
   * renders them and its `applied` covers every rev before it.
   */
  const render = (entryId: string): void => {
    const first = entries.get(entryId);
    if (!first) return;
    first.dirty = true;
    if (rendering.has(entryId)) return;
    rendering.add(entryId);
    void (async () => {
      try {
        for (;;) {
          // Re-read each time: a fresh state replaces the record, and renders next, never alongside.
          const rec = entries.get(entryId);
          if (!rec?.dirty || closed) break;
          rec.dirty = false;
          const { rev, locale, fields } = rec;
          const view = viewOf(rec);
          try {
            await options.onState(entryId, locale, fields, view);
          } catch {
            if (entries.get(entryId) === rec) fail(entryId, rev, 'render');
            continue;
          }
          // A whole state that arrived meanwhile starts over; this render's rev no longer counts.
          if (entries.get(entryId) !== rec) continue;
          post({ kind: 'applied', rev, entryId });
          if (has('layout')) scheduleLayout();
        }
      } finally {
        rendering.delete(entryId);
      }
    })();
  };

  // --- pointer: what the editor hovers and clicks -----------------------------------------

  const marked = (target: EventTarget | null): Element | undefined => {
    if (!isElement(target)) return undefined;
    const el = target.closest(`[${REF_ATTRIBUTE}]`);
    return el && attr(el, REF_ATTRIBUTE) ? el : undefined;
  };
  const picking = (): boolean => connected && editing && has('select');

  const onClick = (e: MouseEvent): void => {
    const link = isElement(e.target) ? e.target.closest('a[href]') : null;
    const el = picking() ? marked(e.target) : undefined;
    if (!el) {
      // The page follows its own links; the final `navigated` names where it went.
      if (link) leavingTo = (link as HTMLAnchorElement).href;
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    post({
      kind: 'pointer',
      pointer: 'click',
      ref: attr(el, REF_ATTRIBUTE) as string,
      rect: rectOf(el),
    });
  };

  let pointerAt: EventTarget | null = null;
  let hoverFrame: number | undefined;
  let hovered: string | null = null;
  const sendHover = (el: Element | null): void => {
    const ref = el ? (attr(el, REF_ATTRIBUTE) ?? null) : null;
    if (ref === hovered) return;
    hovered = ref;
    post(
      ref && el
        ? { kind: 'pointer', pointer: 'hover', ref, rect: rectOf(el) }
        : { kind: 'pointer', pointer: 'hover', ref: null, rect: null },
    );
  };
  /** After the page's own handlers: a link its router took over is not where the page goes. */
  const onClickSettled = (e: MouseEvent): void => {
    if (e.defaultPrevented) leavingTo = undefined;
  };
  const onPointerMove = (e: PointerEvent): void => {
    if (!picking()) return;
    pointerAt = e.target;
    if (hoverFrame !== undefined) return;
    hoverFrame = win.requestAnimationFrame(() => {
      hoverFrame = undefined;
      if (picking()) sendHover(marked(pointerAt) ?? null);
    });
  };
  const onPointerLeave = (): void => {
    if (hoverFrame !== undefined) win.cancelAnimationFrame(hoverFrame);
    hoverFrame = undefined;
    pointerAt = null;
    if (picking()) sendHover(null);
  };

  const elementFor = (ref: string): Element | undefined => {
    // Compared, not interpolated into a selector, so a ref can't be read as CSS.
    for (const el of doc.querySelectorAll(`[${REF_ATTRIBUTE}]`)) {
      if (el.getAttribute(REF_ATTRIBUTE) === ref) return el;
    }
    return undefined;
  };

  // --- navigation ----------------------------------------------------------------------------

  let here = withoutHash(win.location.href);
  /** A client-side navigation ends the session: say where, then connect again on a new channel. */
  const navigated = (to: string): void => {
    let url: string;
    try {
      url = new URL(to, win.location.href).href;
    } catch {
      return;
    }
    leavingTo = undefined;
    const next = withoutHash(url);
    if (next === here) return;
    here = next;
    if (connected && isPreviewUrl(url)) post({ kind: 'navigated', url });
    lastPage = undefined;
    connect();
  };
  const onPopState = (): void => navigated(win.location.href);
  const onPageHide = (): void => {
    // The last word before unload; if the parent is gone, nothing retries: the next page's offer is
    // the recovery.
    const url = leavingTo ?? win.location.href;
    if (connected && isPreviewUrl(url)) post({ kind: 'navigated', url });
  };

  // --- layout (extension) ------------------------------------------------------------------

  let frame: number | undefined;
  let lastLayout = '';
  const scheduleLayout = (): void => {
    if (closed || !connected || !has('layout') || frame !== undefined) return;
    frame = win.requestAnimationFrame(() => {
      frame = undefined;
      if (closed || !connected) return;
      const body = measure();
      // Observers fire for changes that move nothing; an unchanged layout isn't worth a message.
      const json = JSON.stringify(body);
      if (json === lastLayout) return;
      lastLayout = json;
      post({ kind: 'layout', ...body });
    });
  };

  const Resize = (win as Window & { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
  const resize = Resize ? new Resize(() => scheduleLayout()) : undefined;
  const observed = new Set<Element>();
  const observe = (el: Element): void => {
    if (!resize || observed.has(el)) return;
    observed.add(el);
    resize.observe(el);
  };

  const measure = (): LayoutBody => {
    for (const el of observed) {
      if (!el.isConnected) {
        resize?.unobserve(el);
        observed.delete(el);
      }
    }
    const refEls = doc.querySelectorAll(`[${REF_ATTRIBUTE}]`);
    const slotEls = doc.querySelectorAll(`[${SLOT_ATTRIBUTE}]`);
    const cut = refEls.length > MAX_MEASURED || slotEls.length > MAX_MEASURED;
    const blocks: LiveBlockBox[] = [];
    const fields: LiveFieldBox[] = [];
    const children = new Map<Element, { key: string; rect: LiveRect }[]>();
    for (const el of take(refEls)) {
      const ref = attr(el, REF_ATTRIBUTE);
      // What the admin's parser would refuse would cost the whole report: skip it instead.
      if (!ref || !isWireRef(ref)) continue;
      const parsed = parseContentRef(ref);
      const key = parsed ? blockKeyOf(parsed.field) : undefined;
      observe(el);
      const rect = rectOf(el);
      if (key === undefined) {
        fields.push({ ref, rect });
        continue;
      }
      if (!isWireId(key)) continue;
      blocks.push({ ref, rect });
      const slotEl = el.parentElement?.closest(`[${SLOT_ATTRIBUTE}]`);
      // Only a slot the block's own path names: a block of a referenced entry, or of a nested slot
      // the page didn't mark, would put its seams in the wrong list.
      if (!slotEl || !parsed || !holds(attr(slotEl, SLOT_ATTRIBUTE), parsed)) continue;
      const siblings = children.get(slotEl);
      if (siblings) siblings.push({ key, rect });
      else children.set(slotEl, [{ key, rect }]);
    }
    const slots: LiveSlotBox[] = [];
    for (const el of take(slotEls)) {
      const ref = attr(el, SLOT_ATTRIBUTE);
      if (!ref || !isWireRef(ref)) continue;
      observe(el);
      const rect = rectOf(el);
      slots.push({ ref, rect, gaps: gapsOf(rect, children.get(el) ?? []) });
    }
    const envelope = JSON.stringify({ v: version, channel, kind: 'layout' });
    return fitGeometry(
      {
        blocks,
        slots,
        fields,
        scroll: { x: round(win.scrollX), y: round(win.scrollY) },
        viewport: { w: round(win.innerWidth), h: round(win.innerHeight) },
        docHeight: round(doc.documentElement.scrollHeight),
      },
      MAX_MESSAGE_BYTES - new TextEncoder().encode(envelope).byteLength,
      cut,
    );
  };

  const mutations = new (win as Window & typeof globalThis).MutationObserver(() =>
    scheduleLayout(),
  );
  const onScroll = (): void => scheduleLayout();

  // --- wiring ---------------------------------------------------------------------------------

  win.addEventListener('message', onMessage);
  // Capture on the window, so the page's own handlers (which may stop propagation) run after.
  win.addEventListener('click', onClick, true);
  win.addEventListener('click', onClickSettled);
  win.addEventListener('pointermove', onPointerMove, { capture: true, passive: true });
  doc.documentElement.addEventListener('pointerleave', onPointerLeave);
  win.addEventListener('popstate', onPopState);
  win.addEventListener('pagehide', onPageHide);
  win.addEventListener('scroll', onScroll, { capture: true, passive: true });
  win.addEventListener('resize', onScroll, { passive: true });
  mutations.observe(doc.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
  });
  observe(doc.documentElement);
  connect();

  return {
    active: true,
    get connected() {
      return connected;
    },
    get version() {
      return version;
    },
    get capabilities() {
      return accepted;
    },
    get dropped() {
      return dropped;
    },
    on(kind, handler) {
      const set = handlers.get(kind) ?? new Set();
      handlers.set(kind, set);
      set.add(handler as (value: never) => void);
      return () => {
        set.delete(handler as (value: never) => void);
      };
    },
    emit(kind: 'page' | 'navigated', body: Record<string, unknown>) {
      if (kind === 'navigated') {
        if (typeof body.url === 'string') navigated(body.url);
        return;
      }
      const page = pageBody(body);
      if (!page) return;
      lastPage = page;
      if (connected) post({ kind: 'page', ...page });
    },
    refresh: scheduleLayout,
    close() {
      if (closed) return;
      closed = true;
      if (timer !== undefined) win.clearTimeout(timer);
      if (frame !== undefined) win.cancelAnimationFrame(frame);
      if (hoverFrame !== undefined) win.cancelAnimationFrame(hoverFrame);
      win.removeEventListener('message', onMessage);
      win.removeEventListener('click', onClick, true);
      win.removeEventListener('click', onClickSettled);
      win.removeEventListener('pointermove', onPointerMove, { capture: true });
      doc.documentElement.removeEventListener('pointerleave', onPointerLeave);
      win.removeEventListener('popstate', onPopState);
      win.removeEventListener('pagehide', onPageHide);
      win.removeEventListener('scroll', onScroll, { capture: true });
      win.removeEventListener('resize', onScroll);
      mutations.disconnect();
      resize?.disconnect();
      observed.clear();
      entries.clear();
      connected = false;
      setPreviewLink(self, undefined);
    },
  } as PreviewConnection;
}

// --- helpers ---------------------------------------------------------------------------------

function checkOrigin(origin: string, pageOrigin: string): string {
  let parsed: URL | undefined;
  try {
    parsed = new URL(origin);
  } catch {
    parsed = undefined;
  }
  // An exact origin, never `*` or `null`: posting the drafts to any other window would hand them
  // over, and accepting from any would let any page drive what the editor sees.
  if (!parsed || parsed.origin !== origin || !isPreviewUrl(origin)) {
    throw new Error(
      'connectPreview needs adminOrigin as an exact https origin (http only on localhost), ' +
        'e.g. https://admin.example.com',
    );
  }
  // The frame is allowed its own origin (allow-same-origin), which is safe only while that origin
  // is never the admin's.
  if (origin === pageOrigin) {
    throw new Error('connectPreview: adminOrigin must differ from the page’s own origin');
  }
  return origin;
}

function pageBody(
  body: Record<string, unknown>,
): Omit<PageMessage, 'v' | 'channel' | 'kind'> | undefined {
  if (typeof body.url !== 'string' || !isPreviewUrl(body.url) || !Array.isArray(body.entries)) {
    return undefined;
  }
  // The admin drops a whole `page` holding one entry it can't read, so skip such entries here.
  const entries = body.entries
    .filter(
      (e): e is PageMessage['entries'][number] =>
        isRecord(e) && isWireId(e.entryId) && isWireId(e.contentType) && isWireId(e.locale),
    )
    .slice(0, PAGE_REPORT_LIMIT)
    .map(({ entryId, contentType, locale }) => ({ entryId, contentType, locale }));
  return { url: body.url, entries };
}

/** An op without the `proposed` mark (and the message's field and locale, filled in by the parser). */
function strip(op: LivePatchOp & { readonly proposed?: true }): LivePatchOp {
  const { proposed: _, ...rest } = op;
  return rest as LivePatchOp;
}

function insertedKeys(rec: EntryRecord): Set<string> {
  const keys = new Set<string>();
  for (const { op } of rec.proposals) {
    if (op.op === 'insert' && typeof op.block._key === 'string') keys.add(op.block._key);
  }
  return keys;
}

/** The keys an op names: its own, and its place's parent and siblings. */
function keysOf(op: LivePatchOp): string[] {
  const place = op.op === 'insert' ? op : op.op === 'move' ? op.to : undefined;
  const own = 'key' in op && typeof op.key === 'string' ? [op.key] : [];
  const inserted = op.op === 'insert' && typeof op.block._key === 'string' ? [op.block._key] : [];
  const around = place
    ? [place.parent?.key, place.before, place.after].filter((k): k is string => k !== undefined)
    : [];
  return [...own, ...inserted, ...around];
}

const namesKey = (op: LivePatchOp, key: string): boolean => keysOf(op).includes(key);

/**
 * One message's proposals with every `ref` replaced by the key of the block it named, so each can
 * be laid over the fields alone, in any later render. Undefined when one can't be kept: an insert
 * with a block lacking a `_key` (it, or a block in its slots), or a duplicate.
 */
function resolveRefs(ops: readonly LivePatchOp[]): LivePatchOp[] | undefined {
  const refs = new Map<string, string>();
  const at = (k: string | undefined) => (k === undefined ? undefined : (refs.get(k) ?? k));
  const out: LivePatchOp[] = [];
  for (const op of ops) {
    if (op.op === 'duplicate' || op.op === 'setField') return undefined;
    if (op.op === 'insert') {
      if (!everyBlockKeyed(op.block)) return undefined;
      const { ref, ...rest } = op;
      if (ref !== undefined) refs.set(ref, op.block._key as string);
      out.push(placed(rest, at) as LivePatchOp);
    } else if (op.op === 'move') {
      out.push({ ...op, key: at(op.key) as string, to: placed(op.to, at) });
    } else {
      out.push({ ...op, key: at(op.key) as string });
    }
  }
  return out;
}

function placed<
  P extends { parent?: { key: string; slot: string }; before?: string; after?: string },
>(place: P, at: (k: string | undefined) => string | undefined): P {
  return {
    ...place,
    ...(place.parent ? { parent: { ...place.parent, key: at(place.parent.key) as string } } : {}),
    ...(place.before !== undefined ? { before: at(place.before) } : {}),
    ...(place.after !== undefined ? { after: at(place.after) } : {}),
  };
}

/** Whether a slot ref names the slot a block's ref sits in: same entry, path one block up. */
function holds(slotRef: string | undefined, block: ContentRef): boolean {
  const slot = slotRef ? parseContentRef(slotRef) : undefined;
  if (!slot) return false;
  const bracket = block.field.lastIndexOf('[');
  return (
    slot.space === block.space &&
    slot.environment === block.environment &&
    slot.entryId === block.entryId &&
    slot.locale === block.locale &&
    bracket > 0 &&
    slot.field === block.field.slice(0, bracket)
  );
}

function withoutHash(url: string): string {
  const hash = url.indexOf('#');
  return hash < 0 ? url : url.slice(0, hash);
}

function take<T extends Element>(list: NodeListOf<T>): T[] {
  return Array.from(list).slice(0, MAX_MEASURED);
}

function attr(el: Element, name: string): string | undefined {
  const value = el.getAttribute(name);
  return value && value.length <= MAX_ATTRIBUTE ? value : undefined;
}

const round = (n: number): number => Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;

/** Duck-typed, so it holds for elements of the window passed in as well as the global one. */
function isElement(target: EventTarget | null): target is Element {
  return typeof (target as Element | null)?.closest === 'function';
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
