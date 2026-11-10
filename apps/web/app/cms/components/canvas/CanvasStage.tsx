/**
 * The canvas: the customer's own page in the Site frame, with the editor's overlays drawn over it
 * (never a copy of the page): the seams where a block can go, the block under the pointer and the
 * selected one. Every box comes from the page's `layout` (or a click's own box), moved into the
 * frame's coordinates by the frame, so the overlays line up at any device width.
 *
 * The overlay is for the pointer. The keyboard and screen readers reach every block and seam from
 * Layers (the page inside the frame isn't navigable from here), so the seams are out of the tab
 * order and hidden from assistive technology, and the page's frame is the one named thing here.
 */
import type { LiveRect } from '@contentworker/sdk-core/live-preview';
import { cn } from '@contentworker/ui/lib/utils';
import { Lock } from 'lucide-react';
import type { RefObject } from 'react';
import { slotFill } from '~/cms/lib/canvas/model';
import type { Seam } from '~/cms/lib/canvas/seams';
import { useMedia } from '~/cms/lib/device';

export interface CanvasStageProps {
  readonly frameRef: RefObject<HTMLIFrameElement | null>;
  readonly frameKey: string;
  readonly src: string;
  /** Still framing the page: the frame isn't reachable under its skeleton. */
  readonly loading: boolean;
  /** Seams to draw; empty when editing is off or the page reports no layout. */
  readonly seams: readonly Seam[];
  /** The seam the dock is open at. */
  readonly chosenSeam: string | null;
  readonly hovered: LiveRect | null;
  readonly selected: LiveRect | null;
  /** The locked regions the page shows: each one's outline, around all of its blocks. */
  readonly regions?: readonly { readonly id: string; readonly rect: LiveRect }[];
  readonly onChooseSeam: (seam: Seam) => void;
  readonly children?: React.ReactNode;
}

export function CanvasStage(props: CanvasStageProps) {
  const coarse = useMedia('(pointer: coarse)');
  return (
    // Focusable, so focus has somewhere to land on the canvas when the dock closes from a seam.
    <div
      data-canvas-stage
      tabIndex={-1}
      className="relative size-full min-h-0 overflow-hidden bg-muted outline-none"
    >
      <iframe
        key={props.frameKey}
        ref={props.frameRef}
        src={props.src}
        title="Site preview"
        inert={props.loading || undefined}
        className="block size-full border-0"
      />
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
        {props.regions?.map((r) => (
          <RegionMark key={r.id} rect={r.rect} />
        ))}
        {props.hovered ? <Box rect={props.hovered} /> : null}
        {props.selected ? <Box rect={props.selected} selected /> : null}
        {props.seams.map((seam) => (
          <SeamMark
            key={seam.id}
            seam={seam}
            least={coarse ? SEAM_TOUCH : SEAM_TARGET}
            chosen={seam.id === props.chosenSeam}
            onChoose={() => props.onChooseSeam(seam)}
          />
        ))}
      </div>
      {props.children}
    </div>
  );
}

/** A block's outline: selected is the ink edge with the focus ring, hover a lighter edge. */
function Box({ rect, selected }: { rect: LiveRect; selected?: boolean }) {
  return (
    <div
      data-outline={selected ? 'selected' : 'hover'}
      className={cn(
        'absolute rounded-sm border',
        selected ? 'border-foreground shadow-[0_0_0_2px_var(--ring)]' : 'border-foreground/40',
      )}
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
    />
  );
}

/**
 * A locked region's outline: a quiet grey edge around its blocks with a lock at its top corner, on
 * a paper chip so it holds against the customer's page. Grey, not a status hue: a lock is a fact of
 * the page, not something wrong with it. Who locked it is said in Layers and the inspector.
 */
function RegionMark({ rect }: { rect: LiveRect }) {
  return (
    <div
      data-region-outline
      className="absolute rounded-sm border border-muted-foreground/60"
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
    >
      <span className="absolute -top-2.5 left-1.5 inline-flex size-5 items-center justify-center rounded-full border bg-background text-muted-foreground shadow-sm">
        <Lock className="size-3" />
      </span>
    </div>
  );
}

/** The least a seam's target is, across its run: a gap of 0px between blocks is still a place. */
const SEAM_TARGET = 16;
/** For a finger, as the workflow editor's handles grow on touch. */
const SEAM_TOUCH = 44;
/**
 * The most it is: the page reports the gap's box, and a page that reported a huge one would
 * otherwise lay a seam over the whole frame and take every click meant for the page.
 */
const SEAM_MAX = 48;

/**
 * One seam: a dashed rule across the gap, its slot's name and fill shown on hover and once chosen.
 * Dashed grey at rest, ink under the pointer; the chosen one, while the dock is open, is a solid
 * brand line (brand marks what you chose; it is never a status).
 */
function SeamMark({
  seam,
  least,
  chosen,
  onChoose,
}: {
  seam: Seam;
  least: number;
  chosen: boolean;
  onChoose: () => void;
}) {
  const { rect, axis } = seam;
  const across = axis === 'y';
  // Centred on the gap, at least SEAM_TARGET thick, so a seam between touching blocks can be hit.
  const thick = Math.min(SEAM_MAX, Math.max(least, across ? rect.h : rect.w));
  const box = across
    ? { left: rect.x, top: rect.y + rect.h / 2 - thick / 2, width: rect.w, height: thick }
    : { left: rect.x + rect.w / 2 - thick / 2, top: rect.y, width: thick, height: rect.h };
  return (
    <button
      type="button"
      tabIndex={-1}
      data-seam={seam.id}
      data-full={seam.slot.full || undefined}
      onClick={onChoose}
      className="group pointer-events-auto absolute flex items-center justify-center"
      style={box}
    >
      {chosen ? (
        // Where the block will go, while the dock is open: a solid brand line, the mark of what
        // was chosen (never a status), apart from the dashed seams and the hover pill.
        <span
          data-insertion-line
          className={cn(
            // A paper halo, so the line holds against whatever the customer's page is drawn in.
            'absolute rounded-full bg-brand shadow-[0_0_0_2px_var(--background)]',
            across
              ? 'inset-x-0 top-1/2 h-0.5 -translate-y-1/2'
              : 'inset-y-0 left-1/2 w-0.5 -translate-x-1/2',
          )}
        />
      ) : (
        <span
          className={cn(
            'absolute border-dashed border-muted-foreground/50 transition-[border-color] duration-(--motion-instant) group-hover:border-foreground',
            across ? 'inset-x-0 top-1/2 border-t' : 'inset-y-0 left-1/2 border-l',
          )}
        />
      )}
      <span
        className={cn(
          'relative rounded-full border bg-background px-2 py-0.5 text-2xs text-foreground shadow-sm',
          chosen ? 'border-brand' : 'hidden group-hover:inline-block',
        )}
      >
        {slotFill(seam.slot)}
      </span>
    </button>
  );
}
