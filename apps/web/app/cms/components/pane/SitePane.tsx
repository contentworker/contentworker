/**
 * The side pane's Site view: the entry on the customer's own frontend, re-rendered with every
 * unsaved edit (live preview, docs/specs/live-preview-channel.md).
 *
 * It frames the Site frame (`routes/preview-frame.tsx`, this origin), which frames the site and
 * runs the live preview channel with it (`useSiteFrame`, shared with the canvas editor): the entry
 * as the form holds it goes there with every edit, and clicks come back. Saving stays the
 * editor's: nothing here writes.
 */

import type { BlockOp, Breakpoint, ContentType, EntryFields } from '@contentworker/domain';
import type { Capability } from '@contentworker/sdk-core/live-preview';
import { Alert, AlertDescription, AlertTitle } from '@contentworker/ui/alert';
import { Button } from '@contentworker/ui/button';
import { cn } from '@contentworker/ui/lib/utils';
import { Segmented, SegmentedItem } from '@contentworker/ui/segmented';
import { Skeleton, SkeletonText } from '@contentworker/ui/skeleton';
import { Monitor, Smartphone, Tablet } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { ProposalLine } from '~/cms/components/canvas/ProposalLine';
import { LoadingStatus } from '~/cms/components/loading';
import { defaultPreset, type WidthPreset, widthPresets } from '~/cms/lib/breakpoints';
import type { SiteStatus } from '~/cms/lib/live-preview/frame-channel';
import { ghostOps } from '~/cms/lib/live-preview/proposals';
import { useSiteFrame } from './use-site-frame';

/** The published guide to the page side, linked where a site doesn't connect. */
export const LIVE_PREVIEW_GUIDE = 'https://docs.contentworker.app/guides/live-preview/';

const DEVICE_KEY = 'cw.entry-pane.device';
const DEVICE_ICONS = { desktop: Monitor, tablet: Tablet, phone: Smartphone } as const;

export interface SitePaneProps {
  readonly spaceId: string;
  readonly environmentId: string;
  readonly entryId: string;
  readonly contentType: Pick<ContentType, 'apiId' | 'fields' | 'preview'>;
  /** The form's values, as a save would send them, and the locale tab it is on. */
  readonly fields: EntryFields;
  readonly locale: string;
  readonly defaultLocale: string;
  /**
   * What the person may let the page do: a role that can't edit the entry only selects (its clicks
   * still focus fields); its unsaved values are never sent.
   */
  readonly allowed: readonly Capability[] | undefined;
  /** The form's focused field or block on the page, or none: outlined and scrolled into view. */
  readonly selected: string | null;
  /** Beside the form (the pane's own height) rather than stacked under it. */
  readonly split: boolean;
  /** A marked element clicked in the page, and the entries the page said it renders. */
  readonly onPick: (ref: string, pageEntries: readonly string[]) => void;
  /**
   * The catalog's breakpoints: the frame's widths are Base and one per breakpoint when it declares
   * any (`widthPresets`), else Desktop, Tablet and Phone.
   */
  readonly breakpoints?: readonly Breakpoint[];
  /**
   * The block patch a Coworker card for this entry proposes, while it waits: the page shows its
   * blocks as ghosts, outlined as proposed. Nothing here saves it; the card does, on Confirm.
   */
  readonly proposal?: readonly BlockOp[] | null;
  /** The proposal was confirmed, and its save is under way. */
  readonly saving?: boolean;
}

export function SitePane(props: SitePaneProps) {
  const presets = useMemo(() => widthPresets(props.breakpoints), [props.breakpoints]);
  const [preset, setPreset] = useWidthPreset(presets);
  const [mode, setMode] = useState<'edit' | 'view'>('edit');
  const shownOps = useMemo(
    () => (props.proposal ? ghostOps(props.proposal) : null),
    [props.proposal],
  );
  const site = useSiteFrame({ ...props, mode, width: preset.width, proposal: shownOps });
  const { status, origin, note, live, reload } = site;
  // What clicks do now: View until the page answers, whatever was chosen.
  const effectiveMode = live ? mode : 'view';

  const loading = status.status === 'loading';
  const showFrame = status.status !== 'unavailable';

  return (
    <section aria-label="Site" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <WidthSwitch presets={presets} value={preset} onChange={setPreset} />
        <Segmented
          aria-label="Clicks in the page"
          // What clicks do now: View until the page answers, whatever was chosen.
          value={effectiveMode}
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
          // Not reachable by Tab under the skeleton.
          inert={loading || undefined}
          className={cn(
            'relative overflow-hidden rounded-xl bg-muted',
            props.split
              ? 'h-[calc(100dvh-var(--shell-h)-var(--editor-bar-h,0px)-9rem)] min-h-80'
              : 'h-[36rem]',
          )}
        >
          <iframe
            // A new element per load, so a reload or another locale's page adds no history entry.
            key={site.frameKey}
            ref={site.frameRef}
            src={site.src}
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

      <ProposalLine
        waiting={!!props.proposal}
        saving={props.saving === true}
        shown={site.proposal.shown}
        refused={site.proposal.refused}
        unsupported={live && !site.capabilities.includes('proposals')}
      />
      {/* Always there, so a screen reader hears the note when its words arrive. */}
      <p role="status" className="text-muted-foreground text-xs empty:hidden">
        {note === 'render'
          ? 'The page couldn’t render the last edit, so it was sent the whole entry again.'
          : note
            ? 'The page couldn’t apply an edit, so it was sent the whole entry again.'
            : ''}
      </p>
      {/* Its line is held while the frame loads, so the address arriving moves nothing. */}
      {showFrame && origin ? (
        <p className="truncate text-muted-foreground text-xs">
          On <span className="font-mono">{origin}</span>
        </p>
      ) : loading ? (
        <p className="text-xs">
          <SkeletonText width="10rem" />
        </p>
      ) : null}
    </section>
  );
}

function GuideLink() {
  return (
    <a
      href={LIVE_PREVIEW_GUIDE}
      target="_blank"
      rel="noreferrer"
      className="font-medium text-link hover:underline"
    >
      Set up live preview
    </a>
  );
}

/** Why the page isn't live, in words, with the one thing to do about it. */
export function SiteNotice({
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
    case 'not-connected':
      return (
        <Alert>
          <AlertTitle className="line-clamp-none">
            This site isn’t connected for live preview
          </AlertTitle>
          <AlertDescription>
            <p>
              The page loaded but didn’t offer to connect, so it shows the entry as saved. Edits
              appear here as you type once the page calls{' '}
              <span className="font-mono">connectPreview</span>.
            </p>
            <p className="flex flex-wrap gap-x-4">
              {/* The screen that prints the page's config and checks it connects: in a new tab,
                  so the edit in hand isn't left. */}
              <a
                href="/settings/frontend"
                target="_blank"
                rel="noreferrer"
                className="font-medium text-link hover:underline"
              >
                Connect a frontend<span className="sr-only"> (opens in a new tab)</span>
              </a>
              <GuideLink />
            </p>
          </AlertDescription>
        </Alert>
      );
    case 'unsupported':
      return (
        <Alert variant="destructive">
          <AlertTitle className="line-clamp-none">
            {status.detail === 'new' ? 'The site’s SDK is too new' : 'The site’s SDK is too old'}
          </AlertTitle>
          <AlertDescription>
            <p>
              Its ContentWorker SDK shares no live preview version with this admin. Use a{' '}
              <span className="font-mono">@contentworker/sdk</span> release this admin supports;
              until then the page shows the entry as saved.
            </p>
            <GuideLink />
          </AlertDescription>
        </Alert>
      );
    case 'elsewhere':
      return (
        <Alert>
          <AlertTitle className="line-clamp-none">This page doesn’t show this entry</AlertTitle>
          <AlertDescription>
            <p>It’s connected, but your edits go to the page that renders the entry.</p>
            <Button type="button" variant="outline" size="sm" onClick={onReload}>
              Back to the entry
            </Button>
          </AlertDescription>
        </Alert>
      );
    case 'unpreviewable':
      return (
        <Alert variant="destructive">
          <AlertTitle className="line-clamp-none">
            This entry can’t be previewed on this page
          </AlertTitle>
          <AlertDescription>
            <p>
              The page refused the entry as the form holds it, so your edits aren’t shown. Clicks in
              the page still find their fields.
            </p>
          </AlertDescription>
        </Alert>
      );
    case 'navigated':
      return (
        <Alert>
          <AlertTitle className="line-clamp-none">The page moved away from this entry</AlertTitle>
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
          <AlertTitle className="line-clamp-none">
            The page answered from another address
          </AlertTitle>
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
          <AlertTitle className="line-clamp-none">The page didn’t load</AlertTitle>
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
          <AlertTitle className="line-clamp-none">
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

/**
 * The frame's width: the three devices as icons, or Base and the catalog's breakpoints by name,
 * each with its width in its accessible name.
 */
export function WidthSwitch(props: {
  presets: readonly WidthPreset[];
  value: WidthPreset;
  onChange: (id: string) => void;
}) {
  return (
    <Segmented aria-label="Device width" value={props.value.id} onValueChange={props.onChange}>
      {props.presets.map((p) => {
        const Icon = p.device ? DEVICE_ICONS[p.device] : null;
        return (
          <SegmentedItem
            key={p.id}
            value={p.id}
            aria-label={`${p.label}, ${p.width} pixels`}
            title={`${p.label} (${p.width}px)`}
            className={Icon ? undefined : 'max-w-32'}
          >
            {Icon ? <Icon aria-hidden="true" /> : <span className="truncate">{p.label}</span>}
          </SegmentedItem>
        );
      })}
    </Segmented>
  );
}

/**
 * The frame's width preset, remembered per browser by id; the widest (Desktop) until someone picks
 * another, and again when the one kept isn't among `presets` (the catalog's breakpoints changed).
 */
export function useWidthPreset(
  presets: readonly WidthPreset[],
): [WidthPreset, (id: string) => void] {
  const [kept, setKept] = useState<string | null>(null);
  useEffect(() => {
    try {
      setKept(localStorage.getItem(DEVICE_KEY));
    } catch {
      // Storage blocked: the widest.
    }
  }, []);
  const fallback = defaultPreset(presets);
  const preset = presets.find((p) => p.id === kept) ?? fallback;
  return [
    preset,
    (id) => {
      setKept(id);
      try {
        if (id === fallback.id) localStorage.removeItem(DEVICE_KEY);
        else localStorage.setItem(DEVICE_KEY, id);
      } catch {
        // Storage blocked: the choice lasts for this page.
      }
    },
  ];
}
