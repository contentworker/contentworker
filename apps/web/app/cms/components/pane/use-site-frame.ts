/**
 * The editor's side of the Site frame (`routes/preview-frame.tsx`): it frames that page, sends it
 * the entry as the form (or the canvas) holds it, one locale's values (`liveFields`), with the
 * edits since the last send (`liveEdits`) and what the person may let the page do, and hears back
 * where things stand, which entries the page renders and what was clicked. Shared by the entry
 * editor's Site pane and the canvas editor, which also asks for the page's geometry (`canvas`).
 * Saving stays the editor's: nothing here writes.
 */

import {
  type ContentType,
  type EntryFields,
  previewTemplateVariesByLocale,
} from '@contentworker/domain';
import type { Capability, LivePatchOp, LiveRect } from '@contentworker/sdk-core/live-preview';
import { useEffect, useRef, useState } from 'react';
import {
  type FrameGeometry,
  type FrameMessage,
  postFrame,
  readFrame,
  type SiteStatus,
} from '~/cms/lib/live-preview/frame-channel';
import { LOAD_MS } from '~/cms/lib/live-preview/host';
import { type LiveEdits, liveEdits, liveFields } from '~/cms/lib/live-preview/ops';

/** How long a quiet note (a refused edit) stays under the frame. */
const NOTE_MS = 6_000;

export interface SiteFrameOptions {
  readonly spaceId: string;
  readonly environmentId: string;
  readonly entryId: string;
  readonly contentType: Pick<ContentType, 'apiId' | 'fields' | 'preview'>;
  /** The values, as a save would send them, and the locale being edited. */
  readonly fields: EntryFields;
  readonly locale: string;
  readonly defaultLocale: string;
  /** What the person may let the page do; undefined while it is still being read. */
  readonly allowed: readonly Capability[] | undefined;
  /** The focused field or block on the page, or none: outlined and scrolled into view. */
  readonly selected: string | null;
  /** Clicks select (editing), or the page is the site, its links followed. */
  readonly mode: 'edit' | 'view';
  /** The page's width, in CSS pixels: a preset's (`cms/lib/breakpoints.ts`). */
  readonly width: number;
  /** The canvas draws its own outlines: the frame reports geometry instead (`onGeometry`). */
  readonly canvas?: boolean;
  /**
   * Coworker's proposal while its card waits for the person's answer (the dry run's applied ops),
   * shown on the page as ghosts; null or absent, none.
   */
  readonly proposal?: readonly LivePatchOp[] | null;
  /** A marked element clicked in the page, and the entries the page said it renders. */
  readonly onPick: (ref: string, pageEntries: readonly string[]) => void;
  readonly onGeometry?: (geometry: FrameGeometry | null) => void;
  readonly onHover?: (ref: string | null, rect: LiveRect | null) => void;
}

export interface SiteFrame {
  readonly frameRef: React.RefObject<HTMLIFrameElement | null>;
  /** The frame's address and a key per load: a new element per load adds no history entry. */
  readonly src: string;
  readonly frameKey: string;
  readonly status: { readonly status: SiteStatus; readonly detail?: string };
  /** The site's origin, once the frame says. */
  readonly origin: string | undefined;
  /** Why the page was last sent the whole entry (`failed` reason), for a moment. */
  readonly note: string | undefined;
  /** Connected: clicks find fields even when the page can't take this entry's values. */
  readonly live: boolean;
  /** What the session was accepted with (empty before connect). */
  readonly capabilities: readonly Capability[];
  /** The page shows the proposal now; or it refused the last one (it couldn't place a block). */
  readonly proposal: { readonly shown: boolean; readonly refused: boolean };
  readonly reload: () => void;
  /**
   * Asks the page to bring a marked element into view (needs `scroll`): centred, or its top or
   * bottom edge `inset` frame pixels clear of the frame's edge.
   */
  readonly scrollTo: (
    ref: string,
    place?: { readonly align: 'start' | 'end'; readonly inset: number },
  ) => void;
  /** Asks the page to scroll `dy` frame pixels (needs `scroll` and `layout`): the canvas's drag. */
  readonly scrollBy: (dy: number) => void;
}

export function useSiteFrame(props: SiteFrameOptions): SiteFrame {
  const { spaceId, environmentId, entryId, contentType, fields, locale, defaultLocale } = props;
  const outer = useRef<HTMLIFrameElement>(null);
  const [frameKey, setFrameKey] = useState(0);
  const [status, setStatus] = useState<{ status: SiteStatus; detail?: string }>({
    status: 'loading',
  });
  const [origin, setOrigin] = useState<string | undefined>();
  const [note, setNote] = useState<string | undefined>();
  const [capabilities, setCapabilities] = useState<readonly Capability[]>([]);
  const [proposal, setProposal] = useState({ shown: false, refused: false });
  const ready = useRef(false);
  /** The proposal the frame was last sent, by content. */
  const proposalSent = useRef<string | null>(null);
  const pageEntries = useRef<readonly string[]>([]);
  // One locale's values, as the page renders them; what was last sent is where the next edits start.
  const now = liveFields(contentType, fields, locale, defaultLocale);
  const latest = useRef(now);
  latest.current = now;
  const sent = useRef<{ fields: typeof now; locale: string } | null>(null);
  const handlers = useRef(props);
  handlers.current = props;

  const live =
    status.status === 'live' || status.status === 'elsewhere' || status.status === 'unpreviewable';
  const effectiveMode = live ? props.mode : 'view';
  const viewOf = () => ({
    editing: effectiveMode === 'edit',
    width: props.width,
    ...(props.allowed ? { allowed: props.allowed } : {}),
    ...(props.canvas ? { canvas: true } : {}),
  });
  const view = useRef(viewOf());
  view.current = viewOf();
  // A template that fills to another URL per locale is another page per locale: the frame loads
  // that page. Otherwise the same page gets the entry in the new locale.
  const perLocale = previewTemplateVariesByLocale(
    contentType.preview?.urlTemplate ?? '',
    contentType.fields,
  );
  const src =
    `/preview-frame/${encodeURIComponent(spaceId)}/${encodeURIComponent(environmentId)}/` +
    `${encodeURIComponent(entryId)}${perLocale ? `?locale=${encodeURIComponent(locale)}` : ''}`;

  const toFrame = (m: Parameters<typeof postFrame>[1]) =>
    postFrame(outer.current?.contentWindow, m);

  // The frame's messages, from the frame's own window only. Each load of the frame (Try again, or
  // another locale's page) starts over: loading, nothing sent, until it says it's ready.
  // Listened for again per frame load (its key and src).
  useEffect(() => {
    ready.current = false;
    sent.current = null;
    pageEntries.current = [];
    setStatus({ status: 'loading' });
    setNote(undefined);
    setCapabilities([]);
    setProposal({ shown: false, refused: false });
    handlers.current.onGeometry?.(null);
    handlers.current.onHover?.(null, null);
    let noteTimer: ReturnType<typeof setTimeout> | undefined;
    // The frame never came up (a refused load, a dead server): said, not waited on for ever.
    const loadTimer = setTimeout(() => {
      if (!ready.current) setStatus({ status: 'failed' });
    }, LOAD_MS);
    const onMessage = (event: MessageEvent) => {
      const m = readFrame<FrameMessage>(event, outer.current?.contentWindow);
      if (!m) return;
      switch (m.type) {
        case 'ready':
          ready.current = true;
          clearTimeout(loadTimer);
          setOrigin(m.origin);
          // What the page may do first, so its offer is answered with it; then the entry.
          toFrame({ type: 'view', ...view.current });
          sent.current = { fields: latest.current, locale };
          toFrame({
            type: 'entry',
            entry: { entryId, locale, fields: latest.current },
            edits: null,
          });
          if (handlers.current.selected) {
            toFrame({ type: 'select', ref: handlers.current.selected });
          }
          // A new load holds no proposal: the one waiting goes to it.
          proposalSent.current = null;
          if (handlers.current.proposal) {
            proposalSent.current = JSON.stringify(handlers.current.proposal);
            toFrame({ type: 'proposal', ops: handlers.current.proposal });
          }
          return;
        case 'proposal':
          setProposal({ shown: m.shown === true, refused: m.refused === true });
          return;
        case 'status':
          if (m.status === 'unavailable') clearTimeout(loadTimer);
          setStatus({ status: m.status, ...(m.detail ? { detail: m.detail } : {}) });
          if (m.status === 'live') setNote(undefined);
          if (m.status !== 'live' && m.status !== 'elsewhere' && m.status !== 'unpreviewable') {
            setCapabilities([]);
          }
          return;
        case 'session':
          pageEntries.current = Array.isArray(m.entries) ? m.entries : [];
          setCapabilities(Array.isArray(m.capabilities) ? m.capabilities : []);
          return;
        case 'note':
          setNote(m.kind);
          clearTimeout(noteTimer);
          noteTimer = setTimeout(() => setNote(undefined), NOTE_MS);
          return;
        case 'pick':
          if (typeof m.ref === 'string') handlers.current.onPick(m.ref, pageEntries.current);
          return;
        case 'geometry':
          handlers.current.onGeometry?.(m.geometry ?? null);
          return;
        case 'hover':
          handlers.current.onHover?.(m.ref ?? null, m.rect ?? null);
          return;
      }
    };
    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('message', onMessage);
      clearTimeout(loadTimer);
      clearTimeout(noteTimer);
    };
  }, [frameKey, src]);

  // Every edit: the changes since the last send, or the whole state for a new locale.
  const nowJson = JSON.stringify(now);
  // Keyed on the values by content (nowJson).
  useEffect(() => {
    if (!ready.current) return;
    const before = sent.current;
    const edits: LiveEdits | null =
      before && before.locale === locale
        ? liveEdits(contentType, locale, before.fields, now)
        : null;
    if (edits && Object.keys(edits.fields).length === 0 && edits.blocks.length === 0) return;
    sent.current = { fields: now, locale };
    toFrame({ type: 'entry', entry: { entryId, locale, fields: now }, edits });
  }, [nowJson, locale, entryId, contentType]);

  const allowedKey = props.allowed?.join(',') ?? '';
  // `allowed` by content (allowedKey).
  useEffect(() => {
    if (ready.current) toFrame({ type: 'view', ...view.current });
  }, [effectiveMode, props.width, allowedKey, props.canvas]);

  // Per selection.
  useEffect(() => {
    if (ready.current) toFrame({ type: 'select', ref: props.selected });
  }, [props.selected]);

  // Per proposal, by content: shown while its card waits, taken back (null) when it is answered.
  const proposalKey = props.proposal ? JSON.stringify(props.proposal) : null;
  useEffect(() => {
    if (!ready.current || proposalSent.current === proposalKey) return;
    proposalSent.current = proposalKey;
    toFrame({ type: 'proposal', ops: props.proposal ?? null });
  }, [proposalKey]);

  return {
    frameRef: outer,
    src,
    frameKey: `${frameKey}:${src}`,
    status,
    origin,
    note,
    live,
    capabilities,
    proposal,
    reload: () => setFrameKey((k) => k + 1),
    scrollTo: (ref, place) => {
      if (ready.current) toFrame({ type: 'scroll', ref, ...(place ?? {}) });
    },
    scrollBy: (dy) => {
      if (ready.current) toFrame({ type: 'scrollBy', dy });
    },
  };
}
