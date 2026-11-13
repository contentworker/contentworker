import type { ContentType, FieldType, FilterOp } from '@contentworker/domain';
import { Badge } from '@contentworker/ui/badge';
import { Button } from '@contentworker/ui/button';
import { ListSearch } from '@contentworker/ui/catalog';
import { Input } from '@contentworker/ui/input';
import { cn } from '@contentworker/ui/lib/utils';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@contentworker/ui/select';
import { ListFilter, Plus, UserRound, X } from 'lucide-react';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { statusLabel } from '../lib/format';
import type { EntryFilter, EntryListQuery } from '../lib/management';
import { StatusDot } from './status';

/** Operators offered per field category — narrows the menu to what makes sense. */
const OPS_BY_CATEGORY = {
  text: [
    { value: 'eq', label: 'is' },
    { value: 'ne', label: 'is not' },
    { value: 'match', label: 'contains' },
    { value: 'in', label: 'is any of' },
    { value: 'nin', label: 'is none of' },
    { value: 'exists', label: 'exists' },
  ],
  number: [
    { value: 'eq', label: '=' },
    { value: 'ne', label: '≠' },
    { value: 'gt', label: '>' },
    { value: 'gte', label: '≥' },
    { value: 'lt', label: '<' },
    { value: 'lte', label: '≤' },
    { value: 'exists', label: 'exists' },
  ],
  date: [
    { value: 'eq', label: 'on' },
    { value: 'gt', label: 'after' },
    { value: 'gte', label: 'on or after' },
    { value: 'lt', label: 'before' },
    { value: 'lte', label: 'on or before' },
    { value: 'exists', label: 'exists' },
  ],
  boolean: [
    { value: 'eq', label: 'is' },
    { value: 'exists', label: 'exists' },
  ],
  array: [
    { value: 'in', label: 'has any of' },
    { value: 'nin', label: 'has none of' },
    { value: 'eq', label: 'has' },
    { value: 'exists', label: 'is not empty' },
  ],
  status: [
    { value: 'eq', label: 'is' },
    { value: 'ne', label: 'is not' },
    { value: 'in', label: 'is any of' },
  ],
} satisfies Record<string, { value: FilterOp; label: string }[]>;

type Category = keyof typeof OPS_BY_CATEGORY;

const ENTRY_STATUSES = ['draft', 'changed', 'published', 'archived'] as const;

/** The statuses a person looks for most, one click each on the toolbar (archived is rare). */
const CHIP_STATUSES = ['draft', 'changed', 'published'] as const;

/**
 * Whether a condition says what it matches: one without a value is a row still being built in
 * the panel, and never reaches the list (a half-built "Status is …" would match nothing).
 */
export function filterComplete(f: EntryFilter): boolean {
  if (f.op === 'exists') return typeof f.value === 'boolean';
  const v = f.value;
  if (Array.isArray(v)) return v.some((x) => String(x).trim() !== '');
  if (typeof v === 'boolean' || typeof v === 'number') return true;
  return typeof v === 'string' && v.trim() !== '';
}

/** The statuses the toolbar's chips show as chosen: a `sys.status` that is, or is any of. */
export function chosenStatuses(filters: readonly EntryFilter[]): string[] {
  const f = filters.find((x) => x.field === 'sys.status' && (x.op === 'eq' || x.op === 'in'));
  if (!f) return [];
  const v = f.value;
  return (Array.isArray(v) ? v : [v]).map((x) => String(x)).filter((x) => x !== '');
}

/** `filters` with the chips' status condition set to `statuses` (is one, is any of several, none). */
export function withStatuses(filters: readonly EntryFilter[], statuses: readonly string[]) {
  const rest = filters.filter(
    (x) => !(x.field === 'sys.status' && (x.op === 'eq' || x.op === 'in')),
  );
  if (statuses.length === 0) return rest;
  const status: EntryFilter =
    statuses.length === 1
      ? { field: 'sys.status', op: 'eq', value: statuses[0] as string }
      : { field: 'sys.status', op: 'in', value: [...statuses] };
  return [status, ...rest];
}

const same = (a: readonly EntryFilter[], b: readonly EntryFilter[]) =>
  JSON.stringify(a) === JSON.stringify(b);

function categoryOf(type: FieldType): Category {
  switch (type) {
    case 'Integer':
    case 'Number':
      return 'number';
    case 'Date':
      return 'date';
    case 'Boolean':
      return 'boolean';
    case 'Array':
      return 'array';
    default:
      return 'text';
  }
}

interface FieldOption {
  readonly field: string;
  readonly label: string;
  readonly category: Category;
}

const STATUS_OPTION: FieldOption = { field: 'sys.status', label: 'Status', category: 'status' };

/** Builds the selectable fields: a synthetic `sys.status` plus the type's own fields. */
function fieldOptions(type: ContentType): FieldOption[] {
  return [
    STATUS_OPTION,
    ...type.fields.map((f) => ({
      field: f.apiId,
      label: f.name,
      category: categoryOf(f.type),
    })),
  ];
}

/** A row's value editor — adapts to the field/op (status menu, boolean, list, …). */
function ValueInput(props: {
  option: FieldOption;
  filter: EntryFilter;
  onChange: (value: EntryFilter['value']) => void;
}) {
  const { option, filter, onChange } = props;
  if (filter.op === 'exists') {
    return (
      <Select value={String(filter.value ?? 'true')} onValueChange={(v) => onChange(v === 'true')}>
        <SelectTrigger aria-label="Filter value" className="h-8 w-[120px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="true">present</SelectItem>
          <SelectItem value="false">absent</SelectItem>
        </SelectContent>
      </Select>
    );
  }
  if (option.field === 'sys.status') {
    if (filter.op === 'in') {
      return (
        <Input
          aria-label="Filter value"
          className="h-8 w-[200px] max-sm:w-full"
          placeholder="draft, published"
          value={Array.isArray(filter.value) ? filter.value.join(', ') : String(filter.value ?? '')}
          onChange={(e) => onChange(e.target.value.split(',').map((s) => s.trim()))}
        />
      );
    }
    return (
      <Select value={typeof filter.value === 'string' ? filter.value : ''} onValueChange={onChange}>
        <SelectTrigger aria-label="Filter value" className="h-8 w-[140px] max-sm:flex-1">
          <SelectValue placeholder="Choose…" />
        </SelectTrigger>
        <SelectContent>
          {ENTRY_STATUSES.map((s) => (
            <SelectItem key={s} value={s}>
              {statusLabel(s)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }
  if (option.category === 'boolean') {
    return (
      <Select
        value={typeof filter.value === 'boolean' ? String(filter.value) : ''}
        onValueChange={(v) => onChange(v === 'true')}
      >
        <SelectTrigger aria-label="Filter value" className="h-8 w-[120px] max-sm:flex-1">
          <SelectValue placeholder="Choose…" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="true">true</SelectItem>
          <SelectItem value="false">false</SelectItem>
        </SelectContent>
      </Select>
    );
  }
  const isList = filter.op === 'in' || filter.op === 'nin';
  return (
    <Input
      aria-label="Filter value"
      className="h-8 w-[200px] max-sm:w-full"
      type={option.category === 'date' && !isList ? 'date' : 'text'}
      placeholder={isList ? 'a, b, c' : 'value'}
      value={Array.isArray(filter.value) ? filter.value.join(', ') : String(filter.value ?? '')}
      onChange={(e) =>
        onChange(isList ? e.target.value.split(',').map((s) => s.trim()) : e.target.value)
      }
    />
  );
}

/** How long the search box waits after a keystroke before the list's URL takes the text. */
const SEARCH_WRITE_MS = 150;

/**
 * The search box. The list's state is its URL, which a navigation updates a moment after the
 * keystroke: bound straight to it, fast typing loses characters. So the box holds its own text and
 * writes it on a pause, and follows the URL when something else changes it (a view, Clear, Back).
 */
function SearchField(props: { value: string; onChange(text: string): void }) {
  const [text, setText] = useState(props.value);
  const written = useRef(props.value);
  const onChange = useRef(props.onChange);
  onChange.current = props.onChange;
  useEffect(() => {
    if (props.value === written.current) return;
    written.current = props.value;
    setText(props.value);
  }, [props.value]);
  useEffect(() => {
    if (text === written.current) return;
    const timer = setTimeout(() => {
      written.current = text;
      onChange.current(text);
    }, SEARCH_WRITE_MS);
    return () => clearTimeout(timer);
  }, [text]);
  return (
    <ListSearch
      label="Search entries"
      className="max-w-none"
      placeholder="Search text fields…"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onClear={() => setText('')}
    />
  );
}

/**
 * Filter and search toolbar for the entries list (the table sorts from its own headers). Holds
 * no query state of its own beyond panel visibility — the parent owns the `EntryListQuery` so it
 * can drive the fetch and reflect the active-filter count.
 */
export function EntryFilterBar(props: {
  type: ContentType;
  value: EntryListQuery;
  onChange: (query: EntryListQuery) => void;
  /** Before the search (the views menu). */
  leading?: ReactNode;
  /** After Filters and Clear (the column picker). */
  trailing?: ReactNode;
}) {
  const { type, value, onChange } = props;
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const options = fieldOptions(type);
  const filters = value.filters ?? [];

  // The panel's rows: the list's conditions, and any still being built. Only complete ones are
  // the list's (`filterComplete`); a row without a value waits here until it has one.
  const [rows, setRows] = useState<readonly EntryFilter[]>(filters);
  const [seen, setSeen] = useState<readonly EntryFilter[]>(filters);
  if (!same(filters, seen)) {
    // Changed from outside (a view, Clear, Back, a chip): those, and the rows still being built.
    setSeen(filters);
    setRows([...filters, ...rows.filter((r) => !filterComplete(r))]);
  }
  const commit = (next: readonly EntryFilter[]) => {
    setRows(next);
    const complete = next.filter(filterComplete);
    setSeen(complete);
    if (!same(complete, filters)) {
      onChange({ ...value, filters: complete.length > 0 ? complete : undefined });
    }
  };

  const optionFor = (field: string) => options.find((o) => o.field === field) ?? STATUS_OPTION;

  const patchFilter = (i: number, patch: Partial<EntryFilter>) =>
    commit(
      rows.map((f, j) => {
        if (j !== i) return f;
        const next = { ...f, ...patch };
        // "exists" asks present or absent, present until chosen; leaving it starts the value over.
        if (patch.op === 'exists' && f.op !== 'exists') return { ...next, value: true };
        if (patch.op && patch.op !== 'exists' && f.op === 'exists') return { ...next, value: '' };
        return next;
      }),
    );

  const addFilter = () => {
    const first = options[0];
    if (!first) return;
    commit([...rows, { field: first.field, op: 'eq', value: '' }]);
    setOpen(true);
  };

  const removeFilter = (i: number) => commit(rows.filter((_, j) => j !== i));

  const chosen = chosenStatuses(filters);
  const toggleStatus = (status: string) => {
    const next = chosen.includes(status) ? chosen.filter((s) => s !== status) : [...chosen, status];
    const nextFilters = withStatuses(filters, next);
    onChange({ ...value, filters: nextFilters.length > 0 ? nextFilters : undefined });
  };

  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };

  // A `where` tree (from a saved view or a link) counts as one: the bar doesn't edit its groups.
  const grouped = value.where !== undefined;
  // So does a `links_to_entry`, from a link or a view: the bar has no row for "any field".
  const linked = (value.linksToEntry?.length ?? 0) > 0;
  // The panel's conditions only: the search shows itself in its box.
  const activeCount = filters.length + (grouped ? 1 : 0) + (linked ? 1 : 0);
  // "Mine" and the search are their own, beside the panel's filters; Clear clears them with them.
  const clearable = activeCount > 0 || value.mine === true || Boolean(value.search);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {props.leading}
        {/* On a phone the buttons share a row and the search has its own, wide enough to use. */}
        <div className="flex-1 max-sm:order-first max-sm:basis-full sm:max-w-xs">
          <SearchField
            value={value.search ?? ''}
            onChange={(text) => onChange({ ...value, search: text || undefined })}
          />
        </div>
        {/* The statuses people look for most, one click each: they are the panel's Status
            condition, so the panel and the chips always agree. */}
        <fieldset className="flex items-center gap-1 border-0 p-0 max-sm:basis-full">
          <legend className="sr-only">Status</legend>
          {CHIP_STATUSES.map((s) => {
            const on = chosen.includes(s);
            return (
              <Button
                key={s}
                type="button"
                // Pressed reads as the ink fill, as Mine does: on and off differ by more than a tint.
                variant={on ? 'default' : 'outline'}
                size="sm"
                aria-pressed={on}
                onClick={() => toggleStatus(s)}
                className="gap-1.5"
              >
                <StatusDot status={s} className={cn(on && 'ring-1 ring-background')} />
                {statusLabel(s)}
              </Button>
            );
          })}
        </fieldset>
        <Button
          ref={trigger}
          type="button"
          variant="outline"
          size="sm"
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          onClick={() => setOpen((o) => !o)}
        >
          <ListFilter aria-hidden="true" className="size-4" />
          Filters
          {activeCount > 0 && (
            <Badge variant="secondary" className="ml-1">
              {activeCount}
            </Badge>
          )}
        </Button>
        <Button
          type="button"
          // Pressed reads as the ink fill, so on and off differ by more than a tint.
          variant={value.mine ? 'default' : 'outline'}
          size="sm"
          aria-pressed={value.mine === true}
          onClick={() => onChange({ ...value, mine: value.mine ? undefined : true })}
        >
          <UserRound aria-hidden="true" className="size-4" />
          Mine
        </Button>
        {clearable && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            // Filters and search only: the sort and the trash view aren't filters.
            onClick={() =>
              onChange({
                ...value,
                filters: undefined,
                search: undefined,
                where: undefined,
                mine: undefined,
                linksToEntry: undefined,
              })
            }
            className="text-muted-foreground"
          >
            <X aria-hidden="true" className="size-4" />
            Clear
          </Button>
        )}
        {/* Off a phone only: its rows show no field columns, and the buttons keep to one row. */}
        {props.trailing && <div className="ml-auto max-md:hidden">{props.trailing}</div>}
      </div>

      {open && (
        // biome-ignore lint/a11y/noStaticElementInteractions: Escape closes the panel from anywhere in it.
        <div
          id={panelId}
          className="card space-y-3 p-3"
          onKeyDown={(e) => {
            // A select's own Escape (its menu closing) is handled before this and marked so.
            if (e.key !== 'Escape' || e.defaultPrevented) return;
            e.preventDefault();
            close();
          }}
        >
          {rows.length === 0 && !grouped && !linked && (
            <p className="text-muted-foreground text-sm">No filters. Add one to narrow the list.</p>
          )}
          {grouped && (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-muted-foreground">
                Also grouped conditions (and, or) from the saved view or link, kept as they are.
              </span>
              <Button
                type="button"
                variant="link"
                size="xs"
                className="px-0"
                onClick={() => onChange({ ...value, where: undefined })}
              >
                Remove them
              </Button>
            </div>
          )}
          {linked && (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-muted-foreground">
                Also only entries linking to the entry the saved view or link names.
              </span>
              <Button
                type="button"
                variant="link"
                size="xs"
                className="px-0"
                aria-label="Remove the link condition"
                onClick={() => onChange({ ...value, linksToEntry: undefined })}
              >
                Remove it
              </Button>
            </div>
          )}
          {rows.map((filter, i) => {
            const option = optionFor(filter.field);
            const ops = OPS_BY_CATEGORY[option.category];
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: filters are positional rows
              <div key={i} className="flex flex-wrap items-center gap-2">
                <Select
                  value={filter.field}
                  onValueChange={(field) => {
                    const ok = OPS_BY_CATEGORY[optionFor(field).category];
                    patchFilter(i, {
                      field,
                      op: ok.some((o) => o.value === filter.op)
                        ? filter.op
                        : (ok[0]?.value ?? 'eq'),
                      value: filter.op === 'exists' ? true : '',
                    });
                  }}
                >
                  <SelectTrigger aria-label="Filter field" className="h-8 w-[160px] max-sm:flex-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {options.map((o) => (
                      <SelectItem key={o.field} value={o.field}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  value={filter.op}
                  onValueChange={(op) => patchFilter(i, { op: op as FilterOp })}
                >
                  <SelectTrigger
                    aria-label="Filter operator"
                    className="h-8 w-[140px] max-sm:flex-1"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ops.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <ValueInput
                  option={option}
                  filter={filter}
                  onChange={(v) => patchFilter(i, { value: v })}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  aria-label="Remove filter"
                  onClick={() => removeFilter(i)}
                >
                  <X className="size-4" />
                </Button>
              </div>
            );
          })}

          <div className="flex flex-wrap items-center gap-2 border-t pt-3">
            <Button type="button" variant="outline" size="sm" onClick={addFilter}>
              <Plus aria-hidden="true" />
              Add filter
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
