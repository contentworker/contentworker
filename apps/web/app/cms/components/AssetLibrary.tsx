import type { Asset, AssetFolder } from '@contentworker/domain';
import { Alert, AlertDescription, AlertTitle } from '@contentworker/ui/alert';
import { Button } from '@contentworker/ui/button';
import { Card } from '@contentworker/ui/card';
import { Checkbox } from '@contentworker/ui/checkbox';
import { cn } from '@contentworker/ui/lib/utils';
import { Skeleton, SkeletonPill, SkeletonText } from '@contentworker/ui/skeleton';
import { Table, TableBody, TableHead, Td, Th, Tr } from '@contentworker/ui/table';
import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query';
import { Archive, ArchiveRestore, ImageIcon, Trash2, Upload } from 'lucide-react';
import { type DragEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AssetDetailSheet } from '~/cms/components/AssetDetailSheet';
import { AssetPreview } from '~/cms/components/AssetPreview';
import { AssetBulkBar } from '~/cms/components/assets/AssetBulkBar';
import { AssetFilterBar, type AssetView } from '~/cms/components/assets/AssetFilterBar';
import { AssetFolderTree } from '~/cms/components/assets/AssetFolderTree';
import { AssetInUseNotice } from '~/cms/components/assets/AssetInUseNotice';
import {
  AssetUploadList,
  type UploadItem,
  uploadSummary,
} from '~/cms/components/assets/AssetUploadList';
import { InlineConfirm } from '~/cms/components/InlineConfirm';
import {
  LoadingStatus,
  Refreshing,
  rememberCount,
  rememberedCount,
} from '~/cms/components/loading';
import { EmptyState, PageHeader } from '~/cms/components/page';
import { StatusBadge } from '~/cms/components/status';
import {
  ALL_FOLDERS,
  type AssetFilterState,
  activeFilterCount,
  assetLibraryQuery,
  assetName,
  bulkSummary,
  type FolderSelection,
  fileSize,
  runBulk,
} from '~/cms/lib/assets';
import { humanize } from '~/cms/lib/format';
import { useClient } from '../lib/client-context';
import { ApiError, type AssetInUse, assetUsageOf } from '../lib/management';
import { useInvalidate, useQueryKeys, useScopedQuery } from '../lib/queries';
import { useToast } from '../lib/toast';

/** Label for a hosted video's processing state, shown beside the asset status. */
const VIDEO_STATUS_LABEL: Record<string, string> = {
  pending: 'Awaiting upload',
  processing: 'Processing',
  ready: 'Ready',
  error: 'Failed',
};

const VIEW_KEY = 'cw.assets.view';

/** Grid or list is how this browser likes the library, kept across visits (like the pane split). */
function useView(): [AssetView, (v: AssetView) => void] {
  const [view, setView] = useState<AssetView>(() => {
    try {
      return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'grid';
    } catch {
      return 'grid';
    }
  });
  const set = useCallback((v: AssetView) => {
    setView(v);
    try {
      if (v === 'grid') localStorage.removeItem(VIEW_KEY);
      else localStorage.setItem(VIEW_KEY, v);
    } catch {
      // Storage blocked: the choice lasts for this page.
    }
  }, []);
  return [view, set];
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * The asset library: folders beside a filtered, paged grid or list. Upload by picking or dropping
 * any number of files (into the open folder), select several to move, publish or archive them, and
 * archive or delete one at a time; a delete the API refuses shows the entries that use the asset.
 */
export function AssetLibrary(props: { locale: string }) {
  const { locale } = props;
  const { client } = useClient();
  const toast = useToast();
  const invalidate = useInvalidate();
  const keys = useQueryKeys();
  const [folder, setFolder] = useState<FolderSelection>(ALL_FOLDERS);
  const [filters, setFilters] = useState<AssetFilterState>({});
  const [view, setView] = useView();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [open, setOpen] = useState<Asset | null>(null);
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [dragging, setDragging] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [inUse, setInUse] = useState<({ asset: Asset } & AssetInUse) | null>(null);
  // A bulk action's failures, by asset: named in place, and still selected to try again.
  const [bulkFailures, setBulkFailures] = useState<{
    readonly verb: string;
    readonly items: readonly { name: string; error: string }[];
  } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const query = useMemo(() => assetLibraryQuery(folder, filters), [folder, filters]);
  const pages = useInfiniteQuery({
    queryKey: keys.assetLibrary(query),
    queryFn: ({ pageParam }) =>
      client.listAssets(pageParam ? { ...query, cursor: pageParam } : query),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor,
    // Another folder or filter keeps the assets on screen (dimmed if slow) until its own arrive.
    placeholderData: keepPreviousData,
  });
  const assets = useMemo(() => pages.data?.pages.flatMap((p) => p.items) ?? [], [pages.data]);
  // Skeletons: the first page comes back as long as the library was last time (this session);
  // the next page, as a row of them after the last asset.
  const countKey = `assets:${view}`;
  const pending = pages.isPending
    ? rememberedCount(countKey, view === 'grid' ? 8 : 6)
    : pages.isFetchingNextPage
      ? 4
      : 0;
  useEffect(() => {
    if (pages.data && !pages.isPlaceholderData) rememberCount(countKey, assets.length);
  }, [countKey, pages.data, pages.isPlaceholderData, assets.length]);
  const folders = useScopedQuery(['asset-folders'], () => client.listAssetFolders()).data ?? [];
  const tags = useScopedQuery(['tags'], () => client.listTags(), { silent: true }).data ?? [];

  const reload = () => invalidate(['assets']);
  const reloadFolders = () => invalidate(['asset-folders']);
  const fail = (e: unknown) => toast.error(message(e));
  const openFolder = folder.kind === 'folder' ? folders.find((f) => f.id === folder.id) : undefined;

  const changeFolder = (next: FolderSelection) => {
    setFolder(next);
    setSelected(new Set());
    setBulkFailures(null);
  };
  const changeFilters = (next: AssetFilterState) => {
    setFilters(next);
    setSelected(new Set());
    setBulkFailures(null);
  };

  // --- uploads ------------------------------------------------------------
  const patchUpload = (id: string, patch: Partial<UploadItem>) =>
    setUploads((list) => list.map((u) => (u.id === id ? { ...u, ...patch } : u)));

  const uploadOne = async (file: File, folderId: string | undefined) => {
    if (file.type.startsWith('video/')) {
      try {
        // Hosted video (Cloudflare Stream): adaptive playback and a poster. Filed afterwards: the
        // video upload starts on the host, not with a folder.
        const asset = await client.uploadVideo(file);
        if (folderId) await client.moveAssets([asset.id], folderId);
        return;
      } catch (e) {
        // 501: no video host bound on this deployment; store it as a plain file.
        if (!(e instanceof ApiError && e.status === 501)) throw e;
      }
    }
    await client.uploadAsset(file, folderId ? { folderId } : {});
  };

  const upload = async (files: readonly File[]) => {
    if (files.length === 0) return;
    const folderId = openFolder?.id;
    const batch = files.map((file, i) => ({
      file,
      item: {
        id: `${Date.now()}-${i}-${file.name}`,
        name: file.name,
        state: 'queued',
      } as UploadItem,
    }));
    setUploads((list) => [...list.filter((u) => u.state !== 'done'), ...batch.map((b) => b.item)]);
    const outcome = new Map<string, UploadItem>();
    let next = 0;
    const lane = async () => {
      while (next < batch.length) {
        const { file, item } = batch[next++] as (typeof batch)[number];
        patchUpload(item.id, { state: 'uploading' });
        try {
          await uploadOne(file, folderId);
          patchUpload(item.id, { state: 'done' });
          outcome.set(item.id, { ...item, state: 'done' });
        } catch (e) {
          patchUpload(item.id, { state: 'failed', error: message(e) });
          outcome.set(item.id, { ...item, state: 'failed', error: message(e) });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, batch.length) }, lane));
    if (fileRef.current) fileRef.current.value = '';
    // The batch's end is said once, in a toast, beside the list's own live summary.
    const finished = [...outcome.values()];
    const summary = uploadSummary(finished);
    if (finished.some((u) => u.state === 'failed')) toast.error(summary);
    else toast.success(summary);
    await reload();
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    void upload([...e.dataTransfer.files]);
  };
  const onDragOver = (e: DragEvent) => {
    if (![...e.dataTransfer.types].includes('Files')) return;
    e.preventDefault();
    setDragging(true);
  };

  // --- one asset ----------------------------------------------------------
  const publish = (a: Asset) => void client.publishAsset(a.id).then(reload).catch(fail);

  // Unpublish is only offered on a published asset, so republishing restores
  // exactly what was live: an Undo, not an up-front confirm (as for entries).
  const unpublish = (asset: Asset) =>
    void client
      .unpublishAsset(asset.id)
      .then(reload)
      .then(() =>
        toast.success(`Unpublished “${assetName(asset, locale)}”`, {
          action: {
            label: 'Undo',
            onAction: () =>
              void client
                .publishAsset(asset.id)
                .then(reload)
                .then(() => toast.success(`Republished “${assetName(asset, locale)}”`))
                .catch(fail),
          },
        }),
      )
      .catch(fail);

  // Archive is undone by restoring, so it too is an Undo rather than a confirm.
  const archive = (asset: Asset) =>
    void client
      .archiveAsset(asset.id)
      .then(reload)
      .then(() =>
        toast.success(`Archived “${assetName(asset, locale)}”`, {
          action: {
            label: 'Undo',
            onAction: () => void client.restoreAsset(asset.id).then(reload).catch(fail),
          },
        }),
      )
      .catch(fail);

  const restore = (asset: Asset) =>
    void client
      .restoreAsset(asset.id)
      .then(reload)
      .then(() => toast.success(`Restored “${assetName(asset, locale)}” as a draft`))
      .catch(fail);

  const remove = async (asset: Asset) => {
    setConfirmDelete(null);
    try {
      await client.deleteAsset(asset.id);
      setSelected((s) => {
        const next = new Set(s);
        next.delete(asset.id);
        return next;
      });
      toast.success(`Deleted “${assetName(asset, locale)}”`);
      await reload();
    } catch (e) {
      const used = assetUsageOf(e);
      if (used) setInUse({ asset, ...used });
      else fail(e);
    }
  };

  // --- selection and bulk ---------------------------------------------------
  const toggle = (id: string, on: boolean) =>
    setSelected((s) => {
      const next = new Set(s);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const allSelected = assets.length > 0 && assets.every((a) => selected.has(a.id));
  const ids = [...selected];

  // A failure never stops the rest. The ones that failed stay selected and are named in place, as
  // the entries list names its bulk failures, so they can be tried again.
  const bulk = async (verb: string, act: (id: string) => Promise<unknown>) => {
    setBulkBusy(true);
    setBulkFailures(null);
    try {
      const outcome = await runBulk(ids, act);
      (outcome.failed ? toast.error : toast.success)(bulkSummary(verb, outcome));
      const failures = outcome.failures ?? [];
      setSelected(new Set(failures.map((f) => f.id)));
      if (failures.length > 0) {
        const byId = new Map(assets.map((a) => [a.id, a]));
        setBulkFailures({
          verb,
          items: failures.map((f) => {
            const a = byId.get(f.id);
            return { name: a ? assetName(a, locale) : f.id, error: f.error };
          }),
        });
      }
      await reload();
    } finally {
      setBulkBusy(false);
    }
  };

  const moveSelected = async (folderId: string | null) => {
    setBulkBusy(true);
    try {
      const { moved } = await client.moveAssets(ids, folderId);
      const where = folderId ? folders.find((f) => f.id === folderId)?.name : undefined;
      toast.success(
        `Moved ${moved} ${moved === 1 ? 'asset' : 'assets'} ${where ? `to “${where}”` : 'out of their folders'}`,
      );
      setSelected(new Set());
      await reload();
    } catch (e) {
      fail(e);
    } finally {
      setBulkBusy(false);
    }
  };

  // --- folders --------------------------------------------------------------
  const createFolder = async (name: string, parentId?: string) => {
    try {
      const created = await client.createAssetFolder({ name, ...(parentId ? { parentId } : {}) });
      await reloadFolders();
      changeFolder({ kind: 'folder', id: created.id });
      return created;
    } catch (e) {
      fail(
        e instanceof ApiError && e.status === 409 ? `A folder named “${name}” is already here` : e,
      );
      return undefined;
    }
  };
  const renameFolder = async (f: AssetFolder, name: string) => {
    try {
      await client.updateAssetFolder(f.id, { name });
      await reloadFolders();
    } catch (e) {
      fail(
        e instanceof ApiError && e.status === 409 ? `A folder named “${name}” is already here` : e,
      );
    }
  };
  const deleteFolder = async (f: AssetFolder) => {
    try {
      await client.deleteAssetFolder(f.id);
      changeFolder({ kind: 'all' });
      await reloadFolders();
      toast.success(`Deleted folder “${f.name}”`);
    } catch (e) {
      fail(
        e instanceof ApiError && e.status === 409
          ? `“${f.name}” isn’t empty: move or delete what is in it first`
          : e,
      );
    }
  };

  // --- rendering ----------------------------------------------------------
  const pick = () => fileRef.current?.click();

  /** The actions on one asset, the same in the grid and the list. */
  const actions = (a: Asset, name: string) =>
    confirmDelete === a.id ? (
      <InlineConfirm
        message={`Delete “${name}”?`}
        note="Its files go too. This can’t be undone."
        onCancel={() => setConfirmDelete(null)}
      >
        <Button type="button" size="sm" variant="destructive" onClick={() => void remove(a)}>
          Delete
        </Button>
      </InlineConfirm>
    ) : (
      <div className="flex items-center gap-0.5">
        {a.status === 'archived' ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            aria-label={`Restore “${name}”`}
            onClick={() => restore(a)}
          >
            <ArchiveRestore aria-hidden="true" />
            Restore
          </Button>
        ) : a.status === 'published' ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            aria-label={`Unpublish “${name}”`}
            onClick={() => unpublish(a)}
          >
            Unpublish
          </Button>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            aria-label={`Publish “${name}”`}
            onClick={() => publish(a)}
          >
            Publish
          </Button>
        )}
        {a.status !== 'archived' && (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={`Archive “${name}”`}
            onClick={() => archive(a)}
          >
            <Archive aria-hidden="true" />
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={`Delete “${name}”`}
          onClick={() => setConfirmDelete(a.id)}
        >
          <Trash2 aria-hidden="true" />
        </Button>
      </div>
    );

  const badges = (a: Asset) => {
    const video = a.file.video;
    return (
      <div className="flex flex-wrap items-center gap-1">
        <StatusBadge status={a.status} />
        {video && (
          <StatusBadge
            status={video.status === 'ready' ? 'completed' : video.status}
            label={VIDEO_STATUS_LABEL[video.status] ?? humanize(video.status)}
          />
        )}
      </div>
    );
  };

  const selectBox = (a: Asset, name: string) => (
    <Checkbox
      aria-label={`Select “${name}”`}
      checked={selected.has(a.id)}
      onCheckedChange={(on) => toggle(a.id, on === true)}
    />
  );

  const grid = (
    <ul className="grid grid-cols-[repeat(auto-fill,minmax(168px,1fr))] gap-3">
      {assets.map((a) => {
        const name = assetName(a, locale);
        return (
          <li key={a.id} className="flex">
            <Card
              size="sm"
              // A Ledger board card: hover and the open button's focus tint the card muted; the
              // card's own controls sit beside the open button, never inside it.
              className={cn(
                'relative w-full gap-2 p-2 transition-[background-color] hover:bg-muted/60 has-[[data-open-asset]:focus-visible]:bg-muted/60 has-[[data-open-asset]:focus-visible]:ring-2 has-[[data-open-asset]:focus-visible]:ring-ring/50',
                selected.has(a.id) && 'bg-muted/60 ring-2 ring-ring/50',
              )}
            >
              <div className="absolute top-3 left-3 z-10 rounded-[5px] bg-background">
                {selectBox(a, name)}
              </div>
              <AssetPreview
                asset={a}
                alt={String(a.metadata.altText?.[locale] ?? a.file.fileName)}
                className="h-28 w-full"
              />
              {/* The name is the card's control, stretched over it; its visible text is only the
                  name, which its label carries (WCAG 2.5.3). */}
              <button
                type="button"
                data-open-asset=""
                onClick={() => setOpen(a)}
                aria-label={`Open “${name}”`}
                className="truncate text-left font-medium text-sm outline-none after:absolute after:inset-0 after:rounded-[inherit] after:content-['']"
              >
                {name}
              </button>
              <div className="relative z-10 flex flex-wrap items-center justify-between gap-1">
                {confirmDelete === a.id ? null : badges(a)}
                {actions(a, name)}
              </div>
            </Card>
          </li>
        );
      })}
      {Array.from({ length: pending }, (_, i) => (
        <li key={`pending-${i}`} className="flex" aria-hidden="true">
          <AssetCardSkeleton index={i} />
        </li>
      ))}
    </ul>
  );

  // On a phone each row lays itself out as the entries rows do: the checkbox beside the name, the
  // type, size and status under it, the actions at the end. The cells keep their table roles.
  const ROW_STACK =
    'max-md:grid max-md:grid-cols-[auto_minmax(0,1fr)_auto] max-md:items-center max-md:gap-x-2 max-md:gap-y-1.5 max-md:px-3 max-md:py-2';
  const CELL_STACK = 'max-md:block max-md:p-0';
  const phoneLabel = (label: string) => (
    <span aria-hidden="true" className="text-muted-foreground md:hidden">
      {label}{' '}
    </span>
  );
  const list = (
    <div className="card overflow-clip">
      <Table caption="Assets" stack="rows" className="max-md:block">
        <TableHead>
          <Tr>
            <Th className="w-8">
              <Checkbox
                aria-label="Select all shown"
                checked={allSelected}
                disabled={assets.length === 0}
                onCheckedChange={(on) =>
                  setSelected(on === true ? new Set(assets.map((a) => a.id)) : new Set())
                }
              />
            </Th>
            <Th>Name</Th>
            <Th>Type</Th>
            <Th numeric>Size</Th>
            <Th>Status</Th>
            <Th>
              <span className="sr-only">Actions</span>
            </Th>
          </Tr>
        </TableHead>
        <TableBody className="max-md:block">
          {assets.map((a) => {
            const name = assetName(a, locale);
            return (
              <Tr key={a.id} className={ROW_STACK}>
                <Td label="Select" className={`${CELL_STACK} max-md:row-span-2 max-md:self-start`}>
                  {selectBox(a, name)}
                </Td>
                <Td label="Name" className={`${CELL_STACK} max-md:col-span-2`}>
                  {/* The thumbnail beside the button, not in it: the button's visible text is the
                      name alone (a fallback tile would add the file name to it). */}
                  <div className="flex min-w-0 items-center gap-2">
                    <AssetPreview asset={a} alt="" className="size-8 shrink-0 rounded-lg" />
                    <button
                      type="button"
                      onClick={() => setOpen(a)}
                      aria-label={`Open “${name}”`}
                      className="hit-area min-w-0 truncate rounded-full text-left font-medium outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/30"
                    >
                      {name}
                    </button>
                  </div>
                </Td>
                <Td
                  label="Type"
                  className={`font-mono text-xs ${CELL_STACK} max-md:col-start-2 max-md:truncate`}
                >
                  {phoneLabel('Type')}
                  {a.file.contentType}
                </Td>
                <Td label="Size" numeric className={`${CELL_STACK} max-md:text-left`}>
                  {phoneLabel('Size')}
                  {fileSize(a.file.size)}
                </Td>
                <Td label="Status" className={`${CELL_STACK} max-md:col-start-2`}>
                  {badges(a)}
                </Td>
                <Td label="Actions" className={`text-right ${CELL_STACK}`}>
                  {actions(a, name)}
                </Td>
              </Tr>
            );
          })}
          {Array.from({ length: pending }, (_, i) => (
            <AssetRowSkeleton
              key={`pending-${i}`}
              index={i}
              rowClassName={ROW_STACK}
              cellClassName={CELL_STACK}
            />
          ))}
        </TableBody>
      </Table>
    </div>
  );

  const filtered = activeFilterCount(filters) > 0 || folder.kind !== 'all';

  return (
    <div className="space-y-4">
      <PageHeader
        title="Assets"
        subtitle="Images, video, audio and documents you can link from entries."
      >
        <input
          ref={fileRef}
          type="file"
          multiple
          className="hidden"
          aria-label="Upload asset files"
          onChange={(e) => void upload([...(e.target.files ?? [])])}
        />
        <Button type="button" size="sm" onClick={pick}>
          <Upload aria-hidden="true" />
          {openFolder ? `Upload to “${openFolder.name}”` : 'Upload'}
        </Button>
      </PageHeader>

      <div className="grid gap-6 md:grid-cols-[13rem_minmax(0,1fr)]">
        <AssetFolderTree
          folders={folders}
          value={folder}
          onChange={changeFolder}
          onCreate={createFolder}
          onRename={renameFolder}
          onDelete={deleteFolder}
        />

        {/* The drop target. Picking files with Upload is the keyboard's way to the same place. */}
        <section
          aria-label="Asset library"
          onDragOver={onDragOver}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
          }}
          onDrop={onDrop}
          className={cn(
            'min-w-0 space-y-4 rounded-2xl transition-[box-shadow]',
            dragging && 'ring-2 ring-ring/50 ring-offset-4 ring-offset-background',
          )}
        >
          <AssetFilterBar
            value={filters}
            onChange={changeFilters}
            tags={tags}
            view={view}
            onViewChange={setView}
          />
          {dragging && (
            <p className="caption" aria-live="polite">
              Drop files to upload {openFolder ? `to “${openFolder.name}”` : 'here'}
            </p>
          )}
          <AssetUploadList items={uploads} onDismiss={() => setUploads([])} />
          {bulkFailures && (
            <Alert variant="destructive">
              <AlertTitle>
                {bulkFailures.items.length} {bulkFailures.items.length === 1 ? 'asset' : 'assets'}{' '}
                not {bulkFailures.verb.toLowerCase()}
              </AlertTitle>
              <AlertDescription>
                <p>They are still selected, to try again.</p>
                <ul className="space-y-0.5">
                  {bulkFailures.items.map((f, i) => (
                    <li key={i}>
                      <span className="font-medium">{f.name}</span>
                      {f.error ? `: ${f.error}` : ''}
                    </li>
                  ))}
                </ul>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-2"
                  onClick={() => setBulkFailures(null)}
                >
                  Dismiss
                </Button>
              </AlertDescription>
            </Alert>
          )}
          {inUse && (
            <AssetInUseNotice
              name={assetName(inUse.asset, locale)}
              usage={inUse.usage}
              total={inUse.total}
              onArchive={
                inUse.asset.status === 'archived'
                  ? undefined
                  : () => {
                      archive(inUse.asset);
                      setInUse(null);
                    }
              }
              onDismiss={() => setInUse(null)}
            />
          )}
          <AssetBulkBar
            count={selected.size}
            folders={folders}
            busy={bulkBusy}
            onMove={(f) => void moveSelected(f)}
            onPublish={() => void bulk('Published', (id) => client.publishAsset(id))}
            onArchive={() => void bulk('Archived', (id) => client.archiveAsset(id))}
            onClear={() => {
              setSelected(new Set());
              setBulkFailures(null);
            }}
          />
          {pages.isPending ? (
            <>
              <LoadingStatus>Loading assets…</LoadingStatus>
              {view === 'grid' ? grid : list}
            </>
          ) : pages.isError && assets.length === 0 ? (
            // A failed load is said as one, never as an empty library.
            <Alert variant="destructive">
              <AlertTitle>The assets didn’t load</AlertTitle>
              <AlertDescription>
                <p>{message(pages.error)}</p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-2"
                  onClick={() => void pages.refetch()}
                >
                  Retry
                </Button>
              </AlertDescription>
            </Alert>
          ) : assets.length === 0 ? (
            filtered ? (
              <EmptyState
                icon={ImageIcon}
                title="Nothing here"
                description="No assets match this folder and these filters. Drop files here to add some."
              />
            ) : (
              <EmptyState
                icon={ImageIcon}
                title="No assets yet"
                description="Upload or drop images, video and files to start your library."
              >
                <Button type="button" onClick={pick}>
                  Upload
                </Button>
              </EmptyState>
            )
          ) : (
            <Refreshing busy={pages.isPlaceholderData}>{view === 'grid' ? grid : list}</Refreshing>
          )}
          {pages.hasNextPage && (
            <div className="flex justify-center">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={pages.isFetchingNextPage}
                aria-busy={pages.isFetchingNextPage || undefined}
                onClick={() => void pages.fetchNextPage()}
              >
                Load more
              </Button>
              {pages.isFetchingNextPage ? (
                <LoadingStatus>Loading more assets…</LoadingStatus>
              ) : null}
            </div>
          )}
        </section>
      </div>

      <AssetDetailSheet
        asset={open}
        locale={locale}
        open={open !== null}
        onOpenChange={(o) => !o && setOpen(null)}
        onSaved={() => void reload()}
        onAssetChange={(next) => {
          setOpen(next);
          void reload();
        }}
      />
    </div>
  );
}

/** Name lengths for skeleton cards and rows, so a run of them reads as different file names. */
const NAME_WIDTHS = ['72%', '54%', '86%', '61%', '47%', '78%'];

/** A board card still on its way: the real card's padding, preview, name line and footer. */
function AssetCardSkeleton({ index }: { index: number }) {
  return (
    <Card size="sm" className="relative w-full gap-2 p-2">
      <Skeleton className="h-28 w-full" />
      <span className="font-medium text-sm">
        <SkeletonText width={NAME_WIDTHS[index % NAME_WIDTHS.length]} />
      </span>
      <div className="flex flex-wrap items-center justify-between gap-1">
        <SkeletonPill className={index % 3 === 2 ? 'w-[5.5rem]' : 'w-[4.5rem]'} />
        <AssetActionsSkeleton />
      </div>
    </Card>
  );
}

/** A list row still on its way, laid out by the real row's classes (it stacks the same). */
function AssetRowSkeleton({
  index,
  rowClassName,
  cellClassName,
}: {
  index: number;
  rowClassName: string;
  cellClassName: string;
}) {
  return (
    <Tr aria-hidden="true" className={rowClassName}>
      <Td className={`${cellClassName} max-md:row-span-2 max-md:self-start`}>
        <Skeleton className="size-4 rounded-[4px]" />
      </Td>
      <Td className={`${cellClassName} max-md:col-span-2`}>
        <div className="flex min-w-0 items-center gap-2">
          <Skeleton className="size-8 shrink-0 rounded-lg" />
          <SkeletonText className="font-medium" width={NAME_WIDTHS[index % NAME_WIDTHS.length]} />
        </div>
      </Td>
      <Td className={`text-xs ${cellClassName} max-md:col-start-2`}>
        <SkeletonText width="6.5rem" />
      </Td>
      <Td numeric className={`text-xs ${cellClassName} max-md:text-left`}>
        <SkeletonText width="3rem" className="items-end max-md:items-start" />
      </Td>
      <Td className={`${cellClassName} max-md:col-start-2`}>
        <SkeletonPill className="w-[4.5rem]" />
      </Td>
      <Td className={`text-right ${cellClassName}`}>
        <AssetActionsSkeleton className="ml-auto" />
      </Td>
    </Tr>
  );
}

/** The ghost actions (Publish or Unpublish, Archive, Delete) as they sit at rest: a label, two icons. */
function AssetActionsSkeleton({ className }: { className?: string }) {
  return (
    <span className={cn('flex h-6 w-[8.25rem] items-center gap-2.5 px-2.5 text-xs', className)}>
      <SkeletonText width="3.5rem" className="w-auto" />
      <Skeleton className="size-3 rounded-[3px]" />
      <Skeleton className="size-3 rounded-[3px]" />
    </span>
  );
}
