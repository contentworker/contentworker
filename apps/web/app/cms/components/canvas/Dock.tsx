/**
 * The dock: what can go at the chosen seam, and nothing else. It lists the blocks the seam's slot
 * takes (`dockGroups`) as one compact row of cards along the bottom edge, under the catalog's group
 * captions, each its name and a line of its description, scrolling sideways when they don't fit,
 * so the page above (and the chosen seam) stays in view. Picking one puts it in the page at once
 * (unsaved). A full slot says so and offers nothing, as does a locked one (the canvas draws no seam
 * there, but Add in Layers or the inspector can still ask), and so does a place inside a locked
 * region: in a slot of a block locked with everything inside, or between two blocks of a locked
 * run (`/` after one of them can still ask). A block whose manifest names an asset
 * (`thumbnail: { assetId }`) leads its card with that picture, read with the catalog's other
 * thumbnails in one lookup (`useBlockThumbnails`) and decorative beside its name; a `{ url }`
 * thumbnail isn't drawn (the admin's `img-src` takes no other origin), and neither is an asset
 * that's gone or fails to load: that block is its name, as before.
 *
 * One tab stop: ← → (and ↑ ↓) move across the cards, Home and End go to either end, Enter or Space
 * puts the block in, Escape closes the dock.
 *
 * With Coworker on, where the dock offers blocks it also offers Ask Coworker to fill this (a ghost
 * `xs` button led by the mark in `ai`): Coworker is asked for those same blocks at this place, and
 * its proposal comes back as a card to confirm, shown on the page as ghosts meanwhile.
 */
import type { BlockCatalog, ComponentVariant } from '@contentworker/domain';
import { Button } from '@contentworker/ui/button';
import { cn } from '@contentworker/ui/lib/utils';
import { X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { BlockThumbnail } from '~/cms/components/BlockThumbnail';
import { useBlockThumbnails } from '~/cms/lib/block-thumbnails';
import { dockGroups } from '~/cms/lib/canvas/dock';
import { type CanvasPlace, placeLockedBy, slotCount } from '~/cms/lib/canvas/model';
import { Mark } from '~/components/mark';

export interface DockProps {
  readonly place: CanvasPlace;
  readonly catalog: BlockCatalog | null | undefined;
  readonly onInsert: (variant: ComponentVariant) => void;
  readonly onClose: () => void;
  /** Drawn in a sheet, which has its own title and close button. */
  readonly inSheet?: boolean;
  /**
   * Ask Coworker to fill this place instead, with the blocks offered here; absent where Coworker is
   * off or the person can't edit. `held` says why it can't be asked yet.
   */
  readonly ask?: { readonly onAsk: () => void; readonly held?: string };
}

export function Dock({ place, catalog, onInsert, onClose, inSheet, ask }: DockProps) {
  const titleId = useId();
  const heldId = useId();
  const { slot, index } = place;
  const lockedBy = placeLockedBy(place);
  const groups = lockedBy ? [] : dockGroups(slot, catalog);
  const items = groups.flatMap((g) => g.items);
  const thumbnails = useBlockThumbnails(catalog);
  const row = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLElement>(null);
  // The card that holds the dock's one tab stop.
  const [active, setActive] = useState(0);
  const where =
    slot.blocks.length === 0
      ? 'empty'
      : index === 0
        ? `before ${slot.blocks[0]?.name ?? 'the first block'}`
        : `after ${slot.blocks[index - 1]?.name ?? 'the last block'}`;

  const cards = () => [...(row.current?.querySelectorAll<HTMLElement>('[data-dock-item]') ?? [])];
  const focusCard = (at: number) => {
    const card = cards()[at];
    if (!card) return;
    setActive(at);
    card.focus();
    card.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  };

  // Opening it is choosing a seam: the first block it offers takes focus, so Enter puts it there.
  // With none to offer (a full slot), the dock does, so what it says is heard and Escape works.
  useEffect(() => {
    setActive(0);
    (cards()[0] ?? box.current)?.focus();
  }, [slot.path, index]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const at = cards().indexOf(e.target as HTMLElement);
    if (at < 0) return;
    const last = items.length - 1;
    const to =
      e.key === 'ArrowRight' || e.key === 'ArrowDown'
        ? Math.min(at + 1, last)
        : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
          ? Math.max(at - 1, 0)
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? last
              : undefined;
    if (to === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    focusCard(to);
  };

  let n = -1;
  return (
    <section
      aria-label={inSheet ? `Add to ${slot.name}` : undefined}
      aria-labelledby={inSheet ? undefined : titleId}
      ref={box}
      tabIndex={-1}
      data-dock={slot.path}
      className="flex min-h-0 flex-col outline-none"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
          return;
        }
        onKeyDown(e);
      }}
    >
      <div className="flex items-baseline gap-2 px-4 pt-2 pb-1">
        {/* In a sheet, the sheet's title names it. */}
        {inSheet ? null : (
          <h2 id={titleId} className="section-title">
            Add to {slot.name}
          </h2>
        )}
        <span className="text-muted-foreground text-xs tabular-nums">
          {slotCount(slot)} · {where}
        </span>
        {/* Only where the dock offers blocks: Coworker is asked for what a person could add. */}
        {ask && items.length > 0 ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="ml-auto"
            data-ask-fill
            disabled={!!ask.held}
            aria-describedby={ask.held ? heldId : undefined}
            onClick={ask.onAsk}
          >
            <Mark className="text-ai" />
            Ask Coworker to fill this
          </Button>
        ) : null}
        {inSheet ? null : (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className={ask && items.length > 0 ? undefined : 'ml-auto'}
            aria-label="Close the dock"
            onClick={onClose}
          >
            <X aria-hidden="true" />
          </Button>
        )}
      </div>
      {ask?.held && items.length > 0 ? (
        <p id={heldId} className="px-4 pb-1 text-muted-foreground text-xs">
          {ask.held}
        </p>
      ) : null}
      {slot.locked ? (
        <p className="max-w-measure px-4 pb-3 text-sm">
          {slot.name} is locked: its blocks stay as they are, in their order. What’s inside them can
          still be edited.
        </p>
      ) : lockedBy ? (
        <p className="max-w-measure px-4 pb-3 text-sm">
          {slot.sealedBy
            ? `${slot.name} is in a locked region: its blocks stay as they are, in their order.`
            : 'This is between blocks that are locked together: nothing can go between them. Choose a place before or after them.'}
        </p>
      ) : slot.full ? (
        <p className="max-w-measure px-4 pb-3 text-sm">
          {slot.name} is full: it holds {slot.max} of {slot.max}. Remove a block from it to add
          another.
        </p>
      ) : items.length === 0 ? (
        <p className="max-w-measure px-4 pb-3 text-sm">
          {slot.name} takes no blocks the site provides.
        </p>
      ) : (
        <div
          ref={row}
          tabIndex={-1}
          className="flex min-h-0 gap-4 overflow-x-auto px-4 pb-3 outline-none"
        >
          {groups.map((g, gi) => {
            const groupId = `${titleId}-g${gi}`;
            return (
              <div key={g.group ?? ''} className="flex shrink-0 flex-col gap-1">
                <h3 id={groupId} className="caption">
                  {g.group ?? 'Blocks'}
                </h3>
                <ul className="flex gap-2" aria-labelledby={groupId}>
                  {g.items.map((item) => {
                    n += 1;
                    const at = n;
                    return (
                      <li key={item.variant.apiId}>
                        <button
                          type="button"
                          data-dock-item={item.variant.apiId}
                          tabIndex={at === active ? 0 : -1}
                          onFocus={() => setActive(at)}
                          onClick={() => onInsert(item.variant)}
                          className={cn(
                            'flex h-14 w-52 items-center gap-2.5 rounded-xl bg-muted/60 px-3 text-left',
                            'transition-[background-color] hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring',
                          )}
                        >
                          {/* 4:3 at the card's inner height, so the dock keeps its 160px; with
                              any picture in the catalog, a card without one holds its place. */}
                          <BlockThumbnail
                            src={thumbnails.of(item.variant.apiId)}
                            className="aspect-[4/3] h-10 rounded-lg"
                            fallback={
                              thumbnails.any ? (
                                <span
                                  aria-hidden="true"
                                  className="aspect-[4/3] h-10 shrink-0 rounded-lg bg-muted"
                                />
                              ) : null
                            }
                          />
                          <span className="flex min-w-0 flex-1 flex-col">
                            <span className="truncate font-medium text-sm">{item.name}</span>
                            {item.description ? (
                              <span className="truncate text-muted-foreground text-xs">
                                {item.description}
                              </span>
                            ) : null}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
