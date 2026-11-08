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
  LIVE_PREVIEW_CAPABILITIES,
  LIVE_PREVIEW_MARK,
  LIVE_PREVIEW_VERSIONS,
  type LivePreviewCapability,
  type LivePreviewFields,
  narrowCapabilities,
  negotiateVersion,
  type PageEntry,
  type PreviewRect,
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
  /** Whether the signed-in person may read what a ref names. Refs failing it are dropped. */
  readonly canRead?: (ref: ContentRef) => boolean;
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
  applied: { readonly entryId: string; readonly rev: number };
  failed: { readonly entryId: string; readonly rev: number; readonly reason: 'gap' | 'render' };
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
  close(): void;
}

interface Session extends PreviewSession {
  readonly channel: string;
  readonly target: Postable;
  readonly revs: Map<string, number>;
  page: readonly PageEntry[];
}

const keyOf = (entryId: string, locale: string) => `${entryId}\u0000${locale}`;

function normalizeOrigin(value: string): string {
  const origin = new URL(value).origin;
  if (origin === 'null') throw new Error(`Not an origin: ${value}`);
  return origin;
}

/** Listens for the framed frontend and runs its sessions. */
export function connectPreviewHost(options: PreviewHostOptions): PreviewHost {
  const win = options.window ?? (globalThis as unknown as { window?: PreviewHostWindow }).window;
  if (!win) throw new Error('connectPreviewHost requires a window.');
  const allowed = new Set(options.allowedOrigins.map(normalizeOrigin));
  const versions = options.versions ?? LIVE_PREVIEW_VERSIONS;
  const allowedCaps = options.capabilities ?? LIVE_PREVIEW_CAPABILITIES;
  const states = new Map<string, { entryId: string; locale: string; fields: LivePreviewFields }>();
  const listeners = new Map<keyof PreviewHostEvents, Set<(detail: never) => void>>();
  let session: Session | undefined;
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
      page: [],
    };
    session = s;
    post(s, 'connect.accept', { version, capabilities: s.capabilities });
    fire('connect', { origin, version, capabilities: s.capabilities, sdk: s.sdk });
    for (const key of states.keys()) sendState(s, key);
  };

  // A ref from the page names an entry it reported, or one being edited here,
  // and one the signed-in person may read: the page is never trusted to say
  // which entry a click is about.
  const readable = (s: Session, ref: ContentRef) =>
    (s.page.some((e) => e.entryId === ref.entryId) ||
      [...states.values()].some((st) => st.entryId === ref.entryId)) &&
    (options.canRead?.(ref) ?? true);

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
        fire('applied', { entryId: message.entryId, rev: message.rev });
        return;
      case 'failed': {
        fire('failed', { entryId: message.entryId, rev: message.rev, reason: message.reason });
        // A gap is recovered by sending the whole state again; a render
        // failure is the page's to report, and resending would fail the same way.
        if (message.reason === 'gap') {
          for (const [key, state] of states) {
            if (state.entryId === message.entryId) sendState(s, key);
          }
        }
        return;
      }
    }
  };

  win.addEventListener('message', onMessage);

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
      states.set(key, { entryId, locale, fields });
      if (session) sendState(session, key);
    },
    patch(entryId, locale, fields) {
      const key = keyOf(entryId, locale);
      const state = states.get(key);
      if (!state) throw new Error(`setState(${entryId}, ${locale}) must come before patch.`);
      states.set(key, { ...state, fields: { ...state.fields, ...fields } });
      const s = session;
      if (!s?.capabilities.includes('patch.fields')) return;
      if (!s.revs.has(key)) {
        sendState(s, key);
        return;
      }
      post(s, 'entry.patch', { rev: nextRev(s, key), entryId, locale, fields });
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
    close() {
      closed = true;
      session = undefined;
      win.removeEventListener('message', onMessage);
    },
  };
}
