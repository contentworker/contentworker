import type { ContentType, FieldType, FilterOp } from '@contentworker/domain';
import { Badge } from '@contentworker/ui/badge';
import { Button } from '@contentworker/ui/button';
import { Input } from '@contentworker/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@contentworker/ui/select';
import { ListFilter, Search, X } from 'lucide-react';
import { useState } from 'react';
import type { EntryFilter, EntryListQuery, EntryOrder } from '../lib/management';

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
          className="h-8 w-[200px]"
          placeholder="draft, published"
          value={Array.isArray(filter.value) ? filter.value.join(', ') : String(filter.value ?? '')}
          onChange={(e) => onChange(e.target.value.split(',').map((s) => s.trim()))}
        />
      );
    }
    return (
      <Select value={String(filter.value ?? 'draft')} onValueChange={onChange}>
        <SelectTrigger aria-label="Filter value" className="h-8 w-[140px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {ENTRY_STATUSES.map((s) => (
            <SelectItem key={s} value={s}>
              {s}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }
  if (option.category === 'boolean') {
    return (
      <Select value={String(filter.value ?? 'true')} onValueChange={(v) => onChange(v === 'true')}>
        <SelectTrigger aria-label="Filter value" className="h-8 w-[120px]">
          <SelectValue />
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
      className="h-8 w-[200px]"
      type={option.category === 'date' && !isList ? 'date' : 'text'}
      placeholder={isList ? 'a, b, c' : 'value'}
      value={Array.isArray(filter.value) ? filter.value.join(', ') : String(filter.value ?? '')}
      onChange={(e) =>
        onChange(isList ? e.target.value.split(',').map((s) => s.trim()) : e.target.value)
      }
    />
  );
}

/**
 * Filter/sort/search toolbar for the entries list. Holds no query state of its
 * own beyond panel visibility — the parent owns the `EntryListQuery` so it can
 * drive the fetch and reflect the active-filter count.
 */
export function EntryFilterBar(props: {
  type: ContentType;
  value: EntryListQuery;
  onChange: (query: EntryListQuery) => void;
}) {
  const { type, value, onChange } = props;
  const [open, setOpen] = useState(false);
  const options = fieldOptions(type);
  const filters = value.filters ?? [];
  const order = value.order?.[0];

  const optionFor = (field: string) => options.find((o) => o.field === field) ?? STATUS_OPTION;

  const patchFilter = (i: number, patch: Partial<EntryFilter>) =>
    onChange({ ...value, filters: filters.map((f, j) => (j === i ? { ...f, ...patch } : f)) });

  const addFilter = () => {
    const first = options[0];
    if (!first) return;
    onChange({
      ...value,
      filters: [...filters, { field: first.field, op: 'eq', value: '' }],
    });
    setOpen(true);
  };

  const removeFilter = (i: number) =>
    onChange({ ...value, filters: filters.filter((_, j) => j !== i) });

  const setOrder = (next: EntryOrder | undefined) =>
    onChange({ ...value, order: next ? [next] : undefined });

  const activeCount = filters.length + (value.search ? 1 : 0) + (order ? 1 : 0);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 sm:max-w-xs">
          <Search className="-translate-y-1/2 absolute top-1/2 left-2.5 size-4 text-muted-foreground" />
          <Input
            className="h-9 pl-8"
            placeholder="Search text fields…"
            value={value.search ?? ''}
            onChange={(e) => onChange({ ...value, search: e.target.value || undefined })}
          />
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => setOpen((o) => !o)}>
          <ListFilter className="size-4" />
          Filters
          {activeCount > 0 && (
            <Badge variant="secondary" className="ml-1">
              {activeCount}
            </Badge>
          )}
        </Button>
        {activeCount > 0 && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onChange({})}
            className="text-muted-foreground"
          >
            <X className="size-4" />
            Clear
          </Button>
        )}
      </div>

      {open && (
        <div className="space-y-3 rounded-lg border bg-card p-3">
          {filters.length === 0 && (
            <p className="text-muted-foreground text-sm">No filters. Add one to narrow the list.</p>
          )}
          {filters.map((filter, i) => {
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
                      value: '',
                    });
                  }}
                >
                  <SelectTrigger aria-label="Filter field" className="h-8 w-[160px]">
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
                  <SelectTrigger aria-label="Filter operator" className="h-8 w-[140px]">
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
              + Add filter
            </Button>
            <div className="ml-auto flex items-center gap-2">
              <span className="text-muted-foreground text-sm">Sort by</span>
              <Select
                value={order?.field ?? 'none'}
                onValueChange={(field) =>
                  setOrder(
                    field === 'none' ? undefined : { field, direction: order?.direction ?? 'asc' },
                  )
                }
              >
                <SelectTrigger aria-label="Sort field" className="h-8 w-[160px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Default</SelectItem>
                  {options.map((o) => (
                    <SelectItem key={o.field} value={o.field}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={order?.direction ?? 'asc'}
                disabled={!order}
                onValueChange={(direction) =>
                  order && setOrder({ ...order, direction: direction as 'asc' | 'desc' })
                }
              >
                <SelectTrigger aria-label="Sort direction" className="h-8 w-[120px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="asc">Ascending</SelectItem>
                  <SelectItem value="desc">Descending</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
