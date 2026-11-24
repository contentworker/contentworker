import { cn } from '@contentworker/ui/lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '@contentworker/ui/tooltip';
import { Eye, Globe, type LucideIcon, PanelRight, ScrollText } from 'lucide-react';
import type { KeyboardEvent } from 'react';
import type { PaneView } from './use-pane-layout';

const ICONS: Record<PaneView, LucideIcon> = {
  details: PanelRight,
  preview: Eye,
  site: Globe,
  activity: ScrollText,
};

/**
 * The side pane folded to its views, on the form's right edge, when the row beside the assistant's
 * column is too narrow to split. Each opens the pane over the form at that view; the open one,
 * pressed again, closes it. One tab stop, the arrows moving between the views, as the canvas's
 * dock does. The open view wears the current-item fill with its icon in brand, as every list's
 * current row does.
 */
export function PaneRail({
  views,
  view,
  open,
  onPick,
  labels,
  controls,
  onKeyDown: onOtherKey,
}: {
  views: readonly PaneView[];
  view: PaneView;
  /** Whether the pane is open over the form. */
  open: boolean;
  /** A view pressed: open the pane at it, or close it when it is the one already open. */
  onPick: (v: PaneView) => void;
  labels: Record<PaneView, string>;
  /** The id of the pane it opens. */
  controls: string;
  /** Keys other than the arrows (the editor's Escape, which closes the pane). */
  onKeyDown?: (e: KeyboardEvent<HTMLDivElement>) => void;
}) {
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const keys: Record<string, number> = {
      ArrowDown: 1,
      ArrowRight: 1,
      ArrowUp: -1,
      ArrowLeft: -1,
    };
    const step = keys[e.key];
    if (step === undefined) return onOtherKey?.(e);
    const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button')];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    e.preventDefault();
    buttons[(at + step + buttons.length) % buttons.length]?.focus();
  };
  // The roving stop: the open view, else the one the pane would open on.
  const stop = views.includes(view) ? view : views[0];
  return (
    <div
      role="toolbar"
      aria-label="Side pane"
      aria-orientation="vertical"
      onKeyDown={onKeyDown}
      className="flex flex-col items-center gap-1"
    >
      {views.map((v) => {
        const Icon = ICONS[v];
        const current = open && v === view;
        return (
          <Tooltip key={v}>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={labels[v]}
                aria-pressed={current}
                aria-controls={controls}
                tabIndex={v === stop ? 0 : -1}
                onClick={() => onPick(v)}
                className={cn(
                  'hit-area inline-flex size-9 items-center justify-center rounded-lg outline-none transition-[background-color,color] focus-visible:ring-3 focus-visible:ring-ring/30 focus-visible:border-ring',
                  current
                    ? 'bg-accent text-accent-foreground current-item'
                    : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
                )}
              >
                <Icon aria-hidden="true" className={cn('size-4', current && 'text-brand')} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="left" sideOffset={6}>
              {labels[v]}
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}
