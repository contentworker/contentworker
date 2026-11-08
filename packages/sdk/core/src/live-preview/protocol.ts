/**
 * The live preview channel's wire format, shared by both windows.
 *
 * The admin frames the customer's frontend; the two talk over `postMessage`.
 * Everything here is pure (no DOM), so both halves and their tests share one
 * definition of what a valid message is. The design is
 * `docs/specs/live-preview-channel.md`.
 */
import { type ContentRef, parseContentRef } from '../content-ref.js';

/** Marks our messages, so other `postMessage` traffic on the page is ignored, not counted. */
export const LIVE_PREVIEW_MARK = 'cw.live-preview';

/**
 * Every protocol version this build speaks, newest first.
 *
 * Customers install the SDK into their own sites and update it whenever they
 * like, so the admin keeps speaking every version a supported SDK release
 * offers. Dropping an entry is a breaking change: say so in the changelog.
 * An additive change (a new optional field, or a new message kind both sides
 * can ignore) does not bump the version.
 *
 * - 1: every SDK release that ships `@contentworker/sdk/live-preview`.
 */
export const LIVE_PREVIEW_VERSIONS: readonly number[] = [1];

/** What a page lets the admin do. Fixed when the preview connects. */
export type LivePreviewCapability = 'select' | 'patch.fields' | 'scroll' | 'proposals';

export const LIVE_PREVIEW_CAPABILITIES: readonly LivePreviewCapability[] = [
  'select',
  'patch.fields',
  'scroll',
  'proposals',
];

/** Most entries one `page` message reports: the edited entry and its direct references. */
export const PAGE_ENTRY_LIMIT = 50;

/** Field values: JSON data only, exactly as the Management API types them. Never markup. */
export type LivePreviewFields = Readonly<Record<string, unknown>>;

export interface PageEntry {
  readonly entryId: string;
  readonly contentType: string;
  readonly locale: string;
}

/** A rectangle in the iframe's viewport coordinates. */
export interface PreviewRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type RejectReason = 'unsupported-version';
export type FailReason = 'gap' | 'render';

interface Envelope {
  readonly cw: typeof LIVE_PREVIEW_MARK;
  readonly v: number;
  readonly channel: string;
}

// Connect messages keep this shape in every version: they are how two
// different versions find out what they share.
export interface ConnectOffer extends Envelope {
  readonly kind: 'connect.offer';
  readonly versions: readonly number[];
  readonly capabilities: readonly string[];
  readonly sdk: { readonly name: string; readonly version: string };
}

export interface ConnectAccept extends Envelope {
  readonly kind: 'connect.accept';
  readonly version: number;
  readonly capabilities: readonly LivePreviewCapability[];
}

/**
 * Asks the page to connect again: sent by an admin that starts listening after
 * the page loaded, or that was rebuilt. It carries no channel (the admin does
 * not know one yet), so the page accepts it on origin and window alone; all it
 * can do is make the page send a fresh offer to the admin origin.
 */
export interface ConnectRequest extends Envelope {
  readonly kind: 'connect.request';
}

export interface ConnectReject extends Envelope {
  readonly kind: 'connect.reject';
  readonly reason: RejectReason;
  /** The versions the admin speaks, so the page can say which side is behind. */
  readonly versions: readonly number[];
}

export interface EntryState extends Envelope {
  readonly kind: 'entry.state';
  readonly rev: number;
  readonly entryId: string;
  readonly locale: string;
  readonly fields: LivePreviewFields;
}

export interface EntryPatch extends Envelope {
  readonly kind: 'entry.patch';
  readonly rev: number;
  readonly entryId: string;
  readonly locale: string;
  readonly fields: LivePreviewFields;
}

export interface SelectMessage extends Envelope {
  readonly kind: 'select';
  readonly ref: ContentRef | null;
}

/** How a proposed change touches a block, by its `_key`. */
export type ProposalMark = 'inserted' | 'updated' | 'moved';

/** Most block keys one proposal marks. */
export const PROPOSAL_MARK_LIMIT = 1000;

/**
 * Coworker's proposed change to an entry, shown as ghosts and never saved. The
 * admin applies the proposed block patch itself and sends the resulting
 * top-level field values, so the page needs no patch engine: it renders
 * `fields` over the unsaved state and styles the marked blocks. `removed`
 * names blocks the proposal deletes (absent from `fields`), for the admin's
 * overlay or a page that wants to show them struck out.
 */
export interface ProposalShow extends Envelope {
  readonly kind: 'proposal.show';
  readonly entryId: string;
  readonly locale: string;
  readonly fields: LivePreviewFields;
  readonly marks: Readonly<Record<string, ProposalMark>>;
  readonly removed: readonly string[];
}

/** Takes the proposal away: accepted (the unsaved state now holds it) or dismissed. */
export interface ProposalClear extends Envelope {
  readonly kind: 'proposal.clear';
  readonly entryId: string;
  readonly locale: string;
}

export interface ScrollMessage extends Envelope {
  readonly kind: 'scroll';
  readonly ref: ContentRef;
}

export interface PageMessage extends Envelope {
  readonly kind: 'page';
  readonly url: string;
  readonly entries: readonly PageEntry[];
}

export interface NavigatedMessage extends Envelope {
  readonly kind: 'navigated';
  readonly url: string;
}

export interface PointerMessage extends Envelope {
  readonly kind: 'pointer';
  readonly pointer: 'hover' | 'click';
  readonly ref: ContentRef;
  readonly rect: PreviewRect;
}

export interface AppliedMessage extends Envelope {
  readonly kind: 'applied';
  readonly entryId: string;
  readonly locale: string;
  readonly rev: number;
}

export interface FailedMessage extends Envelope {
  readonly kind: 'failed';
  readonly entryId: string;
  readonly locale: string;
  readonly rev: number;
  readonly reason: FailReason;
}

/** Admin → frontend. */
export type HostMessage =
  | ConnectRequest
  | ConnectAccept
  | ConnectReject
  | EntryState
  | EntryPatch
  | SelectMessage
  | ScrollMessage
  | ProposalShow
  | ProposalClear;

/** Frontend → admin. */
export type GuestMessage =
  | ConnectOffer
  | PageMessage
  | NavigatedMessage
  | PointerMessage
  | AppliedMessage
  | FailedMessage;

/** What a host message needs the page to have allowed; connect messages need nothing. */
export const HOST_MESSAGE_CAPABILITY: Readonly<
  Record<HostMessage['kind'], LivePreviewCapability | null>
> = {
  'connect.request': null,
  'connect.accept': null,
  'connect.reject': null,
  'entry.state': 'patch.fields',
  'entry.patch': 'patch.fields',
  select: 'select',
  scroll: 'scroll',
  'proposal.show': 'proposals',
  'proposal.clear': 'proposals',
};

/** What a guest message needs the session to have accepted. */
export const GUEST_MESSAGE_CAPABILITY: Readonly<
  Record<GuestMessage['kind'], LivePreviewCapability | null>
> = {
  'connect.offer': null,
  page: null,
  navigated: null,
  pointer: 'select',
  applied: 'patch.fields',
  failed: 'patch.fields',
};

/** The highest version both sides speak, or undefined when they share none. */
export function negotiateVersion(
  offered: readonly number[],
  supported: readonly number[] = LIVE_PREVIEW_VERSIONS,
): number | undefined {
  let best: number | undefined;
  for (const v of offered) {
    if (supported.includes(v) && (best === undefined || v > best)) best = v;
  }
  return best;
}

/**
 * The capabilities a session uses: what the page offered, narrowed to what the
 * admin allows. Names this build doesn't know are dropped, so a newer page can
 * offer more than an older admin understands.
 */
export function narrowCapabilities(
  offered: readonly string[],
  allowed: readonly LivePreviewCapability[] = LIVE_PREVIEW_CAPABILITIES,
): LivePreviewCapability[] {
  return LIVE_PREVIEW_CAPABILITIES.filter((c) => offered.includes(c) && allowed.includes(c));
}

/** A fresh channel id: 128 random bits, base64url. */
export function newChannel(random: Pick<Crypto, 'getRandomValues'> = globalThis.crypto): string {
  const bytes = random.getRandomValues(new Uint8Array(16));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const CHANNEL = /^[A-Za-z0-9_-]{22,64}$/;

/** The part of a `MessageEvent` the checks read. */
export interface IncomingMessage {
  readonly data: unknown;
  readonly origin: string;
  readonly source: unknown;
}

export interface AcceptContext {
  /** Whether `origin` may talk to this side. */
  readonly origin: (origin: string) => boolean;
  /** The one window allowed to send: the iframe's `contentWindow`, or `window.parent`. */
  readonly source: unknown;
  /**
   * The session's channel. Undefined only on the admin before a session
   * exists, where the one acceptable message is a `connect.offer` with a
   * well-formed new channel.
   */
  readonly channel: string | undefined;
}

export type Verdict<M> = { ok: true; message: M } | { ok: false; reason: DropReason };

export type DropReason = 'foreign' | 'origin' | 'source' | 'channel' | 'unknown' | 'shape';

const GUEST_KINDS = new Set<string>(Object.keys(GUEST_MESSAGE_CAPABILITY));
const HOST_KINDS = new Set<string>(Object.keys(HOST_MESSAGE_CAPABILITY));

/**
 * The three checks every message passes before anything reads it: the sender's
 * origin, the sender's window, and the session's channel. Each catches what the
 * other two miss: a page on an allowed origin in another tab fails the window
 * check, our own iframe navigated somewhere else fails the origin check, and a
 * stale page load of the right site in the right frame fails the channel check.
 * Only then is the message's shape validated, and a message that fails it is
 * dropped whole, never partly applied.
 *
 * `'foreign'` means the message isn't ours at all (no mark), and `'unknown'`
 * that it is a kind this build doesn't know (a newer peer's additive message):
 * callers ignore both without counting them as drops.
 */
export function acceptGuestMessage(
  event: IncomingMessage,
  ctx: AcceptContext,
): Verdict<GuestMessage> {
  const pre = precheck(event, ctx);
  if (pre) return { ok: false, reason: pre };
  const data = event.data as Record<string, unknown>;
  if (ctx.channel === undefined || data.kind === 'connect.offer') {
    // An offer starts a session, so it brings its own channel.
    if (data.kind !== 'connect.offer' || typeof data.channel !== 'string') {
      return { ok: false, reason: 'channel' };
    }
    if (!CHANNEL.test(data.channel)) return { ok: false, reason: 'channel' };
  } else if (data.channel !== ctx.channel) {
    return { ok: false, reason: 'channel' };
  }
  if (typeof data.kind !== 'string' || !GUEST_KINDS.has(data.kind)) {
    return { ok: false, reason: 'unknown' };
  }
  const message = parseGuestMessage(data);
  return message ? { ok: true, message } : { ok: false, reason: 'shape' };
}

/** The frontend's side of the same checks, for messages from the admin. */
export function acceptHostMessage(
  event: IncomingMessage,
  ctx: AcceptContext & { readonly channel: string },
): Verdict<HostMessage> {
  const pre = precheck(event, ctx);
  if (pre) return { ok: false, reason: pre };
  const data = event.data as Record<string, unknown>;
  // A connect request is the one message without the page's channel: the
  // admin sending it doesn't know one yet.
  if (data.kind !== 'connect.request' && data.channel !== ctx.channel) {
    return { ok: false, reason: 'channel' };
  }
  if (typeof data.kind !== 'string' || !HOST_KINDS.has(data.kind)) {
    return { ok: false, reason: 'unknown' };
  }
  const message = parseHostMessage(data);
  return message ? { ok: true, message } : { ok: false, reason: 'shape' };
}

function precheck(event: IncomingMessage, ctx: AcceptContext): DropReason | undefined {
  const data = event.data;
  if (!isRecord(data) || data.cw !== LIVE_PREVIEW_MARK) return 'foreign';
  if (!ctx.origin(event.origin)) return 'origin';
  if (event.source == null || event.source !== ctx.source) return 'source';
  return undefined;
}

// ---- shapes ---------------------------------------------------------------

const MAX_DEPTH = 64;
const MAX_NODES = 100_000;
const MAX_STRING = 64;
const MAX_URL = 4096;
/** Total characters of string data in one message's fields, about 32 MB as UTF-16. */
const MAX_CHARS = 16_000_000;

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Normalizes an origin the channel may talk to, or throws. `https:` anywhere,
 * `http:` only on loopback for local development: on a plain-http origin
 * anyone on the network path could put a page in the frame and receive drafts.
 */
export function previewOrigin(value: string, what = 'origin'): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${what} must be an origin like https://admin.example.com, not ${value}`);
  }
  const ok =
    url.origin === value &&
    (url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname)));
  if (!ok) {
    throw new Error(
      `${what} must be an origin like https://admin.example.com (http only on localhost), not ${value}`,
    );
  }
  return url.origin;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return false;
  const proto = Object.getPrototypeOf(x);
  return proto === Object.prototype || proto === null;
}

const isVersion = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) > 0;
const isRev = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0;
const isId = (x: unknown): x is string => typeof x === 'string' && x.length > 0 && x.length <= 256;
const isShort = (x: unknown): x is string =>
  typeof x === 'string' && x.length > 0 && x.length <= MAX_STRING;
const isUrl = (x: unknown): x is string => {
  if (typeof x !== 'string' || x.length > MAX_URL) return false;
  try {
    const u = new URL(x);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
};

/**
 * Plain JSON data: objects, arrays, strings, finite numbers, booleans and null,
 * bounded in depth and size. `postMessage` can carry far more (dates, maps,
 * blobs, cycles), none of which is a field value.
 */
export function isJsonData(x: unknown): boolean {
  let nodes = 0;
  let chars = 0;
  const seen = new Set<object>();
  const count = (text: string) => {
    chars += text.length;
    return chars <= MAX_CHARS;
  };
  const walk = (v: unknown, depth: number): boolean => {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) return false;
    if (typeof v === 'string') return count(v);
    if (v === null || typeof v === 'boolean') return true;
    if (typeof v === 'number') return Number.isFinite(v);
    if (typeof v !== 'object') return false;
    if (seen.has(v)) return false;
    seen.add(v);
    if (Array.isArray(v)) return v.every((item) => walk(item, depth + 1));
    if (!isRecord(v)) return false;
    return Object.entries(v).every(([key, item]) => count(key) && walk(item, depth + 1));
  };
  return walk(x, 0);
}

const isFields = (x: unknown): x is LivePreviewFields => isRecord(x) && isJsonData(x);

function isRect(x: unknown): x is PreviewRect {
  return (
    isRecord(x) &&
    [x.x, x.y, x.width, x.height].every((n) => typeof n === 'number' && Number.isFinite(n))
  );
}

function refOf(x: unknown): ContentRef | undefined {
  if (!isRecord(x)) return undefined;
  const parts = [x.space, x.environment, x.entryId, x.contentType, x.field, x.locale];
  if (!parts.every(isId)) return undefined;
  // Round-trip through the DOM format, so a ref here is exactly a ref an
  // element could carry. Encoding throws on a lone surrogate: not a ref.
  try {
    return parseContentRef(parts.map((p) => encodeURIComponent(p as string)).join('|'));
  } catch {
    return undefined;
  }
}

const BLOCK_KEY = /^[A-Za-z0-9_-]{1,64}$/;
const isBlockKey = (x: unknown): x is string => typeof x === 'string' && BLOCK_KEY.test(x);
const isMark = (x: unknown): x is ProposalMark =>
  x === 'inserted' || x === 'updated' || x === 'moved';

function isPageEntry(x: unknown): x is PageEntry {
  return isRecord(x) && isId(x.entryId) && isId(x.contentType) && isId(x.locale);
}

const strings = (x: unknown, max: number): x is string[] =>
  Array.isArray(x) && x.length <= max && x.every(isShort);
const versions = (x: unknown): x is number[] =>
  Array.isArray(x) && x.length > 0 && x.length <= 32 && x.every(isVersion);

function base(d: Record<string, unknown>) {
  return { cw: LIVE_PREVIEW_MARK, v: d.v as number, channel: d.channel as string } as const;
}

/** Parses a message from the frontend, or returns undefined if it isn't one. */
export function parseGuestMessage(d: Record<string, unknown>): GuestMessage | undefined {
  if (!isVersion(d.v) || typeof d.channel !== 'string') return undefined;
  const b = base(d);
  switch (d.kind) {
    case 'connect.offer': {
      const sdk = d.sdk;
      if (!versions(d.versions) || !strings(d.capabilities, 32)) return undefined;
      if (!isRecord(sdk) || !isShort(sdk.name) || !isShort(sdk.version)) return undefined;
      return {
        ...b,
        kind: d.kind,
        versions: [...d.versions],
        capabilities: [...d.capabilities],
        sdk: { name: sdk.name, version: sdk.version },
      };
    }
    case 'page': {
      const entries = d.entries;
      if (!isUrl(d.url) || !Array.isArray(entries)) return undefined;
      if (entries.length > PAGE_ENTRY_LIMIT || !entries.every(isPageEntry)) return undefined;
      return {
        ...b,
        kind: d.kind,
        url: d.url,
        entries: entries.map((e) => ({
          entryId: e.entryId,
          contentType: e.contentType,
          locale: e.locale,
        })),
      };
    }
    case 'navigated':
      return isUrl(d.url) ? { ...b, kind: d.kind, url: d.url } : undefined;
    case 'pointer': {
      const ref = refOf(d.ref);
      if ((d.pointer !== 'hover' && d.pointer !== 'click') || !ref || !isRect(d.rect)) {
        return undefined;
      }
      const { x, y, width, height } = d.rect;
      return { ...b, kind: d.kind, pointer: d.pointer, ref, rect: { x, y, width, height } };
    }
    case 'applied':
      return isId(d.entryId) && isId(d.locale) && isRev(d.rev)
        ? { ...b, kind: d.kind, entryId: d.entryId, locale: d.locale, rev: d.rev }
        : undefined;
    case 'failed':
      return isId(d.entryId) &&
        isId(d.locale) &&
        isRev(d.rev) &&
        (d.reason === 'gap' || d.reason === 'render')
        ? {
            ...b,
            kind: d.kind,
            entryId: d.entryId,
            locale: d.locale,
            rev: d.rev,
            reason: d.reason,
          }
        : undefined;
    default:
      return undefined;
  }
}

/** Parses a message from the admin, or returns undefined if it isn't one. */
export function parseHostMessage(d: Record<string, unknown>): HostMessage | undefined {
  if (!isVersion(d.v) || typeof d.channel !== 'string') return undefined;
  const b = base(d);
  switch (d.kind) {
    case 'connect.request':
      return { ...b, kind: d.kind };
    case 'connect.accept': {
      const caps = d.capabilities;
      if (!isVersion(d.version) || !strings(caps, 32)) return undefined;
      return {
        ...b,
        kind: d.kind,
        version: d.version,
        capabilities: LIVE_PREVIEW_CAPABILITIES.filter((c) => caps.includes(c)),
      };
    }
    case 'connect.reject':
      return d.reason === 'unsupported-version' && versions(d.versions)
        ? { ...b, kind: d.kind, reason: d.reason, versions: [...d.versions] }
        : undefined;
    case 'entry.state':
    case 'entry.patch':
      return isRev(d.rev) && isId(d.entryId) && isId(d.locale) && isFields(d.fields)
        ? {
            ...b,
            kind: d.kind,
            rev: d.rev,
            entryId: d.entryId,
            locale: d.locale,
            fields: d.fields,
          }
        : undefined;
    case 'select': {
      if (d.ref === null) return { ...b, kind: d.kind, ref: null };
      const ref = refOf(d.ref);
      return ref ? { ...b, kind: d.kind, ref } : undefined;
    }
    case 'scroll': {
      const ref = refOf(d.ref);
      return ref ? { ...b, kind: d.kind, ref } : undefined;
    }
    case 'proposal.show': {
      const marks = d.marks;
      const removed = d.removed;
      if (!isId(d.entryId) || !isId(d.locale) || !isFields(d.fields)) return undefined;
      if (!isRecord(marks) || !Array.isArray(removed)) return undefined;
      const entries = Object.entries(marks);
      if (entries.length + removed.length > PROPOSAL_MARK_LIMIT) return undefined;
      if (!entries.every(([k, m]) => isBlockKey(k) && isMark(m))) return undefined;
      if (!removed.every(isBlockKey)) return undefined;
      return {
        ...b,
        kind: d.kind,
        entryId: d.entryId,
        locale: d.locale,
        fields: d.fields,
        marks: Object.fromEntries(entries) as Record<string, ProposalMark>,
        removed: [...removed],
      };
    }
    case 'proposal.clear':
      return isId(d.entryId) && isId(d.locale)
        ? { ...b, kind: d.kind, entryId: d.entryId, locale: d.locale }
        : undefined;
    default:
      return undefined;
  }
}
