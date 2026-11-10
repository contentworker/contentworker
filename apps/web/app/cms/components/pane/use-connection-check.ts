/**
 * Connect a frontend's live check: it frames the Site frame (`routes/preview-frame.tsx`) for one
 * entry, out of sight, and reports how the site's page answered the live preview channel. It is the
 * same frame, the same host and the same preview link the entry editor's Site pane uses, so
 * "connected" here means the editor will connect. A lighter check can't say as much: a fetch of
 * the site from this page can't read a cross-origin answer, and a page that loads hasn't offered
 * to connect. The page is accepted with no capabilities: it can't be sent or asked anything.
 */

import { useEffect, useRef, useState } from 'react';
import { type FrameMessage, postFrame, readFrame } from '~/cms/lib/live-preview/frame-channel';
import { LOAD_MS } from '~/cms/lib/live-preview/host';

/** What the check found. `sdk` carries which way the site's SDK is off (`old` or `new`). */
export type ConnectionResult =
  | { readonly state: 'checking' }
  | { readonly state: 'connected'; readonly origin?: string }
  | { readonly state: 'sdk'; readonly detail: 'old' | 'new' }
  | {
      readonly state: 'not-connected';
      /** `silent` loaded but never offered; `failed` never loaded; `origin` offered from elsewhere. */
      readonly reason: 'silent' | 'failed' | 'origin' | 'navigated';
      readonly detail?: string;
    }
  | { readonly state: 'unavailable'; readonly detail?: string };

/** The Site frame's address for an entry. */
export const checkFrameSrc = (spaceId: string, environmentId: string, entryId: string) =>
  `/preview-frame/${encodeURIComponent(spaceId)}/${encodeURIComponent(environmentId)}/` +
  encodeURIComponent(entryId);

/**
 * Runs one check per `run` (a new value checks again) while `entryId` is set, answering through
 * the returned `result` (null before the first run) and the frame to render (`frameRef`, `src`).
 * The frame is dropped once there is an answer, so the site isn't left loaded behind the screen.
 */
export function useConnectionCheck(props: {
  readonly spaceId: string;
  readonly environmentId: string;
  readonly entryId: string | undefined;
  readonly run: number;
}) {
  const { spaceId, environmentId, entryId, run } = props;
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [result, setResult] = useState<ConnectionResult | null>(null);
  const active = run > 0 && entryId !== undefined;
  const checking = active && result?.state === 'checking';

  // Each run starts over: checking, until the frame says how the page answered.
  useEffect(() => {
    if (!active) return;
    setResult({ state: 'checking' });
    let ready = false;
    let origin: string | undefined;
    // The frame itself never came up (a refused load, a dead server): said, not waited on.
    const loadTimer = setTimeout(() => {
      if (!ready) setResult({ state: 'not-connected', reason: 'failed' });
    }, LOAD_MS);
    const onMessage = (event: MessageEvent) => {
      const m = readFrame<FrameMessage>(event, frameRef.current?.contentWindow);
      if (!m) return;
      if (m.type === 'ready') {
        ready = true;
        clearTimeout(loadTimer);
        origin = m.origin;
        // Nothing allowed: the offer is answered, and the session can do nothing.
        postFrame(frameRef.current?.contentWindow, {
          type: 'view',
          editing: false,
          device: 'desktop',
          allowed: [],
        });
        return;
      }
      if (m.type !== 'status') return;
      clearTimeout(loadTimer);
      switch (m.status) {
        case 'loading':
          return;
        case 'live':
        case 'elsewhere':
        case 'unpreviewable':
          setResult({ state: 'connected', ...(origin ? { origin } : {}) });
          return;
        case 'unsupported':
          setResult({ state: 'sdk', detail: m.detail === 'new' ? 'new' : 'old' });
          return;
        case 'not-connected':
          setResult({ state: 'not-connected', reason: 'silent' });
          return;
        case 'failed':
          setResult({ state: 'not-connected', reason: 'failed' });
          return;
        case 'origin':
          setResult({
            state: 'not-connected',
            reason: 'origin',
            ...(m.detail ? { detail: m.detail } : {}),
          });
          return;
        case 'navigated':
          setResult({ state: 'not-connected', reason: 'navigated' });
          return;
        case 'unavailable':
          setResult({ state: 'unavailable', ...(m.detail ? { detail: m.detail } : {}) });
          return;
      }
    };
    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('message', onMessage);
      clearTimeout(loadTimer);
    };
  }, [active, run, entryId, spaceId, environmentId]);

  return {
    frameRef,
    result: active ? result : null,
    checking,
    /** Rendered only while checking, keyed per run so each check is a fresh load. */
    src: checking && entryId ? checkFrameSrc(spaceId, environmentId, entryId) : undefined,
    frameKey: `${run}:${entryId ?? ''}`,
  };
}
