/**
 * The live preview wire protocol: what the admin and a previewed page say to each other over
 * `postMessage` while an editor edits an entry the page is showing.
 *
 * The admin frames the customer's real frontend, sends it the entry's fields and then each edit
 * as a patch (the op vocabulary of `patchBlocks`, plus `setField` for ordinary fields), and draws
 * every overlay itself, outside the frame, from the geometry the page reports back. Unsaved edits
 * never reach the API from the page.
 *
 * Each side is untrusted to the other: the frame runs whatever the customer's site runs, and the
 * page can't know that every message claiming to be the admin is. So every message is parsed here
 * before it is acted on, in both directions, with size caps, and nothing in one is ever evaluated.
 * The admin imports these same parsers for the page's messages.
 */
import type { LivePatchOp } from './patch.js';

/** The protocol version every message carries as `cw`. */
export const LIVE_PREVIEW_PROTOCOL = 1;

/** The query parameter the admin puts on the framed page's URL; its value is the session id. */
export const LIVE_PREVIEW_SESSION_PARAM = 'cw_session';

/** The largest message either side accepts, as UTF-8 JSON. */
export const MAX_MESSAGE_BYTES = 256 * 1024;
/**
 * The largest `init`: it carries the whole entry, which can be bigger than one edit. Stored entries
 * are D1 rows (at most 2 MB), so nothing real is larger.
 */
export const MAX_INIT_BYTES = 2 * 1024 * 1024;
/** The most ops one `patch` may carry (as `patchBlocks` allows). */
export const MAX_PATCH_OPS = 100;
/** The most blocks, slots or fields one `geometry` reports; a page with more reports those nearest the viewport. */
export const MAX_GEOMETRY_ITEMS = 2000;
/** The most seams one `geometry` reports across all its slots. */
export const MAX_GEOMETRY_GAPS = 4000;

const MAX_ID = 256;
const MAX_URL = 8192;
const MAX_TEXT = 1000;
const MAX_DEPTH = 64;
const SESSION = /^[A-Za-z0-9_-]{8,128}$/;
/** Names that would reach an object's prototype if assigned; refused anywhere in a message. */
const FORBIDDEN_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

/** The shortcut keys a page forwards in edit mode; any other key stays with the page. */
export const FORWARDED_KEYS = [
  'z',
  'Escape',
  '/',
  'Delete',
  'Backspace',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
] as const;
export type ForwardedKey = (typeof FORWARDED_KEYS)[number];

/** Whether a string can be a session id (what `cw_session` carries). */
export function isLivePreviewSession(value: unknown): value is string {
  return typeof value === 'string' && SESSION.test(value);
}

// --- shapes ---------------------------------------------------------------------

/** Locale-keyed field values, as the Management API returns an entry's fields. */
export type LiveFields = Record<string, Record<string, unknown>>;

/** What every message carries: the protocol version, the session it belongs to, and its type. */
export interface LiveEnvelope<T extends string> {
  readonly cw: typeof LIVE_PREVIEW_PROTOCOL;
  readonly session: string;
  readonly type: T;
}

/**
 * One thing on the page: a block by its `_key` (`data-cw-block`), or one field by its serialized
 * content ref (`data-cw-ref`).
 */
export type LiveTarget =
  | { readonly key: string; readonly ref?: undefined }
  | { readonly ref: string; readonly key?: undefined };
/** A target, or nothing (`hover` leaving every target, `select` clearing the selection). */
export type LiveOptionalTarget =
  | LiveTarget
  | { readonly key?: undefined; readonly ref?: undefined };

/** A box in the frame's viewport, in CSS pixels. */
export interface LiveRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export type LivePreviewMode = 'edit' | 'view';

// admin → page

/** The entry being edited: its fields as the editor holds them, and which entry and locale. */
export interface LiveInitMessage extends LiveEnvelope<'init'> {
  readonly fields: LiveFields;
  readonly locale: string;
  readonly version: number;
  readonly entryId: string;
  readonly contentType: string;
  /**
   * The last patch `seq` these fields already include. Lets the admin re-send the whole entry
   * mid-session (after the page refused a patch) without its next patch being taken as stale.
   */
  readonly seq?: number;
}

/** Edits since the last patch, in order. `seq` only goes up; a patch at or below the last is stale. */
export interface LivePatchMessage extends LiveEnvelope<'patch'> {
  readonly seq: number;
  readonly ops: readonly LivePatchOp[];
}

export type LiveSelectMessage = LiveEnvelope<'select'> & LiveOptionalTarget;
export type LiveHoverMessage = LiveEnvelope<'hover'> & LiveOptionalTarget;
export type LiveScrollToMessage = LiveEnvelope<'scrollTo'> & LiveTarget;
export interface LiveModeMessage extends LiveEnvelope<'mode'> {
  readonly mode: LivePreviewMode;
}

export type LiveAdminMessage =
  | LiveInitMessage
  | LivePatchMessage
  | LiveSelectMessage
  | LiveHoverMessage
  | LiveScrollToMessage
  | LiveModeMessage;

// page → admin

export interface LiveHelloMessage extends LiveEnvelope<'hello'> {
  readonly sdkVersion: string;
  readonly capabilities: readonly string[];
}

/** Everything up to and including `seq` is on screen. */
export interface LiveRenderedMessage extends LiveEnvelope<'rendered'> {
  readonly seq: number;
}

export interface LiveBlockBox {
  readonly key: string;
  readonly rect: LiveRect;
  /** The slot it sits in (`data-cw-slot`), and the block that slot belongs to. */
  readonly slot?: string;
  readonly parentKey?: string;
}

/**
 * A place a block can be inserted: `index` in the slot, between `after` and `before` (absent at
 * the slot's start or end). `axis` is the direction the slot's blocks run (`y` stacked, `x` side by
 * side), so the seam is drawn across it.
 */
export interface LiveGap {
  readonly index: number;
  readonly rect: LiveRect;
  readonly axis: 'x' | 'y';
  readonly after?: string;
  readonly before?: string;
}

export interface LiveSlotBox {
  /** A top-level blocks field's apiId, or the slot's apiId on `parentKey`'s block. */
  readonly path: string;
  readonly parentKey?: string;
  readonly rect: LiveRect;
  readonly gaps: readonly LiveGap[];
}

export interface LiveFieldBox {
  readonly ref: string;
  readonly rect: LiveRect;
}

/** Where everything is, in the frame's viewport. */
export interface LiveGeometryMessage extends LiveEnvelope<'geometry'> {
  readonly blocks: readonly LiveBlockBox[];
  readonly slots: readonly LiveSlotBox[];
  readonly fields: readonly LiveFieldBox[];
  readonly scroll: { readonly x: number; readonly y: number };
  readonly viewport: { readonly w: number; readonly h: number };
  readonly docHeight: number;
  /**
   * Some boxes were left out to fit the caps and the message size; those on screen and nearest it
   * are kept first. Absent when everything is reported.
   */
  readonly truncated?: true;
}

export type LivePickMessage = LiveEnvelope<'pick'> & LiveTarget;
export type LiveGuestHoverMessage = LiveEnvelope<'hover'> & LiveOptionalTarget;

/** A link the editor clicked in edit mode; the page never follows it itself. */
export interface LiveNavigateMessage extends LiveEnvelope<'navigate'> {
  readonly url: string;
}

/** A forwarded shortcut. */
export interface LiveKeyMessage extends LiveEnvelope<'key'> {
  readonly key: ForwardedKey;
  readonly meta: boolean;
  readonly ctrl: boolean;
  readonly shift: boolean;
  readonly alt: boolean;
}

export type LiveErrorKind = 'invalid' | 'patch' | 'render' | 'target';
/**
 * Something went wrong. For `patch`, `seq` is the patch that was refused or lost; the page is out of
 * step from it, drops every later patch (answering this again) and waits for an `init`. For
 * `render`, it is the last seq that call held; nothing from it is acknowledged until a render
 * that includes it succeeds.
 */
export interface LiveErrorMessage extends LiveEnvelope<'error'> {
  readonly kind: LiveErrorKind;
  readonly message: string;
  readonly seq?: number;
}

export type LiveGuestMessage =
  | LiveHelloMessage
  | LiveRenderedMessage
  | LiveGeometryMessage
  | LivePickMessage
  | LiveGuestHoverMessage
  | LiveNavigateMessage
  | LiveKeyMessage
  | LiveErrorMessage;

// --- parsing ---------------------------------------------------------------------

/**
 * A parsed message, or why not: `foreign` (not this protocol or session: ignore it quietly),
 * `unknown` (a type this side doesn't speak: ignore it, the other side may be newer), `too-large`
 * or `invalid` (ours, but malformed: worth an `error` back).
 */
export type LiveParse<M> =
  | { readonly ok: true; readonly message: M }
  | { readonly ok: false; readonly reason: 'foreign' | 'unknown' | 'too-large' | 'invalid' };

const ADMIN_TYPES = new Set(['init', 'patch', 'select', 'hover', 'scrollTo', 'mode']);
const GUEST_TYPES = new Set([
  'hello',
  'rendered',
  'geometry',
  'pick',
  'hover',
  'navigate',
  'key',
  'error',
]);
const ERROR_KINDS = new Set<string>(['invalid', 'patch', 'render', 'target']);

/** Parses what the admin sent a page. `session` is the page's own. */
export function parseAdminMessage(data: unknown, session: string): LiveParse<LiveAdminMessage> {
  const head = envelope(data, session, ADMIN_TYPES);
  if (!head.ok) return head;
  const m = data as Record<string, unknown>;
  const cap = m.type === 'init' ? MAX_INIT_BYTES : MAX_MESSAGE_BYTES;
  if (!withinBytes(m, cap)) return { ok: false, reason: 'too-large' };
  if (!clean(m)) return { ok: false, reason: 'invalid' };
  return checked(m, adminValid(m));
}

/** What the admin expects of a message from the page it framed. */
export interface LiveGuestExpectation {
  /** The session id the admin minted for this framing (fresh and random, per frame load). */
  readonly session: string;
  /** The framed page's origin: the frame's `src` origin. */
  readonly origin: string;
  /** The frame's window (`iframe.contentWindow`). */
  readonly source: unknown;
  /**
   * The origins a `navigate` may name; others are refused. Default: the page's own origin, so a
   * page can't send the editor (or, framed again with a session, the session) anywhere else.
   */
  readonly navigateOrigins?: readonly string[];
}

/**
 * Parses what a page sent the admin. The session alone is no proof: it sits in the frame's URL,
 * readable by every script on the page and wherever the frame navigates, so the event's origin
 * and source are checked first, as the page checks the admin's. A message that parses is rebuilt
 * from its validated fields, so nothing else the page put in it reaches the admin.
 */
export function parseGuestMessage(
  event: { readonly data: unknown; readonly origin: string; readonly source: unknown },
  expected: LiveGuestExpectation,
): LiveParse<LiveGuestMessage> {
  if (event.origin !== expected.origin || event.source !== expected.source) {
    return { ok: false, reason: 'foreign' };
  }
  const head = envelope(event.data, expected.session, GUEST_TYPES);
  if (!head.ok) return head;
  const m = event.data as Record<string, unknown>;
  if (!withinBytes(m, MAX_MESSAGE_BYTES)) return { ok: false, reason: 'too-large' };
  if (!clean(m)) return { ok: false, reason: 'invalid' };
  const body = guestBody(m, expected.navigateOrigins ?? [expected.origin]);
  if (!body) return { ok: false, reason: 'invalid' };
  return {
    ok: true,
    message: { cw: LIVE_PREVIEW_PROTOCOL, session: expected.session, ...body } as LiveGuestMessage,
  };
}

function checked<M>(m: Record<string, unknown>, valid: boolean): LiveParse<M> {
  return valid ? { ok: true, message: m as M } : { ok: false, reason: 'invalid' };
}

function envelope(
  data: unknown,
  session: string,
  types: ReadonlySet<string>,
): { ok: true } | { ok: false; reason: 'foreign' | 'unknown' } {
  if (!isRecord(data) || data.cw !== LIVE_PREVIEW_PROTOCOL || data.session !== session) {
    return { ok: false, reason: 'foreign' };
  }
  if (typeof data.type !== 'string' || !types.has(data.type))
    return { ok: false, reason: 'unknown' };
  return { ok: true };
}

/**
 * Whether `value` serializes to at most `cap` bytes of UTF-8 JSON. A value JSON can't serialize
 * (a cycle, a BigInt, nesting deep enough to overflow) is over every cap.
 */
function withinBytes(value: unknown, cap: number): boolean {
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    return false;
  }
  // UTF-8 is never shorter than UTF-16 code units, so a long string is over without encoding it.
  if (json.length > cap) return false;
  return new TextEncoder().encode(json).byteLength <= cap;
}

/**
 * Plain data only, anywhere in `value`: no prototype-reaching names, no absurd nesting, and no
 * object that isn't a plain one (structured clone carries Maps, Dates and ArrayBuffers, which JSON
 * measures as `{}`).
 */
export function clean(value: unknown, depth = 0): boolean {
  if (depth > MAX_DEPTH) return false;
  if (Array.isArray(value)) return value.every((v) => clean(v, depth + 1));
  if (typeof value !== 'object' || value === null) return true;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  for (const [name, held] of Object.entries(value)) {
    if (FORBIDDEN_NAMES.has(name) || !clean(held, depth + 1)) return false;
  }
  return true;
}

function adminValid(m: Record<string, unknown>): boolean {
  switch (m.type) {
    case 'init':
      return (
        isFields(m.fields) &&
        isName(m.locale) &&
        isCount(m.version) &&
        isId(m.entryId) &&
        isId(m.contentType) &&
        (m.seq === undefined || isCount(m.seq))
      );
    case 'patch':
      return (
        isCount(m.seq) && Array.isArray(m.ops) && m.ops.length <= MAX_PATCH_OPS && m.ops.every(isOp)
      );
    case 'select':
    case 'hover':
      return isOptionalTarget(m);
    case 'scrollTo':
      return isTarget(m);
    case 'mode':
      return m.mode === 'edit' || m.mode === 'view';
    default:
      return false;
  }
}

type Body = Record<string, unknown>;

/** A page message's validated fields, freshly built; undefined when any is malformed. */
function guestBody(
  m: Record<string, unknown>,
  navigateOrigins: readonly string[],
): Body | undefined {
  switch (m.type) {
    case 'hello':
      return isText(m.sdkVersion, 64) &&
        Array.isArray(m.capabilities) &&
        m.capabilities.length <= 32 &&
        m.capabilities.every((c) => isText(c, 64))
        ? { type: 'hello', sdkVersion: m.sdkVersion, capabilities: [...m.capabilities] }
        : undefined;
    case 'rendered':
      return isCount(m.seq) ? { type: 'rendered', seq: m.seq } : undefined;
    case 'geometry':
      return geometryBody(m);
    case 'pick': {
      const target = targetBody(m);
      return target ? { type: 'pick', ...target } : undefined;
    }
    case 'hover': {
      if (m.key === undefined && m.ref === undefined) return { type: 'hover' };
      const target = targetBody(m);
      return target ? { type: 'hover', ...target } : undefined;
    }
    case 'navigate':
      return isNavigable(m.url, navigateOrigins) ? { type: 'navigate', url: m.url } : undefined;
    case 'key':
      return (FORWARDED_KEYS as readonly unknown[]).includes(m.key) &&
        [m.meta, m.ctrl, m.shift, m.alt].every((b) => typeof b === 'boolean')
        ? { type: 'key', key: m.key, meta: m.meta, ctrl: m.ctrl, shift: m.shift, alt: m.alt }
        : undefined;
    case 'error':
      return typeof m.kind === 'string' &&
        ERROR_KINDS.has(m.kind) &&
        isText(m.message, MAX_TEXT) &&
        optional(m.seq, isCount)
        ? {
            type: 'error',
            kind: m.kind,
            message: m.message,
            ...(m.seq !== undefined ? { seq: m.seq } : {}),
          }
        : undefined;
    default:
      return undefined;
  }
}

// --- the ops -------------------------------------------------------------------------

function isOp(value: unknown): boolean {
  if (!isRecord(value) || !isName(value.field) || !isName(value.locale)) return false;
  switch (value.op) {
    case 'setField':
      return true;
    case 'insert':
      return isRecord(value.block) && isPlace(value) && optional(value.ref, isId);
    case 'update':
      return (
        isId(value.key) &&
        optional(value.set, isRecord) &&
        optional(value.unset, (u) => Array.isArray(u) && u.every(isName))
      );
    case 'move':
      return isId(value.key) && isRecord(value.to) && isPlace(value.to);
    case 'remove':
      return isId(value.key);
    case 'duplicate':
      return isId(value.key) && optional(value.ref, isId);
    default:
      return false;
  }
}

function isPlace(value: Record<string, unknown>): boolean {
  return (
    optional(value.parent, (p) => isRecord(p) && isId(p.key) && isName(p.slot)) &&
    optional(value.before, isId) &&
    optional(value.after, isId) &&
    optional(value.index, isCount)
  );
}

function isFields(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return Object.entries(value).every(
    ([name, held]) => isName(name) && isRecord(held) && Object.keys(held).every(isName),
  );
}

// --- geometry -----------------------------------------------------------------------

function geometryBody(m: Record<string, unknown>): Body | undefined {
  const { blocks, slots, fields, scroll, viewport, docHeight } = m;
  if (!Array.isArray(blocks) || blocks.length > MAX_GEOMETRY_ITEMS) return undefined;
  if (!Array.isArray(slots) || slots.length > MAX_GEOMETRY_ITEMS) return undefined;
  if (!Array.isArray(fields) || fields.length > MAX_GEOMETRY_ITEMS) return undefined;
  if (!isRecord(scroll) || !isNumber(scroll.x) || !isNumber(scroll.y)) return undefined;
  if (!isRecord(viewport) || !isNumber(viewport.w) || !isNumber(viewport.h)) return undefined;
  if (!isNumber(docHeight) || (m.truncated !== undefined && m.truncated !== true)) return undefined;
  const outBlocks: LiveBlockBox[] = [];
  for (const b of blocks) {
    if (!isRecord(b) || !isId(b.key) || !isRect(b.rect)) return undefined;
    if (!optional(b.slot, isId) || !optional(b.parentKey, isId)) return undefined;
    outBlocks.push({
      key: b.key,
      rect: rectBody(b.rect),
      ...(b.slot !== undefined ? { slot: b.slot as string } : {}),
      ...(b.parentKey !== undefined ? { parentKey: b.parentKey as string } : {}),
    });
  }
  const outSlots: LiveSlotBox[] = [];
  let gapCount = 0;
  for (const s of slots) {
    if (!isRecord(s) || !isId(s.path) || !optional(s.parentKey, isId) || !isRect(s.rect)) {
      return undefined;
    }
    if (!Array.isArray(s.gaps)) return undefined;
    gapCount += s.gaps.length;
    if (gapCount > MAX_GEOMETRY_GAPS) return undefined;
    const gaps: LiveGap[] = [];
    for (const g of s.gaps) {
      const gap = gapBody(g);
      if (!gap) return undefined;
      gaps.push(gap);
    }
    outSlots.push({
      path: s.path,
      rect: rectBody(s.rect),
      gaps,
      ...(s.parentKey !== undefined ? { parentKey: s.parentKey as string } : {}),
    });
  }
  const outFields: LiveFieldBox[] = [];
  for (const f of fields) {
    if (!isRecord(f) || !isRef(f.ref) || !isRect(f.rect)) return undefined;
    outFields.push({ ref: f.ref, rect: rectBody(f.rect) });
  }
  return {
    type: 'geometry',
    blocks: outBlocks,
    slots: outSlots,
    fields: outFields,
    scroll: { x: scroll.x, y: scroll.y },
    viewport: { w: viewport.w, h: viewport.h },
    docHeight,
    ...(m.truncated ? { truncated: true } : {}),
  };
}

function gapBody(g: unknown): LiveGap | undefined {
  if (!isRecord(g) || !isCount(g.index) || (g.axis !== 'x' && g.axis !== 'y')) return undefined;
  if (!isRect(g.rect) || !optional(g.after, isId) || !optional(g.before, isId)) return undefined;
  return {
    index: g.index as number,
    rect: rectBody(g.rect),
    axis: g.axis,
    ...(g.after !== undefined ? { after: g.after as string } : {}),
    ...(g.before !== undefined ? { before: g.before as string } : {}),
  };
}

const rectBody = (r: LiveRect): LiveRect => ({ x: r.x, y: r.y, w: r.w, h: r.h });

function targetBody(m: Record<string, unknown>): LiveTarget | undefined {
  if (!isTarget(m)) return undefined;
  return m.key !== undefined ? { key: m.key as string } : { ref: m.ref as string };
}

function isRect(r: unknown): r is LiveRect {
  return isRecord(r) && isNumber(r.x) && isNumber(r.y) && isNumber(r.w) && isNumber(r.h);
}

// --- primitives -----------------------------------------------------------------------

function isTarget(m: Record<string, unknown>): boolean {
  return m.key !== undefined ? m.ref === undefined && isId(m.key) : isRef(m.ref);
}

function isOptionalTarget(m: Record<string, unknown>): boolean {
  return (m.key === undefined && m.ref === undefined) || isTarget(m);
}

/** An https URL, or http on this machine (a frontend in development). */
export function isPreviewUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname));
  } catch {
    return false;
  }
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

function isNavigable(value: unknown, origins: readonly string[]): value is string {
  return isText(value, MAX_URL) && isPreviewUrl(value) && origins.includes(new URL(value).origin);
}

const isNumber = (n: unknown): boolean => typeof n === 'number' && Number.isFinite(n);
const isCount = (n: unknown): boolean => Number.isSafeInteger(n) && (n as number) >= 0;
const isText = (s: unknown, max: number): s is string =>
  typeof s === 'string' && s.length > 0 && s.length <= max;
/**
 * A key, name or id: bounded, and never one that reaches a prototype when used as a property
 * name, since either side may index by it.
 */
const isId = (s: unknown): s is string => isText(s, MAX_ID) && !FORBIDDEN_NAMES.has(s);
const isName = isId;
const isRef = (s: unknown): s is string => isText(s, MAX_ID * 4) && !FORBIDDEN_NAMES.has(s);
const optional = (v: unknown, test: (v: unknown) => boolean): boolean => v === undefined || test(v);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether a name is safe to assign as an own property (not one that reaches a prototype). */
export function isSafeName(name: string): boolean {
  return !FORBIDDEN_NAMES.has(name);
}
