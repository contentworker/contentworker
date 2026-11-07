/**
 * The side pane's Site view: the entry on the customer's own frontend, re-rendered with every
 * unsaved edit (live preview).
 *
 * It frames the Site frame (`routes/preview-frame.tsx`, this origin), which frames the site and
 * speaks live preview with it. This side sends the entry as the form holds it, with the ops since
 * the last send (`liveOps`), and hears back where things stand, what was clicked and which
 * shortcut keys were pressed in the page. Saving stays the editor's: nothing here writes.
 */

import type { ContentType, EntryFields } from '@contentworker/domain';
import type { LiveTarget } from '@contentworker/sdk-core/live-preview';
import { Alert, AlertDescription, AlertTitle } from '@contentworker/ui/alert';
import { Button } from '@contentworker/ui/button';
import { cn } from '@contentworker/ui/lib/utils';
import { Segmented, SegmentedItem } from '@contentworker/ui/segmented';
import { Skeleton } from '@contentworker/ui/skeleton';
import { Monitor, Smartphone, Tablet } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { LoadingStatus } from '~/cms/components/loading';
import {
  DEVICE_WIDTHS,
  type Device,
  type FrameEntry,
  type FrameKey,
  type FrameMessage,
  postFrame,
  readFrame,
  type SiteStatus,
} from '~/cms/lib/live-preview/frame-channel';
import { LOAD_MS } from '~/cms/lib/live-preview/host';
import { liveOps } from '~/cms/lib/live-preview/ops';

/** The published guide to the page side, linked where a site doesn't answer. */
export const LIVE_PREVIEW_GUIDE = 'https://docs.contentworker.app/guides/live-preview/';

const DEVICE_KEY = 'cw.entry-pane.device';
const DEVICES: readonly { value: Device; label: string; icon: typeof Monitor }[] = [
  { value: 'desktop', label: 'Desktop', icon: Monitor },
  { value: 'tablet', label: 'Tablet', icon: Tablet },
  { value: 'phone', label: 'Phone', icon: Smartphone },
];

/** How long a quiet note (a refused patch) stays under the frame. */
const NOTE_MS = 6_000;

export interface SitePaneProps {
  readonly spaceId: string;
  readonly environmentId: string;
  readonly entryId: string;
  readonly contentType: Pick<ContentType, 'apiId' | 'fields' | 'preview'>;
  /** The entry's saved version, sent with the entry. */
  readonly version: number;
  /** The form's values, as a save would send them, and the locale tab it is on. */
  readonly fields: EntryFields;
  readonly locale: string;
  /** Beside the form (the pane's own height) rather than stacked under it. */
  readonly split: boolean;
  /** A block or field clicked in the page, in edit mode. */
  readonly onPick: (target: LiveTarget) => void;
  /** A shortcut pressed in the page, to act on as if pressed in the editor. */
  readonly onKey: (key: FrameKey) => void;
}

export function SitePane(props: SitePaneProps) {
  const { spaceId, environmentId, entryId, contentType, version, fields, locale } = props;
  const outer = useRef<HTMLIFrameElement>(null);
  const [frameKey, setFrameKey] = useState(0);
  const [status, setStatus] = useState<{ status: SiteStatus; detail?: string }>({
    status: 'loading',
  });
  const [origin, setOrigin] = useState<string | undefined>();
  const [note, setNote] = useState<string | undefined>();
  const [device, setDevice] = useDevice();
  const [mode, setMode] = useState<'edit' | 'view'>('edit');
  const ready = useRef(false);
  // What the frame was last sent: the next edit is the ops from here.
  const sent = useRef<EntryFields | null>(null);
  const latest = useRef<FrameEntry>({
    fields,
    locale,
    version,
    entryId,
    contentType: contentType.apiId,
  });
  latest.current = { fields, locale, version, entryId, contentType: contentType.apiId };
  const handlers = useRef(props);
  handlers.current = props;

  // Clicks select while editing; in view mode the page is the site, its links followed.
  const live = status.status === 'live';
  const effectiveMode = live ? mode : 'view';
  const modeRef = useRef(effectiveMode);
  modeRef.current = effectiveMode;
  const deviceRef = useRef(device);
  deviceRef.current = device;
  // A template that says `{locale}` (or a field's value, which may be localized) is another page
  // per locale: the frame loads that page. Otherwise the same page gets the entry in the locale.
  const template = contentType.preview?.urlTemplate ?? '';
  const perLocale = /\{(locale|field:[^}]*)\}/.test(template);
  const src =
    `/preview-frame/${encodeURIComponent(spaceId)}/${encodeURIComponent(environmentId)}/` +
    `${encodeURIComponent(entryId)}${perLocale ? `?locale=${encodeURIComponent(locale)}` : ''}`;

  const reload = () => {
    ready.current = false;
    sent.current = null;
    setStatus({ status: 'loading' });
    setNote(undefined);
    setFrameKey((k) => k + 1);
  };

  // The frame's messages, from the frame's own window only; listened for again per frame load.
  useEffect(() => {
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
          sent.current = latest.current.fields;
          postFrame(outer.current?.contentWindow, {
            type: 'entry',
            entry: latest.current,
            ops: null,
          });
          postFrame(outer.current?.contentWindow, {
            type: 'view',
            mode: modeRef.current,
            device: deviceRef.current,
          });
          return;
        case 'status':
          if (m.status === 'unavailable') clearTimeout(loadTimer);
          setStatus({ status: m.status, ...(m.detail ? { detail: m.detail } : {}) });
          if (m.status === 'live') setNote(undefined);
          return;
        case 'note':
          setNote(m.kind);
          clearTimeout(noteTimer);
          noteTimer = setTimeout(() => setNote(undefined), NOTE_MS);
          return;
        case 'pick':
          handlers.current.onPick(m.target);
          return;
        case 'key':
          // Escape clears the selection, here and on the page; the rest act in the editor.
          if (m.key === 'Escape') postFrame(outer.current?.contentWindow, { type: 'select' });
          handlers.current.onKey({
            key: m.key,
            meta: m.meta,
            ctrl: m.ctrl,
            shift: m.shift,
            alt: m.alt,
          });
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

  // Every edit: the ops since the last send, or the whole entry when they can't be a patch.
  useEffect(() => {
    if (!ready.current) return;
    const ops = sent.current ? liveOps(contentType, sent.current, fields) : null;
    sent.current = fields;
    postFrame(outer.current?.contentWindow, {
      type: 'entry',
      entry: { fields, locale, version, entryId, contentType: contentType.apiId },
      ops,
    });
  }, [fields, locale, version, entryId, contentType]);

  useEffect(() => {
    if (ready.current) {
      postFrame(outer.current?.contentWindow, { type: 'view', mode: effectiveMode, device });
    }
  }, [effectiveMode, device]);

  // Escape in the pane clears the selection, as it does pressed in the page.
  const region = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = region.current;
    if (!el) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') postFrame(outer.current?.contentWindow, { type: 'select' });
    };
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
  }, []);

  const loading = status.status === 'loading';
  const showFrame = status.status !== 'unavailable';

  return (
    <section ref={region} aria-label="Site" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Segmented
          aria-label="Device width"
          value={device}
          onValueChange={(v) => setDevice(v as Device)}
        >
          {DEVICES.map(({ value, label, icon: Icon }) => (
            <SegmentedItem
              key={value}
              value={value}
              aria-label={`${label}, ${DEVICE_WIDTHS[value]} pixels`}
              title={`${label} (${DEVICE_WIDTHS[value]}px)`}
            >
              <Icon aria-hidden="true" />
            </SegmentedItem>
          ))}
        </Segmented>
        <Segmented
          aria-label="Clicks in the page"
          value={mode}
          onValueChange={(v) => setMode(v as 'edit' | 'view')}
          disabled={!live}
        >
          <SegmentedItem value="edit" title="A click selects the field in the form">
            Edit
          </SegmentedItem>
          <SegmentedItem value="view" title="Links are followed, as on the site">
            View
          </SegmentedItem>
        </Segmented>
      </div>

      <SiteNotice status={status} origin={origin} onReload={reload} />

      {showFrame ? (
        <div
          aria-busy={loading || undefined}
          className={cn(
            'relative overflow-hidden rounded-xl bg-muted',
            props.split
              ? 'h-[calc(100dvh-var(--shell-h)-var(--editor-bar-h,0px)-9rem)] min-h-80'
              : 'h-[36rem]',
          )}
        >
          <iframe
            key={frameKey}
            ref={outer}
            src={src}
            title="Site preview"
            className="block size-full border-0"
          />
          {loading ? (
            <>
              <LoadingStatus>Loading the entry’s page…</LoadingStatus>
              <Skeleton aria-hidden="true" className="absolute inset-0 rounded-none" />
            </>
          ) : null}
        </div>
      ) : null}

      {note === 'patch' || note === 'render' ? (
        <p role="status" className="text-muted-foreground text-xs">
          {note === 'patch'
            ? 'The page couldn’t apply an edit, so it was sent the whole entry again.'
            : 'The page couldn’t render the last edit.'}
        </p>
      ) : null}
      {origin && showFrame ? (
        <p className="truncate text-muted-foreground text-xs">
          On <span className="font-mono">{origin}</span>
        </p>
      ) : null}
    </section>
  );
}

/** Why the page isn't live, in words, with the one thing to do about it. */
function SiteNotice({
  status,
  origin,
  onReload,
}: {
  status: { status: SiteStatus; detail?: string };
  origin: string | undefined;
  onReload: () => void;
}) {
  switch (status.status) {
    case 'loading':
    case 'live':
      return null;
    case 'timeout':
      return (
        <Alert>
          <AlertTitle>This site doesn’t speak live preview yet</AlertTitle>
          <AlertDescription>
            <p>
              The page loaded but didn’t answer, so it shows the entry as saved. Edits appear here
              as you type once the page runs the live preview runtime.
            </p>
            <a
              href={LIVE_PREVIEW_GUIDE}
              target="_blank"
              rel="noreferrer"
              className="font-medium text-link hover:underline"
            >
              Set up live preview
            </a>
          </AlertDescription>
        </Alert>
      );
    case 'navigated':
      return (
        <Alert>
          <AlertTitle>The page moved away from this entry</AlertTitle>
          <AlertDescription>
            <p>Edits go to the entry’s own page.</p>
            <Button type="button" variant="outline" size="sm" onClick={onReload}>
              Back to the entry
            </Button>
          </AlertDescription>
        </Alert>
      );
    case 'origin':
      return (
        <Alert variant="destructive">
          <AlertTitle>The page answered from another address</AlertTitle>
          <AlertDescription>
            <p>
              It answered from <span className="font-mono">{status.detail}</span>
              {origin ? (
                <>
                  , but the preview URL names <span className="font-mono">{origin}</span>
                </>
              ) : null}
              . Set the type’s preview URL to the address the page is served from.
            </p>
          </AlertDescription>
        </Alert>
      );
    case 'failed':
      return (
        <Alert variant="destructive">
          <AlertTitle>The page didn’t load</AlertTitle>
          <AlertDescription>
            <p>Check that the site is running and lets this admin frame it.</p>
            <Button type="button" variant="outline" size="sm" onClick={onReload}>
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      );
    case 'unavailable':
      return (
        <Alert variant={status.detail === 'incomplete' ? 'default' : 'destructive'}>
          <AlertTitle>
            {status.detail === 'incomplete'
              ? 'This entry has no page on the site yet'
              : 'The entry’s page can’t be shown'}
          </AlertTitle>
          <AlertDescription>
            <p>{UNAVAILABLE[status.detail ?? ''] ?? UNAVAILABLE.error}</p>
            {status.detail === 'error' || status.detail === 'incomplete' ? (
              <Button type="button" variant="outline" size="sm" onClick={onReload}>
                Try again
              </Button>
            ) : null}
          </AlertDescription>
        </Alert>
      );
  }
}

const UNAVAILABLE: Record<string, string> = {
  'not-found': 'This entry can’t be found in this space and environment.',
  refused: 'Your role can’t make a preview link for this entry.',
  incomplete:
    'Its preview URL needs a value this entry doesn’t have in this locale yet (a slug, say). Save one, then try again.',
  error: 'The preview link couldn’t be made just now.',
};

/** The device width, remembered per browser; Desktop until someone picks another. */
function useDevice(): [Device, (d: Device) => void] {
  const [device, setDevice] = useState<Device>('desktop');
  useEffect(() => {
    try {
      const kept = localStorage.getItem(DEVICE_KEY);
      if (kept === 'tablet' || kept === 'phone') setDevice(kept);
    } catch {
      // Storage blocked: Desktop.
    }
  }, []);
  return [
    device,
    (d) => {
      setDevice(d);
      try {
        if (d === 'desktop') localStorage.removeItem(DEVICE_KEY);
        else localStorage.setItem(DEVICE_KEY, d);
      } catch {
        // Storage blocked: the choice lasts for this page.
      }
    },
  ];
}
