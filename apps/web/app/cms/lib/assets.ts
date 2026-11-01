import type { Asset, AssetFolder, AssetKind } from '@contentworker/domain';
import type { AssetListQuery } from './management';

/** Where the library is looking: everything, the assets in no folder, or one folder. */
export type FolderSelection =
  | { readonly kind: 'all' }
  | { readonly kind: 'root' }
  | {
      readonly kind: 'folder';
      readonly id: string;
    };

export const ALL_FOLDERS: FolderSelection = { kind: 'all' };

/** The library's filter bar, as the screen holds it (the API query is derived from it). */
export interface AssetFilterState {
  readonly kind?: AssetKind;
  readonly status?: 'draft' | 'published' | 'archived' | 'all';
  readonly tag?: string;
  /** One of {@link ASSET_SORTS}' values. */
  readonly sort?: AssetSortChoice;
}

export type AssetSortChoice =
  | 'updated-desc'
  | 'updated-asc'
  | 'created-desc'
  | 'size-desc'
  | 'size-asc';

export const ASSET_SORTS: readonly { value: AssetSortChoice; label: string }[] = [
  { value: 'updated-desc', label: 'Recently changed' },
  { value: 'updated-asc', label: 'Least recently changed' },
  { value: 'created-desc', label: 'Newest' },
  { value: 'size-desc', label: 'Largest' },
  { value: 'size-asc', label: 'Smallest' },
];

export const KIND_LABELS: Record<AssetKind, string> = {
  image: 'Images',
  video: 'Video',
  audio: 'Audio',
  document: 'Documents',
  other: 'Other files',
};

const SORT_QUERY: Record<AssetSortChoice, Pick<AssetListQuery, 'sort' | 'order'>> = {
  'updated-desc': {},
  'updated-asc': { sort: 'updatedAt', order: 'asc' },
  'created-desc': { sort: 'createdAt', order: 'desc' },
  'size-desc': { sort: 'size', order: 'desc' },
  'size-asc': { sort: 'size', order: 'asc' },
};

/** A page of the library this size; the API allows up to 100. */
export const ASSET_PAGE_SIZE = 50;

/** The API query for what the screen shows: the folder, then the filter bar. */
export function assetLibraryQuery(
  folder: FolderSelection,
  filters: AssetFilterState,
): AssetListQuery {
  return {
    limit: ASSET_PAGE_SIZE,
    ...(folder.kind === 'root' ? { folder: 'root' } : {}),
    ...(folder.kind === 'folder' ? { folder: folder.id } : {}),
    ...(filters.kind ? { kind: filters.kind } : {}),
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.tag ? { tag: filters.tag } : {}),
    ...(filters.sort ? SORT_QUERY[filters.sort] : {}),
  };
}

/** How many filters are narrowing the list (the sort is not one). */
export const activeFilterCount = (f: AssetFilterState): number =>
  [f.kind, f.status, f.tag].filter(Boolean).length;

/** A folder as the tree draws it: its depth under the root (0 at the top). */
export interface FolderRow {
  readonly folder: AssetFolder;
  readonly depth: number;
}

/**
 * The folders in tree order with their depth. The API lists them in path order, which already puts
 * a parent before its children; sorting by name within a parent is done here.
 */
export function folderRows(folders: readonly AssetFolder[]): FolderRow[] {
  const children = new Map<string, AssetFolder[]>();
  for (const f of folders) {
    const key = f.parentId ?? '';
    children.set(key, [...(children.get(key) ?? []), f]);
  }
  const out: FolderRow[] = [];
  const walk = (parent: string, depth: number) => {
    const list = [...(children.get(parent) ?? [])].sort((a, b) => a.name.localeCompare(b.name));
    for (const folder of list) {
      out.push({ folder, depth });
      walk(folder.id, depth + 1);
    }
  };
  walk('', 0);
  return out;
}

/** A folder's name with its ancestors, `Brand / Logos`, for a move menu. */
export function folderLabel(folder: AssetFolder, folders: readonly AssetFolder[]): string {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const names = folder.path
    .split('/')
    .filter(Boolean)
    .map((id) => byId.get(id)?.name ?? '…');
  return names.join(' / ');
}

/** The name an editor knows an asset by: its title in the locale, else its file name. */
export function assetName(asset: Asset, locale: string): string {
  return String(asset.title?.[locale] ?? asset.file.fileName);
}

/** `1.2 MB`, for the list view's size column. */
export function fileSize(bytes: number | undefined): string {
  if (bytes === undefined) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let n = bytes / 1024;
  let unit = 0;
  while (n >= 1024 && unit < units.length - 1) {
    n /= 1024;
    unit += 1;
  }
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[unit]}`;
}

/** The outcome of running one action over several assets. */
export interface BulkOutcome {
  readonly done: number;
  readonly failed: number;
}

/**
 * Runs `act` over every id, a few at a time, and counts what worked: one failure never stops the
 * rest, and the caller reports the tally.
 */
export async function runBulk(
  ids: readonly string[],
  act: (id: string) => Promise<unknown>,
  concurrency = 4,
): Promise<BulkOutcome> {
  let done = 0;
  let failed = 0;
  let next = 0;
  const lane = async () => {
    while (next < ids.length) {
      const id = ids[next++] as string;
      try {
        await act(id);
        done += 1;
      } catch {
        failed += 1;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, lane));
  return { done, failed };
}

/** "Published 3 assets", or "Published 2 of 3 assets; 1 failed". */
export function bulkSummary(verb: string, outcome: BulkOutcome): string {
  const total = outcome.done + outcome.failed;
  const noun = total === 1 ? 'asset' : 'assets';
  if (outcome.failed === 0) return `${verb} ${total} ${noun}`;
  return `${verb} ${outcome.done} of ${total} ${noun}; ${outcome.failed} failed`;
}
