import { type KeyboardEvent, type RefObject, useLayoutEffect, useRef, useState } from 'react';

/**
 * The widths the entry form and the side pane each need before they can sit side by side: a form
 * column, and the panels' own 21rem. Below their sum the pane stacks under the form instead of
 * squeezing either one. Measured on the row they share, not on the viewport, so collapsing the
 * sidebar buys the split back. (After felix's side pane.)
 */
export const MAIN_MIN_PX = 420;
export const PANE_MIN_PX = 336;

/**
 * How the pane stands beside the form. `split`: side by side, behind the divider. `stack`: under
 * the form, as on a phone or an iPad. `rail`: a strip of the pane's views on the form's right edge,
 * each opening the pane over the form; only beside the assistant's column, where the row is too
 * narrow to split and stacking would push the entry's history below the fold just while Coworker
 * proposes changes to it.
 */
export type PaneMode = 'split' | 'rail' | 'stack';

export function paneMode(width: number, beside: { readonly assistantColumn: boolean }): PaneMode {
  if (width >= MAIN_MIN_PX + PANE_MIN_PX) return 'split';
  // Unmeasured (the server, the first render) stacks, as it always has.
  return width > 0 && beside.assistantColumn ? 'rail' : 'stack';
}

const SHARE_KEY = 'cw.entry-pane.share';
/** Under half: the form keeps the larger side until someone moves the divider. */
export const DEFAULT_SHARE = 0.4;

function readShare(): number {
  try {
    const v = Number(localStorage.getItem(SHARE_KEY));
    return Number.isFinite(v) && v > 0 && v < 1 ? v : DEFAULT_SHARE;
  } catch {
    return DEFAULT_SHARE;
  }
}

function writeShare(v: number) {
  try {
    if (v === DEFAULT_SHARE) localStorage.removeItem(SHARE_KEY);
    else localStorage.setItem(SHARE_KEY, v.toFixed(3));
  } catch {
    // Storage blocked: the split lasts for this page.
  }
}

export interface PaneLayout {
  /** The row the form and the pane share: a callback ref, so a row that mounts late is measured. */
  ref: (el: HTMLElement | null) => void;
  /** Side by side, a rail beside the form, or stacked under it. */
  mode: PaneMode;
  /** Room for both side by side. */
  split: boolean;
  /** The pane's share of the row, clamped so neither side drops below its floor. */
  share: number;
  min: number;
  max: number;
  onChange: (share: number) => void;
  onCommit: (share: number) => void;
  onReset: () => void;
}

/**
 * Where the divider stands. The share is per browser rather than per entry (it is how this screen
 * likes to be divided), and a drag is held apart from it, so a drag writes to storage once, when
 * it ends. The server can't measure, so it draws the stacked layout and the split arrives before
 * the first paint after hydration.
 */
export function usePaneLayout(beside: { readonly assistantColumn: boolean }): PaneLayout {
  const [el, ref] = useState<HTMLElement | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (!el) return;
    const measure = () => setWidth(el.getBoundingClientRect().width);
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);

  const [stored, setStored] = useState(DEFAULT_SHARE);
  useLayoutEffect(() => setStored(readShare()), []);
  const [live, setLive] = useState<number | null>(null);

  const mode = paneMode(width, beside);
  const split = mode === 'split';
  const min = width ? Math.min(PANE_MIN_PX / width, 0.5) : DEFAULT_SHARE;
  const max = width ? Math.max(1 - MAIN_MIN_PX / width, min) : DEFAULT_SHARE;
  const share = Math.min(max, Math.max(min, live ?? stored));

  return {
    ref,
    mode,
    split,
    share,
    min,
    max,
    onChange: setLive,
    onCommit: (v) => {
      setLive(null);
      setStored(v);
      writeShare(v);
    },
    onReset: () => {
      setLive(null);
      setStored(DEFAULT_SHARE);
      writeShare(DEFAULT_SHARE);
    },
  };
}

/**
 * What the entry editor's side pane shows: the draft as a document, the entry on the customer's
 * own site (live preview), the entry's panels, or its activity (the audit rows about it, for a
 * space administrator).
 */
export type PaneView = 'preview' | 'site' | 'details' | 'activity';

/**
 * The segments the pane offers, in order. A new entry has none (its pane is the preview alone);
 * Site only when the entry's type has a preview URL to frame; Activity only for an administrator.
 */
export function paneViews(opts: {
  readonly isEdit: boolean;
  readonly hasSite: boolean;
  readonly isAdmin: boolean;
}): PaneView[] {
  if (!opts.isEdit) return [];
  return [
    'details',
    'preview',
    ...(opts.hasSite ? (['site'] as const) : []),
    ...(opts.isAdmin ? (['activity'] as const) : []),
  ];
}

const VIEW_KEY = 'cw.entry-pane.view';

/**
 * The pane's view, remembered per browser; Details until someone picks another. Site is never
 * remembered: it frames the type's own site (and sends it the unsaved draft) only when someone
 * picks it for the entry in front of them.
 */
export function usePaneView(): [PaneView, (v: PaneView) => void] {
  const [view, setView] = useState<PaneView>('details');
  useLayoutEffect(() => {
    try {
      const kept = localStorage.getItem(VIEW_KEY);
      if (kept === 'preview' || kept === 'activity') setView(kept);
    } catch {
      // Storage blocked: Details.
    }
  }, []);
  return [
    view,
    (v) => {
      setView(v);
      if (v === 'site') return;
      try {
        if (v === 'details') localStorage.removeItem(VIEW_KEY);
        else localStorage.setItem(VIEW_KEY, v);
      } catch {
        // Storage blocked: the choice lasts for this page.
      }
    },
  ];
}

export interface PanePeek {
  /** The pane is open over the form. */
  open: boolean;
  /** A rail view pressed: open the pane at it, or close it when it is the view already open. */
  pick: (v: PaneView) => void;
  /** Close it; `refocus` hands focus back to the open view's button in the rail. */
  close: (refocus: boolean) => void;
  /** Escape, on the rail or in the pane, closes it. */
  onKeyDown: (e: KeyboardEvent<HTMLElement>) => void;
  railRef: RefObject<HTMLDivElement | null>;
}

/**
 * The pane opened from the rail. Held against the entry it was opened on, so another entry, or
 * the split coming back, finds it closed without an effect to reset it.
 */
export function usePanePeek(opts: {
  /** Whether the pane is folded to the rail at all. */
  readonly rail: boolean;
  /** The entry on screen (its id, or 'new'). */
  readonly entry: string;
  /** The view the pane shows. */
  readonly view: PaneView;
  /** Picks the pane's view; absent where it has one view only (a new entry's preview). */
  readonly onView?: ((v: PaneView) => void) | undefined;
}): PanePeek {
  const [openOn, setOpenOn] = useState<string | null>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const open = opts.rail && openOn === opts.entry;
  const close = (refocus: boolean) => {
    setOpenOn(null);
    // The rail's one tab stop is the open view's button, so the keyboard picks up where it was.
    if (refocus) railRef.current?.querySelector<HTMLElement>('button[tabindex="0"]')?.focus();
  };
  return {
    open,
    pick: (v) => {
      if (open && opts.view === v) return close(false);
      opts.onView?.(v);
      setOpenOn(opts.entry);
    },
    close,
    onKeyDown: (e) => {
      if (e.key !== 'Escape' || !open || e.defaultPrevented) return;
      // A menu or dialog the pane opened is portalled outside it and keeps its own Escape.
      if (!e.currentTarget.contains(e.target as Node)) return;
      e.preventDefault();
      close(true);
    },
    railRef,
  };
}
