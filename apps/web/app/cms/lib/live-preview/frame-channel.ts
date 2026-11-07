/**
 * What the entry editor and its Site frame (`routes/preview-frame.tsx`, a page of this origin
 * that frames the customer's site) say to each other. Both are the admin's own documents, so this
 * is a same-origin `postMessage`, but each side still checks the other's origin and window: the
 * framed site sits one window further in and could post to its parent's parent.
 *
 * The editor sends the entry as the form holds it, with the ops since its last send; the frame
 * runs the live preview protocol with the site and reports back what the editor shows.
 */
import type {
  ForwardedKey,
  LiveFields,
  LivePatchOp,
  LivePreviewMode,
  LiveTarget,
} from '@contentworker/sdk-core/live-preview';

/** Marks this channel's messages; anything without it is someone else's. */
export const FRAME_CHANNEL = 'cw-site-frame';

/** The device widths the frame can show the site at, in CSS pixels. */
export const DEVICE_WIDTHS = { desktop: 1280, tablet: 768, phone: 390 } as const;
export type Device = keyof typeof DEVICE_WIDTHS;

/** The entry as the form holds it: what the frame sends the site as `init`. */
export interface FrameEntry {
  readonly fields: LiveFields;
  readonly locale: string;
  readonly version: number;
  readonly entryId: string;
  readonly contentType: string;
}

/**
 * Where the Site pane stands: framing (`loading`), talking to the site (`live`), or why not.
 * `timeout`: the page loaded but never said hello; `navigated`: it did once, then a load came
 * without one; `origin`: it answered from another origin than its preview URL names; `failed`:
 * the page never loaded; `unavailable`: the frame couldn't make a preview link for the entry.
 */
export type SiteStatus =
  | 'loading'
  | 'live'
  | 'timeout'
  | 'navigated'
  | 'origin'
  | 'failed'
  | 'unavailable';

export type EditorMessage =
  /** `ops` null: send the whole entry (first, after a refusal, or when a patch can't say it). */
  | {
      readonly type: 'entry';
      readonly entry: FrameEntry;
      readonly ops: readonly LivePatchOp[] | null;
    }
  | { readonly type: 'view'; readonly mode: LivePreviewMode; readonly device: Device }
  | { readonly type: 'select'; readonly target?: LiveTarget };

export type FrameMessage =
  /** The frame is up and wants the entry; `origin` is the site it frames. */
  | { readonly type: 'ready'; readonly origin?: string }
  | { readonly type: 'status'; readonly status: SiteStatus; readonly detail?: string }
  /** The site refused a patch or failed a render: a quiet note, not a state. */
  | { readonly type: 'note'; readonly kind: string }
  | { readonly type: 'pick'; readonly target: LiveTarget }
  | ({ readonly type: 'key' } & FrameKey);

/** A shortcut pressed in the page (one of the protocol's forwarded keys) and its modifiers. */
export interface FrameKey {
  readonly key: ForwardedKey;
  readonly meta: boolean;
  readonly ctrl: boolean;
  readonly shift: boolean;
  readonly alt: boolean;
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
