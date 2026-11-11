import type { LinkType } from '@contentworker/domain';
import { Badge } from '@contentworker/ui/badge';
import { Button } from '@contentworker/ui/button';
import { ArrowDown, ArrowUp, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { EntityPicker } from './EntityPicker';
import type { PickOption } from './EntryForm';

interface LinkValue {
  readonly id: string;
  readonly linkType: LinkType;
}

const isLink = (v: unknown): v is LinkValue =>
  typeof (v as { id?: unknown } | null)?.id === 'string';

/**
 * A list of links (an Array of Link items): each linked entry or asset a row, by its title and
 * type, in the order the editor gave them. Add is the single link's picker, offering what the
 * field takes; Move up, Move down and Remove are ghost icon buttons named for their row, as an
 * asset collection's are. Focus stays on a moved row (on its other arrow at an end) and goes to
 * the row that took a removed one's place (or Add); each change is said in a polite line.
 *
 * A link repeats if the editor adds it twice, as the API allows, so rows are their place in the
 * list. A target the pickers don't hold (past the first page, or gone) shows its id rather than a
 * blank that would read as no link.
 */
export function LinkListInput(props: {
  id: string;
  label: string;
  linkType: LinkType;
  /** What a link can resolve against: every entry or asset the pickers hold. */
  known: readonly PickOption[];
  /** What Add offers: `known`, narrowed to what the field takes. */
  options: readonly PickOption[];
  onSearch?: (query: string) => Promise<readonly PickOption[]>;
  /** The list's path, so each row finds its own error (`related[1]`). */
  path: string;
  errorFor?: (path: string) => string | undefined;
  invalid?: boolean;
  describedBy?: string;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const { id, label, linkType } = props;
  const items = Array.isArray(props.value) ? props.value.filter(isLink) : [];
  const noun = linkType === 'Asset' ? 'asset' : 'entry';
  // Picked through a search, so not in `known`: remembered for the row's title.
  const [found, setFound] = useState<ReadonlyMap<string, PickOption>>(new Map());
  const [announcement, setAnnouncement] = useState('');
  const list = useRef<HTMLOListElement>(null);
  const addId = `${id}-add`;
  const focusAfter = useRef<{ index: number; move?: 'up' | 'down' } | 'add' | null>(null);

  useEffect(() => {
    const target = focusAfter.current;
    if (target === null) return;
    focusAfter.current = null;
    if (target === 'add') {
      document.getElementById(addId)?.focus();
      return;
    }
    const row = list.current?.querySelector<HTMLElement>(`[data-index="${target.index}"]`);
    if (!target.move) {
      row?.querySelector<HTMLButtonElement>('[data-remove]')?.focus();
      return;
    }
    const wanted = row?.querySelector<HTMLButtonElement>(`[data-move="${target.move}"]`);
    const other = row?.querySelector<HTMLButtonElement>(
      `[data-move="${target.move === 'up' ? 'down' : 'up'}"]`,
    );
    // At the top (or bottom) the button just used is disabled: the other one keeps the row.
    (wanted && !wanted.disabled ? wanted : other)?.focus();
  });

  const optionOf = (linkId: string) =>
    props.known.find((o) => o.id === linkId) ?? found.get(linkId);
  const titleOf = (linkId: string) => {
    const o = optionOf(linkId);
    return o ? (o.title ?? o.label) : undefined;
  };
  const emit = (next: readonly LinkValue[]) => props.onChange(next.length > 0 ? next : undefined);

  const add = (picked: string | undefined, option: PickOption | undefined) => {
    if (!picked) return;
    if (option && !props.known.some((o) => o.id === picked)) {
      setFound((m) => new Map(m).set(picked, option));
    }
    emit([...items, { id: picked, linkType }]);
    setAnnouncement(`“${option?.title ?? option?.label ?? picked}” added to ${label}.`);
  };

  const move = (from: number, dir: 'up' | 'down') => {
    const to = dir === 'up' ? from - 1 : from + 1;
    const moved = items[from];
    if (!moved || to < 0 || to >= items.length) return;
    const next = [...items];
    next.splice(from, 1);
    next.splice(to, 0, moved);
    focusAfter.current = { index: to, move: dir };
    emit(next);
    setAnnouncement(
      `“${titleOf(moved.id) ?? moved.id}” moved to position ${to + 1} of ${items.length}.`,
    );
  };

  const remove = (index: number) => {
    const gone = items[index];
    if (!gone) return;
    focusAfter.current = index < items.length - 1 ? { index } : 'add';
    emit(items.filter((_, i) => i !== index));
    setAnnouncement(`“${titleOf(gone.id) ?? gone.id}” removed from ${label}.`);
  };

  return (
    <div className="space-y-2">
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
      {items.length > 0 && (
        <ol ref={list} aria-label={label} className="divide-y rounded-xl bg-secondary/40">
          {items.map((link, i) => {
            const option = optionOf(link.id);
            const title = titleOf(link.id);
            const name = title ?? link.id;
            const type = linkType === 'Asset' ? option?.mimeType : option?.contentType;
            const err = props.errorFor?.(`${props.path}[${i}]`);
            const errId = err ? `${id}-${i}-error` : undefined;
            return (
              // Keyed by place: a row is its place in the list, and a link may repeat.
              <li key={i} data-index={i} className="space-y-1 px-3 py-2">
                <div className="flex items-center gap-2 max-md:flex-wrap">
                  <span
                    aria-hidden="true"
                    className="w-5 shrink-0 text-right text-muted-foreground text-xs tabular-nums"
                  >
                    {i + 1}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {title ?? <code className="text-xs">{link.id}</code>}
                  </span>
                  <Badge variant="outline">
                    {type ?? (linkType === 'Asset' ? 'Asset' : 'Entry')}
                  </Badge>
                  {/* A finger's 44px targets (hit-area) must not overlap: icon-xs is 24px, so 20px
                      apart on a coarse pointer. */}
                  <div className="flex shrink-0 items-center gap-0.5 max-md:ml-auto pointer-coarse:gap-5">
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost"
                      data-move="up"
                      aria-label={`Move “${name}” up`}
                      disabled={i === 0}
                      onClick={() => move(i, 'up')}
                    >
                      <ArrowUp aria-hidden="true" />
                    </Button>
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost"
                      data-move="down"
                      aria-label={`Move “${name}” down`}
                      disabled={i === items.length - 1}
                      onClick={() => move(i, 'down')}
                    >
                      <ArrowDown aria-hidden="true" />
                    </Button>
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost"
                      data-remove=""
                      aria-describedby={errId}
                      aria-label={`Remove “${name}” from ${label}`}
                      onClick={() => remove(i)}
                    >
                      <X aria-hidden="true" />
                    </Button>
                  </div>
                </div>
                {err && (
                  <p id={errId} className="text-destructive text-xs">
                    {err}
                  </p>
                )}
              </li>
            );
          })}
        </ol>
      )}
      <EntityPicker
        id={addId}
        options={props.options}
        value=""
        ariaLabel={`Add ${noun === 'asset' ? 'an asset' : 'an entry'} to ${label}`}
        placeholder={noun === 'asset' ? 'Add an asset…' : 'Add an entry…'}
        invalid={props.invalid}
        errorId={props.describedBy}
        {...(props.onSearch ? { onSearch: props.onSearch } : {})}
        onChange={add}
      />
    </div>
  );
}
