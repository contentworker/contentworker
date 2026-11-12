/**
 * What the entry editor and its Site frame (`routes/preview-frame.tsx`, a page of this origin
 * that frames the customer's site) say to each other. Both are the admin's own documents, so this
 * is a same-origin `postMessage`, but each side still checks the other's origin and window: the
 * framed site sits one window further in and could post to its parent's parent.
 *
 * The editor sends the entry as the form holds it (one locale's values) with the edits since its
 * last send, and what the person may let the page do; the frame runs the live preview channel with
 * the site (`host.ts`) and reports back where things stand and what was clicked.
 */
import type {
  Capability,
  LiveFields,
  LiveGap,
  LivePatchOp,
  LiveRect,
} from '@contentworker/sdk-core/live-preview';
import type { LiveEdits } from './ops';

/** Marks this channel's messages; anything without it is someone else's. */
export const FRAME_CHANNEL = 'cw-site-frame';

/**
 * The widths the frame shows the site at, in CSS pixels: a preset's (`cms/lib/breakpoints.ts`, the
 * catalog's breakpoints or the three devices), within the bounds a breakpoint's `minWidth` takes.
 * Anything else is the default.
 */
export const FRAME_WIDTH = { min: 1, max: 10_000, default: 1280 } as const;

/**
 * What an editor page loaded before `width` replaced `device` sends: its device's width. An open
 * tab keeps its old script after a deploy, and frames a new Site frame. Remove one release after
 * the canvas's breakpoint presets ship, once no tab can still be that old.
 */
const LEGACY_DEVICE_WIDTHS: Readonly<Record<string, number>> = {
  desktop: 1280,
  tablet: 768,
  phone: 390,
};

/** The width a `view` message asks for: its `width`, else an older editor's `device`. */
export function viewWidth(m: { readonly width?: unknown; readonly device?: unknown }): number {
  const legacy = typeof m.device === 'string' ? LEGACY_DEVICE_WIDTHS[m.device] : undefined;
  return frameWidth(m.width ?? legacy);
}

/** A `view` message's width as the frame uses it: a whole number in bounds, else the default. */
export function frameWidth(width: unknown): number {
  return typeof width === 'number' &&
    Number.isInteger(width) &&
    width >= FRAME_WIDTH.min &&
    width <= FRAME_WIDTH.max
    ? width
    : FRAME_WIDTH.default;
}

/** One entry in one locale, as the form holds it: what the frame sends the site as `entry.state`. */
export interface FrameEntry {
  readonly entryId: string;
  readonly locale: string;
  readonly fields: LiveFields;
}

/**
 * Where the Site pane stands: framing (`loading`), connected (`live`), or why not.
 * - `not-connected`: the page loaded but never offered to connect.
 * - `unsupported`: it offered only protocol versions this admin doesn't speak (`detail`: `old` or
 *   `new`, which way its SDK is off).
 * - `elsewhere`: connected, but the page doesn't render this entry (`page` doesn't list it).
 * - `navigated`: it went to an address none of the space's preview URLs name, or a page that never
 *   connects after one that did.
 * - `origin`: it offered from another origin than the framed URL's.
 * - `unpreviewable`: the page refused the entry's whole state, so it can't show it.
 * - `failed`: the frame never loaded; `unavailable`: no preview link could be made (`detail`).
 */
export type SiteStatus =
  | 'loading'
  | 'live'
  | 'not-connected'
  | 'unsupported'
  | 'elsewhere'
  | 'navigated'
  | 'origin'
  | 'unpreviewable'
  | 'failed'
  | 'unavailable';

export type EditorMessage =
  /** `edits` null: send the whole state (first, a new locale, or when edits can't say it). */
  | { readonly type: 'entry'; readonly entry: FrameEntry; readonly edits: LiveEdits | null }
  | {
      readonly type: 'view';
      /** Editing on: clicks in the page select (`editing { on }`); off, the page is the site. */
      readonly editing: boolean;
      /** The page's width, in CSS pixels: the frame scales it down to fit. */
      readonly width: number;
      /**
       * What the person may let the page do; the frame accepts no more than this of the offer.
       * Absent while it isn't known yet: the frame holds the page's offer until it is.
       */
      readonly allowed?: readonly Capability[];
      /**
       * The canvas editor draws the outlines and seams itself, over the frame: the frame draws
       * none and reports the page's geometry instead (`geometry`, `hover`).
       */
      readonly canvas?: boolean;
    }
  /** The form's focused field or block on the page, or none. */
  | { readonly type: 'select'; readonly ref: string | null }
  /**
   * Coworker's proposal for the entry while its card waits for an answer: the dry run's applied
   * ops, which the page shows as ghosts. Null takes it back.
   */
  | { readonly type: 'proposal'; readonly ops: readonly LivePatchOp[] | null }
  /**
   * Bring a marked element into the page's view, selecting nothing (`scroll`): centred, or its top
   * (`start`) or bottom (`end`) edge `inset` pixels of the frame clear of the frame's edge.
   */
  | {
      readonly type: 'scroll';
      readonly ref: string;
      readonly align?: 'start' | 'end';
      readonly inset?: number;
    }
  /**
   * For the canvas: scroll the page `dy` pixels of the frame (negative up), as a carried block
   * nears its edge. The frame says it to the page as a `scroll` to an element it last reported.
   */
  | { readonly type: 'scrollBy'; readonly dy: number };

export type FrameMessage =
  /** The frame is up and wants the entry; `origin` is the site it frames. */
  | { readonly type: 'ready'; readonly origin?: string }
  | { readonly type: 'status'; readonly status: SiteStatus; readonly detail?: string }
  /** The page couldn't take an edit, so it was sent the whole entry: a quiet note, not a state. */
  | { readonly type: 'note'; readonly kind: string }
  /** Whether the page shows Coworker's proposal now, and whether it refused the last one. */
  | { readonly type: 'proposal'; readonly shown: boolean; readonly refused?: boolean }
  /** A marked element clicked in the page: its ref, already checked by the frame. */
  | { readonly type: 'pick'; readonly ref: string }
  /** For the canvas: the page's boxes, in the frame's own coordinates (null: none to draw). */
  | { readonly type: 'geometry'; readonly geometry: FrameGeometry | null }
  /** For the canvas: the marked element under the pointer, or none. */
  | { readonly type: 'hover'; readonly ref: string | null; readonly rect: LiveRect | null }
  /** The entries the page renders, and the capabilities the session was accepted with. */
  | {
      readonly type: 'session';
      readonly entries: readonly string[];
      readonly capabilities: readonly Capability[];
    };

/**
 * The page's `layout`, as the canvas draws it: every box moved from the page's viewport into the
 * frame's (scaled to the device width and centred), so the canvas lays them straight over the frame
 * element. Refs are the page's, untrusted: the canvas checks each names its entry before using it.
 */
export interface FrameGeometry {
  readonly blocks: readonly { readonly ref: string; readonly rect: LiveRect }[];
  readonly slots: readonly {
    readonly ref: string;
    readonly rect: LiveRect;
    readonly gaps: readonly LiveGap[];
  }[];
  /** Some boxes far from the viewport were left out to fit the page's message. */
  readonly truncated: boolean;
}

/** Posts on the channel to `target`, which is this origin's window, never `*`. */
export function postFrame(
  target: Window | null | undefined,
  message: EditorMessage | FrameMessage,
) {
  target?.postMessage({ channel: FRAME_CHANNEL, ...message }, window.location.origin);
}

/**
 * A channel message from `expected` on this origin, or undefined. Only the shape the reader
 * switches on is checked: both sides are this admin, and each reads only the fields it expects.
 */
export function readFrame<M extends EditorMessage | FrameMessage>(
  event: { readonly data: unknown; readonly origin: string; readonly source: unknown },
  expected: unknown,
): M | undefined {
  if (!expected || event.source !== expected || event.origin !== window.location.origin) {
    return undefined;
  }
  const data = event.data as { channel?: unknown; type?: unknown } | null;
  if (typeof data !== 'object' || data === null || data.channel !== FRAME_CHANNEL) return undefined;
  return typeof data.type === 'string' ? (data as M) : undefined;
}
