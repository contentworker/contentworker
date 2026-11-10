/**
 * The admin's half of the live preview channel (docs/specs/live-preview-channel.md), as the Site
 * frame runs it with the customer's page it frames.
 *
 * The page connects: it offers a channel, its protocol versions and capabilities, and the host
 * answers `connect.accept` (the highest shared version, the capabilities narrowed to what the
 * person may let it do) or `connect.reject` with both version lists. Every message goes through
 * the protocol's `acceptMessage` (origin: the framed URL's; sender: the iframe's window; channel:
 * the pinned one, or on an offer a new well-formed one) and then its schema, and the host posts
 * only to that origin. A fresh offer from the same window replaces the session.
 *
 * Once the page reports in `page` that it renders the entry, the host sends its whole unsaved
 * state (`entry.state`), then each edit as `entry.patch` or `blocks.patch`, numbered by `rev` per
 * entry. The page answers `applied` or `failed`; a failure is answered with a fresh state, except
 * a state the page refused as invalid, which would fail again: then the entry can't be previewed.
 * Nothing it says saves, publishes or calls a use-case: clicks only move focus in the form.
 *
 * While a Coworker card for the entry waits for the person's answer, its proposal rides on top as
 * `blocks.patch` ops marked `proposed` (`setProposal`), which the page renders as ghosts: sent
 * again after every whole state, and taken back with a fresh one. Confirm saves through the card,
 * never through here.
 */

import { SCOPES } from '@contentworker/domain';
import {
  type AdminMessage,
  acceptMessage,
  type Capability,
  type ConnectOfferMessage,
  capabilityAllows,
  type FrontendMessage,
  type LayoutMessage,
  type LivePatchOp,
  type LiveRect,
  MAX_MESSAGE_BYTES,
  MAX_STATE_BYTES,
  narrowCapabilities,
  negotiateVersion,
  parseFrontendMessage,
  SUPPORTED_VERSIONS,
} from '@contentworker/sdk-core/live-preview';
import type { FrameEntry, SiteStatus } from './frame-channel';
import type { LiveEdits } from './ops';

/**
 * How long a loaded page has to offer before the pane says it isn't connected: the frontend
 * offers four times, a second apart, so this outlasts its last try.
 */
export const CONNECT_MS = 5_000;
/** How long the frame has to load at all before the pane says the page didn't load. */
export const LOAD_MS = 20_000;

/** The capabilities the admin uses for someone who edits the entry. */
export const ADMIN_CAPABILITIES: readonly Capability[] = [
  'select',
  'patch.fields',
  'patch.blocks',
  'scroll',
  'layout',
];

/** What a person who can't edit the entry lets the page do: clicks and outlines, never values. */
export const SELECT_ONLY: readonly Capability[] = ['select', 'scroll', 'layout'];

/**
 * What the page may do for a person with `scopes` in the space (docs/specs/live-preview-channel.md,
 * "Capabilities": narrowed by the space's admin config). Without `content:write` their unsaved
 * values aren't theirs to send, so they only select; the page shows the entry as saved. With
 * Coworker on (`assistant`), a writer's page may also show its proposals as ghosts: capabilities
 * are fixed when the page connects, so it is accepted then, and used only while a proposal waits
 * for the person's answer (`setProposal`).
 */
export function capabilitiesFor(
  scopes: readonly string[],
  opts: { readonly assistant?: boolean } = {},
): readonly Capability[] {
  if (!scopes.includes(SCOPES.contentWrite)) return SELECT_ONLY;
  return opts.assistant ? [...ADMIN_CAPABILITIES, 'proposals'] : ADMIN_CAPABILITIES;
}

/** Anything with a `postMessage(message, targetOrigin)`: the framed page's window. */
interface Postable {
  postMessage(message: unknown, targetOrigin: string): void;
}

type HostStatus = Exclude<SiteStatus, 'unavailable'>;

export interface HostOptions {
  /** The framed page's origin, exactly: the preview URL's. */
  readonly origin: string;
  /** Every origin the space's preview URLs name: where a `navigated` may take the session. */
  readonly origins: readonly string[];
  /** The framed page's window, read when needed (an iframe's `contentWindow`). */
  readonly frame: () => Postable | null | undefined;
  readonly onStatus: (status: HostStatus, detail?: string) => void;
  /** Connected (or reconnected): the entries the page renders and what was accepted. */
  readonly onSession?: (entries: readonly string[], capabilities: readonly Capability[]) => void;
  readonly onPointer?: (
    pointer: 'hover' | 'click',
    ref: string | null,
    rect: LiveRect | null,
  ) => void;
  readonly onLayout?: (layout: LayoutMessage) => void;
  /** The page couldn't take an edit and was sent the whole entry (`failed` reason). */
  readonly onNote?: (reason: string) => void;
  /**
   * Whether the page shows Coworker's proposal now: true once it was sent, false when there is
   * none, the session can't show one, or the page refused it (`refused`).
   */
  readonly onProposal?: (shown: boolean, refused?: boolean) => void;
  readonly connectMs?: number;
  readonly loadMs?: number;
}

type Outbound = AdminMessage extends infer M
  ? M extends AdminMessage
    ? Omit<M, 'v' | 'channel'>
    : never
  : never;

export class LivePreviewHost {
  status: HostStatus = 'loading';
  /** The last rev sent for the entry, and the rev of the last whole state. */
  rev = 0;
  stateRev = 0;
  /** The highest rev the page says is on screen. */
  rendered = 0;
  /** Send blocks fields whole (`entry.patch`): the page refused key-addressed ops twice running. */
  wholeFields = false;
  private origin: string;
  private channel: string | undefined;
  private version: number | undefined;
  private accepted: Capability[] = [];
  private allowed: readonly Capability[] | undefined;
  /** An offer that came before the editor said what it allows: answered once it does. */
  private pending: ConnectOfferMessage | undefined;
  private pageEntries: string[] = [];
  private entry: FrameEntry | undefined;
  private editing = true;
  private selected: string | null = null;
  /** The page refused the entry's whole state: nothing more is sent this session. */
  private blocked = false;
  /**
   * Coworker's proposal waiting for the person's answer, one list of ops per blocks field: sent
   * after every whole state (which clears the page's proposals), until it is taken back.
   */
  private proposal: { readonly field: string; readonly ops: readonly LivePatchOp[] }[] = [];
  /** The revs the proposal went out on, this session: a refusal of one drops the proposal. */
  private proposalRevs = new Set<number>();
  /** The page holds the proposal now. */
  private proposalShown = false;
  /** The last state answered a failure, and nothing since has rendered. */
  private recovering = false;
  /** Whether a page ever connected in this frame: a later load that never does navigated away. */
  private connectedOnce = false;
  private phase: 'loading' | 'waiting' | 'idle' = 'idle';
  /**
   * An offer came since the frame's last load event, and no `navigated` after it: the next load
   * event is that page's own (a page offers before its load event), whatever loads came before.
   */
  private offeredSinceLoad = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly o: HostOptions;

  constructor(options: HostOptions) {
    this.o = options;
    this.origin = options.origin;
  }

  // --- the frame's loads ------------------------------------------------------------

  /** The frame is about to load the page: starts the clock on it loading at all. */
  start(): void {
    this.endSession();
    this.offeredSinceLoad = false;
    this.phase = 'loading';
    this.wait(this.o.loadMs ?? LOAD_MS, () => this.setStatus('failed'));
  }

  /**
   * The frame finished a load. A page usually offers before its load event, and then this is that
   * page's load; otherwise the frame went somewhere and that page has its time to offer. A load
   * that never offers (a site's redirect or sign-in hand-off page) is passing: the page after it
   * may still offer, before its own load or within the time from it, and then it is live. Only a
   * load with no offer in that time says the page moved away (or never connected).
   */
  frameLoaded(): void {
    if (this.offeredSinceLoad) {
      this.offeredSinceLoad = false;
      this.phase = 'idle';
      return;
    }
    this.endSession();
    this.phase = 'waiting';
    this.wait(this.o.connectMs ?? CONNECT_MS, () => {
      this.phase = 'idle';
      this.setStatus(this.connectedOnce ? 'navigated' : 'not-connected');
    });
  }

  // --- receiving ----------------------------------------------------------------------

  /** Every `message` event the frame's window sees; only the framed page's are read. */
  receive(event: { readonly data: unknown; readonly origin: string; readonly source: unknown }) {
    const source = this.o.frame();
    if (!source || event.source !== source) return;
    const data = acceptMessage(event, {
      origin: this.origin,
      source,
      // Before connect, and for a fresh offer from the same window, any well-formed channel.
      ...(this.channel && !isOffer(event.data) ? { channel: this.channel } : {}),
      ...(this.version !== undefined && !isOffer(event.data) ? { version: this.version } : {}),
    });
    if (!data) {
      // Ours by its shape, from the frame's own window, but another origin: the page redirected
      // (www, another host) and offers from there. Said, never read.
      if (event.origin !== this.origin && isOffer(event.data)) {
        this.setStatus('origin', event.origin);
      }
      return;
    }
    const parsed = parseFrontendMessage(data);
    if (!parsed.ok) return;
    const m = parsed.message;
    if (m.kind === 'connect.offer') {
      this.offer(m);
      return;
    }
    if (!this.channel || m.channel !== this.channel) return;
    if (!capabilityAllows(m, this.accepted)) return;
    this.handle(m);
  }

  private offer(m: ConnectOfferMessage): void {
    // Only while a load is under way (the frame's, or the one after a load that never offered): a
    // fresh offer on a page whose load was already counted (a remount) is no load's.
    this.offeredSinceLoad = this.phase !== 'idle';
    if (this.phase === 'waiting') this.phase = 'idle';
    this.clearTimer();
    if (this.allowed === undefined) {
      this.pending = m;
      return;
    }
    const version = negotiateVersion(m.versions, SUPPORTED_VERSIONS);
    if (version === undefined) {
      // Stamped with the newest it offered: the only version it can read before connect.
      this.postOn(m.channel, m.versions[0] as number, {
        kind: 'connect.reject',
        reason: 'unsupported-version',
        versions: [...SUPPORTED_VERSIONS],
      });
      const newest = Math.max(...m.versions);
      this.setStatus('unsupported', newest < Math.min(...SUPPORTED_VERSIONS) ? 'old' : 'new');
      return;
    }
    // A fresh offer (a remount, a new page) replaces whatever session was here.
    this.endSession();
    this.channel = m.channel;
    this.version = version;
    this.accepted = narrowCapabilities(m.capabilities, this.allowed);
    this.post({ kind: 'connect.accept', version, capabilities: this.accepted });
    this.connectedOnce = true;
    this.setStatus('live');
    this.o.onSession?.([], this.accepted);
    if (this.has('select')) {
      if (!this.editing) this.post({ kind: 'editing', on: false });
      if (this.selected) this.post({ kind: 'select', ref: this.selected });
    }
  }

  private handle(m: FrontendMessage): void {
    switch (m.kind) {
      case 'page': {
        const had = this.pageEntries.includes(this.entry?.entryId ?? '');
        this.pageEntries = m.entries.map((e) => e.entryId);
        this.o.onSession?.(this.pageEntries, this.accepted);
        const shows = this.shows();
        this.setStatus(shows ? 'live' : 'elsewhere');
        if (shows && !had) this.sendState();
        return;
      }
      case 'navigated': {
        // The session ends; the next page offers again. Only to an address this space previews on.
        let to: string | undefined;
        try {
          to = new URL(m.url).origin;
        } catch {
          to = undefined;
        }
        this.endSession();
        // That page is leaving: the next load is another page's, which has its own offer to make.
        this.offeredSinceLoad = false;
        if (to && this.o.origins.includes(to)) {
          this.origin = to;
          this.phase = 'loading';
          this.wait(this.o.loadMs ?? LOAD_MS, () => this.setStatus('navigated'));
        } else {
          this.phase = 'idle';
          this.clearTimer();
          this.setStatus('navigated');
        }
        return;
      }
      case 'pointer':
        this.o.onPointer?.(m.pointer, m.ref, m.rect);
        return;
      case 'layout':
        this.o.onLayout?.(m);
        return;
      case 'applied':
        if (m.entryId !== undefined && m.entryId !== this.entry?.entryId) return;
        if (m.rev > this.rendered && m.rev <= this.rev) this.rendered = m.rev;
        if (m.rev > this.stateRev) this.recovering = false;
        return;
      case 'failed': {
        if (m.entryId !== undefined && m.entryId !== this.entry?.entryId) return;
        // Something the last whole state already replaced: that state puts it right.
        if (m.rev < this.stateRev || this.blocked) return;
        if (this.proposalRevs.has(m.rev) && m.reason !== 'gap') {
          // The page can't show the proposal (too many ghosts, a block it can't place, a render
          // that threw): it goes, so the state that resyncs the page doesn't bring it back to fail
          // again. A gap is the page missing an edit before it: resent with the state as ever.
          this.proposal = [];
          this.proposalRevs.clear();
          this.setShown(false, true);
          this.sendState();
          return;
        }
        if (m.reason === 'invalid' && m.rev === this.stateRev) {
          // The page can't read the entry itself; sending it again would fail the same way.
          this.blocked = true;
          this.setStatus('unpreviewable');
          return;
        }
        this.o.onNote?.(m.reason);
        // Ops refused again right after a recovery: this page takes blocks fields whole from here.
        if (m.reason === 'conflict' && this.recovering) this.wholeFields = true;
        this.recovering = true;
        this.sendState();
        return;
      }
    }
  }

  // --- from the editor --------------------------------------------------------------------

  /** What the person may let the page do. An offer waiting on it is answered now. */
  setAllowed(allowed: readonly Capability[]): void {
    this.allowed = allowed;
    // A live session only ever narrows: the admin may use less than it accepted, never more.
    if (this.channel) this.accepted = narrowCapabilities(this.accepted, allowed);
    const pending = this.pending;
    this.pending = undefined;
    if (pending) this.offer(pending);
  }

  /**
   * The entry as the form holds it now, and the edits since the last call: patches when there are
   * some, the whole state when `edits` is null, the entry or locale moved, or a patch is too big.
   */
  setEntry(entry: FrameEntry, edits: LiveEdits | null): void {
    const prev = this.entry;
    this.entry = entry;
    if (!this.shows() || this.blocked) return;
    if (edits === null || !prev || prev.entryId !== entry.entryId || prev.locale !== entry.locale) {
      this.sendState();
      return;
    }
    const fields: Record<string, unknown> = { ...edits.fields };
    const blocks = [];
    for (const group of edits.blocks) {
      if (this.wholeFields || !this.has('patch.blocks')) {
        fields[group.field] = entry.fields[group.field] ?? null;
      } else blocks.push(group);
    }
    if (Object.keys(fields).length > 0) {
      if (!this.has('patch.fields')) {
        this.sendState();
        return;
      }
      const patch = { kind: 'entry.patch', ...this.address(1), fields } as const;
      if (!withinBytes(patch, MAX_MESSAGE_BYTES - 1024)) {
        this.sendState();
        return;
      }
      this.rev += 1;
      this.post({ ...patch, rev: this.rev });
    }
    for (const group of blocks) {
      const patch = {
        kind: 'blocks.patch',
        ...this.address(1),
        field: group.field,
        ops: group.ops,
      } as const;
      if (!withinBytes(patch, MAX_MESSAGE_BYTES - 1024)) {
        this.sendState();
        return;
      }
      this.rev += 1;
      this.post({ ...patch, rev: this.rev });
    }
  }

  /** Turns in-page editing (picking) on or off: off, the page is the site, links followed. */
  setEditing(on: boolean): void {
    this.editing = on;
    if (this.has('select')) this.post({ kind: 'editing', on });
  }

  /** Outlines a ref on the page and scrolls it into view (`scroll`), or clears the selection. */
  select(ref: string | null, scroll = false): void {
    this.selected = ref;
    if (this.has('select')) this.post({ kind: 'select', ref });
    if (ref && scroll && this.has('scroll')) this.post({ kind: 'scroll', ref });
  }

  /**
   * Scrolls a marked element into the page's view, leaving the selection alone: centred, or its top
   * or bottom edge `inset` CSS pixels (the page's) clear of the view's (a page that doesn't read
   * `align` centres it).
   */
  scrollTo(ref: string, place?: { readonly align: 'start' | 'end'; readonly inset: number }): void {
    if (!this.has('scroll')) return;
    this.post({
      kind: 'scroll',
      ref,
      ...(place ? { align: place.align, inset: place.inset } : {}),
    });
  }

  /**
   * Coworker's proposal for the entry, rendered by the page as ghost blocks that are never part of
   * its saved state, or null to take it back. Its ops are the dry run's applied ops in the entry's
   * locale, every block they bring keyed, so each ghost has a name. Sent only on a session that
   * accepted `proposals`; a new proposal, or none, first clears the page's with a fresh state.
   * Returns whether the page was sent it.
   */
  setProposal(ops: readonly LivePatchOp[] | null): boolean {
    const had = this.proposalShown;
    const next: { field: string; ops: LivePatchOp[] }[] = [];
    for (const op of ops ?? []) {
      const group = next.find((g) => g.field === op.field);
      if (group) group.ops.push(op);
      else next.push({ field: op.field, ops: [op] });
    }
    this.proposal = next;
    // A fresh state clears what the page holds, and sends the new proposal after it.
    if (had) this.sendState();
    else this.sendProposal();
    return this.proposalShown;
  }

  /**
   * Sends the held proposal, the ops in the locale the page shows: after a whole state, or on its
   * own when the page holds none.
   */
  private sendProposal(): void {
    const locale = this.entry?.locale;
    const groups = this.proposal
      .map((g) => ({ field: g.field, ops: g.ops.filter((op) => op.locale === locale) }))
      .filter((g) => g.ops.length > 0);
    if (groups.length === 0 || !this.has('proposals') || !this.shows() || this.blocked) {
      this.setShown(false);
      return;
    }
    for (const { field, ops } of groups) {
      const patch = {
        kind: 'blocks.patch',
        ...this.address(1),
        field,
        ops: ops.map((op) => ({ ...op, proposed: true as const })),
      } as const;
      // Too big to cross: shown in Coworker's card only.
      if (!withinBytes(patch, MAX_MESSAGE_BYTES - 1024)) {
        const sent = this.proposalRevs.size > 0;
        this.proposal = [];
        this.setShown(false, true);
        // Part of it went out: a fresh state takes that back.
        if (sent) this.sendState();
        return;
      }
      this.rev += 1;
      this.proposalRevs.add(this.rev);
      this.post({ ...patch, rev: this.rev });
    }
    this.setShown(true);
  }

  private setShown(shown: boolean, refused = false): void {
    if (shown === this.proposalShown && !refused) return;
    this.proposalShown = shown;
    this.o.onProposal?.(shown, refused);
  }

  /** The capabilities the session was accepted with (empty before connect). */
  get capabilities(): readonly Capability[] {
    return this.accepted;
  }

  dispose(): void {
    this.clearTimer();
    this.endSession();
  }

  // --- helpers ----------------------------------------------------------------------------

  private shows(): boolean {
    return !!this.channel && !!this.entry && this.pageEntries.includes(this.entry.entryId);
  }

  private has(c: Capability): boolean {
    return !!this.channel && this.accepted.includes(c);
  }

  private address(ahead: number) {
    const e = this.entry as FrameEntry;
    return { rev: this.rev + ahead, entryId: e.entryId, locale: e.locale };
  }

  private sendState(): void {
    const e = this.entry;
    if (!e || !this.shows() || this.blocked) return;
    if (!this.has('patch.fields') && !this.has('patch.blocks')) return;
    const state = { kind: 'entry.state', ...this.address(1), fields: e.fields } as const;
    if (!withinBytes(state, MAX_STATE_BYTES - 1024)) {
      this.blocked = true;
      this.setShown(false);
      this.setStatus('unpreviewable');
      return;
    }
    this.rev += 1;
    this.stateRev = this.rev;
    this.post({ ...state, rev: this.rev });
    // A whole state clears the page's proposals: the one still waiting goes again on top of it.
    this.proposalRevs.clear();
    this.sendProposal();
  }

  private endSession(): void {
    this.channel = undefined;
    this.version = undefined;
    this.accepted = [];
    this.pageEntries = [];
    this.blocked = false;
    this.recovering = false;
    // The page and its ghosts are gone; a proposal still waiting goes to the next one.
    this.proposalRevs.clear();
    this.setShown(false);
  }

  private post(message: Outbound): void {
    if (!this.channel || this.version === undefined) return;
    this.postOn(this.channel, this.version, message);
  }

  private postOn(channel: string, v: number, message: Outbound): void {
    this.o.frame()?.postMessage({ v, channel, ...message }, this.origin);
  }

  private setStatus(status: HostStatus, detail?: string): void {
    // Still connected while the page shows other entries, or can't take this one's state.
    if (status !== 'live' && status !== 'elsewhere' && status !== 'unpreviewable')
      this.endSession();
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

/** Whether `value` is at most `cap` bytes of UTF-8 JSON (the page's own cap on what it reads). */
function withinBytes(value: unknown, cap: number): boolean {
  const json = JSON.stringify(value);
  return json.length <= cap && new TextEncoder().encode(json).byteLength <= cap;
}

function isOffer(data: unknown): boolean {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { kind?: unknown }).kind === 'connect.offer'
  );
}
