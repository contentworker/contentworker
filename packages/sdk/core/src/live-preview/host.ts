/**
 * The admin half of the live preview channel: runs in `apps/web` around the
 * iframe that frames the customer's frontend.
 *
 * Framework-free, so the admin's React hook is a thin wrapper and the whole
 * conversation can be tested against a fake frontend. Not published: only the
 * frontend half ships in `@contentworker/sdk/live-preview`.
 */
import type { ContentRef } from '../content-ref.js';
import {
  acceptGuestMessage,
  type ConnectOffer,
  GUEST_MESSAGE_CAPABILITY,
  type HostMessage,
  type IncomingMessage,
  isJsonData,
  LIVE_PREVIEW_CAPABILITIES,
  LIVE_PREVIEW_MARK,
  LIVE_PREVIEW_VERSIONS,
  type LivePreviewCapability,
  type LivePreviewFields,
  narrowCapabilities,
  negotiateVersion,
  type PageEntry,
  type PreviewRect,
  type ProposalMark,
  previewOrigin,
} from './protocol.js';

interface Postable {
  postMessage(message: unknown, targetOrigin: string): void;
}

export interface PreviewHostWindow {
  addEventListener(type: 'message', listener: (e: IncomingMessage) => void): void;
  removeEventListener(type: 'message', listener: (e: IncomingMessage) => void): void;
}

export interface PreviewHostOptions {
  /** The iframe framing the frontend. Its `contentWindow` is the only window heard. */
  readonly frame: { readonly contentWindow: unknown };
  /** Origins the frontend may be on: the origins of the space's preview URL templates. */
  readonly allowedOrigins: readonly string[];
  /** Versions this admin speaks, newest first. */
  readonly versions?: readonly number[];
  /** What this admin may use, e.g. narrowed by the person's role. Defaults to everything. */
  readonly capabilities?: readonly LivePreviewCapability[];
  /** The space and environment being edited. A ref from the page naming any other is dropped. */
  readonly scope: { readonly space: string; readonly environment: string };
  /**
   * Whether the signed-in person may read what a ref names. Refs failing it are
   * dropped. Required: what the page reports is a hint, never a permission.
   */
  readonly canRead: (ref: ContentRef) => boolean;
  /** Window to listen on. Defaults to the global one. */
  readonly window?: PreviewHostWindow;
}

export interface PreviewSession {
  readonly origin: string;
  readonly version: number;
  readonly capabilities: readonly LivePreviewCapability[];
  readonly sdk: { readonly name: string; readonly version: string };
}

export interface PreviewHostEvents {
  connect: PreviewSession;
  reject: { readonly origin: string; readonly theirs: readonly number[] };
  /** The page went away (navigated or closed); a new page connects again. */
  ended: { readonly url: string | undefined };
  page: { readonly url: string; readonly entries: readonly PageEntry[] };
  pointer: {
    readonly pointer: 'hover' | 'click';
    readonly ref: ContentRef;
    readonly rect: PreviewRect;
  };
  applied: { readonly entryId: string; readonly locale: string; readonly rev: number };
  failed: {
    readonly entryId: string;
    readonly locale: string;
    readonly rev: number;
    readonly reason: 'gap' | 'render';
  };
}

export interface PreviewHost {
  readonly session: PreviewSession | undefined;
  readonly dropped: number;
  on<K extends keyof PreviewHostEvents>(
    event: K,
    listener: (detail: PreviewHostEvents[K]) => void,
  ): () => void;
  /**
   * Sets an entry's whole unsaved state. Sent now when connected, and again
   * to every page that connects later, so a navigation never loses edits.
   */
  setState(entryId: string, locale: string, fields: LivePreviewFields): void;
  /** Changes some of an entry's unsaved fields. Needs `setState` first. */
  patch(entryId: string, locale: string, fields: LivePreviewFields): void;
  /** Outlines a marked element on the page, or clears the outline. Needs `select`. */
  select(ref: ContentRef | null): boolean;
  /** Scrolls a marked element into view. Needs `scroll`. */
  scroll(ref: ContentRef): boolean;
  /**
   * Shows Coworker's proposal on the page as ghosts: the field values after
   * the proposed block patch (applied here, with the domain's patch engine),
   * and how each touched block changed. Kept and shown again to a page that
   * connects later, until cleared. Needs `proposals`.
   */
  showProposal(
    entryId: string,
    locale: string,
    proposal: {
      readonly fields: LivePreviewFields;
      readonly marks: Readonly<Record<string, ProposalMark>>;
      readonly removed?: readonly string[];
    },
  ): boolean;
  /** Takes a proposal away, accepted or dismissed. Needs `proposals`. */
  clearProposal(entryId: string, locale: string): boolean;
  /**
   * Asks the framed page to connect again. Sent on creation too, so an admin
   * that starts listening after the page loaded still reaches it.
   */
  reconnect(): void;
  close(): void;
}

interface Session extends PreviewSession {
  readonly channel: string;
  readonly target: Postable;
  readonly revs: Map<string, number>;
  /** Per entry and locale, the rev of the last state resent for a gap. */
  readonly resentAt: Map<string, number>;
  page: readonly PageEntry[];
}

const keyOf = (entryId: string, locale: string) => `${entryId}\u0000${locale}`;

/** The shortest gap between two sessions a burst of offers from one frame can start. */
const NEW_SESSION_MS = 200;

/**
 * Field values as they go on the wire: `undefined` dropped the way JSON drops
 * it (in arrays it becomes `null`), and anything else that isn't JSON data
 * refused. The page drops a message whose values aren't JSON, so letting one
 * through would freeze that entry's preview with nothing reported.
 *
 * In a patch, a top-level field set to `undefined` was cleared, and a missing
 * key would mean "unchanged", so it is sent as `null`.
 */
function wireFields(fields: LivePreviewFields, patch = false): LivePreviewFields {
  const strip = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map((item) => (item === undefined ? null : strip(item)));
    if (typeof v !== 'object' || v === null || Object.getPrototypeOf(v) !== Object.prototype) {
      return v;
    }
    const out: Record<string, unknown> = {};
    for (const [k, item] of Object.entries(v)) if (item !== undefined) out[k] = strip(item);
    return out;
  };
  const out = strip(fields) as Record<string, unknown>;
  if (patch) {
    for (const [k, v] of Object.entries(fields)) if (v === undefined) out[k] = null;
  }
  if (!isJsonData(out)) {
    throw new TypeError('Live preview fields must be JSON data (no dates, maps or cycles).');
  }
  return out;
}

/** Listens for the framed frontend and runs its sessions. */
export function connectPreviewHost(options: PreviewHostOptions): PreviewHost {
  const win = options.window ?? (globalThis as unknown as { window?: PreviewHostWindow }).window;
  if (!win) throw new Error('connectPreviewHost requires a window.');
  const allowed = new Set(options.allowedOrigins.map((o) => previewOrigin(o, 'allowedOrigins')));
  const versions = options.versions ?? LIVE_PREVIEW_VERSIONS;
  const allowedCaps = options.capabilities ?? LIVE_PREVIEW_CAPABILITIES;
  const states = new Map<string, { entryId: string; locale: string; fields: LivePreviewFields }>();
  const proposals = new Map<
    string,
    {
      entryId: string;
      locale: string;
      fields: LivePreviewFields;
      marks: Readonly<Record<string, ProposalMark>>;
      removed: readonly string[];
    }
  >();
  const listeners = new Map<keyof PreviewHostEvents, Set<(detail: never) => void>>();
  let session: Session | undefined;
  let startedAt = Number.NEGATIVE_INFINITY;
  let dropped = 0;
  let closed = false;

  const fire = <K extends keyof PreviewHostEvents>(event: K, detail: PreviewHostEvents[K]) => {
    for (const listener of listeners.get(event) ?? []) {
      (listener as (d: PreviewHostEvents[K]) => void)(detail);
    }
  };

  const post = (s: Session, kind: HostMessage['kind'], body: Record<string, unknown>) => {
    s.target.postMessage(
      { cw: LIVE_PREVIEW_MARK, v: s.version, channel: s.channel, kind, ...body },
      s.origin,
    );
  };

  const nextRev = (s: Session, key: string) => {
    const rev = (s.revs.get(key) ?? -1) + 1;
    s.revs.set(key, rev);
    return rev;
  };

  const sendState = (s: Session, key: string) => {
    const state = states.get(key);
    if (!state || !s.capabilities.includes('patch.fields')) return;
    post(s, 'entry.state', {
      rev: nextRev(s, key),
      entryId: state.entryId,
      locale: state.locale,
      fields: state.fields,
    });
  };

  const start = (offer: ConnectOffer, origin: string, target: Postable) => {
    if (session && session.channel === offer.channel && session.origin === origin) {
      // A retry of the offer this session answered (it crossed the accept):
      // answer again, without starting over.
      post(session, 'connect.accept', {
        version: session.version,
        capabilities: session.capabilities,
      });
      return;
    }
    const now = Date.now();
    if (session && now - startedAt < NEW_SESSION_MS) {
      // A page that keeps sending new offers over a live session would tear it
      // down and resend every state each time. A page that said `navigated`
      // connects at once; any other retries a second later.
      dropped++;
      return;
    }
    startedAt = now;
    if (session) fire('ended', { url: undefined });
    session = undefined;
    const version = negotiateVersion(offer.versions, versions);
    if (version === undefined) {
      target.postMessage(
        {
          cw: LIVE_PREVIEW_MARK,
          v: versions[0] ?? 1,
          channel: offer.channel,
          kind: 'connect.reject',
          reason: 'unsupported-version',
          versions,
        },
        origin,
      );
      fire('reject', { origin, theirs: offer.versions });
      return;
    }
    const s: Session = {
      origin,
      version,
      capabilities: narrowCapabilities(offer.capabilities, allowedCaps),
      sdk: offer.sdk,
      channel: offer.channel,
      target,
      revs: new Map(),
      resentAt: new Map(),
      page: [],
    };
    session = s;
    post(s, 'connect.accept', { version, capabilities: s.capabilities });
    fire('connect', { origin, version, capabilities: s.capabilities, sdk: s.sdk });
    for (const key of states.keys()) sendState(s, key);
    for (const key of proposals.keys()) sendProposal(s, key);
  };

  const sendProposal = (s: Session, key: string) => {
    const p = proposals.get(key);
    if (!p || !s.capabilities.includes('proposals')) return;
    post(s, 'proposal.show', p);
  };

  // A ref from the page must be in the scope being edited, name an entry it
  // reported (same type and locale) or one being edited here, and pass
  // `canRead`. The page's report narrows what a click may name; only
  // `canRead` grants anything.
  const readable = (s: Session, ref: ContentRef) =>
    ref.space === options.scope.space &&
    ref.environment === options.scope.environment &&
    (s.page.some(
      (e) =>
        e.entryId === ref.entryId && e.contentType === ref.contentType && e.locale === ref.locale,
    ) ||
      states.has(keyOf(ref.entryId, ref.locale))) &&
    options.canRead(ref);

  const onMessage = (event: IncomingMessage) => {
    if (closed) return;
    const s = session;
    const verdict = acceptGuestMessage(event, {
      // Once connected, only the session's own origin; a new offer may come
      // from any allowed origin (the page navigated within the site).
      origin: (o) => allowed.has(o),
      source: options.frame.contentWindow,
      channel: s?.channel,
    });
    if (!verdict.ok) {
      if (verdict.reason !== 'foreign' && verdict.reason !== 'unknown') dropped++;
      return;
    }
    const message = verdict.message;
    if (message.kind === 'connect.offer') {
      start(message, event.origin, event.source as Postable);
      return;
    }
    const needs = GUEST_MESSAGE_CAPABILITY[message.kind];
    if (
      !s ||
      event.origin !== s.origin ||
      message.v !== s.version ||
      (needs && !s.capabilities.includes(needs))
    ) {
      dropped++;
      return;
    }
    switch (message.kind) {
      case 'page':
        s.page = message.entries;
        fire('page', { url: message.url, entries: message.entries });
        return;
      case 'navigated':
        session = undefined;
        fire('ended', { url: message.url });
        return;
      case 'pointer':
        if (!readable(s, message.ref)) {
          dropped++;
          return;
        }
        fire('pointer', { pointer: message.pointer, ref: message.ref, rect: message.rect });
        return;
      case 'applied':
        fire('applied', { entryId: message.entryId, locale: message.locale, rev: message.rev });
        return;
      case 'failed': {
        const { entryId, locale, rev, reason } = message;
        fire('failed', { entryId, locale, rev, reason });
        // A gap is recovered by sending that entry's whole state again; a
        // render failure is the page's to report, and resending would fail
        // the same way. A gap reported for a rev already superseded (patches
        // were in flight) needs nothing: the resend it caused already covers it.
        const key = keyOf(entryId, locale);
        if (reason === 'gap' && rev > (s.resentAt.get(key) ?? -1)) {
          sendState(s, key);
          s.resentAt.set(key, s.revs.get(key) ?? 0);
        }
        return;
      }
    }
  };

  const requestConnect = () => {
    const target = options.frame.contentWindow as Postable | null | undefined;
    if (!target || typeof target.postMessage !== 'function') return;
    // The frame's origin isn't known before an offer, so the request goes to
    // each allowed origin; the browser delivers only the one that matches.
    for (const origin of allowed) {
      target.postMessage(
        { cw: LIVE_PREVIEW_MARK, v: versions[0] ?? 1, channel: '', kind: 'connect.request' },
        origin,
      );
    }
  };

  win.addEventListener('message', onMessage);
  requestConnect();

  return {
    get session() {
      const s = session;
      return (
        s && { origin: s.origin, version: s.version, capabilities: s.capabilities, sdk: s.sdk }
      );
    },
    get dropped() {
      return dropped;
    },
    on(event, listener) {
      const set = listeners.get(event) ?? new Set();
      set.add(listener as (detail: never) => void);
      listeners.set(event, set);
      return () => set.delete(listener as (detail: never) => void);
    },
    setState(entryId, locale, fields) {
      const key = keyOf(entryId, locale);
      states.set(key, { entryId, locale, fields: wireFields(fields) });
      if (session) sendState(session, key);
    },
    patch(entryId, locale, fields) {
      const key = keyOf(entryId, locale);
      const state = states.get(key);
      if (!state) throw new Error(`setState(${entryId}, ${locale}) must come before patch.`);
      const changed = wireFields(fields, true);
      states.set(key, { ...state, fields: { ...state.fields, ...changed } });
      const s = session;
      if (!s?.capabilities.includes('patch.fields')) return;
      if (!s.revs.has(key)) {
        sendState(s, key);
        return;
      }
      post(s, 'entry.patch', { rev: nextRev(s, key), entryId, locale, fields: changed });
    },
    select(ref) {
      const s = session;
      if (!s?.capabilities.includes('select')) return false;
      post(s, 'select', { ref });
      return true;
    },
    scroll(ref) {
      const s = session;
      if (!s?.capabilities.includes('scroll')) return false;
      post(s, 'scroll', { ref });
      return true;
    },
    showProposal(entryId, locale, proposal) {
      const key = keyOf(entryId, locale);
      proposals.set(key, {
        entryId,
        locale,
        fields: wireFields(proposal.fields),
        marks: { ...proposal.marks },
        removed: [...(proposal.removed ?? [])],
      });
      const s = session;
      if (!s?.capabilities.includes('proposals')) return false;
      sendProposal(s, key);
      return true;
    },
    clearProposal(entryId, locale) {
      const had = proposals.delete(keyOf(entryId, locale));
      const s = session;
      if (!had || !s?.capabilities.includes('proposals')) return false;
      post(s, 'proposal.clear', { entryId, locale });
      return true;
    },
    reconnect() {
      if (closed) return;
      if (session) {
        session = undefined;
        fire('ended', { url: undefined });
      }
      requestConnect();
    },
    close() {
      closed = true;
      session = undefined;
      win.removeEventListener('message', onMessage);
    },
  };
}
