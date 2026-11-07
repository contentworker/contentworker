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
/** The most blocks, slots or fields one `geometry` reports; a page with more reports the first. */
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
export interface LiveErrorMessage extends LiveEnvelope<'error'> {
  readonly kind: LiveErrorKind;
  readonly message: string;
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
  if (!clean(m, 0)) return { ok: false, reason: 'invalid' };
  return checked(m, adminValid(m));
}

/** Parses what a page sent the admin. `session` is the one the admin gave the frame. */
export function parseGuestMessage(data: unknown, session: string): LiveParse<LiveGuestMessage> {
  const head = envelope(data, session, GUEST_TYPES);
  if (!head.ok) return head;
  const m = data as Record<string, unknown>;
  if (!withinBytes(m, MAX_MESSAGE_BYTES)) return { ok: false, reason: 'too-large' };
  return checked(m, guestValid(m));
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

/** No prototype-reaching names and no absurd nesting, anywhere in the message. */
function clean(value: unknown, depth: number): boolean {
  if (depth > MAX_DEPTH) return false;
  if (Array.isArray(value)) return value.every((v) => clean(v, depth + 1));
  if (!isRecord(value)) return true;
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

function guestValid(m: Record<string, unknown>): boolean {
  switch (m.type) {
    case 'hello':
      return (
        isText(m.sdkVersion, 64) &&
        Array.isArray(m.capabilities) &&
        m.capabilities.length <= 32 &&
        m.capabilities.every((c) => isText(c, 64))
      );
    case 'rendered':
      return isCount(m.seq);
    case 'geometry':
      return isGeometry(m);
    case 'pick':
      return isTarget(m);
    case 'hover':
      return isOptionalTarget(m);
    case 'navigate':
      return isHttpUrl(m.url);
    case 'key':
      return (
        (FORWARDED_KEYS as readonly unknown[]).includes(m.key) &&
        [m.meta, m.ctrl, m.shift, m.alt].every((b) => typeof b === 'boolean')
      );
    case 'error':
      return typeof m.kind === 'string' && ERROR_KINDS.has(m.kind) && isText(m.message, MAX_TEXT);
    default:
      return false;
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

function isGeometry(m: Record<string, unknown>): boolean {
  const { blocks, slots, fields, scroll, viewport } = m;
  if (!Array.isArray(blocks) || blocks.length > MAX_GEOMETRY_ITEMS) return false;
  if (!Array.isArray(slots) || slots.length > MAX_GEOMETRY_ITEMS) return false;
  if (!Array.isArray(fields) || fields.length > MAX_GEOMETRY_ITEMS) return false;
  let gaps = 0;
  for (const s of slots) {
    if (!isRecord(s) || !isName(s.path) || !optional(s.parentKey, isId) || !isRect(s.rect)) {
      return false;
    }
    if (!Array.isArray(s.gaps)) return false;
    gaps += s.gaps.length;
    if (gaps > MAX_GEOMETRY_GAPS || !s.gaps.every(isGap)) return false;
  }
  return (
    blocks.every(
      (b) =>
        isRecord(b) &&
        isId(b.key) &&
        isRect(b.rect) &&
        optional(b.slot, isName) &&
        optional(b.parentKey, isId),
    ) &&
    fields.every((f) => isRecord(f) && isText(f.ref, MAX_ID * 4) && isRect(f.rect)) &&
    isRecord(scroll) &&
    isNumber(scroll.x) &&
    isNumber(scroll.y) &&
    isRecord(viewport) &&
    isNumber(viewport.w) &&
    isNumber(viewport.h) &&
    isNumber(m.docHeight)
  );
}

function isGap(g: unknown): boolean {
  return (
    isRecord(g) &&
    isCount(g.index) &&
    isRect(g.rect) &&
    (g.axis === 'x' || g.axis === 'y') &&
    optional(g.after, isId) &&
    optional(g.before, isId)
  );
}

function isRect(r: unknown): boolean {
  return isRecord(r) && isNumber(r.x) && isNumber(r.y) && isNumber(r.w) && isNumber(r.h);
}

// --- primitives -----------------------------------------------------------------------

function isTarget(m: Record<string, unknown>): boolean {
  return m.key !== undefined ? m.ref === undefined && isId(m.key) : isText(m.ref, MAX_ID * 4);
}

function isOptionalTarget(m: Record<string, unknown>): boolean {
  return (m.key === undefined && m.ref === undefined) || isTarget(m);
}

function isHttpUrl(value: unknown): boolean {
  if (!isText(value, MAX_URL)) return false;
  try {
    const { protocol } = new URL(value);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

const isNumber = (n: unknown): boolean => typeof n === 'number' && Number.isFinite(n);
const isCount = (n: unknown): boolean => Number.isSafeInteger(n) && (n as number) >= 0;
const isText = (s: unknown, max: number): s is string =>
  typeof s === 'string' && s.length > 0 && s.length <= max;
const isId = (s: unknown): boolean => isText(s, MAX_ID);
/** A field, slot or locale name: an id that can't reach a prototype when assigned. */
const isName = (s: unknown): boolean => isId(s) && !FORBIDDEN_NAMES.has(s as string);
const optional = (v: unknown, test: (v: unknown) => boolean): boolean => v === undefined || test(v);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether a name is safe to assign as an own property (not one that reaches a prototype). */
export function isSafeName(name: string): boolean {
  return !FORBIDDEN_NAMES.has(name);
}
