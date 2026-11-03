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
import { Kbd } from '@contentworker/ui/kbd';
import { Skeleton, SkeletonPill, SkeletonText } from '@contentworker/ui/skeleton';
import {
  Table,
  TableBody,
  Td as TableCell,
  TableEmpty,
  TableFoot,
  Th as TableHead,
  TableHead as TableHeader,
  Tr as TableRow,
} from '@contentworker/ui/table';
import { MoreHorizontalIcon } from 'lucide-react';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router';
import { Ago } from '~/cms/components/ago';
import { StatusBadge } from '~/cms/components/status';
import type { EntryOrder, PreviewEntry } from '../../lib/management';
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

/** The columns a header sorts by: the display field, the status, and when it last changed. */
export const SORT_STATUS = 'sys.status';
export const SORT_UPDATED = 'sys.updatedAt';

export interface EntriesTableProps {
  readonly type: ContentType;
  readonly entries: readonly PreviewEntry[];
  readonly locale: string;
  readonly picked: ReadonlySet<string>;
  readonly busy: boolean;
  readonly viewingTrash: boolean;
  /** Editor URL for an entry; the title links here. */
  hrefFor(entry: PreviewEntry): string;
  /** Ticks (or unticks) these entries: one checkbox, X, or a shift-click range. */
  onPick(ids: readonly string[], picked: boolean): void;
  onPickAll(all: boolean): void;
  readonly actions: EntryRowActions;
  /** The list's sort, drawn on its column header; none is least recently changed first. */
  readonly order?: EntryOrder;
  /** Sorts by a column from its header. Without it the headers are plain captions. */
  onSort?(field: string): void;
  /** Reads the next page onto the end. Shown in the table's foot while there is more. */
  onLoadMore?(): void;
  readonly loadingMore?: boolean;
  /** Says why there are no rows (a search that missed), in a row under the headers. */
  readonly empty?: ReactNode;
  /** Skeleton rows to draw after the entries: the first page, before it has arrived. */
  readonly pending?: number;
}

/** The entry's display-field value in `locale`, or null when it has none. */
export function entryTitle(type: ContentType, entry: PreviewEntry, locale: string): string | null {
  const value = (entry.fields[type.displayField] as Record<string, unknown> | undefined)?.[locale];
  if (value === undefined || value === null || value === '') return null;
  return String(value);
}

export const needsPublish = (status: string) => status === 'draft' || status === 'changed';

/** The columns: checkbox, title, status, updated, the contextual action, the menu. */
const COLUMNS = 6;

// Below md each row is a card: the checkbox and title on the first line, the
// status, when it changed and the actions beneath. The header stays for screen
// readers, and the explicit roles keep table semantics through the display change.
// From md every row is one height, its cells centred on it.
const ROW_STACK =
  'group/row md:h-11 max-md:grid max-md:grid-cols-[auto_auto_minmax(0,1fr)_auto_auto] max-md:items-center max-md:gap-x-2 max-md:gap-y-1.5 max-md:py-2';
const CELL_STACK = 'max-md:block max-md:p-0';

/**
 * The row's Publish is quiet: a ghost at badge height, shown on the row a pointer is over, the row
 * focus is in, the J/K row and a ticked one. A touch screen has no hover, so there it always shows.
 */
const QUIET_ACTION =
  'opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100 group-data-active/row:opacity-100 group-data-[state=selected]/row:opacity-100 touch:opacity-100 max-md:opacity-100';

/**
 * Entries table: the title opens the entry, one fixed-position contextual
 * action (Publish, or Restore in the trash), everything else in a per-row menu.
 * J/K (or the arrows once a row has focus) move between rows, Enter opens, X
 * selects; shift-click ticks a range. Title, Status and Updated sort from their
 * headers. Load more, in the foot, reads the next page onto the end.
 */
export function EntriesTable(props: EntriesTableProps) {
  const { type, entries, locale, picked, busy, viewingTrash, actions } = props;
  const bodyRef = useRef<HTMLTableSectionElement>(null);
  const [active, setActive] = useState<number | null>(null);
  const keysId = useId();
  usePageShortcuts(ENTRIES_LIST_SHORTCUTS);
  const latest = useRef(props);
  latest.current = props;
  // The active row, clamped so a shorter list (after a filter) never points past its end.
  const activeRef = useRef<number | null>(null);
  activeRef.current = active !== null && active < entries.length ? active : null;
  // Where the last checkbox click was, for a shift-click range.
  const anchor = useRef<string | null>(null);
  // Load more hands focus to the first row it brought, so the keyboard carries on from there.
  const focusFrom = useRef<number | null>(null);

  const fieldName = type.fields.find((f) => f.apiId === type.displayField)?.name;
  const titleHeader = fieldName ?? type.displayField;
  const pickedHere = entries.filter((e) => picked.has(e.id)).length;
  const allState =
    entries.length > 0 && pickedHere === entries.length
      ? true
      : pickedHere > 0
        ? ('indeterminate' as const)
        : false;

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
        anchor.current = entry.id;
        latest.current.onPick([entry.id], !latest.current.picked.has(entry.id));
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // Live props are read through refs, so the listener is bound once.
  }, []);

  // A page arrived after Load more: focus the first new row (the button may be gone).
  useEffect(() => {
    const from = focusFrom.current;
    if (from === null || entries.length <= from) return;
    focusFrom.current = null;
    const rows = bodyRef.current?.querySelectorAll<HTMLElement>('[data-row-primary]');
    rows?.[from]?.focus();
    setActive(from);
  }, [entries.length]);

  const pickFromCheckbox = (index: number, shift: boolean) => {
    const entry = entries[index];
    if (!entry) return;
    const value = !picked.has(entry.id);
    const from = shift && anchor.current ? entries.findIndex((e) => e.id === anchor.current) : -1;
    anchor.current = entry.id;
    if (from < 0) return props.onPick([entry.id], value);
    const [lo, hi] = from < index ? [from, index] : [index, from];
    props.onPick(
      entries.slice(lo, hi + 1).map((e) => e.id),
      value,
    );
  };

  const sortOf = (field: string): 'ascending' | 'descending' | undefined => {
    const order = props.order;
    // No order is the default: least recently changed first.
    if (!order) return field === SORT_UPDATED ? 'ascending' : undefined;
    if (order.field !== field) return undefined;
    return order.direction === 'asc' ? 'ascending' : 'descending';
  };
  const header = (field: string, label: ReactNode, className?: string) => {
    const sort = props.onSort ? sortOf(field) : undefined;
    return (
      <TableHead role="columnheader" scope="col" sort={sort} className={className}>
        {props.onSort ? (
          <button
            type="button"
            className="hit-area caption -mx-1 rounded-sm px-1 hover:text-foreground"
            onClick={() => props.onSort?.(field)}
          >
            {label}
          </button>
        ) : (
          label
        )}
      </TableHead>
    );
  };

  return (
    <div className="space-y-2">
      <div className="card overflow-clip">
        {/* `stack="rows"`: on a phone each row lays itself out (a grid), keeping its
          table roles; the card runs the rows edge to edge. */}
        <Table
          stack="rows"
          sticky
          caption={`${type.name} entries`}
          aria-describedby={viewingTrash ? undefined : keysId}
          className="max-md:block [&_td]:align-middle"
        >
          <TableHeader role="rowgroup" className="max-md:sr-only">
            <TableRow role="row">
              <TableHead role="columnheader" scope="col" className="w-8">
                <Checkbox
                  aria-label="Select all entries"
                  checked={allState}
                  disabled={entries.length === 0}
                  onCheckedChange={() => props.onPickAll(allState !== true)}
                />
              </TableHead>
              {header(type.displayField, titleHeader)}
              {header(SORT_STATUS, 'Status', 'w-28')}
              {header(SORT_UPDATED, 'Updated', 'w-28')}
              <TableHead role="columnheader" scope="col" className="w-24">
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
                  className={ROW_STACK}
                >
                  <TableCell
                    role="cell"
                    className={`${CELL_STACK} max-md:row-span-2 max-md:self-start max-md:pt-0.5`}
                  >
                    <Checkbox
                      aria-label={`Select ${quoted}`}
                      checked={picked.has(e.id)}
                      // A click (or Space) carries Shift, which a range needs; the checked
                      // state follows `picked`.
                      onClick={(ev) => {
                        ev.preventDefault();
                        pickFromCheckbox(i, ev.shiftKey);
                      }}
                    />
                  </TableCell>
                  <TableCell
                    role="cell"
                    className={`whitespace-normal ${CELL_STACK} max-md:col-span-4`}
                  >
                    {viewingTrash ? (
                      <span className={title ? 'font-medium' : 'text-muted-foreground'}>
                        {title ?? 'Untitled entry'}
                      </span>
                    ) : (
                      <Link
                        to={props.hrefFor(e)}
                        data-row-primary=""
                        className={`rounded-sm font-medium underline-offset-4 hover:underline focus-visible:underline ${title ? '' : 'text-muted-foreground'}`}
                      >
                        {title ?? 'Untitled entry'}
                      </Link>
                    )}
                  </TableCell>
                  <TableCell role="cell" className={`${CELL_STACK} max-md:col-start-2`}>
                    <StatusBadge status={e.status} />
                  </TableCell>
                  <TableCell
                    role="cell"
                    className={`${CELL_STACK} whitespace-nowrap text-muted-foreground text-xs`}
                  >
                    {e.updatedAt ? <Ago at={e.updatedAt} /> : null}
                  </TableCell>
                  <TableCell role="cell" className={`${CELL_STACK} text-right`}>
                    {viewingTrash ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="xs"
                        onClick={() => actions.restore(e)}
                        disabled={busy}
                      >
                        Restore
                      </Button>
                    ) : needsPublish(e.status) ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        onClick={() => actions.publish(e)}
                        disabled={busy}
                        aria-label={`Publish ${quoted}`}
                        className={QUIET_ACTION}
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
                            {/* A singleton's copy would be its refused second entry. */}
                            {!type.singleton && (
                              <DropdownMenuItem onSelect={() => actions.duplicate(e)}>
                                Duplicate
                              </DropdownMenuItem>
                            )}
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
            {entries.length === 0 && props.empty ? (
              <TableEmpty colSpan={COLUMNS}>{props.empty}</TableEmpty>
            ) : null}
            {Array.from({ length: props.pending ?? 0 }, (_, i) => (
              <EntryRowSkeleton key={i} index={i} viewingTrash={viewingTrash} />
            ))}
          </TableBody>
          {props.onLoadMore ? (
            <TableFoot className="max-md:block">
              <TableRow className="border-t max-md:block">
                <TableCell colSpan={COLUMNS} className="py-2 text-center max-md:block">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={props.loadingMore}
                    onClick={() => {
                      focusFrom.current = entries.length;
                      props.onLoadMore?.();
                    }}
                  >
                    {props.loadingMore ? 'Loading more…' : 'Load more'}
                  </Button>
                </TableCell>
              </TableRow>
            </TableFoot>
          ) : null}
        </Table>
      </div>
      {!viewingTrash && (
        <>
          <p id={keysId} className="sr-only">
            Press J or K to move between entries, Enter to open one, and X to select it.
          </p>
          <p
            aria-hidden="true"
            className="hidden px-1 text-2xs text-muted-foreground fine:md:block"
          >
            <Kbd>J</Kbd> <Kbd>K</Kbd> to move, <Kbd>Enter</Kbd> to open, <Kbd>X</Kbd> to select
          </p>
        </>
      )}
    </div>
  );
}

/** Title lengths for skeleton rows, so a column of them reads as titles of different lengths. */
const TITLE_WIDTHS = ['58%', '42%', '71%', '50%', '64%', '37%'];

/**
 * A row still on its way, laid out by the real row's classes so nothing moves when it arrives:
 * the checkbox, the title, a status pill, when it changed, and Restore on each trashed row.
 */
function EntryRowSkeleton({ index, viewingTrash }: { index: number; viewingTrash: boolean }) {
  return (
    <TableRow role="row" aria-hidden="true" className={ROW_STACK}>
      <TableCell
        role="cell"
        className={`${CELL_STACK} max-md:row-span-2 max-md:self-start max-md:pt-0.5`}
      >
        <Skeleton className="size-4 rounded-[4px]" />
      </TableCell>
      <TableCell role="cell" className={`${CELL_STACK} max-md:col-span-4`}>
        <SkeletonText width={TITLE_WIDTHS[index % TITLE_WIDTHS.length]} />
      </TableCell>
      <TableCell role="cell" className={`${CELL_STACK} max-md:col-start-2`}>
        <SkeletonPill className={index % 3 === 1 ? 'w-[5.5rem]' : 'w-[4.5rem]'} />
      </TableCell>
      <TableCell role="cell" className={`${CELL_STACK} text-xs`}>
        <SkeletonText width="3.5rem" />
      </TableCell>
      <TableCell role="cell" className={`${CELL_STACK} text-right`}>
        {/* The row's Publish is hidden at rest; Restore, in the trash, always shows. */}
        {viewingTrash ? <SkeletonPill className="h-6 w-[4.25rem]" /> : null}
      </TableCell>
      <TableCell role="cell" className={`${CELL_STACK} text-right`}>
        {/* The row menu's ghost button is only its icon at rest: hold its height, draw nothing. */}
        <span className="inline-block size-8 align-middle" />
      </TableCell>
    </TableRow>
  );
}
