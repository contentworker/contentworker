/**
 * The live preview channel's wire protocol (docs/specs/live-preview-channel.md): what the admin
 * and a framed frontend say to each other over `postMessage`, and the checks every message passes
 * before either side acts on it. The frontend half (`connectPreview`) and the admin half
 * (`apps/web`) both import this module, so they share one definition.
 *
 * Each side is untrusted to the other. Every message goes through `acceptMessage` (origin, sender,
 * channel, version), then its kind's schema; one that fails is dropped whole and counted, never
 * partly applied. A message that parses is rebuilt from its validated fields, so nothing else the
 * sender put in it reaches the receiver. Nothing in a message is ever evaluated, and no message
 * carries content as HTML or Markdown.
 */
import type { LivePatchOp } from './patch.js';

// --- versions ----------------------------------------------------------------------

/** The protocol versions this SDK's frontend half speaks, newest first. */
export const OFFERED_VERSIONS: readonly number[] = [1];

/**
 * The versions the admin speaks. Customers update the SDK in their own sites on their own
 * schedule, so the admin keeps every version a supported SDK release offers. Dropping one is a
 * breaking change, called out in the changelog. Each entry names the last SDK release that needs it.
 */
export const SUPPORTED_VERSIONS: readonly number[] = [
  1, // needed by @contentworker/sdk 0.3.0 (the first with live preview) and every later release so far
];

/** The highest version both lists hold, or undefined when they share none. */
export function negotiateVersion(
  offered: readonly unknown[],
  supported: readonly number[] = SUPPORTED_VERSIONS,
): number | undefined {
  const shared = offered.filter(
    (v): v is number => isVersion(v) && supported.includes(v as number),
  );
  return shared.length > 0 ? Math.max(...shared) : undefined;
}

// --- capabilities --------------------------------------------------------------------

/**
 * What a page lets the admin do, fixed at connect. `layout` is an extension (see the spec's
 * Extensions section): the slot and seam geometry the canvas editor draws insertion points from.
 */
export const CAPABILITIES = [
  'select',
  'patch.fields',
  'patch.blocks',
  'proposals',
  'scroll',
  'layout',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** `offered`, narrowed to what `allowed` holds: the admin can narrow, never widen. */
export function narrowCapabilities(
  offered: readonly unknown[],
  allowed: readonly unknown[] = CAPABILITIES,
): Capability[] {
  const both = CAPABILITIES.filter((c) => offered.includes(c) && allowed.includes(c));
  // Proposals are block ops rendered as ghosts: without `patch.blocks` there is no state to lay them on.
  return both.includes('patch.blocks') ? both : both.filter((c) => c !== 'proposals');
}

// --- the channel -----------------------------------------------------------------------

/** 128 bits of base64url, unpadded. */
const CHANNEL = /^[A-Za-z0-9_-]{22}$/;

/** A fresh channel: 128 random bits from `crypto.getRandomValues`, base64url. */
export function newChannel(random: Crypto = crypto): string {
  const bytes = random.getRandomValues(new Uint8Array(16));
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function isChannel(value: unknown): value is string {
  return typeof value === 'string' && CHANNEL.test(value);
}

// --- limits ------------------------------------------------------------------------------

/** The largest message either side accepts, as UTF-8 JSON. */
export const MAX_MESSAGE_BYTES = 256 * 1024;
/** The largest `entry.state`: the whole entry. Stored entries are D1 rows (at most 2 MB). */
export const MAX_STATE_BYTES = 2 * 1024 * 1024;
/** The most ops one `blocks.patch` carries (as `patchBlocks` allows). */
export const MAX_PATCH_OPS = 100;
/** The most blocks, slots or fields one `layout` reports; a page with more sends those nearest the viewport. */
export const MAX_GEOMETRY_ITEMS = 2000;
/** The most seams one `layout` reports across its slots. */
export const MAX_GEOMETRY_GAPS = 4000;
/** The most entries one `page` reports. */
export const MAX_PAGE_ENTRIES = 200;

const MAX_ID = 256;
const MAX_REF = 2048;
const MAX_URL = 8192;
const MAX_DEPTH = 64;
/** Names that would reach an object's prototype if assigned; refused anywhere in a message. */
const FORBIDDEN_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

// --- shapes --------------------------------------------------------------------------------

/** One entry's field values in one locale (not locale-keyed): what `onState` renders. */
export type LiveFields = Record<string, unknown>;

/** What every message carries. */
export interface LiveEnvelope<K extends string> {
  readonly v: number;
  readonly channel: string;
  readonly kind: K;
}

/** A box in the iframe's viewport, in CSS pixels. */
export interface LiveRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** Which entry a patch is for, and its place in that entry's order. */
interface EntryAddress {
  /** Increases by one per entry per session; `entry.state` sets it. */
  readonly rev: number;
  readonly entryId: string;
  readonly locale: string;
}

// admin → frontend

export interface ConnectAcceptMessage extends LiveEnvelope<'connect.accept'> {
  readonly version: number;
  readonly capabilities: readonly Capability[];
}
export interface ConnectRejectMessage extends LiveEnvelope<'connect.reject'> {
  readonly reason: 'unsupported-version';
  readonly versions: readonly number[];
}
/** The whole unsaved state of one entry in one locale. */
export interface EntryStateMessage extends LiveEnvelope<'entry.state'>, EntryAddress {
  readonly fields: LiveFields;
}
/** Changed top-level field values since `rev - 1`; `null` clears a field. */
export interface EntryPatchMessage extends LiveEnvelope<'entry.patch'>, EntryAddress {
  readonly fields: LiveFields;
}
/**
 * The `patchBlocks` ops on one blocks field. An op's own `field` and `locale`, when given, must
 * be the message's. An op with `proposed: true` is Coworker's proposal: rendered as a ghost, never
 * part of the fields handed to `onState`.
 */
export interface BlocksPatchMessage extends LiveEnvelope<'blocks.patch'>, EntryAddress {
  readonly field: string;
  readonly ops: readonly (LivePatchOp & { readonly proposed?: true })[];
}
export interface SelectMessage extends LiveEnvelope<'select'> {
  readonly ref: string | null;
}
export interface ScrollMessage extends LiveEnvelope<'scroll'> {
  readonly ref: string;
  /**
   * Extension: where the element lands. `center` (the default, and what a page that doesn't read
   * it does), `start` (its top edge at the top of the view) or `end` (its bottom edge at the
   * bottom), each `inset` CSS pixels clear of that edge, so the admin can keep it out from under
   * something it draws over the frame.
   */
  readonly align?: ScrollAlign;
  readonly inset?: number;
}
export type ScrollAlign = 'start' | 'center' | 'end';
/** The most an inset may be: more is no edge of any screen. */
export const MAX_SCROLL_INSET = 4000;
/** Extension: the admin turns in-page editing (picking) on or off. Needs `select`. */
export interface EditingMessage extends LiveEnvelope<'editing'> {
  readonly on: boolean;
}

export type AdminMessage =
  | ConnectAcceptMessage
  | ConnectRejectMessage
  | EntryStateMessage
  | EntryPatchMessage
  | BlocksPatchMessage
  | SelectMessage
  | ScrollMessage
  | EditingMessage;

// frontend → admin

export interface ConnectOfferMessage extends LiveEnvelope<'connect.offer'> {
  readonly versions: readonly number[];
  readonly capabilities: readonly Capability[];
  readonly sdk: { readonly name: string; readonly version: string };
}
/** What the page renders: which entries' state to send. */
export interface PageMessage extends LiveEnvelope<'page'> {
  readonly url: string;
  readonly entries: readonly {
    readonly entryId: string;
    readonly contentType: string;
    readonly locale: string;
  }[];
}
export interface NavigatedMessage extends LiveEnvelope<'navigated'> {
  readonly url: string;
}
/**
 * A marked element hovered or clicked, with its box. The spec names the hover/click field `kind`,
 * which the envelope's `kind` already holds, so it travels as `pointer`. Extension: a hover with
 * `ref` and `rect` null says the pointer left every marked element.
 */
export interface PointerMessage extends LiveEnvelope<'pointer'> {
  readonly pointer: 'hover' | 'click';
  readonly ref: string | null;
  readonly rect: LiveRect | null;
}
/** Everything for `entryId` up to `rev` is on screen. `entryId` is an extension: revs are per entry. */
export interface AppliedMessage extends LiveEnvelope<'applied'> {
  readonly rev: number;
  readonly entryId?: string;
}
/**
 * A patch didn't render: `gap` (out of order), and as extensions `invalid` (failed its schema),
 * `conflict` (its ops couldn't be placed) and `render` (`onState` threw). Every one is answered
 * with a fresh `entry.state`.
 */
export interface FailedMessage extends LiveEnvelope<'failed'> {
  readonly rev: number;
  readonly reason: FailReason;
  readonly entryId?: string;
}
export type FailReason = 'gap' | 'invalid' | 'conflict' | 'render';

/** Extension (`layout`): where blocks, slots and fields are, for the canvas editor's seams. */
export interface LayoutMessage extends LiveEnvelope<'layout'> {
  readonly blocks: readonly LiveBlockBox[];
  readonly slots: readonly LiveSlotBox[];
  readonly fields: readonly LiveFieldBox[];
  readonly scroll: { readonly x: number; readonly y: number };
  readonly viewport: { readonly w: number; readonly h: number };
  readonly docHeight: number;
  /** Some boxes were left out to fit; those on screen and nearest it are kept first. */
  readonly truncated?: true;
}
export interface LiveBlockBox {
  /** The block's ref: its field path ends with `[<key>]`. */
  readonly ref: string;
  readonly rect: LiveRect;
}
/** A place a block can go: `index` in the slot, between the blocks keyed `after` and `before`. */
export interface LiveGap {
  readonly index: number;
  readonly rect: LiveRect;
  /** The direction the slot's blocks run: `y` stacked, `x` side by side. */
  readonly axis: 'x' | 'y';
  readonly after?: string;
  readonly before?: string;
}
export interface LiveSlotBox {
  /** The slot's ref: its field path ends with the slot's field name (`body`, `body[<key>].items`). */
  readonly ref: string;
  readonly rect: LiveRect;
  readonly gaps: readonly LiveGap[];
}
export interface LiveFieldBox {
  readonly ref: string;
  readonly rect: LiveRect;
}

export type FrontendMessage =
  | ConnectOfferMessage
  | PageMessage
  | NavigatedMessage
  | PointerMessage
  | AppliedMessage
  | FailedMessage
  | LayoutMessage;

// --- the three checks -----------------------------------------------------------------------

/** What a receiver expects of a message: who may send it, on which channel, at which version. */
export interface Expected {
  /** The other side's origin: the configured `adminOrigin`, or the framed URL's origin. */
  readonly origin: string;
  /** The other side's window: `window.parent`, or `iframe.contentWindow`. */
  readonly source: unknown;
  /** The pinned channel; absent only while the admin waits for an offer (then any well-formed one). */
  readonly channel?: string;
  /** The negotiated version; absent before connect (then any positive integer). */
  readonly version?: number;
}

/**
 * The checks every message passes, in both directions, before its shape is even looked at:
 * origin, sender, channel (and version). Each catches what the others miss: the origin alone
 * admits any frame of that origin, the sender alone whatever that window navigated to, and the
 * channel ties a message to one connected page load. Returns the message's data, or undefined.
 */
export function acceptMessage(
  event: { readonly data: unknown; readonly origin: string; readonly source: unknown },
  expected: Expected,
): Record<string, unknown> | undefined {
  if (event.origin !== expected.origin) return undefined;
  if (event.source !== expected.source || event.source === null || event.source === undefined) {
    return undefined;
  }
  const data = event.data;
  if (!isRecord(data) || !isChannel(data.channel)) return undefined;
  if (expected.channel !== undefined && data.channel !== expected.channel) return undefined;
  if (expected.version !== undefined ? data.v !== expected.version : !isVersion(data.v)) {
    return undefined;
  }
  return data;
}

// --- parsing ---------------------------------------------------------------------------------

/**
 * A parsed message, or why not: `unknown` (a kind this side doesn't speak: ignore it, the other
 * side may be newer), `too-large` or `invalid` (drop it whole and count it).
 */
export type LiveParse<M> =
  | { readonly ok: true; readonly message: M }
  | { readonly ok: false; readonly reason: 'unknown' | 'too-large' | 'invalid' };

type Body = Record<string, unknown>;

const ADMIN_KINDS = new Set([
  'connect.accept',
  'connect.reject',
  'entry.state',
  'entry.patch',
  'blocks.patch',
  'select',
  'scroll',
  'editing',
]);
const FRONTEND_KINDS = new Set([
  'connect.offer',
  'page',
  'navigated',
  'pointer',
  'applied',
  'failed',
  'layout',
]);
const FAIL_REASONS = new Set<string>(['gap', 'invalid', 'conflict', 'render']);

/** Parses, after `acceptMessage`, what the admin sent the frontend. */
export function parseAdminMessage(data: Record<string, unknown>): LiveParse<AdminMessage> {
  return parse(data, ADMIN_KINDS, adminBody);
}

/** Parses, after `acceptMessage`, what the frontend sent the admin. */
export function parseFrontendMessage(data: Record<string, unknown>): LiveParse<FrontendMessage> {
  return parse(data, FRONTEND_KINDS, frontendBody);
}

function parse<M>(
  data: Record<string, unknown>,
  kinds: ReadonlySet<string>,
  body: (m: Record<string, unknown>) => Body | undefined,
): LiveParse<M> {
  if (typeof data.kind !== 'string' || !kinds.has(data.kind))
    return { ok: false, reason: 'unknown' };
  // The bounded walk first: structured clone can deliver a 100-byte message holding a list of a
  // hundred million holes, or a typed array, which JSON would spend seconds measuring.
  if (!clean(data)) return { ok: false, reason: 'invalid' };
  const cap = data.kind === 'entry.state' ? MAX_STATE_BYTES : MAX_MESSAGE_BYTES;
  if (!withinBytes(data, cap)) return { ok: false, reason: 'too-large' };
  const built = body(data);
  if (!built) return { ok: false, reason: 'invalid' };
  return { ok: true, message: { v: data.v, channel: data.channel, ...built } as M };
}

/**
 * Whether the accepted capabilities allow `message`. The admin checks before it sends, the
 * frontend again when one arrives anyway; connect messages and acknowledgements need none.
 */
export function capabilityAllows(
  message: AdminMessage | FrontendMessage,
  accepted: readonly Capability[],
): boolean {
  const has = (c: Capability) => accepted.includes(c);
  switch (message.kind) {
    case 'entry.state':
      // The whole state is what either kind of patch builds on.
      return has('patch.fields') || has('patch.blocks');
    case 'entry.patch':
      return has('patch.fields');
    case 'blocks.patch':
      return message.ops.every((op) => (op.proposed ? has('proposals') : has('patch.blocks')));
    case 'select':
    case 'editing':
    case 'pointer':
      return has('select');
    case 'scroll':
      return has('scroll');
    case 'layout':
      return has('layout');
    default:
      return true;
  }
}

function adminBody(m: Record<string, unknown>): Body | undefined {
  switch (m.kind) {
    case 'connect.accept':
      return isVersion(m.version) &&
        Array.isArray(m.capabilities) &&
        m.capabilities.length <= CAPABILITIES.length * 2 &&
        m.capabilities.every((c) => typeof c === 'string')
        ? {
            kind: m.kind,
            version: m.version,
            capabilities: narrowCapabilities(m.capabilities as string[]),
          }
        : undefined;
    case 'connect.reject':
      return m.reason === 'unsupported-version' && isVersionList(m.versions)
        ? { kind: m.kind, reason: m.reason, versions: [...(m.versions as number[])] }
        : undefined;
    case 'entry.state':
    case 'entry.patch': {
      const at = address(m);
      return at && isFields(m.fields) ? { kind: m.kind, ...at, fields: m.fields } : undefined;
    }
    case 'blocks.patch': {
      const at = address(m);
      if (!at || !isName(m.field) || !Array.isArray(m.ops) || m.ops.length > MAX_PATCH_OPS) {
        return undefined;
      }
      if (m.ops.length === 0) return undefined;
      const ops: unknown[] = [];
      for (const op of m.ops) {
        if (!isRecord(op) || !isOp(op, m.field as string, at.locale)) return undefined;
        if (op.proposed !== undefined && op.proposed !== true) return undefined;
        ops.push({ ...op, field: m.field, locale: at.locale });
      }
      return { kind: m.kind, ...at, field: m.field, ops };
    }
    case 'select':
      return m.ref === null || isRef(m.ref) ? { kind: m.kind, ref: m.ref } : undefined;
    case 'scroll': {
      if (!isRef(m.ref)) return undefined;
      if (
        m.align !== undefined &&
        m.align !== 'start' &&
        m.align !== 'center' &&
        m.align !== 'end'
      ) {
        return undefined;
      }
      const inset = m.inset;
      if (
        inset !== undefined &&
        (typeof inset !== 'number' ||
          !Number.isFinite(inset) ||
          inset < 0 ||
          inset > MAX_SCROLL_INSET)
      ) {
        return undefined;
      }
      return {
        kind: m.kind,
        ref: m.ref,
        ...(m.align !== undefined ? { align: m.align } : {}),
        ...(inset !== undefined ? { inset } : {}),
      };
    }
    case 'editing':
      return typeof m.on === 'boolean' ? { kind: m.kind, on: m.on } : undefined;
    default:
      return undefined;
  }
}

function frontendBody(m: Record<string, unknown>): Body | undefined {
  switch (m.kind) {
    case 'connect.offer': {
      const sdk = m.sdk;
      if (!isVersionList(m.versions) || (m.versions as number[]).length === 0) return undefined;
      if (!Array.isArray(m.capabilities) || m.capabilities.length > CAPABILITIES.length * 2) {
        return undefined;
      }
      if (!isRecord(sdk) || !isText(sdk.name, 64) || !isText(sdk.version, 64)) return undefined;
      return {
        kind: m.kind,
        versions: [...(m.versions as number[])],
        capabilities: narrowCapabilities(m.capabilities),
        sdk: { name: sdk.name, version: sdk.version },
      };
    }
    case 'page': {
      if (!isUrl(m.url) || !Array.isArray(m.entries) || m.entries.length > MAX_PAGE_ENTRIES) {
        return undefined;
      }
      const entries = [];
      for (const e of m.entries) {
        if (!isRecord(e) || !isId(e.entryId) || !isId(e.contentType) || !isName(e.locale)) {
          return undefined;
        }
        entries.push({ entryId: e.entryId, contentType: e.contentType, locale: e.locale });
      }
      return { kind: m.kind, url: m.url, entries };
    }
    case 'navigated':
      return isUrl(m.url) ? { kind: m.kind, url: m.url } : undefined;
    case 'pointer': {
      if (m.pointer !== 'hover' && m.pointer !== 'click') return undefined;
      if (m.ref === null && m.rect === null && m.pointer === 'hover') {
        return { kind: m.kind, pointer: m.pointer, ref: null, rect: null };
      }
      return isRef(m.ref) && isRect(m.rect)
        ? { kind: m.kind, pointer: m.pointer, ref: m.ref, rect: rectBody(m.rect) }
        : undefined;
    }
    case 'applied':
      return isCount(m.rev) && optional(m.entryId, isId)
        ? { kind: m.kind, rev: m.rev, ...(m.entryId !== undefined ? { entryId: m.entryId } : {}) }
        : undefined;
    case 'failed':
      return isCount(m.rev) &&
        typeof m.reason === 'string' &&
        FAIL_REASONS.has(m.reason) &&
        optional(m.entryId, isId)
        ? {
            kind: m.kind,
            rev: m.rev,
            reason: m.reason,
            ...(m.entryId !== undefined ? { entryId: m.entryId } : {}),
          }
        : undefined;
    case 'layout':
      return layoutBody(m);
    default:
      return undefined;
  }
}

function address(m: Record<string, unknown>): EntryAddress | undefined {
  return isCount(m.rev) && isId(m.entryId) && isName(m.locale)
    ? { rev: m.rev as number, entryId: m.entryId, locale: m.locale }
    : undefined;
}

// --- ops ---------------------------------------------------------------------------------

function isOp(value: Record<string, unknown>, field: string, locale: string): boolean {
  if (value.field !== undefined && value.field !== field) return false;
  if (value.locale !== undefined && value.locale !== locale) return false;
  switch (value.op) {
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

function isFields(value: unknown): value is LiveFields {
  return isRecord(value) && Object.keys(value).every(isName);
}

// --- content values -------------------------------------------------------------------------

/**
 * A rich text value: a `RichTextDocument` tree all the way down (every node an object with a
 * `nodeType`, every `content` a list of nodes, every text node's `value` a string), never a
 * string of markup anywhere in it. Structural only: which node types exist is the admin's check.
 */
export function isRichTextDocument(value: unknown): boolean {
  if (!isRecord(value) || value.nodeType !== 'document') return false;
  let nodes = 0;
  const node = (n: unknown, depth: number): boolean => {
    nodes += 1;
    if (nodes > MAX_NODES || depth > MAX_DEPTH) return false;
    if (!isRecord(n) || typeof n.nodeType !== 'string') return false;
    if (n.nodeType === 'text' && typeof n.value !== 'string') return false;
    if (n.content === undefined) return n.nodeType !== 'document';
    return Array.isArray(n.content) && n.content.every((c) => node(c, depth + 1));
  };
  return node(value, 0);
}

/**
 * Why `value` can't be a field value of `type` on the channel, or undefined when it can. The
 * admin checks values with it before sending, holding the content type; the frontend, which
 * doesn't, refuses a patch that turns a rich text document into anything else.
 */
export function contentValueIssue(type: string, value: unknown): string | undefined {
  if (value === null) return undefined;
  if (type === 'RichText' && !isRichTextDocument(value)) {
    return 'Rich text crosses the channel as a RichTextDocument, never as HTML or Markdown';
  }
  return undefined;
}

// --- layout -------------------------------------------------------------------------------------

function layoutBody(m: Record<string, unknown>): Body | undefined {
  const { blocks, slots, fields, scroll, viewport, docHeight } = m;
  if (!Array.isArray(blocks) || blocks.length > MAX_GEOMETRY_ITEMS) return undefined;
  if (!Array.isArray(slots) || slots.length > MAX_GEOMETRY_ITEMS) return undefined;
  if (!Array.isArray(fields) || fields.length > MAX_GEOMETRY_ITEMS) return undefined;
  if (!isRecord(scroll) || !isNumber(scroll.x) || !isNumber(scroll.y)) return undefined;
  if (!isRecord(viewport) || !isNumber(viewport.w) || !isNumber(viewport.h)) return undefined;
  if (!isNumber(docHeight) || (m.truncated !== undefined && m.truncated !== true)) return undefined;
  const boxes = (list: unknown[]): LiveFieldBox[] | undefined => {
    const out: LiveFieldBox[] = [];
    for (const b of list) {
      if (!isRecord(b) || !isRef(b.ref) || !isRect(b.rect)) return undefined;
      out.push({ ref: b.ref, rect: rectBody(b.rect) });
    }
    return out;
  };
  const outBlocks = boxes(blocks);
  const outFields = boxes(fields);
  if (!outBlocks || !outFields) return undefined;
  const outSlots: LiveSlotBox[] = [];
  let gapCount = 0;
  for (const s of slots) {
    if (!isRecord(s) || !isRef(s.ref) || !isRect(s.rect) || !Array.isArray(s.gaps)) {
      return undefined;
    }
    gapCount += s.gaps.length;
    if (gapCount > MAX_GEOMETRY_GAPS) return undefined;
    const gaps: LiveGap[] = [];
    for (const g of s.gaps) {
      if (!isRecord(g) || !isCount(g.index) || (g.axis !== 'x' && g.axis !== 'y')) return undefined;
      if (!isRect(g.rect) || !optional(g.after, isId) || !optional(g.before, isId))
        return undefined;
      gaps.push({
        index: g.index as number,
        rect: rectBody(g.rect),
        axis: g.axis,
        ...(g.after !== undefined ? { after: g.after as string } : {}),
        ...(g.before !== undefined ? { before: g.before as string } : {}),
      });
    }
    outSlots.push({ ref: s.ref, rect: rectBody(s.rect), gaps });
  }
  return {
    kind: 'layout',
    blocks: outBlocks,
    slots: outSlots,
    fields: outFields,
    scroll: { x: scroll.x, y: scroll.y },
    viewport: { w: viewport.w, h: viewport.h },
    docHeight,
    ...(m.truncated ? { truncated: true } : {}),
  };
}

// --- primitives ----------------------------------------------------------------------------------

/**
 * Whether `value` serializes to at most `cap` bytes of UTF-8 JSON. A value JSON can't serialize
 * (a cycle, a BigInt, nesting deep enough to overflow) is over every cap.
 */
export function withinBytes(value: unknown, cap: number): boolean {
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

/** The most values (objects, lists and their members) one message may hold. */
const MAX_NODES = 200_000;
/** The longest list one message may hold; a list is refused by its length, before it is read. */
const MAX_LIST = 10_000;

/**
 * Plain data only, anywhere in `value`, found in bounded time: no prototype-reaching names, no
 * nesting past 64, no list longer than 10,000, at most 200,000 values, and no object that isn't a
 * plain one or a plain list (structured clone carries Maps, Dates and typed arrays, which JSON
 * measures as `{}` or spends seconds on). Runs before anything else reads the message.
 */
export function clean(value: unknown): boolean {
  let nodes = 0;
  const walk = (v: unknown, depth: number): boolean => {
    nodes += 1;
    if (nodes > MAX_NODES || depth > MAX_DEPTH) return false;
    if (typeof v !== 'object' || v === null) return typeof v !== 'function';
    const proto = Object.getPrototypeOf(v);
    if (Array.isArray(v)) {
      if (proto !== Array.prototype || v.length > MAX_LIST) return false;
      // A hole would be skipped by every `every()` check and then reach the page as `null`.
      for (let i = 0; i < v.length; i++) {
        if (!Object.hasOwn(v, i) || !walk(v[i], depth + 1)) return false;
      }
      return true;
    }
    if (proto !== Object.prototype && proto !== null) return false;
    for (const name of Object.keys(v)) {
      if (FORBIDDEN_NAMES.has(name)) return false;
      if (!walk((v as Record<string, unknown>)[name], depth + 1)) return false;
    }
    return true;
  };
  return walk(value, 0);
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

function isRect(r: unknown): r is LiveRect {
  return isRecord(r) && isNumber(r.x) && isNumber(r.y) && isNumber(r.w) && isNumber(r.h);
}
const rectBody = (r: LiveRect): LiveRect => ({ x: r.x, y: r.y, w: r.w, h: r.h });

const isUrl = (s: unknown): s is string => isText(s, MAX_URL) && isPreviewUrl(s);
const isVersion = (n: unknown): boolean => Number.isSafeInteger(n) && (n as number) >= 1;
const isVersionList = (l: unknown): boolean =>
  Array.isArray(l) && l.length <= 32 && l.every(isVersion);
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
const isRef = (s: unknown): s is string => isText(s, MAX_REF) && !FORBIDDEN_NAMES.has(s);

/** Whether a page may send `value` as a key, id or locale: what the admin's parser accepts. */
export const isWireId = isId;
/** Whether a page may send `value` as a ref: what the admin's parser accepts. */
export const isWireRef = isRef;
const optional = (v: unknown, test: (v: unknown) => boolean): boolean => v === undefined || test(v);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether a name is safe to assign as an own property (not one that reaches a prototype). */
export function isSafeName(name: string): boolean {
  return !FORBIDDEN_NAMES.has(name);
}
