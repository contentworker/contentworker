/**
 * Layers: the page's blocks as an outline, slot by slot. It opens on demand, and it is the whole
 * keyboard and screen-reader path to the page (whose own document isn't navigable from the admin):
 * every block is a tree item, arrows move the selection (↑ ↓ through the page, ← to the block
 * holding it, → into its first slot), Enter opens its settings, and each slot of the page's top
 * level has its own Add button, which opens the dock at its end. A slot the block config locks
 * says so beside its name, with a lock, and offers no Add.
 */
import { Button } from '@contentworker/ui/button';
import { cn } from '@contentworker/ui/lib/utils';
import { Lock, Plus } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { ToneBadge } from '~/cms/components/status';
import {
  type CanvasBlock,
  type CanvasSlot,
  flattenBlocks,
  parentBlock,
  slotFill,
} from '~/cms/lib/canvas/model';

export interface LayersProps {
  readonly slots: readonly CanvasSlot[];
  readonly selected: string | null;
  readonly onSelect: (key: string | null) => void;
  /** Enter on a block: its settings. */
  readonly onOpen: (key: string) => void;
  /** Add to the end of a top-level slot; absent while the canvas can't change the page. */
  readonly onAdd?: (slot: CanvasSlot) => void;
}

export function Layers({ slots, selected, onSelect, onOpen, onAdd }: LayersProps) {
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

  return (
    <div ref={root} className="flex flex-col gap-5">
      {slots.map((slot) => (
        <section key={slot.path} aria-label={slotFill(slot)} className="flex flex-col gap-1">
          <div className="flex items-center justify-between gap-2 px-2">
            <h3 className="caption inline-flex items-center gap-1">
              {slot.locked ? <Lock aria-hidden="true" className="size-3" /> : null}
              {slotFill(slot)}
            </h3>
            {onAdd && !slot.locked ? (
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
              className="flex flex-col"
              onKeyDown={onKeyDown}
            >
              {slot.blocks.map((b) => (
                <LayerItem
                  key={b.key}
                  block={b}
                  level={1}
                  selected={selected}
                  tabStop={tabStop}
                  onSelect={onSelect}
                />
              ))}
            </div>
          )}
        </section>
      ))}
    </div>
  );
}

function LayerItem(props: {
  block: CanvasBlock;
  level: number;
  selected: string | null;
  tabStop: string | undefined;
  onSelect: (key: string) => void;
}) {
  const { block, level, selected } = props;
  const isSelected = block.key === selected;
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
        props.onSelect(block.key);
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
        <span className="truncate">{block.name}</span>
        {block.label ? (
          <span className="min-w-0 truncate text-muted-foreground text-xs">{block.label}</span>
        ) : null}
        {block.variant ? null : (
          <span className="ml-auto shrink-0">
            <ToneBadge tone="bad" label="Removed from code" />
          </span>
        )}
      </div>
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
                {slot.locked ? <Lock className="size-3" /> : null}
                {slotFill(slot)}
              </div>
              {/* biome-ignore lint/a11y/useSemanticElements: one slot's tree items, not a fieldset. */}
              <div role="group" aria-label={slotFill(slot)} className="flex flex-col">
                {slot.blocks.map((child) => (
                  <LayerItem
                    key={child.key}
                    block={child}
                    level={level + 1}
                    selected={selected}
                    tabStop={props.tabStop}
                    onSelect={props.onSelect}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
