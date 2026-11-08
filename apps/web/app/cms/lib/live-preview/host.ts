/**
 * The admin's half of live preview: what the Site frame runs with the customer's page it frames.
 *
 * It waits for the page's `hello`, sends the entry (`init`) and then each edit as a numbered
 * `patch`, and hands the page's geometry, picks, hovers and keys to the frame. Every message from
 * the page goes through `parseGuestMessage` with the event's real origin and window, so a message
 * from anywhere else, or from the page after it navigated to another origin, is never read; and it
 * posts only to the page's exact origin.
 *
 * The page acknowledges what it has rendered (`rendered {seq}`), not necessarily every seq: a
 * failed render is never acknowledged, and edits that land mid-render are folded together. After
 * a refused patch the page drops the patches that follow until the whole entry comes again, and
 * says so with `error {kind: 'patch'}`; the host answers with one `init` carrying the current
 * fields and the seq they include, which puts both sides back in step.
 */
import {
  LIVE_PREVIEW_PROTOCOL,
  type LiveAdminMessage,
  type LiveGeometryMessage,
  type LiveKeyMessage,
  type LivePatchOp,
  type LivePreviewMode,
  type LiveTarget,
  MAX_MESSAGE_BYTES,
  MAX_PATCH_OPS,
  parseGuestMessage,
} from '@contentworker/sdk-core/live-preview';
import type { FrameEntry, SiteStatus } from './frame-channel';

/** How long a loaded page has to say hello before the pane says it doesn't speak live preview. */
export const HANDSHAKE_MS = 5_000;
/** How long the frame has to load at all before the pane says the page didn't load. */
export const LOAD_MS = 20_000;

/** Anything with a `postMessage(message, targetOrigin)`: the framed page's window. */
interface Postable {
  postMessage(message: unknown, targetOrigin: string): void;
}

export interface HostOptions {
  /** The framed page's origin, exactly (the preview URL template's). */
  readonly origin: string;
  /** This framing's session id (`cw_session` on the page's URL). */
  readonly session: string;
  /** The framed page's window, read when needed (an iframe's `contentWindow` changes per load). */
  readonly frame: () => Postable | null | undefined;
  readonly onStatus: (status: Exclude<SiteStatus, 'unavailable'>, detail?: string) => void;
  readonly onGeometry?: (geometry: LiveGeometryMessage) => void;
  readonly onHover?: (target: LiveTarget | undefined) => void;
  readonly onPick?: (target: LiveTarget) => void;
  readonly onKey?: (key: LiveKeyMessage) => void;
  /** An edit-mode link the page asked to follow, on its own origin. */
  readonly onNavigate?: (url: string) => void;
  /** Whether the framed page has focus (the frame's document's active element is its frame). */
  readonly focused?: () => boolean;
  /** The page refused a patch or failed a render. */
  readonly onNote?: (kind: string) => void;
  readonly handshakeMs?: number;
  readonly loadMs?: number;
}

type Outbound = LiveAdminMessage extends infer M
  ? M extends LiveAdminMessage
    ? Omit<M, 'cw' | 'session'>
    : never
  : never;

export class LivePreviewHost {
  /** The last patch seq sent (an `init` says the fields include it). */
  seq = 0;
  /** The highest seq the page says is on screen. */
  rendered = 0;
  status: Exclude<SiteStatus, 'unavailable'> = 'loading';
  private connected = false;
  /** Whether a page has ever said hello in this framing: a later load without one navigated away. */
  private greeted = false;
  private entry: FrameEntry | undefined;
  private mode: LivePreviewMode = 'view';
  /** The seq the last `init` carried: a refusal of a patch it already covers needs no other. */
  private initSeq = -1;
  /** The last init answered a refused patch, and no patch since has rendered. */
  private recovering = false;
  /** Send each changed blocks field whole (`setField`), not by key: the page refused both ways. */
  wholeFields = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Where the frame is: loading a page, waiting on a loaded page's hello, or neither. */
  private phase: 'loading' | 'handshake' | 'idle' = 'idle';
  private helloBeforeLoad = false;
  private readonly o: HostOptions;

  constructor(options: HostOptions) {
    this.o = options;
  }

  /** The frame is about to load the page: starts the clock on it loading at all. */
  start(): void {
    this.connected = false;
    this.helloBeforeLoad = false;
    this.phase = 'loading';
    this.wait(this.o.loadMs ?? LOAD_MS, () => this.setStatus('failed'));
  }

  /**
   * The frame finished a load. A page usually says hello before its load event, and then this is
   * that page's load; otherwise the frame went somewhere (a link followed in view mode, a redirect)
   * and that page has the handshake's time to say hello, or it navigated away.
   */
  frameLoaded(): void {
    if (this.helloBeforeLoad) {
      this.helloBeforeLoad = false;
      this.phase = 'idle';
      return;
    }
    this.connected = false;
    this.phase = 'handshake';
    this.wait(this.o.handshakeMs ?? HANDSHAKE_MS, () => {
      this.phase = 'idle';
      this.setStatus(this.greeted ? 'navigated' : 'timeout');
    });
  }

  /** Every `message` event the frame's window sees; only the framed page's are read. */
  receive(event: { readonly data: unknown; readonly origin: string; readonly source: unknown }) {
    const source = this.o.frame();
    if (!source || event.source !== source) return;
    if (event.origin !== this.o.origin) {
      // Ours by its envelope, but from another origin: the page redirected (www, or another host)
      // and runs the SDK there. Said, never read.
      if (this.oursByEnvelope(event.data)) this.setStatus('origin', event.origin);
      return;
    }
    const parsed = parseGuestMessage(event, {
      session: this.o.session,
      origin: this.o.origin,
      source,
    });
    if (!parsed.ok) return;
    const m = parsed.message;
    switch (m.type) {
      case 'hello':
        // Said while the page was still loading, it belongs to the load event still to come.
        this.helloBeforeLoad = this.phase === 'loading';
        if (this.phase === 'handshake') this.phase = 'idle';
        this.clearTimer();
        this.connected = true;
        this.greeted = true;
        this.setStatus('live');
        this.sendInit();
        this.post({ type: 'mode', mode: this.mode });
        return;
      case 'rendered':
        // Not necessarily every seq: the highest one said is what's on screen.
        if (m.seq > this.rendered && m.seq <= this.seq) this.rendered = m.seq;
        // A patch after the recovery init rendered: back in step.
        if (m.seq > this.initSeq) this.recovering = false;
        return;
      case 'geometry':
        this.o.onGeometry?.(m);
        return;
      case 'hover':
        this.o.onHover?.(m.key !== undefined || m.ref !== undefined ? target(m) : undefined);
        return;
      case 'pick': {
        const picked = target(m) as LiveTarget;
        this.post({ type: 'select', ...picked });
        this.o.onPick?.(picked);
        return;
      }
      case 'key':
        // Only a key the person plausibly pressed: in edit mode, with focus in the page. A page
        // can post keys whenever it likes, and they act on the editor's form.
        if (this.mode === 'edit' && (this.o.focused?.() ?? true)) this.o.onKey?.(m);
        return;
      case 'navigate':
        if (this.mode === 'edit') this.o.onNavigate?.(m.url);
        return;
      case 'error':
        if (m.kind !== 'patch') {
          this.o.onNote?.(m.kind);
          return;
        }
        // A patch the last init already covers was dropped while the page was out of step: the
        // init puts it right. (A page without `seq` on its errors: once per init.)
        if (m.seq !== undefined ? m.seq <= this.initSeq : this.initSeq === this.seq) return;
        this.o.onNote?.(m.kind);
        // Refused again right after a recovery: this page can't take those ops by key, so blocks
        // fields go whole from here on.
        if (this.recovering) this.wholeFields = true;
        this.recovering = true;
        this.sendInit();
        return;
    }
  }

  /**
   * The entry as the form holds it now, and the ops since the last call: a patch when there are
   * some, the whole entry when `ops` is null, the locale or version moved, or the patch is too big.
   */
  setEntry(entry: FrameEntry, ops: readonly LivePatchOp[] | null): void {
    const prev = this.entry;
    this.entry = entry;
    if (!this.connected) return;
    const whole =
      ops === null ||
      !prev ||
      prev.locale !== entry.locale ||
      prev.version !== entry.version ||
      prev.entryId !== entry.entryId;
    if (whole) {
      this.sendInit();
      return;
    }
    if (ops.length === 0) return;
    if (ops.length > MAX_PATCH_OPS || !fits(ops)) {
      this.sendInit();
      return;
    }
    this.seq += 1;
    this.post({
      type: 'patch',
      seq: this.seq,
      ops: this.wholeFields ? asWholeFields(ops, entry) : ops,
    });
  }

  setMode(mode: LivePreviewMode): void {
    this.mode = mode;
    if (this.connected) this.post({ type: 'mode', mode });
  }

  /** Selects a target on the page, or clears the selection. */
  select(t: LiveTarget | undefined): void {
    if (this.connected) this.post({ type: 'select', ...(t ?? {}) } as Outbound);
  }

  dispose(): void {
    this.clearTimer();
    this.connected = false;
  }

  private sendInit(): void {
    const e = this.entry;
    if (!e) return;
    // Always with the seq: an init without one would reset the page's to 0.
    this.initSeq = this.seq;
    this.post({
      type: 'init',
      fields: e.fields,
      locale: e.locale,
      version: e.version,
      entryId: e.entryId,
      contentType: e.contentType,
      seq: this.seq,
    });
  }

  private post(message: Outbound): void {
    this.o
      .frame()
      ?.postMessage(
        { cw: LIVE_PREVIEW_PROTOCOL, session: this.o.session, ...message },
        this.o.origin,
      );
  }

  private oursByEnvelope(data: unknown): boolean {
    const m = data as { cw?: unknown; session?: unknown } | null;
    return (
      typeof m === 'object' &&
      m !== null &&
      m.cw === LIVE_PREVIEW_PROTOCOL &&
      m.session === this.o.session
    );
  }

  private setStatus(status: Exclude<SiteStatus, 'unavailable'>, detail?: string): void {
    if (status !== 'live') this.connected = false;
    this.status = status;
    this.o.onStatus(status, detail);
  }

  private wait(ms: number, then: () => void): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      then();
    }, ms);
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
}

/** `ops` with every block op replaced by its field's value, whole, once per field and locale. */
function asWholeFields(ops: readonly LivePatchOp[], entry: FrameEntry): LivePatchOp[] {
  const out: LivePatchOp[] = [];
  const done = new Set<string>();
  for (const op of ops) {
    if (op.op === 'setField') {
      out.push(op);
      continue;
    }
    const id = `${op.field}\u0000${op.locale}`;
    if (done.has(id)) continue;
    done.add(id);
    const value = entry.fields[op.field]?.[op.locale];
    out.push(
      value === undefined
        ? { op: 'setField', field: op.field, locale: op.locale }
        : { op: 'setField', field: op.field, locale: op.locale, value },
    );
  }
  return out;
}

function target(m: { key?: string; ref?: string }): LiveTarget {
  return m.key !== undefined ? { key: m.key } : { ref: m.ref as string };
}

/** Whether a patch of these ops is within the page's message cap (with room for the envelope). */
function fits(ops: readonly LivePatchOp[]): boolean {
  return new TextEncoder().encode(JSON.stringify(ops)).byteLength < MAX_MESSAGE_BYTES - 1024;
}
