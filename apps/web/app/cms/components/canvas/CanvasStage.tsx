/**
 * The canvas: the customer's own page in the Site frame, with the editor's overlays drawn over it
 * (never a copy of the page): the seams where a block can go, the block under the pointer and the
 * selected one, the locked regions, and Coworker's ghost blocks while its proposal waits (marked
 * "Proposed" in words). Every box comes from the page's `layout` (or a click's own box), moved into
 * the frame's coordinates by the frame, so the overlays line up at any device width.
 *
 * With a fine pointer the selected block carries a grip: dragged, the seams it may go to stand out,
 * the one nearest the pointer takes the insertion line (or says why the block can't go there), and
 * letting go moves it there (`drag.judge`, `cms/lib/canvas/drag.ts`). Esc, or letting go away from
 * every seam, puts it down where it was. A touch screen has no grip: iPadOS drag is unreliable, so
 * a finger moves blocks from the inspector and Layers, as the keyboard does.
 *
 * The overlay is for the pointer. The keyboard and screen readers reach every block and seam from
 * Layers (the page inside the frame isn't navigable from here), so the seams and the grip are out of
 * the tab order and hidden from assistive technology, and the page's frame is the one named thing
 * here. Every move a drag makes, the inspector's Move up, Move down and Move to make too.
 */
import type { LiveRect } from '@contentworker/sdk-core/live-preview';
import { cn } from '@contentworker/ui/lib/utils';
import { GripVertical, Lock } from 'lucide-react';
import { type RefObject, useEffect, useRef, useState } from 'react';
import type { DropVerdict } from '~/cms/lib/canvas/drag';
import { slotFill } from '~/cms/lib/canvas/model';
import type { Seam } from '~/cms/lib/canvas/seams';
import { useMedia } from '~/cms/lib/device';
import type { GhostKind } from '~/cms/lib/live-preview/proposals';
import { GhostMark } from './GhostMark';

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
  /** Coworker's ghost blocks the page draws while its proposal waits: each marked as proposed. */
  readonly ghosts?: readonly {
    readonly key: string;
    readonly kind: GhostKind;
    readonly rect: LiveRect;
  }[];
  readonly onChooseSeam: (seam: Seam) => void;
  /** Dragging the selected block to a seam; absent where it can't be (touch, review, a lock). */
  readonly drag?: StageDrag;
  readonly children?: React.ReactNode;
}

/** The selected block, offered to the pointer to drag. */
export interface StageDrag {
  readonly key: string;
  readonly name: string;
  readonly rect: LiveRect;
  /** Whether the block may go at a seam: the op that moves it there, or why not. */
  readonly judge: (seam: Seam) => DropVerdict;
  readonly onStart: () => void;
  readonly onDrop: (seam: Seam) => void;
  /** Let go over a seam it can't go to: the reason, to say. */
  readonly onRefused: (reason: string) => void;
  /** Put down where it was (Esc, or away from every seam). */
  readonly onCancel: () => void;
}

/** How far the pointer travels before a press on the grip is a drag, not a click. */
const DRAG_SLOP = 4;
/** How near a seam the pointer must be for it to take the block: about a seam's touch target. */
const DROP_REACH = 44;

/** A drag under way: where the pointer is in the stage, and the seam nearest it. */
interface Moving {
  readonly x: number;
  readonly y: number;
  readonly over: { readonly seam: Seam; readonly verdict: DropVerdict } | null;
}

export function CanvasStage(props: CanvasStageProps) {
  const coarse = useMedia('(pointer: coarse)');
  const stage = useRef<HTMLDivElement>(null);
  const [moving, setMoving] = useState<Moving | null>(null);
  /** Where the press on the grip began, until it is a drag or a click. */
  const pressed = useRef<{ x: number; y: number } | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const movingRef = useRef(moving);
  movingRef.current = moving;

  const pointAt = (e: { clientX: number; clientY: number }) => {
    const box = stage.current?.getBoundingClientRect();
    return { x: e.clientX - (box?.left ?? 0), y: e.clientY - (box?.top ?? 0) };
  };
  /** The seam nearest a point within reach, judged for the dragged block. */
  const overAt = (x: number, y: number): Moving['over'] => {
    const drag = latest.current.drag;
    if (!drag) return null;
    let best: { seam: Seam; d: number } | null = null;
    for (const seam of latest.current.seams) {
      const d = distance(seam.rect, x, y);
      if (d <= DROP_REACH && (!best || d < best.d)) best = { seam, d };
    }
    return best ? { seam: best.seam, verdict: drag.judge(best.seam) } : null;
  };
  const end = () => {
    pressed.current = null;
    movingRef.current = null;
    setMoving(null);
  };

  // Esc puts the block down where it was, before the canvas's own Esc (deselect) hears it.
  useEffect(() => {
    if (!moving) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      end();
      latest.current.drag?.onCancel();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [moving]);

  // The block went (undo, another's save) or stopped being draggable: nothing is carried.
  const dragKey = props.drag?.key;
  useEffect(() => {
    if (!dragKey) end();
  }, [dragKey]);

  const drag = props.drag;
  const dragging = moving && drag ? drag : null;
  return (
    // Focusable, so focus has somewhere to land on the canvas when the dock closes from a seam.
    <div
      ref={stage}
      data-canvas-stage
      data-dragging={dragging ? '' : undefined}
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
        {props.ghosts?.map((g) => (
          <GhostMark key={g.key} kind={g.kind} rect={g.rect} />
        ))}
        {props.hovered && !dragging ? <Box rect={props.hovered} /> : null}
        {props.selected ? <Box rect={props.selected} selected moving={!!dragging} /> : null}
        {props.seams.map((seam) => {
          // While a block is carried: the seams it may go to stand out, the rest step back, and
          // the one nearest the pointer says what letting go there does.
          const verdict = dragging ? dragging.judge(seam) : undefined;
          const over = moving?.over?.seam.id === seam.id;
          return (
            <SeamMark
              key={seam.id}
              seam={seam}
              least={coarse ? SEAM_TOUCH : SEAM_TARGET}
              chosen={dragging ? over && verdict?.kind === 'move' : seam.id === props.chosenSeam}
              {...(verdict ? { drop: { kind: verdict.kind, over } } : {})}
              {...(over && verdict?.kind === 'refused' ? { says: verdict.reason } : {})}
              onChoose={() => props.onChooseSeam(seam)}
            />
          );
        })}
        {drag ? (
          // Held by the pointer from the press until it lets go (pointer capture), over the frame
          // too, so the page under it never takes the drag; a wheel still scrolls the page.
          <button
            type="button"
            tabIndex={-1}
            data-drag-handle={drag.key}
            title={`Drag to move ${drag.name}`}
            className={cn(
              'pointer-events-auto absolute inline-flex size-6 touch-none items-center justify-center rounded-full border bg-background text-muted-foreground shadow-sm hover:text-foreground',
              dragging ? 'cursor-grabbing' : 'cursor-grab',
            )}
            style={{ left: drag.rect.x + Math.max(0, drag.rect.w - 30), top: drag.rect.y + 6 }}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              e.preventDefault();
              e.currentTarget.setPointerCapture?.(e.pointerId);
              // Out of the framed page, whose keys the admin never hears, so Esc can put it back.
              stage.current?.focus({ preventScroll: true });
              pressed.current = pointAt(e);
            }}
            onPointerMove={(e) => {
              const at = pointAt(e);
              if (movingRef.current) {
                const next = { ...at, over: overAt(at.x, at.y) };
                movingRef.current = next;
                setMoving(next);
                return;
              }
              const from = pressed.current;
              if (!from || Math.hypot(at.x - from.x, at.y - from.y) < DRAG_SLOP) return;
              pressed.current = null;
              drag.onStart();
              // Held in the ref at once: the next move may come before the render that sets it.
              const started = { ...at, over: overAt(at.x, at.y) };
              movingRef.current = started;
              setMoving(started);
            }}
            onPointerUp={(e) => {
              const was = movingRef.current;
              end();
              if (!was) return;
              const at = pointAt(e);
              const over = overAt(at.x, at.y);
              if (over?.verdict.kind === 'move') drag.onDrop(over.seam);
              else if (over?.verdict.kind === 'refused') drag.onRefused(over.verdict.reason);
              else drag.onCancel();
            }}
            onPointerCancel={() => {
              const was = movingRef.current;
              end();
              if (was) drag.onCancel();
            }}
          >
            <GripVertical className="size-3.5" />
          </button>
        ) : null}
        {dragging && moving ? (
          // The block in hand, beside the pointer.
          <span
            data-drag-chip
            className="absolute inline-flex items-center gap-1 rounded-full border bg-background px-2 py-0.5 text-2xs text-foreground shadow-sm"
            style={{ left: moving.x + 12, top: moving.y + 12 }}
          >
            <GripVertical className="size-3" />
            Moving {dragging.name}
          </span>
        ) : null}
      </div>
      {props.children}
    </div>
  );
}

/** How far a point is from a box: 0 inside it. */
function distance(rect: LiveRect, x: number, y: number): number {
  const dx = Math.max(rect.x - x, 0, x - (rect.x + rect.w));
  const dy = Math.max(rect.y - y, 0, y - (rect.y + rect.h));
  return Math.hypot(dx, dy);
}

/**
 * A block's outline: selected is the ink edge with the focus ring, hover a lighter edge. Carried
 * (a drag under way), the selected one's edge is dashed: it is still there until it lands.
 */
function Box({ rect, selected, moving }: { rect: LiveRect; selected?: boolean; moving?: boolean }) {
  return (
    <div
      data-outline={moving ? 'moving' : selected ? 'selected' : 'hover'}
      className={cn(
        'absolute rounded-sm border',
        moving
          ? 'border-foreground border-dashed'
          : selected
            ? 'border-foreground shadow-[0_0_0_2px_var(--ring)]'
            : 'border-foreground/40',
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
 *
 * While a block is carried (`drop`), a seam it may go to is a dashed ink rule, one it can't go to
 * or its own place isn't drawn, and the one nearest the pointer is the brand line with its slot's
 * name, or, where the block can't go, the reason on the pill (`says`) and no line.
 */
function SeamMark({
  seam,
  least,
  chosen,
  drop,
  says,
  onChoose,
}: {
  seam: Seam;
  least: number;
  chosen: boolean;
  drop?: { readonly kind: DropVerdict['kind']; readonly over: boolean };
  says?: string;
  onChoose: () => void;
}) {
  if (drop && drop.kind !== 'move' && !(drop.over && says)) return null;
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
      data-drop={drop ? (says ? 'refused' : 'allowed') : undefined}
      onClick={onChoose}
      className={cn(
        'group absolute flex items-center justify-center',
        drop ? 'pointer-events-none' : 'pointer-events-auto',
      )}
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
      ) : says ? null : (
        <span
          className={cn(
            'absolute border-dashed transition-[border-color] duration-(--motion-instant) group-hover:border-foreground',
            drop ? 'border-foreground/70' : 'border-muted-foreground/50',
            across ? 'inset-x-0 top-1/2 border-t' : 'inset-y-0 left-1/2 border-l',
          )}
        />
      )}
      <span
        data-seam-says={says ? '' : undefined}
        className={cn(
          'relative rounded-full border bg-background px-2 py-0.5 text-2xs text-foreground shadow-sm',
          chosen ? 'border-brand' : says ? 'inline-block' : 'hidden group-hover:inline-block',
          // A reason stays on one line, even on a narrow vertical seam.
          says && 'whitespace-nowrap',
        )}
      >
        {says ?? slotFill(seam.slot)}
      </span>
    </button>
  );
}
