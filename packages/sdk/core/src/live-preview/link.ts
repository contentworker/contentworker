/**
 * How the inline editor learns a live preview is connected, so it can stand down: the admin turns
 * editing on and off, clicks go to `pointer`, and nothing is drawn in the page.
 *
 * Held on the global object under a registered symbol rather than in module state: the published
 * package bundles `inline-edit` and `live-preview` as separate entries (and CJS without code
 * splitting), so the two may not share one module instance, but they always share the window.
 */

export interface PreviewLinkState {
  /** A live preview session is connected. */
  readonly connected: boolean;
  /** The admin has editing (picking) on. */
  readonly editing: boolean;
}

type Listener = (state: PreviewLinkState) => void;

interface Link {
  state: PreviewLinkState;
  readonly listeners: Set<Listener>;
}

const KEY = Symbol.for('contentworker.live-preview.link');

function link(): Link {
  const holder = globalThis as { [KEY]?: Link };
  holder[KEY] ??= { state: { connected: false, editing: false }, listeners: new Set() };
  return holder[KEY];
}

/** Called by `connectPreview` as the session connects, toggles editing and ends. */
export function setPreviewLink(state: PreviewLinkState): void {
  const l = link();
  l.state = state;
  for (const listener of l.listeners) listener(state);
}

/** Calls `listener` now and on every change; returns the unsubscribe. */
export function onPreviewLink(listener: Listener): () => void {
  const l = link();
  l.listeners.add(listener);
  listener(l.state);
  return () => {
    l.listeners.delete(listener);
  };
}
