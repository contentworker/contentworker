/**
 * How the inline editor learns a live preview is connected, so it can stand down: the admin turns
 * editing on and off, clicks go to `pointer`, and nothing is drawn in the page.
 *
 * Held on the global object under a registered symbol rather than in module state: the published
 * package bundles `inline-edit` and `live-preview` as separate entries (and CJS without code
 * splitting), so the two may not share one module instance, but they always share the window.
 * Each connection reports for itself, so one closing (a remount, a second component) doesn't turn
 * the overlay back on while another is still connected.
 */

export interface PreviewLinkState {
  /** A live preview session is connected. */
  readonly connected: boolean;
  /** The admin has editing (picking) on. */
  readonly editing: boolean;
}

type Listener = (state: PreviewLinkState) => void;

interface Link {
  readonly connections: Map<symbol, PreviewLinkState>;
  readonly listeners: Set<Listener>;
}

// Versioned: a page loading two SDK releases must not hand one the other's shape of link.
const KEY = Symbol.for('contentworker.live-preview.link.v2');

function link(): Link {
  const holder = globalThis as { [KEY]?: Link };
  holder[KEY] ??= { connections: new Map(), listeners: new Set() };
  return holder[KEY];
}

/** Connected while any connection is; editing while any connected one has it on. */
function current(l: Link): PreviewLinkState {
  let connected = false;
  let editing = false;
  for (const state of l.connections.values()) {
    if (!state.connected) continue;
    connected = true;
    editing ||= state.editing;
  }
  return { connected, editing };
}

/** Called by each `connectPreview` as its session connects, toggles editing and ends. */
export function setPreviewLink(connection: symbol, state: PreviewLinkState | undefined): void {
  const l = link();
  if (state) l.connections.set(connection, state);
  else l.connections.delete(connection);
  const now = current(l);
  for (const listener of l.listeners) listener(now);
}

/** Calls `listener` now and on every change; returns the unsubscribe. */
export function onPreviewLink(listener: Listener): () => void {
  const l = link();
  l.listeners.add(listener);
  listener(current(l));
  return () => {
    l.listeners.delete(listener);
  };
}
