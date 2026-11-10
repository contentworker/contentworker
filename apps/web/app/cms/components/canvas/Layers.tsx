/**
 * Layers: the page's blocks as an outline, slot by slot. It opens on demand, and it is the whole
 * keyboard and screen-reader path to the page (whose own document isn't navigable from the admin):
 * every block is a tree item, arrows move the selection (↑ ↓ through the page, ← to the block
 * holding it, → into its first slot), Enter opens its settings, and each slot of the page's top
 * level has its own Add button, which opens the dock at its end. A slot the block config locks
 * says so beside its name, with a lock, and offers no Add.
 *
 * A locked region's blocks carry a lock, and its first one says who locked it and when. Shift with
 * a click, or with ↑ ↓, takes the neighbours in the same slot into the selection: a run to lock.
 */
import { Button } from '@contentworker/ui/button';
import { cn } from '@contentworker/ui/lib/utils';
import { Lock, Plus } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { ToneBadge } from '~/cms/components/status';
import type { ActorDirectory } from '~/cms/lib/authorship';
import { lockedLine } from '~/cms/lib/block-locks';
import {
  type CanvasBlock,
  type CanvasSlot,
  flattenBlocks,
  parentBlock,
  slotFill,
  slotHeld,
} from '~/cms/lib/canvas/model';

export interface LayersProps {
  readonly slots: readonly CanvasSlot[];
  readonly selected: string | null;
  readonly onSelect: (key: string | null) => void;
  /** Enter on a block: its settings. */
  readonly onOpen: (key: string) => void;
  /** Add to the end of a top-level slot; absent while the canvas can't change the page. */
  readonly onAdd?: (slot: CanvasSlot) => void;
  /** The blocks selected with the focused one (a run): drawn selected too. */
  readonly run?: readonly string[];
  /** Shift with a click or an arrow: takes `key` into the run; absent when runs aren't offered. */
  readonly onExtend?: (key: string) => void;
  /** Who's who, for "Locked by …". */
  readonly directory?: ActorDirectory;
}

export function Layers({
  slots,
  selected,
  onSelect,
  onOpen,
  onAdd,
  run,
  onExtend,
  directory,
}: LayersProps) {
  const root = useRef<HTMLDivElement>(null);
  // The selection moved while focus was in the outline (an arrow): focus follows it.
  useEffect(() => {
    const box = root.current;
    if (!box || !selected || !box.contains(document.activeElement)) return;
    for (const el of box.querySelectorAll<HTMLElement>('[data-layer]')) {
      if (el.dataset.layer === selected) {
        if (el !== document.activeElement) el.focus();
        el.scrollIntoView?.({ block: 'nearest' });
        return;
      }
    }
  }, [selected]);

  const order = flattenBlocks(slots);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const at = order.findIndex((b) => b.key === selected);
    const current = order[at];
    let next: CanvasBlock | undefined;
    if (e.shiftKey && onExtend && current && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      // Within the slot only: a run is neighbours in one slot.
      const sibling = current.slot.blocks[current.index + (e.key === 'ArrowDown' ? 1 : -1)];
      e.preventDefault();
      e.stopPropagation();
      if (sibling) onExtend(sibling.key);
      return;
    }
    switch (e.key) {
      case 'ArrowDown':
        next = order[at + 1] ?? (at < 0 ? order[0] : undefined);
        break;
      case 'ArrowUp':
        next = at > 0 ? order[at - 1] : undefined;
        break;
      case 'ArrowLeft':
        next = current ? parentBlock(slots, current) : undefined;
        break;
      case 'ArrowRight':
        next = current?.slots.find((s) => s.blocks.length > 0)?.blocks[0];
        break;
      case 'Home':
        next = order[0];
        break;
      case 'End':
        next = order.at(-1);
        break;
      case 'Enter':
        if (current) {
          e.preventDefault();
          onOpen(current.key);
        }
        return;
      default:
        return;
    }
    e.preventDefault();
    // Handled here: the page's own arrow keys would move the selection a second time.
    e.stopPropagation();
    if (next) onSelect(next.key);
  };

  // The one item Tab lands on: the selected block, else the first.
  const tabStop = selected && order.some((b) => b.key === selected) ? selected : order[0]?.key;
  const item: ItemProps = {
    selected,
    run: new Set(run ?? []),
    tabStop,
    onSelect,
    ...(onExtend ? { onExtend } : {}),
    ...(directory ? { directory } : {}),
  };

  return (
    <div ref={root} className="flex flex-col gap-5">
      {slots.map((slot) => (
        <section key={slot.path} aria-label={slotFill(slot)} className="flex flex-col gap-1">
          <div className="flex items-center justify-between gap-2 px-2">
            <h3 className="caption inline-flex items-center gap-1">
              {slotHeld(slot) ? <Lock aria-hidden="true" className="size-3" /> : null}
              {slotFill(slot)}
            </h3>
            {onAdd && !slotHeld(slot) ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`Add a block to the end of ${slot.name}`}
                title={slot.full ? `${slot.name} is full` : `Add to ${slot.name}`}
                onClick={() => onAdd(slot)}
              >
                <Plus aria-hidden="true" />
              </Button>
            ) : null}
          </div>
          {slot.blocks.length === 0 ? (
            <p className="px-2 text-muted-foreground text-sm">No blocks yet.</p>
          ) : (
            <div
              role="tree"
              aria-label={`${slot.name} blocks`}
              aria-multiselectable={onExtend ? true : undefined}
              className="flex flex-col"
              onKeyDown={onKeyDown}
            >
              {slot.blocks.map((b) => (
                <LayerItem key={b.key} block={b} level={1} {...item} />
              ))}
            </div>
          )}
        </section>
      ))}
    </div>
  );
}

interface ItemProps {
  selected: string | null;
  run: ReadonlySet<string>;
  tabStop: string | undefined;
  onSelect: (key: string) => void;
  onExtend?: (key: string) => void;
  directory?: ActorDirectory;
}

function LayerItem(props: ItemProps & { block: CanvasBlock; level: number }) {
  const { block, level, selected } = props;
  const { lock } = block;
  const isSelected = block.key === selected || props.run.has(block.key);
  // The region says who locked it once, on its first block.
  const says = lock?.own && lock.region.lock.keys[0] === block.key ? lock.region.lock : undefined;
  const filled = block.slots.filter((s) => s.blocks.length > 0 || s.min !== undefined);
  return (
    <div
      role="treeitem"
      aria-level={level}
      aria-selected={isSelected}
      aria-expanded={filled.length > 0 ? true : undefined}
      tabIndex={block.key === props.tabStop ? 0 : -1}
      data-layer={block.key}
      onClick={(e) => {
        e.stopPropagation();
        if (e.shiftKey && props.onExtend) props.onExtend(block.key);
        else props.onSelect(block.key);
      }}
      onKeyDown={() => undefined}
      className="rounded-lg outline-none focus-visible:outline-2 focus-visible:outline-ring"
    >
      <div
        className={cn(
          'flex min-h-8 cursor-default items-center gap-2 rounded-lg py-1 pr-2 text-sm touch:min-h-11',
          isSelected
            ? 'bg-accent font-medium text-accent-foreground'
            : 'text-foreground hover:bg-accent/60',
        )}
        style={{ paddingLeft: `${0.5 + (level - 1) * 1}rem` }}
      >
        {lock?.own ? <Lock aria-hidden="true" className="size-3 shrink-0" /> : null}
        <span className="truncate">{block.name}</span>
        {block.label ? (
          <span className="min-w-0 truncate text-muted-foreground text-xs">{block.label}</span>
        ) : null}
        {lock?.own && !says ? <span className="sr-only">, locked</span> : null}
        {block.variant ? null : (
          <span className="ml-auto shrink-0">
            <ToneBadge tone="bad" label="Removed from code" />
          </span>
        )}
      </div>
      {says ? (
        <p
          data-locked-line
          className="pb-1 text-2xs text-muted-foreground"
          style={{ paddingLeft: `${0.5 + (level - 1) * 1}rem` }}
        >
          <span className="sr-only">, </span>
          {lockedLine(says, props.directory)}
        </p>
      ) : null}
      {filled.length > 0 ? (
        // biome-ignore lint/a11y/useSemanticElements: a tree item's children, not a form fieldset.
        <div role="group" className="flex flex-col">
          {filled.map((slot) => (
            <div key={slot.path} role="none">
              <div
                className="caption flex items-center gap-1 py-1"
                style={{ paddingLeft: `${0.5 + level * 1}rem` }}
                aria-hidden="true"
              >
                {slotHeld(slot) ? <Lock className="size-3" /> : null}
                {slotFill(slot)}
              </div>
              {/* biome-ignore lint/a11y/useSemanticElements: one slot's tree items, not a fieldset. */}
              <div role="group" aria-label={slotFill(slot)} className="flex flex-col">
                {slot.blocks.map((child) => (
                  <LayerItem key={child.key} {...props} block={child} level={level + 1} />
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
