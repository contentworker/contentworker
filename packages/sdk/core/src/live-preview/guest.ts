/**
 * The page half of live preview: what a customer's frontend runs so the admin can frame it, edit
 * the entry it shows and see each edit re-rendered before anything is saved.
 *
 * Framework-free, like the inline editor: it holds the entry's fields, applies the admin's
 * patches to them and hands the result to `onChange`, so the host app re-renders however it
 * renders (a client re-render, or a server render of the one block a patch touched). It never
 * draws: the admin draws selection, hover and seams outside the frame, from the geometry this
 * reports. The frame keeps its own scrolling, so sticky headers, full-height heroes and lazy
 * loading behave as they do on the live site.
 *
 * Inert unless the page is framed with `cw_session` on its URL, so the same build ships to
 * production. Listens only to the configured admin origin, in the parent window, for its own
 * session, and never evaluates anything a message carries.
 */

import { applyLivePatch, type LivePatchOp } from './patch.js';
import {
  FORWARDED_KEYS,
  type ForwardedKey,
  isLivePreviewSession,
  isPreviewUrl,
  LIVE_PREVIEW_PROTOCOL,
  LIVE_PREVIEW_SESSION_PARAM,
  type LiveAdminMessage,
  type LiveBlockBox,
  type LiveErrorKind,
  type LiveFieldBox,
  type LiveFields,
  type LiveGap,
  type LiveGeometryMessage,
  type LiveGuestMessage,
  type LiveOptionalTarget,
  type LivePreviewMode,
  type LiveRect,
  type LiveSlotBox,
  type LiveTarget,
  MAX_GEOMETRY_GAPS,
  MAX_GEOMETRY_ITEMS,
  MAX_MESSAGE_BYTES,
  parseAdminMessage,
} from './protocol.js';

/** The SDK release this runtime ships in, sent in `hello`. Kept equal to @contentworker/sdk's. */
export const LIVE_PREVIEW_SDK_VERSION = '0.2.0';

/** The attribute on a block's root element, holding its `_key`. */
export const BLOCK_ATTRIBUTE = 'data-cw-block';
/** The attribute on the element holding a slot's blocks, holding the slot's field path. */
export const SLOT_ATTRIBUTE = 'data-cw-slot';
const REF_ATTRIBUTE = 'data-cw-ref';
const MARKED = `[${REF_ATTRIBUTE}],[${BLOCK_ATTRIBUTE}]`;
const MAX_ATTRIBUTE = 256;
const MAX_REF = 1024;

/** Spread onto a block's root element: `<section {...blockAttrs(block._key)}>`. */
export function blockAttrs(key: string): { readonly 'data-cw-block': string } {
  return { [BLOCK_ATTRIBUTE]: key } as { readonly 'data-cw-block': string };
}

/**
 * Spread onto the element directly holding a slot's blocks: the field's apiId at the top
 * (`slotAttrs('body')`), the slot's apiId inside a block (`slotAttrs('items')`, the block being the
 * nearest `data-cw-block` around it).
 */
export function slotAttrs(path: string): { readonly 'data-cw-slot': string } {
  return { [SLOT_ATTRIBUTE]: path } as { readonly 'data-cw-slot': string };
}

/** Which entry the fields are, from the admin's `init`. */
export interface LivePreviewEntry {
  readonly entryId: string;
  readonly contentType: string;
  readonly locale: string;
  readonly version: number;
}

/** What changed: the last patch included, and the ops since the last `onChange` (none for an init). */
export interface LivePreviewUpdate extends LivePreviewEntry {
  readonly seq: number;
  readonly ops: readonly LivePatchOp[];
}

export interface LivePreviewOptions {
  /**
   * The admin's origin, e.g. `https://admin.example.com`. Required: messages from any other origin
   * are ignored, and the page posts to this one only, never `*`.
   */
  readonly adminOrigin: string;
  /**
   * Re-render with the edited fields (locale-keyed, as the Management API returns them). Called once
   * the admin sends the entry, then after each patch; patches that arrive while a render is pending
   * are folded into the next call. May return a promise: the admin hears the edit is on screen
   * when it settles.
   */
  readonly onChange: (fields: LiveFields, update: LivePreviewUpdate) => void | Promise<void>;
  /** The admin selected a block or field, or cleared the selection (`undefined`). */
  readonly onSelect?: (target: LiveTarget | undefined) => void;
  /** The editor's pointer is over a block or field in the admin's outline, or none. */
  readonly onHover?: (target: LiveTarget | undefined) => void;
  /** Mints a key for a block a patch inserts without one. Defaults to a random UUID. */
  readonly newKey?: () => string;
  /** The window to run in. Defaults to the global one. */
  readonly window?: Window;
}

export interface LivePreview {
  /** Whether the page is in a live preview session (framed, with `cw_session`). */
  readonly active: boolean;
  readonly mode: LivePreviewMode;
  /** The fields as edited so far; undefined until the admin sends the entry. */
  readonly fields: LiveFields | undefined;
  /** Measures and reports geometry on the next frame, for layout changes the observers can't see. */
  refresh(): void;
  /** Removes every listener and observer. */
  destroy(): void;
}

const INERT: LivePreview = {
  active: false,
  mode: 'view',
  fields: undefined,
  refresh() {},
  destroy() {},
};

/**
 * Starts the page side of a live preview session, or returns an inert handle when the page isn't
 * in one (not framed, or no `cw_session`, or no DOM). Call `destroy()` to stop.
 */
export function startLivePreview(options: LivePreviewOptions): LivePreview {
  const win = options.window ?? (globalThis.window as Window | undefined);
  if (!win?.document) return INERT;
  const parent = win.parent;
  if (!parent || parent === win) return INERT;
  const session = new URL(win.location.href).searchParams.get(LIVE_PREVIEW_SESSION_PARAM);
  if (!isLivePreviewSession(session)) return INERT;
  // Checked only once in a session, so a mistyped origin breaks previews, not every page view.
  const adminOrigin = checkOrigin(options.adminOrigin);

  const doc = win.document;
  const newKey = options.newKey;
  let destroyed = false;
  let connected = false;
  let mode: LivePreviewMode = 'view';
  let fields: LiveFields | undefined;
  let entry: LivePreviewEntry | undefined;
  let lastSeq = 0;
  let pendingOps: LivePatchOp[] = [];
  let dirty = false;
  let rendering = false;
  let selected = false;
  /**
   * Set when a patch was refused or lost (too large, malformed): the fields no longer match the
   * admin's, so every later patch would land on the wrong state. Patches are dropped, each with the
   * error again, until an `init` resets the fields. `seq` is the patch that went missing, when known.
   */
  let desync: { readonly seq?: number; readonly message: string } | undefined;

  type Outbound = LiveGuestMessage extends infer M
    ? M extends LiveGuestMessage
      ? Omit<M, 'cw' | 'session'>
      : never
    : never;
  const post = (message: Outbound): void => {
    if (destroyed) return;
    parent.postMessage({ cw: LIVE_PREVIEW_PROTOCOL, session, ...message }, adminOrigin);
  };
  const fail = (kind: LiveErrorKind, message: string, seq?: number): void =>
    post({
      type: 'error',
      kind,
      message: message.slice(0, 1000) || kind,
      ...(seq !== undefined ? { seq } : {}),
    });
  const lose = (message: string, seq?: number): void => {
    desync = { ...(seq !== undefined ? { seq } : {}), message };
    fail('patch', message, seq);
  };

  // --- rendering --------------------------------------------------------------------

  /**
   * Renders the latest fields, one `onChange` at a time: edits that land mid-render are folded
   * into the next call, and each settled call is acknowledged with the last seq it included.
   *
   * A call that throws acknowledges nothing, and its ops go back on the queue, so the next call
   * (on the next patch or init, never a retry loop of its own) carries them and its ack covers
   * them only once they are on screen. `fields` is always the latest, so that call renders them.
   */
  const pump = async (): Promise<void> => {
    if (rendering) return;
    rendering = true;
    try {
      while (dirty && !destroyed && fields && entry) {
        dirty = false;
        const seq = lastSeq;
        const ops = pendingOps;
        pendingOps = [];
        try {
          await options.onChange(fields, { ...entry, seq, ops });
        } catch (err) {
          pendingOps = [...ops, ...pendingOps];
          fail('render', err instanceof Error ? err.message : 'onChange failed', seq);
          continue;
        }
        post({ type: 'rendered', seq });
        scheduleGeometry();
      }
    } finally {
      rendering = false;
    }
  };

  const receive = (m: LiveAdminMessage): void => {
    switch (m.type) {
      case 'init': {
        connected = true;
        fields = clone(m.fields);
        entry = {
          entryId: m.entryId,
          contentType: m.contentType,
          locale: m.locale,
          version: m.version,
        };
        // The fields are the whole truth again: a new baseline, and nothing owed from before.
        lastSeq = m.seq ?? 0;
        desync = undefined;
        pendingOps = [];
        dirty = true;
        void pump();
        return;
      }
      case 'patch': {
        if (!fields) {
          fail('patch', 'A patch arrived before the entry', m.seq);
          return;
        }
        // postMessage keeps order, so a seq at or below the last is a resend: already applied.
        if (m.seq <= lastSeq) return;
        if (desync) {
          fail('patch', `Out of step since ${desync.message}; send the entry again`, desync.seq);
          return;
        }
        const result = applyLivePatch(fields, m.ops, newKey ? { newKey } : {});
        if (!result.ok) {
          // Nothing of the patch applies, and nothing after it can: the admin re-sends the entry.
          lose(`patch ${m.seq} ops[${result.op}]: ${result.message}`, m.seq);
          return;
        }
        fields = result.fields;
        lastSeq = m.seq;
        pendingOps.push(...m.ops);
        dirty = true;
        void pump();
        return;
      }
      case 'select':
        selected = targetOf(m) !== undefined;
        options.onSelect?.(targetOf(m));
        return;
      case 'hover':
        options.onHover?.(targetOf(m));
        return;
      case 'scrollTo': {
        const el = elementFor(m);
        if (!el) {
          fail('target', 'Nothing on the page matches that target');
          return;
        }
        const reduce = win.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        el.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
        return;
      }
      case 'mode':
        mode = m.mode;
        if (mode === 'view') hoverKey = undefined;
        return;
    }
  };

  const onMessage = (e: MessageEvent): void => {
    // Origin and source both: the origin alone admits any frame the admin's origin opens, and the
    // source alone admits whatever the parent navigated to.
    if (e.origin !== adminOrigin || e.source !== parent) return;
    const parsed = parseAdminMessage(e.data, session);
    if (parsed.ok) {
      receive(parsed.message);
      return;
    }
    if (parsed.reason !== 'too-large' && parsed.reason !== 'invalid') return;
    const message = parsed.reason === 'too-large' ? 'Message too large' : 'Malformed message';
    const data = e.data as { type?: unknown; seq?: unknown };
    // A lost patch leaves the page a step behind, like a refused one.
    const seq = Number.isSafeInteger(data.seq) ? (data.seq as number) : undefined;
    if (data.type === 'patch' && fields && (seq === undefined || seq > lastSeq)) {
      // Already behind: the first patch that went missing is the one to name.
      if (desync) fail('patch', `Out of step since ${desync.message}`, desync.seq);
      else lose(`patch ${seq ?? '?'}: ${message.toLowerCase()}`, seq);
    } else fail('invalid', message);
  };

  // --- geometry ---------------------------------------------------------------------

  let frame: number | undefined;
  let lastGeometry = '';
  const scheduleGeometry = (): void => {
    if (destroyed || !connected || frame !== undefined) return;
    frame = win.requestAnimationFrame(() => {
      frame = undefined;
      if (destroyed) return;
      const geometry = measure();
      // Observers fire for changes that move nothing; unchanged geometry isn't worth a message.
      const json = JSON.stringify(geometry);
      if (json === lastGeometry) return;
      lastGeometry = json;
      post({ type: 'geometry', ...geometry });
    });
  };

  const Resize = (win as Window & { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
  const resize = Resize ? new Resize(() => scheduleGeometry()) : undefined;
  const observed = new Set<Element>();
  const observe = (el: Element): void => {
    if (!resize || observed.has(el)) return;
    observed.add(el);
    resize.observe(el);
  };

  const measure = () => {
    for (const el of observed) {
      if (!el.isConnected) {
        resize?.unobserve(el);
        observed.delete(el);
      }
    }
    const blockEls = doc.querySelectorAll(`[${BLOCK_ATTRIBUTE}]`);
    const slotEls = doc.querySelectorAll(`[${SLOT_ATTRIBUTE}]`);
    const fieldEls = doc.querySelectorAll(`[${REF_ATTRIBUTE}]`);
    const cut = [blockEls, slotEls, fieldEls].some((list) => list.length > MAX_MEASURED);
    const blocks: LiveBlockBox[] = [];
    const children = new Map<Element, { key: string; rect: LiveRect }[]>();
    for (const el of take(blockEls)) {
      const key = attr(el, BLOCK_ATTRIBUTE, MAX_ATTRIBUTE);
      if (!key) continue;
      observe(el);
      const rect = rectOf(el);
      const slotEl = el.parentElement?.closest(`[${SLOT_ATTRIBUTE}]`);
      const slot = slotEl ? attr(slotEl, SLOT_ATTRIBUTE, MAX_ATTRIBUTE) : undefined;
      const parentKey = slotEl ? parentKeyOf(slotEl) : undefined;
      blocks.push({ key, rect, ...(slot ? { slot } : {}), ...(parentKey ? { parentKey } : {}) });
      if (slotEl && slot) children.set(slotEl, [...(children.get(slotEl) ?? []), { key, rect }]);
    }
    const slots: LiveSlotBox[] = [];
    for (const el of take(slotEls)) {
      const path = attr(el, SLOT_ATTRIBUTE, MAX_ATTRIBUTE);
      if (!path) continue;
      observe(el);
      const rect = rectOf(el);
      const parentKey = parentKeyOf(el);
      const gaps = gapsOf(rect, children.get(el) ?? []);
      slots.push({ path, rect, gaps, ...(parentKey ? { parentKey } : {}) });
    }
    const fieldBoxes: LiveFieldBox[] = [];
    for (const el of take(fieldEls)) {
      const ref = attr(el, REF_ATTRIBUTE, MAX_REF);
      if (ref) fieldBoxes.push({ ref, rect: rectOf(el) });
    }
    const envelope = JSON.stringify({ cw: LIVE_PREVIEW_PROTOCOL, session, type: 'geometry' });
    return fitGeometry(
      {
        blocks,
        slots,
        fields: fieldBoxes,
        scroll: { x: round(win.scrollX), y: round(win.scrollY) },
        viewport: { w: round(win.innerWidth), h: round(win.innerHeight) },
        docHeight: round(doc.documentElement.scrollHeight),
      },
      MAX_MESSAGE_BYTES - new TextEncoder().encode(envelope).byteLength,
      cut,
    );
  };

  const parentKeyOf = (slotEl: Element): string | undefined => {
    const holder = slotEl.closest(`[${BLOCK_ATTRIBUTE}]`);
    return holder ? attr(holder, BLOCK_ATTRIBUTE, MAX_ATTRIBUTE) : undefined;
  };

  const mutations = new (win as Window & typeof globalThis).MutationObserver(() =>
    scheduleGeometry(),
  );
  const onScroll = (): void => scheduleGeometry();

  // --- edit mode: picking, hovering, links and keys ----------------------------------

  /** The nearest marked element: a field's ref wins over the block it sits in. */
  const markedAt = (
    target: EventTarget | null,
  ): { el: Element; target: LiveTarget } | undefined => {
    if (!isElement(target)) return undefined;
    const el = target.closest(MARKED);
    if (!el) return undefined;
    const ref = attr(el, REF_ATTRIBUTE, MAX_REF);
    if (ref) return { el, target: { ref } };
    const key = attr(el, BLOCK_ATTRIBUTE, MAX_ATTRIBUTE);
    return key ? { el, target: { key } } : undefined;
  };

  const onClick = (e: MouseEvent): void => {
    if (mode !== 'edit' || !connected) return;
    const link = isElement(e.target) ? e.target.closest('a[href]') : null;
    const marked = markedAt(e.target);
    // A click on something marked picks it, even inside a link (a card's heading); ⌘ or Ctrl
    // follows the link instead. Either way the page itself goes nowhere: the admin navigates.
    if (link && (e.metaKey || e.ctrlKey || !marked)) {
      stop(e);
      const url = navigableUrl((link as HTMLAnchorElement).href);
      if (url) post({ type: 'navigate', url });
      return;
    }
    if (!marked) return;
    stop(e);
    post({ type: 'pick', ...marked.target });
  };

  let pointer: EventTarget | null = null;
  let hoverFrame: number | undefined;
  let hoverKey: string | undefined;
  const onPointerMove = (e: PointerEvent): void => {
    if (mode !== 'edit' || !connected) return;
    pointer = e.target;
    if (hoverFrame !== undefined) return;
    hoverFrame = win.requestAnimationFrame(() => {
      hoverFrame = undefined;
      if (destroyed || mode !== 'edit') return;
      sendHover(markedAt(pointer)?.target);
    });
  };
  const onPointerLeave = (): void => {
    // A frame still pending would re-send the last target after the pointer has gone.
    if (hoverFrame !== undefined) win.cancelAnimationFrame(hoverFrame);
    hoverFrame = undefined;
    pointer = null;
    if (mode === 'edit' && connected) sendHover(undefined);
  };
  const sendHover = (target: LiveTarget | undefined): void => {
    const id = target ? (target.key !== undefined ? `k:${target.key}` : `r:${target.ref}`) : '';
    if (id === (hoverKey ?? '')) return;
    hoverKey = id || undefined;
    post({ type: 'hover', ...(target ?? {}) } as Outbound);
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    // The innermost target: a window listener sees a shadow root's input as its host element.
    const origin = e.composedPath?.()[0] ?? e.target;
    if (mode !== 'edit' || !connected || e.isComposing || editable(origin)) return;
    const key = forwarded(e);
    if (!key) return;
    // Undo, redo, Escape and `/` are the admin's; arrows and Delete only while something is
    // selected, so the page still scrolls by keyboard when nothing is.
    const navigation = key.startsWith('Arrow') || key === 'Delete' || key === 'Backspace';
    if (!navigation || selected) e.preventDefault();
    post({
      type: 'key',
      key,
      meta: e.metaKey,
      ctrl: e.ctrlKey,
      shift: e.shiftKey,
      alt: e.altKey,
    });
  };

  const editable = (target: EventTarget | null): boolean =>
    isElement(target) &&
    ((target as HTMLElement).isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));

  const elementFor = (target: LiveTarget): Element | undefined => {
    const [name, value] =
      target.key !== undefined ? [BLOCK_ATTRIBUTE, target.key] : [REF_ATTRIBUTE, target.ref];
    // Compared, not interpolated into a selector, so a key can't be read as CSS.
    for (const el of doc.querySelectorAll(`[${name}]`)) {
      if (el.getAttribute(name) === value) return el;
    }
    return undefined;
  };

  // --- wiring -------------------------------------------------------------------------

  win.addEventListener('message', onMessage);
  // Capture on the window, so the page's own handlers (which may stop propagation) run after.
  win.addEventListener('click', onClick, true);
  win.addEventListener('pointermove', onPointerMove, { capture: true, passive: true });
  doc.documentElement.addEventListener('pointerleave', onPointerLeave);
  win.addEventListener('keydown', onKeyDown, true);
  win.addEventListener('scroll', onScroll, { capture: true, passive: true });
  win.addEventListener('resize', onScroll, { passive: true });
  mutations.observe(doc.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
  });
  observe(doc.documentElement);

  post({
    type: 'hello',
    sdkVersion: LIVE_PREVIEW_SDK_VERSION,
    capabilities: ['patch', 'setField', 'geometry', 'pick', 'hover', 'navigate', 'key', 'scrollTo'],
  });

  return {
    active: true,
    get mode() {
      return mode;
    },
    get fields() {
      return fields;
    },
    refresh: scheduleGeometry,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      win.removeEventListener('message', onMessage);
      win.removeEventListener('click', onClick, true);
      win.removeEventListener('pointermove', onPointerMove, { capture: true });
      doc.documentElement.removeEventListener('pointerleave', onPointerLeave);
      win.removeEventListener('keydown', onKeyDown, true);
      win.removeEventListener('scroll', onScroll, { capture: true });
      win.removeEventListener('resize', onScroll);
      mutations.disconnect();
      resize?.disconnect();
      observed.clear();
      if (frame !== undefined) win.cancelAnimationFrame(frame);
      if (hoverFrame !== undefined) win.cancelAnimationFrame(hoverFrame);
    },
  };
}

// --- helpers --------------------------------------------------------------------------

function checkOrigin(origin: string): string {
  let parsed: URL | undefined;
  try {
    parsed = new URL(origin);
  } catch {
    parsed = undefined;
  }
  // An exact origin, never `*` or `null`: posting the entry to any other window would hand it the
  // draft, and accepting from any would let any page edit what the editor sees.
  if (!parsed || parsed.origin !== origin || !isPreviewUrl(origin)) {
    throw new Error(
      'startLivePreview needs adminOrigin as an exact https origin (http only on localhost), ' +
        'e.g. https://admin.example.com',
    );
  }
  return origin;
}

function targetOf(m: LiveOptionalTarget): LiveTarget | undefined {
  if (m.key !== undefined) return { key: m.key };
  if (m.ref !== undefined) return { ref: m.ref };
  return undefined;
}

function forwarded(e: KeyboardEvent): ForwardedKey | undefined {
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (!(FORWARDED_KEYS as readonly string[]).includes(key)) return undefined;
  const mod = e.metaKey || e.ctrlKey;
  if (key === 'z') return mod && !e.altKey ? 'z' : undefined;
  if (key === '/' || key === 'Delete' || key === 'Backspace') {
    return mod || e.altKey ? undefined : (key as ForwardedKey);
  }
  return key as ForwardedKey;
}

function stop(e: Event): void {
  e.preventDefault();
  e.stopPropagation();
}

/**
 * An https link (http on localhost) as an absolute URL without the session parameter; anything
 * else is dropped.
 */
function navigableUrl(href: string): string | undefined {
  if (!isPreviewUrl(href)) return undefined;
  try {
    const url = new URL(href);
    url.searchParams.delete(LIVE_PREVIEW_SESSION_PARAM);
    const out = url.toString();
    return out.length <= 8192 ? out : undefined;
  } catch {
    return undefined;
  }
}

/** The most elements of each kind measured per frame; `fitGeometry` picks what is sent from them. */
const MAX_MEASURED = 10_000;

function take<T extends Element>(list: NodeListOf<T>): T[] {
  return Array.from(list).slice(0, MAX_MEASURED);
}

type GeometryBody = Omit<LiveGeometryMessage, 'cw' | 'session' | 'type'>;

/**
 * The geometry as it fits one message: at most `MAX_GEOMETRY_ITEMS` of each list and
 * `MAX_GEOMETRY_GAPS` seams, in at most `budget` bytes of JSON. What's on screen goes first, then
 * what's nearest it; each list keeps document order. Anything left out sets `truncated`, so the
 * admin knows boxes far from the viewport may be missing, rather than silently losing them all.
 */
export function fitGeometry(g: GeometryBody, budget: number, cut = false): GeometryBody {
  const { w, h } = g.viewport;
  const away = (r: LiveRect): number =>
    Math.max(0, -(r.x + r.w), r.x - w) + Math.max(0, -(r.y + r.h), r.y - h);
  const lists = [g.blocks, g.slots, g.fields] as const;
  const candidates = lists.flatMap((list, kind) =>
    list.map((item, index) => ({
      kind,
      index,
      away: away(item.rect),
      size: JSON.stringify(item).length + 1,
      gaps: kind === 1 ? (item as LiveSlotBox).gaps.length : 0,
    })),
  );
  candidates.sort((a, b) => a.away - b.away || a.kind - b.kind || a.index - b.index);
  const total = candidates.length;
  const bytes = (body: GeometryBody) => new TextEncoder().encode(JSON.stringify(body)).byteLength;

  let room = budget - bytes({ ...g, blocks: [], slots: [], fields: [], truncated: true });
  for (;;) {
    const kept = [new Set<number>(), new Set<number>(), new Set<number>()];
    let used = 0;
    let gaps = 0;
    for (const c of candidates) {
      const set = kept[c.kind] as Set<number>;
      if (set.size >= MAX_GEOMETRY_ITEMS || gaps + c.gaps > MAX_GEOMETRY_GAPS) continue;
      if (used + c.size > room) continue;
      set.add(c.index);
      used += c.size;
      gaps += c.gaps;
    }
    const pick = <T>(list: readonly T[], kind: number) =>
      list.filter((_, i) => (kept[kind] as Set<number>).has(i));
    const out: GeometryBody = {
      ...g,
      blocks: pick(g.blocks, 0),
      slots: pick(g.slots, 1),
      fields: pick(g.fields, 2),
    };
    const truncated = cut || out.blocks.length + out.slots.length + out.fields.length < total;
    const body: GeometryBody = truncated ? { ...out, truncated: true } : out;
    // Sizes were counted in UTF-16 units; keys outside ASCII take more bytes, so check and shrink.
    if (bytes(body) <= budget || room <= 0) return body;
    room = Math.floor(room * 0.75);
  }
}

function attr(el: Element, name: string, max: number): string | undefined {
  const value = el.getAttribute(name);
  return value && value.length <= max ? value : undefined;
}

const round = (n: number): number => Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;

function rectOf(el: Element): LiveRect {
  const r = el.getBoundingClientRect();
  return { x: round(r.left), y: round(r.top), w: round(r.width), h: round(r.height) };
}

/**
 * The seams of a slot: before its first block, between each pair, after its last; one across the
 * whole slot when it's empty. Blocks that start below the previous one's bottom run down the page
 * (`y`); otherwise side by side (`x`).
 */
export function gapsOf(
  slot: LiveRect,
  blocks: readonly { readonly key: string; readonly rect: LiveRect }[],
): LiveGap[] {
  if (blocks.length === 0) return [{ index: 0, rect: slot, axis: 'y' }];
  const axisOf = (a: LiveRect, b: LiveRect): 'x' | 'y' => (b.y >= a.y + a.h - 1 ? 'y' : 'x');
  const first = blocks[0] as (typeof blocks)[number];
  const last = blocks[blocks.length - 1] as (typeof blocks)[number];
  const axis = blocks.length > 1 ? axisOf(first.rect, (blocks[1] as typeof first).rect) : 'y';
  const gaps: LiveGap[] = [];
  gaps.push({
    index: 0,
    axis,
    before: first.key,
    rect:
      axis === 'y'
        ? { x: slot.x, y: slot.y, w: slot.w, h: round(Math.max(0, first.rect.y - slot.y)) }
        : {
            x: slot.x,
            y: first.rect.y,
            w: round(Math.max(0, first.rect.x - slot.x)),
            h: first.rect.h,
          },
  });
  for (let i = 1; i < blocks.length; i++) {
    const a = (blocks[i - 1] as typeof first).rect;
    const b = (blocks[i] as typeof first).rect;
    const along = axisOf(a, b);
    const rect: LiveRect =
      along === 'y'
        ? {
            x: Math.min(a.x, b.x),
            y: round(a.y + a.h),
            w: round(Math.max(a.x + a.w, b.x + b.w) - Math.min(a.x, b.x)),
            h: round(Math.max(0, b.y - (a.y + a.h))),
          }
        : {
            x: round(a.x + a.w),
            y: Math.min(a.y, b.y),
            w: round(Math.max(0, b.x - (a.x + a.w))),
            h: round(Math.max(a.y + a.h, b.y + b.h) - Math.min(a.y, b.y)),
          };
    gaps.push({
      index: i,
      axis: along,
      after: (blocks[i - 1] as typeof first).key,
      before: (blocks[i] as typeof first).key,
      rect,
    });
  }
  const end = last.rect;
  gaps.push({
    index: blocks.length,
    axis,
    after: last.key,
    rect:
      axis === 'y'
        ? {
            x: slot.x,
            y: round(end.y + end.h),
            w: slot.w,
            h: round(Math.max(0, slot.y + slot.h - (end.y + end.h))),
          }
        : {
            x: round(end.x + end.w),
            y: end.y,
            w: round(Math.max(0, slot.x + slot.w - (end.x + end.w))),
            h: end.h,
          },
  });
  return gaps;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Duck-typed, so it holds for elements of the window passed in as well as the global one. */
function isElement(target: EventTarget | null): target is Element {
  return typeof (target as Element | null)?.closest === 'function';
}
