import type { ContentType } from '@contentworker/domain';
import { Button } from '@contentworker/ui/button';
import { Checkbox } from '@contentworker/ui/checkbox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@contentworker/ui/dropdown-menu';
import {
  Table,
  TableBody,
  Td as TableCell,
  Th as TableHead,
  TableHead as TableHeader,
  Tr as TableRow,
} from '@contentworker/ui/table';
import { MoreHorizontalIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { StatusBadge } from '~/cms/components/status';
import type { PreviewEntry } from '../../lib/management';
import { plainKeyAllowed, type ShortcutGroup, usePageShortcuts } from '../../lib/shortcuts';

/**
 * The entries list's single-key shortcuts. They live on the route (not
 * globally), only fire while the list shows, and appear in the "?" list then.
 */
export const ENTRIES_LIST_SHORTCUTS: ShortcutGroup = {
  id: 'entries-list',
  title: 'Entries list',
  items: [
    { keys: ['J'], label: 'Next entry (or ↓)' },
    { keys: ['K'], label: 'Previous entry (or ↑)' },
    { keys: ['Enter'], label: 'Open entry' },
    { keys: ['X'], label: 'Select or deselect entry' },
  ],
};

/** Whether single-key shortcuts should leave this key press alone. */
export function shouldIgnoreShortcut(event: KeyboardEvent): boolean {
  return !plainKeyAllowed(event);
}

export interface EntryRowActions {
  publish(entry: PreviewEntry): void;
  diff(entry: PreviewEntry): void;
  duplicate(entry: PreviewEntry): void;
  unpublish(entry: PreviewEntry): void;
  trash(entry: PreviewEntry): void;
  restore(entry: PreviewEntry): void;
  purge(entry: PreviewEntry): void;
}

export interface EntriesTableProps {
  readonly type: ContentType;
  readonly entries: readonly PreviewEntry[];
  readonly locale: string;
  readonly picked: ReadonlySet<string>;
  readonly busy: boolean;
  readonly viewingTrash: boolean;
  /** Editor URL for an entry; the title links here. */
  hrefFor(entry: PreviewEntry): string;
  onTogglePick(id: string): void;
  onPickAll(all: boolean): void;
  readonly actions: EntryRowActions;
}

/** The entry's display-field value in `locale`, or null when it has none. */
export function entryTitle(type: ContentType, entry: PreviewEntry, locale: string): string | null {
  const value = (entry.fields[type.displayField] as Record<string, unknown> | undefined)?.[locale];
  if (value === undefined || value === null || value === '') return null;
  return String(value);
}

const needsPublish = (status: string) => status === 'draft' || status === 'changed';

// Below md each row is a card: the checkbox and title on the first line, the
// status and actions beneath. The header stays for screen readers, and the
// explicit roles keep table semantics through the display change.
const ROW_STACK =
  'max-md:grid max-md:grid-cols-[auto_minmax(0,1fr)_auto_auto] max-md:items-center max-md:gap-x-2 max-md:gap-y-1.5 max-md:py-2';
const CELL_STACK = 'max-md:block max-md:p-0';

/**
 * Entries table: the title opens the entry, one fixed-position contextual
 * action (Publish, or Restore in the trash), everything else in a per-row menu.
 * J/K (or the arrows once a row has focus) move between rows, Enter opens, X
 * selects.
 */
export function EntriesTable(props: EntriesTableProps) {
  const { type, entries, locale, picked, busy, viewingTrash, actions } = props;
  const bodyRef = useRef<HTMLTableSectionElement>(null);
  const [active, setActive] = useState<number | null>(null);
  usePageShortcuts(ENTRIES_LIST_SHORTCUTS);
  const latest = useRef(props);
  latest.current = props;
  // The active row, clamped so a shorter list (after a filter) never points past its end.
  const activeRef = useRef<number | null>(null);
  activeRef.current = active !== null && active < entries.length ? active : null;

  const fieldName = type.fields.find((f) => f.apiId === type.displayField)?.name;
  const titleHeader = fieldName ?? type.displayField;
  const allPicked = entries.length > 0 && entries.every((e) => picked.has(e.id));

  // Keyboard navigation lives on the document so J/K work from anywhere on the
  // route, but the arrows only take over once focus is inside a row (elsewhere
  // they keep scrolling the page). Enter needs no handler: J/K focus the row's
  // title link, which opens the entry natively.
  useEffect(() => {
    const focusRow = (index: number) => {
      const rows = bodyRef.current?.querySelectorAll<HTMLElement>('[data-row-primary]');
      const target = rows?.[index];
      if (!target) return;
      target.focus();
      target.scrollIntoView?.({ block: 'nearest' });
      setActive(index);
    };
    const onKey = (event: KeyboardEvent) => {
      // The trash has nothing to open; its only row action (Restore) is a
      // write, which J then Enter must never trigger.
      if (shouldIgnoreShortcut(event) || latest.current.viewingTrash) return;
      const count = latest.current.entries.length;
      if (count === 0) return;
      const inRow =
        event.target instanceof Node && bodyRef.current?.contains(event.target as Node) === true;
      const current = inRow ? activeRef.current : null;
      const key = event.key;
      if (key === 'j' || key === 'J' || (inRow && key === 'ArrowDown')) {
        event.preventDefault();
        focusRow(current === null ? 0 : Math.min(current + 1, count - 1));
      } else if (key === 'k' || key === 'K' || (inRow && key === 'ArrowUp')) {
        event.preventDefault();
        focusRow(current === null ? 0 : Math.max(current - 1, 0));
      } else if ((key === 'x' || key === 'X') && current !== null) {
        const entry = latest.current.entries[current];
        if (!entry) return;
        event.preventDefault();
        latest.current.onTogglePick(entry.id);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // Live props are read through refs, so the listener is bound once.
  }, []);

  return (
    <div className="space-y-2">
      <div className="card overflow-clip">
        {/* `stack="rows"`: on a phone each row lays itself out (a grid), keeping its
          table roles; the card runs the rows edge to edge. */}
        <Table stack="rows" sticky caption={`${type.name} entries`} className="max-md:block">
          <TableHeader role="rowgroup" className="max-md:sr-only">
            <TableRow role="row">
              <TableHead role="columnheader" scope="col" className="w-8">
                <Checkbox
                  aria-label="Select all entries"
                  checked={allPicked}
                  onCheckedChange={(c) => props.onPickAll(c === true)}
                />
              </TableHead>
              <TableHead role="columnheader" scope="col">
                {titleHeader}
              </TableHead>
              <TableHead role="columnheader" scope="col" className="w-28">
                Status
              </TableHead>
              <TableHead role="columnheader" scope="col" className="w-28">
                <span className="sr-only">Action</span>
              </TableHead>
              <TableHead role="columnheader" scope="col" className="w-10">
                <span className="sr-only">More actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody ref={bodyRef} role="rowgroup" className="max-md:block">
            {entries.map((e, i) => {
              const title = entryTitle(type, e, locale);
              const name = title ?? 'untitled entry';
              const quoted = title ? `“${title}”` : 'untitled entry';
              return (
                <TableRow
                  key={e.id}
                  role="row"
                  data-active={activeRef.current === i || undefined}
                  data-state={picked.has(e.id) ? 'selected' : undefined}
                  onFocus={() => setActive(i)}
                  onBlur={(ev) => {
                    // Focus leaving the row (not moving within it) drops the highlight.
                    if (!ev.currentTarget.contains(ev.relatedTarget as Node | null))
                      setActive(null);
                  }}
                  className={`data-active:bg-muted/50 ${ROW_STACK}`}
                >
                  <TableCell
                    role="cell"
                    className={`${CELL_STACK} max-md:row-span-2 max-md:self-start max-md:pt-0.5`}
                  >
                    <Checkbox
                      aria-label={`Select ${quoted}`}
                      checked={picked.has(e.id)}
                      onCheckedChange={() => props.onTogglePick(e.id)}
                    />
                  </TableCell>
                  <TableCell
                    role="cell"
                    className={`whitespace-normal ${CELL_STACK} max-md:col-span-3`}
                  >
                    {viewingTrash ? (
                      <span className={title ? 'font-medium' : 'text-muted-foreground'}>
                        {title ?? 'Untitled entry'}
                      </span>
                    ) : (
                      <Link
                        to={props.hrefFor(e)}
                        data-row-primary=""
                        className={`rounded-sm font-medium underline-offset-4 outline-none hover:underline focus-visible:underline focus-visible:ring-3 focus-visible:ring-ring/30 ${title ? '' : 'text-muted-foreground'}`}
                      >
                        {title ?? 'Untitled entry'}
                      </Link>
                    )}
                  </TableCell>
                  <TableCell role="cell" className={`${CELL_STACK} max-md:col-start-2`}>
                    <StatusBadge status={e.status} />
                  </TableCell>
                  <TableCell role="cell" className={`${CELL_STACK} max-md:text-right`}>
                    {viewingTrash ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => actions.restore(e)}
                        disabled={busy}
                      >
                        Restore
                      </Button>
                    ) : needsPublish(e.status) ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => actions.publish(e)}
                        disabled={busy}
                        aria-label={`Publish ${quoted}`}
                      >
                        Publish
                      </Button>
                    ) : null}
                  </TableCell>
                  <TableCell role="cell" className={`${CELL_STACK} text-right`}>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`More actions for ${name}`}
                          disabled={busy}
                        >
                          <MoreHorizontalIcon aria-hidden="true" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-auto min-w-40">
                        {viewingTrash ? (
                          <DropdownMenuItem variant="destructive" onSelect={() => actions.purge(e)}>
                            Delete permanently…
                          </DropdownMenuItem>
                        ) : (
                          <>
                            {e.status !== 'draft' && (
                              <DropdownMenuItem onSelect={() => actions.diff(e)}>
                                Diff vs published
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuItem onSelect={() => actions.duplicate(e)}>
                              Duplicate
                            </DropdownMenuItem>
                            {e.status === 'published' && (
                              <DropdownMenuItem onSelect={() => actions.unpublish(e)}>
                                Unpublish
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              variant="destructive"
                              onSelect={() => actions.trash(e)}
                            >
                              Move to trash
                            </DropdownMenuItem>
                          </>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      {!viewingTrash && (
        <p className="hidden px-1 text-muted-foreground text-xs fine:md:block">
          <Kbd>J</Kbd> <Kbd>K</Kbd> to move, <Kbd>Enter</Kbd> to open, <Kbd>X</Kbd> to select
        </p>
      )}
    </div>
  );
}

function Kbd({ children }: { children: string }) {
  return (
    <kbd className="min-w-5 rounded-sm bg-muted px-1 py-0.5 text-center font-sans text-foreground text-xs">
      {children}
    </kbd>
  );
}
