/**
 * The frontend half of the live preview channel: runs in the customer's page
 * when the admin frames it.
 *
 * A page that isn't framed, or isn't configured, gets a handle that does
 * nothing, so a site can call `connectPreview` on every page and only the
 * framed preview ever talks to the admin.
 */
import type { ContentRef } from '../content-ref.js';
import {
  acceptHostMessage,
  type ConnectOffer,
  type GuestMessage,
  HOST_MESSAGE_CAPABILITY,
  type HostMessage,
  type IncomingMessage,
  LIVE_PREVIEW_CAPABILITIES,
  LIVE_PREVIEW_MARK,
  LIVE_PREVIEW_VERSIONS,
  type LivePreviewCapability,
  type LivePreviewFields,
  newChannel,
  PAGE_ENTRY_LIMIT,
  type PageEntry,
  type PreviewRect,
} from './protocol.js';

/** The window APIs the frontend half uses; the global `window` by default. */
export interface PreviewGuestWindow {
  readonly parent: { postMessage(message: unknown, targetOrigin: string): void } | null;
  readonly location: { readonly origin: string; readonly href: string };
  addEventListener(type: 'message', listener: (e: IncomingMessage) => void): void;
  addEventListener(type: 'pagehide', listener: () => void): void;
  removeEventListener(type: 'message', listener: (e: IncomingMessage) => void): void;
  removeEventListener(type: 'pagehide', listener: () => void): void;
}

export interface ConnectPreviewOptions {
  /** The admin's origin, e.g. `https://admin.example.com`. Printed by the "connect a frontend" screen. */
  readonly adminOrigin: string;
  /** What this page lets the admin do. Defaults to everything it can. */
  readonly capabilities?: readonly LivePreviewCapability[];
  /**
   * Called with an entry's whole unsaved state each time it changes. Re-render
   * from it. Values are typed field data (rich text as a `RichTextDocument`),
   * never markup.
   */
  readonly onState?: (entryId: string, locale: string, fields: LivePreviewFields) => void;
  /** Reported to the admin for diagnostics. */
  readonly sdk?: { readonly name: string; readonly version: string };
  /** How many times to resend an unanswered offer. Default 3. */
  readonly retries?: number;
  /** Milliseconds between offers. Default 1000. */
  readonly retryMs?: number;
  /** Window to run in. Defaults to the global one. */
  readonly window?: PreviewGuestWindow;
}

export type LivePreviewStatus =
  | 'off'
  | 'connecting'
  | 'connected'
  | 'rejected'
  | 'unanswered'
  | 'closed';

export interface LivePreviewEvents {
  connect: { readonly version: number; readonly capabilities: readonly LivePreviewCapability[] };
  reject: { readonly ours: readonly number[]; readonly theirs: readonly number[] };
  unanswered: undefined;
  select: ContentRef | null;
  scroll: ContentRef;
}

export interface LivePreview {
  readonly status: LivePreviewStatus;
  /** The negotiated protocol version, once connected. */
  readonly version: number | undefined;
  /** What the admin will use: what this page offered, narrowed by the admin. */
  readonly capabilities: readonly LivePreviewCapability[];
  /** Messages dropped by the checks or for their shape. A debugging aid. */
  readonly dropped: number;
  on<K extends keyof LivePreviewEvents>(
    event: K,
    listener: (detail: LivePreviewEvents[K]) => void,
  ): () => void;
  /**
   * Tells the admin which entries this page renders: the edited entry and the
   * ones it references directly. Beyond {@link PAGE_ENTRY_LIMIT}, the rest
   * are left out.
   */
  reportPage(entries: readonly PageEntry[]): void;
  /** Tells the admin a marked element was hovered or clicked. Needs `select`. */
  reportPointer(pointer: 'hover' | 'click', ref: ContentRef, rect: PreviewRect): void;
  /** Stops listening. The admin sees the page as gone. */
  close(): void;
}

const DEFAULT_SDK = { name: '@contentworker/sdk', version: 'unknown' } as const;

/**
 * The value for a `Content-Security-Policy` header on preview responses, so
 * only the admin can frame a draft page: `frame-ancestors https://admin.example.com`.
 */
export function previewFrameAncestors(adminOrigin: string): string {
  return `frame-ancestors ${originOf(adminOrigin)}`;
}

function originOf(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`adminOrigin must be an origin like https://admin.example.com, not ${value}`);
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.origin !== value) {
    throw new Error(`adminOrigin must be an origin like https://admin.example.com, not ${value}`);
  }
  return url.origin;
}

/** Connects this page to the admin that frames it, if one does. */
export function connectPreview(options: ConnectPreviewOptions): LivePreview {
  const adminOrigin = originOf(options.adminOrigin);
  const win = options.window ?? (globalThis as unknown as { window?: PreviewGuestWindow }).window;
  const listeners = new Map<keyof LivePreviewEvents, Set<(detail: never) => void>>();
  const on: LivePreview['on'] = (event, listener) => {
    const set = listeners.get(event) ?? new Set();
    set.add(listener as (detail: never) => void);
    listeners.set(event, set);
    return () => set.delete(listener as (detail: never) => void);
  };

  const parent = win?.parent;
  if (!win || !parent || (parent as unknown) === win) {
    // Not framed: nothing to connect to, and nothing to break.
    return {
      status: 'off',
      version: undefined,
      capabilities: [],
      dropped: 0,
      on,
      reportPage() {},
      reportPointer() {},
      close() {},
    };
  }
  if (win.location.origin === adminOrigin) {
    // Framing a page on the admin's own origin would give it the admin's
    // cookies and storage: the separation everything else relies on.
    throw new Error('The previewed site must not be served from the admin origin.');
  }

  const offered = LIVE_PREVIEW_CAPABILITIES.filter(
    (c) => !options.capabilities || options.capabilities.includes(c),
  );
  const channel = newChannel();
  let status: LivePreviewStatus = 'connecting';
  let version: number | undefined;
  let accepted: readonly LivePreviewCapability[] = [];
  let dropped = 0;
  const entries = new Map<string, { rev: number; fields: LivePreviewFields }>();
  let lastPage: { url: string; entries: PageEntry[] } | undefined;

  const fire = <K extends keyof LivePreviewEvents>(event: K, detail: LivePreviewEvents[K]) => {
    for (const listener of listeners.get(event) ?? []) {
      (listener as (d: LivePreviewEvents[K]) => void)(detail);
    }
  };

  const post = (message: GuestMessage) => parent.postMessage(message, adminOrigin);
  const send = (kind: string, body: Record<string, unknown>) => {
    if (status !== 'connected' || version === undefined) return;
    post({ cw: LIVE_PREVIEW_MARK, v: version, channel, kind, ...body } as GuestMessage);
  };

  const offer: ConnectOffer = {
    cw: LIVE_PREVIEW_MARK,
    v: LIVE_PREVIEW_VERSIONS[0] ?? 1,
    channel,
    kind: 'connect.offer',
    versions: LIVE_PREVIEW_VERSIONS,
    capabilities: offered,
    sdk: options.sdk ?? DEFAULT_SDK,
  };
  const retries = options.retries ?? 3;
  const retryMs = options.retryMs ?? 1000;
  let attempts = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const sendOffer = () => {
    if (status !== 'connecting') return;
    if (attempts > retries) {
      status = 'unanswered';
      fire('unanswered', undefined);
      return;
    }
    attempts++;
    post(offer);
    timer = setTimeout(sendOffer, retryMs);
  };

  const apply = (message: HostMessage) => {
    switch (message.kind) {
      case 'connect.accept': {
        if (status !== 'connecting' || !LIVE_PREVIEW_VERSIONS.includes(message.version)) {
          dropped++;
          return;
        }
        clearTimeout(timer);
        status = 'connected';
        version = message.version;
        // The admin may narrow what was offered, never widen it.
        accepted = message.capabilities.filter((c) => offered.includes(c));
        fire('connect', { version, capabilities: accepted });
        // A page usually reports what it renders before the admin answers.
        if (lastPage) send('page', lastPage);
        return;
      }
      case 'connect.reject':
        if (status !== 'connecting') return;
        clearTimeout(timer);
        status = 'rejected';
        console.error(
          `ContentWorker live preview: this site's SDK speaks protocol versions ${LIVE_PREVIEW_VERSIONS.join(', ')}, ` +
            `the admin speaks ${message.versions.join(', ')}. Update @contentworker/sdk.`,
        );
        fire('reject', { ours: LIVE_PREVIEW_VERSIONS, theirs: message.versions });
        return;
      case 'entry.state': {
        entries.set(`${message.entryId}\u0000${message.locale}`, {
          rev: message.rev,
          fields: message.fields,
        });
        render(message.entryId, message.locale, message.rev, message.fields);
        return;
      }
      case 'entry.patch': {
        const key = `${message.entryId}\u0000${message.locale}`;
        const known = entries.get(key);
        if (!known || message.rev !== known.rev + 1) {
          send('failed', { entryId: message.entryId, rev: message.rev, reason: 'gap' });
          return;
        }
        const fields = { ...known.fields, ...message.fields };
        entries.set(key, { rev: message.rev, fields });
        render(message.entryId, message.locale, message.rev, fields);
        return;
      }
      case 'select':
        fire('select', message.ref);
        return;
      case 'scroll':
        fire('scroll', message.ref);
        return;
    }
  };

  const render = (entryId: string, locale: string, rev: number, fields: LivePreviewFields) => {
    try {
      options.onState?.(entryId, locale, fields);
    } catch (error) {
      console.error('ContentWorker live preview: rendering unsaved state failed.', error);
      send('failed', { entryId, rev, reason: 'render' });
      return;
    }
    send('applied', { entryId, rev });
  };

  const onMessage = (event: IncomingMessage) => {
    const verdict = acceptHostMessage(event, {
      origin: (o) => o === adminOrigin,
      source: parent,
      channel,
    });
    if (!verdict.ok) {
      if (verdict.reason !== 'foreign' && verdict.reason !== 'unknown') dropped++;
      return;
    }
    const message = verdict.message;
    const connecting = message.kind === 'connect.accept' || message.kind === 'connect.reject';
    if (!connecting) {
      // Only a connected session carries other messages, at its own version,
      // and only for what this page allowed.
      const needs = HOST_MESSAGE_CAPABILITY[message.kind];
      if (status !== 'connected' || message.v !== version || (needs && !accepted.includes(needs))) {
        dropped++;
        return;
      }
    }
    apply(message);
  };

  const onPageHide = () => send('navigated', { url: win.location.href });

  win.addEventListener('message', onMessage);
  win.addEventListener('pagehide', onPageHide);
  sendOffer();

  return {
    get status() {
      return status;
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
    on,
    reportPage(list) {
      lastPage = {
        url: win.location.href,
        entries: list.slice(0, PAGE_ENTRY_LIMIT).map((e) => ({
          entryId: e.entryId,
          contentType: e.contentType,
          locale: e.locale,
        })),
      };
      send('page', lastPage);
    },
    reportPointer(pointer, ref, rect) {
      if (!accepted.includes('select')) return;
      const { x, y, width, height } = rect;
      send('pointer', { pointer, ref: { ...ref }, rect: { x, y, width, height } });
    },
    close() {
      if (status === 'closed') return;
      clearTimeout(timer);
      onPageHide();
      status = 'closed';
      win.removeEventListener('message', onMessage);
      win.removeEventListener('pagehide', onPageHide);
    },
  };
}
