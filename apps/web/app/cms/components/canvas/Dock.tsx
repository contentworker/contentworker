/**
 * The dock: what can go at the chosen seam, and nothing else. It lists the blocks the seam's slot
 * takes (`dockGroups`), under the catalog's group captions with each block's description, and
 * picking one puts it in the page at once (unsaved). A full slot says so and offers nothing.
 * Thumbnails aren't drawn: the admin's `img-src` takes no other origin, so each block is its name.
 */
import type { BlockCatalog, ComponentVariant } from '@contentworker/domain';
import { Button } from '@contentworker/ui/button';
import { X } from 'lucide-react';
import { useEffect, useId, useRef } from 'react';
import { dockGroups } from '~/cms/lib/canvas/dock';
import type { CanvasPlace } from '~/cms/lib/canvas/model';

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
  const list = useRef<HTMLDivElement>(null);
  const where =
    slot.blocks.length === 0
      ? 'empty'
      : index === 0
        ? `before ${slot.blocks[0]?.name ?? 'the first block'}`
        : `after ${slot.blocks[index - 1]?.name ?? 'the last block'}`;

  // Opening it is choosing a seam: the first block it offers takes focus, so Enter puts it there.
  useEffect(() => {
    (list.current?.querySelector('button') ?? list.current)?.focus();
  }, [slot.path, index]);

  return (
    <section
      aria-label={inSheet ? `Add to ${slot.name}` : undefined}
      aria-labelledby={inSheet ? undefined : titleId}
      data-dock={slot.path}
      className="flex max-h-full min-h-0 flex-col"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="flex items-baseline gap-2 px-4 pt-3 pb-2">
        {/* In a sheet, the sheet's title names it. */}
        {inSheet ? null : (
          <h2 id={titleId} className="section-title">
            Add to {slot.name}
          </h2>
        )}
        <span className="text-muted-foreground text-xs tabular-nums">
          {slot.max !== undefined ? `${slot.blocks.length} of ${slot.max}` : null}
          {slot.max !== undefined ? ' · ' : null}
          {where}
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
      <div ref={list} tabIndex={-1} className="min-h-0 overflow-y-auto px-4 pb-4 outline-none">
        {slot.full ? (
          <p className="max-w-measure text-sm">
            {slot.name} is full: it holds {slot.max} of {slot.max}. Remove a block from it to add
            another.
          </p>
        ) : groups.length === 0 ? (
          <p className="max-w-measure text-sm">{slot.name} takes no blocks the site provides.</p>
        ) : (
          <div className="flex flex-col gap-3">
            {groups.map((g, i) => {
              const groupId = `${titleId}-g${i}`;
              return (
                <div key={g.group ?? ''}>
                  {g.group ? (
                    <h3 id={groupId} className="caption pb-1">
                      {g.group}
                    </h3>
                  ) : null}
                  <ul
                    className="grid gap-1 sm:grid-cols-2 xl:grid-cols-3"
                    aria-labelledby={g.group ? groupId : titleId}
                  >
                    {g.items.map((item) => (
                      <li key={item.variant.apiId}>
                        <button
                          type="button"
                          data-dock-item={item.variant.apiId}
                          onClick={() => onInsert(item.variant)}
                          className="flex w-full flex-col items-start rounded-xl px-3 py-2 text-left transition-[background-color] hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring touch:min-h-11"
                        >
                          <span className="font-medium text-sm">{item.name}</span>
                          {item.description ? (
                            <span className="line-clamp-2 text-muted-foreground text-xs">
                              {item.description}
                            </span>
                          ) : null}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
