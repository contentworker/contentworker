/**
 * The Site frame: the page the entry editor's Site pane frames, which frames the customer's own
 * page for the entry and runs the live preview channel with it (docs/specs/live-preview-channel.md).
 *
 * The admin's own document can't frame the customer's site: its policy is fixed when it loads,
 * and the space is chosen in the browser after that. So the editor frames this page (same origin),
 * whose policy, set per response, allows framing only the origins the space's preview URLs name
 * (`frame-src 'self' <origins>`), and which only this origin may frame (`frame-ancestors 'self'`).
 * Its loader mints the preview link as the signed-in person; the link (a token for this one entry)
 * is the only credential the customer's page ever sees. The page connects to us: nothing is added
 * to its URL.
 *
 * It owns the inner frame and draws the hover and selection outlines over it, from the boxes the
 * page reports, scaled with the frame to the width the editor chose. Under the canvas editor
 * it draws nothing: it hands the boxes (and the seams between blocks) up to the canvas, moved into
 * its own coordinates, and the canvas draws them over this frame. Unsaved edits come
 * from the editor over a same-origin channel (`cms/lib/live-preview/frame-channel.ts`) and go to the
 * page over the live preview channel (`cms/lib/live-preview/host.ts`); clicks go back the same way.
 * So does a Coworker proposal waiting for its answer: the page draws its blocks as ghosts, and this
 * frame outlines each as proposed (the canvas does, under the canvas).
 */

import type {
  LayoutMessage,
  LiveGap,
  LivePatchOp,
  LiveRect,
} from '@contentworker/sdk-core/live-preview';
import { cn } from '@contentworker/ui/lib/utils';
import { useEffect, useMemo, useRef, useState } from 'react';
import { data, useLoaderData } from 'react-router';
import { GhostMark } from '~/cms/components/canvas/GhostMark';
import {
  type EditorMessage,
  FRAME_WIDTH,
  type FrameGeometry,
  frameWidth,
  postFrame,
  readFrame,
} from '~/cms/lib/live-preview/frame-channel';
import { LivePreviewHost } from '~/cms/lib/live-preview/host';
import { ghostKeys, ghostOps, refBlockKey } from '~/cms/lib/live-preview/proposals';
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
 * framing only the space's preview origins. Never stored: the answer carries a preview token.
 */
export function frameHeaders(frame: PreviewFrame): Headers {
  const headers = new Headers({
    [EMBED_HEADER]: JSON.stringify({ frameAncestors: [SELF_FRAMER], formAction: [] }),
    'x-frame-options': 'SAMEORIGIN',
    'cache-control': 'no-store',
  });
  if (frame.ok) headers.set(FRAME_HEADER, JSON.stringify(frame.origins));
  return headers;
}

export function headers({ loaderHeaders }: Route.HeadersArgs) {
  return loaderHeaders;
}

/** Loaded once per frame: the editor reloads the frame itself when it wants another link. */
export const shouldRevalidate = () => false;

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
  return (
    <SiteFrame frontendUrl={frame.frontendUrl} origin={frame.origin} origins={frame.origins} />
  );
}

function SiteFrame({
  frontendUrl,
  origin,
  origins,
}: {
  frontendUrl: string;
  origin: string;
  origins: readonly string[];
}) {
  const iframe = useRef<HTMLIFrameElement>(null);
  const box = useRef<HTMLElement>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [width, setWidth] = useState<number>(FRAME_WIDTH.default);
  const [editing, setEditing] = useState(true);
  const [canvas, setCanvas] = useState(false);
  const [layout, setLayout] = useState<LayoutMessage | null>(null);
  // What the pointer is over and what is selected, by ref, with the box the page last gave.
  const [hover, setHover] = useState<{ ref: string; rect: LiveRect } | null>(null);
  const [selected, setSelected] = useState<{ ref: string; rect: LiveRect | null } | null>(null);
  /** Coworker's proposal's blocks, by key: outlined as proposed where the page draws them. */
  const [proposed, setProposed] = useState<readonly LivePatchOp[] | null>(null);
  const [ghostsShown, setGhostsShown] = useState(false);
  const [entry, setEntry] = useState<{ id: string; locale: string } | null>(null);
  const entryId = entry?.id ?? null;
  // The page shows the ops in its locale only (the host's `sendProposal`): those are what it drew.
  const ghosts = useMemo(
    () =>
      ghostKeys(
        ghostsShown && proposed ? proposed.filter((op) => op.locale === entry?.locale) : [],
      ),
    [ghostsShown, proposed, entry?.locale],
  );
  const host = useRef<LivePreviewHost | null>(null);

  useEffect(() => {
    const parent = window.parent;
    /** The ref last clicked in the page, until the form answers with its focus. */
    let picked: string | null = null;
    const h = new LivePreviewHost({
      origin,
      origins,
      frame: () => iframe.current?.contentWindow,
      onStatus: (status, detail) => {
        if (status !== 'live') {
          setLayout(null);
          setHover(null);
        }
        postFrame(parent, { type: 'status', status, ...(detail ? { detail } : {}) });
      },
      onSession: (entries, capabilities) =>
        postFrame(parent, { type: 'session', entries, capabilities }),
      onPointer: (pointer, ref, rect) => {
        if (pointer === 'hover') {
          setHover(ref && rect ? { ref, rect } : null);
          return;
        }
        if (!ref) return;
        picked = ref;
        setSelected({ ref, rect });
        // The editor checks the ref names its entry before it moves focus.
        postFrame(parent, { type: 'pick', ref });
      },
      onLayout: setLayout,
      onNote: (kind) => postFrame(parent, { type: 'note', kind }),
      onProposal: (shown, refused) => {
        // Marked only while the page holds it: a refused or unsupported one draws nothing.
        setGhostsShown(shown);
        postFrame(parent, { type: 'proposal', shown, ...(refused ? { refused } : {}) });
      },
    });
    host.current = h;
    const onMessage = (event: MessageEvent) => {
      const m = readFrame<EditorMessage>(event, parent);
      if (!m) {
        h.receive(event);
        return;
      }
      switch (m.type) {
        case 'view':
          setWidth(frameWidth(m.width));
          setEditing(m.editing === true);
          setCanvas(m.canvas === true);
          if (Array.isArray(m.allowed)) h.setAllowed(m.allowed);
          h.setEditing(m.editing === true);
          return;
        case 'entry':
          setEntry({ id: m.entry.entryId, locale: m.entry.locale });
          h.setEntry(m.entry, m.edits);
          return;
        case 'proposal': {
          // The editor's own window, but held to the shape the page will check again anyway.
          const ops = Array.isArray(m.ops) ? ghostOps(m.ops) : null;
          setProposed(ops);
          h.setProposal(ops);
          return;
        }
        case 'select':
          setSelected(m.ref ? { ref: m.ref, rect: null } : null);
          // The form focusing what was just clicked: outlined, but the page isn't scrolled under
          // the pointer.
          h.select(m.ref, m.ref !== picked);
          picked = null;
          return;
        case 'scroll': {
          if (typeof m.ref !== 'string') return;
          const align = m.align === 'start' || m.align === 'end' ? m.align : undefined;
          const inset = typeof m.inset === 'number' && Number.isFinite(m.inset) ? m.inset : 0;
          // The editor measures in the frame's pixels; the page, in its own (scaled down to fit).
          h.scrollTo(
            m.ref,
            align
              ? { align, inset: Math.min(4000, Math.max(0, inset / scaleRef.current)) }
              : undefined,
          );
          return;
        }
      }
    };
    window.addEventListener('message', onMessage);
    h.start();
    setSrc(frontendUrl);
    return () => {
      window.removeEventListener('message', onMessage);
      h.dispose();
      host.current = null;
    };
  }, [frontendUrl, origin, origins]);

  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The site renders at the chosen width whatever the pane's, scaled down to fit when wider.
  const scale = size.w > 0 ? Math.min(1, size.w / width) : 1;
  const left = Math.max(0, (size.w - width * scale) / 2);
  const height = size.h / scale;
  const scaleRef = useRef(scale);
  scaleRef.current = scale;

  // The box to draw for a ref: the latest layout's when the page reports one (it follows scrolling),
  // else the box the page gave with the pointer. Geometry may be partial on a very large page.
  const rectOf = (ref: string, given: LiveRect | null): LiveRect | null => {
    const found =
      layout?.fields.find((f) => f.ref === ref)?.rect ??
      layout?.blocks.find((b) => b.ref === ref)?.rect;
    return found ?? given;
  };
  const picked = editing && !canvas && selected ? rectOf(selected.ref, selected.rect) : null;
  // Coworker's ghosts where the page draws them; under the canvas, the canvas marks them.
  const ghostBoxes =
    !canvas && entryId && ghosts.size > 0
      ? (layout?.blocks ?? []).flatMap((b) => {
          const key = refBlockKey(b.ref, entryId);
          const kind = key ? ghosts.get(key) : undefined;
          return key && kind ? [{ key, kind, rect: b.rect }] : [];
        })
      : [];
  const hovered =
    editing && !canvas && hover && hover.ref !== selected?.ref
      ? rectOf(hover.ref, hover.rect)
      : null;

  // Under the canvas: the page's boxes, in this frame's coordinates, whenever they or the scale move.
  const toFrame = (r: LiveRect): LiveRect => ({
    x: left + r.x * scale,
    y: r.y * scale,
    w: r.w * scale,
    h: r.h * scale,
  });
  const geometryKey = canvas ? JSON.stringify([layout, scale, left]) : '';
  // Keyed on the boxes by content (geometryKey).
  useEffect(() => {
    if (!canvas) return;
    const gap = (g: LiveGap): LiveGap => ({ ...g, rect: toFrame(g.rect) });
    const geometry: FrameGeometry | null = layout
      ? {
          blocks: layout.blocks.map((b) => ({ ref: b.ref, rect: toFrame(b.rect) })),
          slots: layout.slots.map((s) => ({
            ref: s.ref,
            rect: toFrame(s.rect),
            gaps: s.gaps.map(gap),
          })),
          truncated: layout.truncated === true,
        }
      : null;
    postFrame(window.parent, { type: 'geometry', geometry });
  }, [geometryKey]);
  const hoverRect = canvas && hover ? rectOf(hover.ref, hover.rect) : null;
  const hoverKey = canvas ? JSON.stringify([hover?.ref ?? null, hoverRect, scale, left]) : '';
  // Keyed on the hovered box by content (hoverKey).
  useEffect(() => {
    if (!canvas) return;
    postFrame(window.parent, {
      type: 'hover',
      ref: hover?.ref ?? null,
      rect: hoverRect ? toFrame(hoverRect) : null,
    });
  }, [hoverKey]);

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
            // As the spec has it: scripts, forms, popups and its own origin (its cookies and storage;
            // safe because that origin is never this one). Never the top window or downloads. The
            // token stays out of the page's Referer.
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
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
        {ghostBoxes.map((g) => (
          <GhostMark
            key={g.key}
            kind={g.kind}
            rect={{
              x: g.rect.x * scale,
              y: g.rect.y * scale,
              w: g.rect.w * scale,
              h: g.rect.h * scale,
            }}
          />
        ))}
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
      data-outline={selected ? 'selected' : 'hover'}
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
