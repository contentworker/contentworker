import type { FilterOp, SavedView, SavedViewQuery } from '@contentworker/domain';
import type { EntryFilter, EntryListQuery } from './management';

/**
 * The entries list's state as its URL: the same query string the Preview API reads
 * (`fields.title[match]=cat`, `sys.status=draft`, `order=-sys.updatedAt`, `query=…`, `where=…`),
 * plus the open saved view (`view`) and the columns (`columns`). A link and a view therefore
 * agree: opening a view writes its query into the URL, and saving reads the URL back.
 *
 * Any other parameter is kept as it came (`extra`): a link from a newer client survives a round
 * trip through this one and is saved with a view, but is never sent with the list request.
 */

export interface EntryListState {
  readonly query: EntryListQuery;
  /** The saved view this list was opened from, if any. */
  readonly viewId?: string;
  /** Columns besides the title; absent is the default (status, then updated). */
  readonly columns?: readonly string[];
}

/** The ops a filter key may carry in brackets, as the API reads them. */
const OPS: ReadonlySet<string> = new Set<FilterOp>([
  'eq',
  'ne',
  'in',
  'nin',
  'gt',
  'gte',
  'lt',
  'lte',
  'between',
  'exists',
  'match',
  'startsWith',
  'ref',
  'refIn',
]);
const LIST_OPS: ReadonlySet<string> = new Set(['in', 'nin', 'between', 'refIn']);

/** The filter keys the Preview API reads (`entry-query.ts`'s FILTER_KEY). */
const FILTER_KEY =
  /^(fields\.[A-Za-z0-9_]+(?:\.[A-Za-z_][A-Za-z0-9_]*){0,3}|sys\.[A-Za-z0-9_]+|metadata\.(?:tags|concepts))(?:\[(\w+)\])?$/;

/**
 * Parameters with a meaning of their own here; anything else that isn't a filter is extra. The
 * connection's (`space`, `env`, `locale`: any CMS URL may carry them) belong to the client, not
 * the list, and are never saved with a view.
 */
export const CONNECTION_PARAMS: readonly string[] = ['space', 'env', 'locale'];
const OWN = new Set([
  'order',
  'query',
  'trashed',
  'where',
  'view',
  'columns',
  ...CONNECTION_PARAMS,
]);

const list = (raw: string) =>
  raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/** Reads the list's state from its URL's search parameters. */
export function listStateFromParams(params: URLSearchParams): EntryListState {
  const filters: EntryFilter[] = [];
  const extra: Record<string, string> = {};
  let order: EntryListQuery['order'];
  let search: string | undefined;
  let where: unknown;
  for (const [key, value] of params) {
    if (key === 'order') {
      order = list(value).map((token) => ({
        field: token.replace(/^-/, '').replace(/^fields\./, ''),
        direction: token.startsWith('-') ? 'desc' : 'asc',
      }));
      continue;
    }
    if (key === 'query') {
      search = value || undefined;
      continue;
    }
    if (key === 'where') {
      try {
        where = JSON.parse(value);
      } catch {
        // A link with a broken tree lists without it, as one without a tree would.
      }
      continue;
    }
    if (OWN.has(key)) continue;
    const m = FILTER_KEY.exec(key);
    const op = m ? (m[2] ?? 'eq') : undefined;
    if (!m || !op || !OPS.has(op)) {
      extra[key] = value;
      continue;
    }
    const field = (m[1] as string).replace(/^fields\./, '');
    filters.push({
      field,
      op: op as FilterOp,
      value: LIST_OPS.has(op) ? list(value) : op === 'exists' ? value !== 'false' : value,
    });
  }
  const view = params.get('view');
  const columns = params.get('columns');
  return {
    query: {
      ...(filters.length ? { filters } : {}),
      ...(order?.length ? { order } : {}),
      ...(search ? { search } : {}),
      ...(where !== undefined ? { where } : {}),
      ...(params.get('trashed') === 'true' ? { trashed: true } : {}),
      ...(Object.keys(extra).length ? { extra } : {}),
    },
    ...(view ? { viewId: view } : {}),
    ...(columns !== null ? { columns: list(columns) } : {}),
  };
}

/** Namespaces a field for the query string: `sys.*` and `metadata.*` stay, else `fields.*`. */
const keyOf = (field: string) =>
  field.startsWith('sys.') || field.startsWith('metadata.') ? field : `fields.${field}`;

/** Writes the list's state as URL search parameters (the inverse of {@link listStateFromParams}). */
export function listStateToParams(state: EntryListState): URLSearchParams {
  const params = new URLSearchParams();
  const { query } = state;
  if (state.viewId) params.set('view', state.viewId);
  for (const f of query.filters ?? []) {
    const path = keyOf(f.field);
    const key = f.op === 'eq' ? path : `${path}[${f.op}]`;
    params.append(key, Array.isArray(f.value) ? f.value.join(',') : String(f.value ?? ''));
  }
  if (query.where !== undefined) params.set('where', JSON.stringify(query.where));
  if (query.order?.length) {
    params.set(
      'order',
      query.order.map((o) => `${o.direction === 'desc' ? '-' : ''}${keyOf(o.field)}`).join(','),
    );
  }
  if (query.search) params.set('query', query.search);
  if (query.trashed) params.set('trashed', 'true');
  for (const [k, v] of Object.entries(query.extra ?? {})) params.set(k, v);
  if (state.columns) params.set('columns', state.columns.join(','));
  return params;
}

/** A filter's comparand as the filter bar holds it: text, a list of text, or a boolean. */
function barValue(op: string, value: unknown): EntryFilter['value'] {
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map(String);
  if (value === undefined || value === null) return op === 'exists' ? true : '';
  return String(value);
}

/** The list a saved view opens: its query, in the bar's terms, and its columns. */
export function viewToListState(view: SavedView): EntryListState {
  const q = view.query;
  const extra = Object.fromEntries(
    Object.entries(q.extra ?? {}).map(([k, v]) => [
      k,
      Array.isArray(v) ? v.join(',') : String(v ?? ''),
    ]),
  );
  return {
    viewId: view.id,
    query: {
      ...(q.filters?.length
        ? {
            filters: q.filters.map((f) => ({
              field: f.field,
              op: f.op,
              value: barValue(f.op, f.value),
            })),
          }
        : {}),
      ...(q.order?.length ? { order: q.order } : {}),
      ...(q.search ? { search: q.search } : {}),
      ...(q.where !== undefined ? { where: q.where } : {}),
      ...(Object.keys(extra).length ? { extra } : {}),
    },
    ...(view.columns ? { columns: view.columns } : {}),
  };
}

/**
 * What saving the list as a view stores: its query in the structured form (the trash flag isn't
 * part of a view). A half-typed filter (no value yet) isn't saved; it would be refused.
 */
export function listQueryToViewQuery(query: EntryListQuery): SavedViewQuery {
  const filters = (query.filters ?? []).filter(
    (f) => f.op === 'exists' || (Array.isArray(f.value) ? f.value.length > 0 : f.value !== ''),
  );
  return {
    ...(filters.length
      ? {
          filters: filters.map((f) => ({
            field: f.field,
            op: f.op,
            ...(f.value !== undefined ? { value: f.value } : {}),
          })),
        }
      : {}),
    ...(query.where !== undefined ? { where: query.where as SavedViewQuery['where'] } : {}),
    ...(query.order?.length ? { order: query.order } : {}),
    ...(query.search ? { search: query.search } : {}),
    ...(query.extra && Object.keys(query.extra).length ? { extra: query.extra } : {}),
  };
}

/** Whether the list still shows exactly what `view` saved (its query and its columns). */
export function matchesView(state: EntryListState, view: SavedView): boolean {
  const canonical = (s: EntryListState) => {
    const p = listStateToParams({ ...s, viewId: undefined, query: { ...s.query, trashed: false } });
    p.sort();
    return p.toString();
  };
  return canonical(state) === canonical(viewToListState(view));
}
