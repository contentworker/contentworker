/**
 * The dock: what can go at the chosen seam, and nothing else. It lists the blocks the seam's slot
 * takes (`dockGroups`) as one compact row of cards along the bottom edge, under the catalog's group
 * captions, each its name and a line of its description, scrolling sideways when they don't fit,
 * so the page above (and the chosen seam) stays in view. Picking one puts it in the page at once
 * (unsaved). A full slot says so and offers nothing. Thumbnails aren't drawn: the admin's `img-src`
 * takes no other origin, so each block is its name.
 *
 * One tab stop: ← → (and ↑ ↓) move across the cards, Home and End go to either end, Enter or Space
 * puts the block in, Escape closes the dock.
 */
import type { BlockCatalog, ComponentVariant } from '@contentworker/domain';
import { Button } from '@contentworker/ui/button';
import { cn } from '@contentworker/ui/lib/utils';
import { X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { dockGroups } from '~/cms/lib/canvas/dock';
import { type CanvasPlace, slotCount } from '~/cms/lib/canvas/model';

export interface DockProps {
  readonly place: CanvasPlace;
  readonly catalog: BlockCatalog | null | undefined;
  readonly onInsert: (variant: ComponentVariant) => void;
  readonly onClose: () => void;
  /** Drawn in a sheet, which has its own title and close button. */
  readonly inSheet?: boolean;
}

export function Dock({ place, catalog, onInsert, onClose, inSheet }: DockProps) {
  const titleId = useId();
  const { slot, index } = place;
  const groups = dockGroups(slot, catalog);
  const items = groups.flatMap((g) => g.items);
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
        {inSheet ? null : (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="ml-auto"
            aria-label="Close the dock"
            onClick={onClose}
          >
            <X aria-hidden="true" />
          </Button>
        )}
      </div>
      {slot.full ? (
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
                            'flex h-14 w-52 flex-col items-start justify-center rounded-xl bg-muted/60 px-3 text-left',
                            'transition-[background-color] hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring',
                          )}
                        >
                          <span className="w-full truncate font-medium text-sm">{item.name}</span>
                          {item.description ? (
                            <span className="w-full truncate text-muted-foreground text-xs">
                              {item.description}
                            </span>
                          ) : null}
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
