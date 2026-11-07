/**
 * The Site frame: the page the entry editor's Site pane frames, which frames the customer's own
 * page for the entry and runs live preview with it.
 *
 * The admin's own document can't frame the customer's site: its policy is fixed when it loads,
 * and the space is chosen in the browser after that. So the editor frames this page (same origin),
 * whose policy, set per response, allows framing exactly the one origin the entry's type previews
 * on (`frame-src 'self' <origin>`), and which only this origin may frame (`frame-ancestors
 * 'self'`). Its loader mints the preview link as the signed-in person; the link (a token for this
 * one entry) is the only credential the customer's page ever sees.
 *
 * It owns the inner frame and draws the hover and selection outlines over it, from the geometry
 * the page reports, scaled with the frame to the device width the editor chose. Unsaved edits come
 * from the editor over a same-origin channel (`cms/lib/live-preview/frame-channel.ts`) and go to the
 * page as patches (`cms/lib/live-preview/host.ts`); picks and keys go back the same way.
 */

import {
  LIVE_PREVIEW_SESSION_PARAM,
  type LiveGeometryMessage,
  type LivePreviewMode,
  type LiveRect,
  type LiveTarget,
} from '@contentworker/sdk-core/live-preview';
import { cn } from '@contentworker/ui/lib/utils';
import { useEffect, useRef, useState } from 'react';
import { data, useLoaderData } from 'react-router';
import {
  DEVICE_WIDTHS,
  type Device,
  type EditorMessage,
  postFrame,
  readFrame,
} from '~/cms/lib/live-preview/frame-channel';
import { LivePreviewHost } from '~/cms/lib/live-preview/host';
import { requireUser } from '~/lib/auth.server';
import { EMBED_HEADER, FRAME_HEADER, SELF_FRAMER } from '~/lib/csp';
import { type PreviewFrame, previewFrame } from '~/lib/preview-frame.server';
import type { Route } from './+types/preview-frame';

export const meta = () => [{ title: 'Site preview · ContentWorker' }];

export async function loader({ request, params }: Route.LoaderArgs) {
  // Only ever a frame: opened any other way (a link, a new tab) it would mint a token for a page
  // nobody frames. Browsers that don't say what a fetch is for still get the frame's own policy.
  const dest = request.headers.get('sec-fetch-dest');
  if (dest && dest !== 'iframe') {
    throw data({ ok: false, error: 'This page opens only in the entry editor.' }, { status: 404 });
  }
  const me = await requireUser(request);
  const url = new URL(request.url);
  const { frame, status } = await previewFrame(
    me,
    {
      spaceId: params.spaceId,
      environmentId: params.environmentId,
      entryId: params.entryId,
      locale: url.searchParams.get('locale') ?? undefined,
    },
    url.origin,
  );
  return data(frame, { status, headers: frameHeaders(frame) });
}

/**
 * The frame's policy, for entry.server.tsx to fold into its CSP: framed by this origin alone, and
 * framing the entry's site alone. Never stored: the answer carries a preview token.
 */
export function frameHeaders(frame: PreviewFrame): Headers {
  const headers = new Headers({
    [EMBED_HEADER]: JSON.stringify({ frameAncestors: [SELF_FRAMER], formAction: [] }),
    'x-frame-options': 'SAMEORIGIN',
    'cache-control': 'no-store',
  });
  if (frame.ok) headers.set(FRAME_HEADER, JSON.stringify([frame.origin]));
  return headers;
}

export function headers({ loaderHeaders }: Route.HeadersArgs) {
  return loaderHeaders;
}

/** Loaded once per frame: the editor reloads the frame itself when it wants another link. */
export const shouldRevalidate = () => false;

/** A fresh session id for one load of the page (what `cw_session` carries). */
function newSession(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function withSession(url: string, session: string): string {
  const u = new URL(url);
  u.searchParams.set(LIVE_PREVIEW_SESSION_PARAM, session);
  return u.toString();
}

export default function PreviewFrameRoute() {
  const frame = useLoaderData<typeof loader>() as PreviewFrame;
  useEffect(() => {
    if (window.parent === window) return;
    postFrame(
      window.parent,
      frame.ok
        ? { type: 'ready', origin: frame.origin }
        : { type: 'status', status: 'unavailable', detail: frame.reason },
    );
  }, [frame]);
  if (!frame.ok) {
    return (
      <main className="grid h-dvh place-items-center bg-muted p-4 text-center text-muted-foreground text-sm">
        <p className="max-w-measure">The entry’s page can’t be shown here.</p>
      </main>
    );
  }
  return <SiteFrame frontendUrl={frame.frontendUrl} origin={frame.origin} />;
}

function SiteFrame({ frontendUrl, origin }: { frontendUrl: string; origin: string }) {
  const iframe = useRef<HTMLIFrameElement>(null);
  const box = useRef<HTMLElement>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [device, setDevice] = useState<Device>('desktop');
  const [mode, setMode] = useState<LivePreviewMode>('view');
  const [geometry, setGeometry] = useState<LiveGeometryMessage | null>(null);
  const [hover, setHover] = useState<LiveTarget | undefined>();
  const [selected, setSelected] = useState<LiveTarget | undefined>();
  const host = useRef<LivePreviewHost | null>(null);

  // The session is minted in the browser, per load of this page: never in the server's answer.
  useEffect(() => {
    const session = newSession();
    const parent = window.parent;
    const h = new LivePreviewHost({
      origin,
      session,
      frame: () => iframe.current?.contentWindow,
      onStatus: (status, detail) => {
        if (status !== 'live') {
          setGeometry(null);
          setHover(undefined);
        }
        postFrame(parent, { type: 'status', status, ...(detail ? { detail } : {}) });
      },
      onGeometry: setGeometry,
      onHover: setHover,
      onPick: (target) => {
        setSelected(target);
        postFrame(parent, { type: 'pick', target });
      },
      onKey: ({ key, meta, ctrl, shift, alt }) =>
        postFrame(parent, { type: 'key', key, meta, ctrl, shift, alt }),
      // A link followed in edit mode: the frame goes there, on the site's own origin (the parser
      // refuses any other), keeping the session in case that page shows the entry too.
      onNavigate: (url) => {
        h.start();
        setSrc(withSession(url, session));
      },
      onNote: (kind) => postFrame(parent, { type: 'note', kind }),
    });
    host.current = h;
    const onMessage = (event: MessageEvent) => {
      const m = readFrame<EditorMessage>(event, parent);
      if (!m) {
        h.receive(event);
        return;
      }
      switch (m.type) {
        case 'entry':
          h.setEntry(m.entry, m.ops);
          return;
        case 'view':
          setDevice(m.device in DEVICE_WIDTHS ? m.device : 'desktop');
          setMode(m.mode === 'edit' ? 'edit' : 'view');
          h.setMode(m.mode === 'edit' ? 'edit' : 'view');
          return;
        case 'select':
          setSelected(m.target);
          h.select(m.target);
          return;
      }
    };
    window.addEventListener('message', onMessage);
    h.start();
    setSrc(withSession(frontendUrl, session));
    return () => {
      window.removeEventListener('message', onMessage);
      h.dispose();
      host.current = null;
    };
  }, [frontendUrl, origin]);

  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The site renders at the device's width whatever the pane's, scaled down to fit when wider.
  const width = DEVICE_WIDTHS[device];
  const scale = size.w > 0 ? Math.min(1, size.w / width) : 1;
  const left = Math.max(0, (size.w - width * scale) / 2);
  const height = size.h / scale;

  const rectOf = (t: LiveTarget | undefined): LiveRect | undefined => {
    if (!t || !geometry) return undefined;
    // Geometry may be partial on a very large page: a target it leaves out isn't drawn.
    if (t.key !== undefined) return geometry.blocks.find((b) => b.key === t.key)?.rect;
    return geometry.fields.find((f) => f.ref === t.ref)?.rect;
  };
  const same = (a?: LiveTarget, b?: LiveTarget) => !!a && !!b && a.key === b.key && a.ref === b.ref;
  const picked = mode === 'edit' ? rectOf(selected) : undefined;
  const hovered = mode === 'edit' && !same(hover, selected) ? rectOf(hover) : undefined;

  return (
    <main
      ref={box}
      aria-label="Site preview"
      className="relative h-dvh w-full overflow-hidden bg-muted"
    >
      {src ? (
        <div
          className="absolute top-0 origin-top-left"
          style={{ left, width, height, transform: `scale(${scale})` }}
        >
          <iframe
            ref={iframe}
            src={src}
            title="The entry on your site"
            // Scripts and forms, and its own origin so it can post as itself; never the top window,
            // popups or downloads. The token stays out of the page's Referer.
            sandbox="allow-scripts allow-same-origin allow-forms"
            referrerPolicy="no-referrer"
            onLoad={() => host.current?.frameLoaded()}
            className="block size-full border-0 bg-background"
          />
        </div>
      ) : null}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute top-0 overflow-hidden"
        style={{ left, width: width * scale, height: size.h }}
      >
        {hovered ? <Outline rect={hovered} scale={scale} /> : null}
        {picked ? <Outline rect={picked} scale={scale} selected /> : null}
      </div>
    </main>
  );
}

/** A block or field's outline: selected is an ink edge with the focus ring, hover a lighter edge. */
function Outline({ rect, scale, selected }: { rect: LiveRect; scale: number; selected?: boolean }) {
  return (
    <div
      className={cn(
        'absolute rounded-sm border',
        selected ? 'border-foreground shadow-[0_0_0_2px_var(--ring)]' : 'border-foreground/40',
      )}
      style={{
        left: rect.x * scale,
        top: rect.y * scale,
        width: rect.w * scale,
        height: rect.h * scale,
      }}
    />
  );
}
