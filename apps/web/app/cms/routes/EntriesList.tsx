import { Alert, AlertDescription, AlertTitle } from '@contentworker/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@contentworker/ui/alert-dialog';
import { Button } from '@contentworker/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@contentworker/ui/sheet';
import { Skeleton } from '@contentworker/ui/skeleton';
import { useQueryClient } from '@tanstack/react-query';
import { FileText } from 'lucide-react';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { EntryFilterBar } from '~/cms/components/EntryFilterBar';
import { Empty, EmptyState, PageHeader } from '~/cms/components/page';
import { EntryDiff } from '../components/EntryDiff';
import { EntriesTable, type EntryRowActions } from '../components/entries/EntriesTable';
import { useClient } from '../lib/client-context';
import type { EntryListQuery, PreviewEntry } from '../lib/management';
import { useDebouncedValue, useEntriesQuery, useQueryKeys } from '../lib/queries';
import { type ToastOptions, useToast } from '../lib/toast';
import { useContentOutlet } from './content-context';

/** Entries table for one content type, with bulk publishing and a draft/published diff. */
export function EntriesList() {
  const { typeId } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { client, conn, busy, run } = useClient();
  const { types } = useContentOutlet();
  const queryClient = useQueryClient();
  const keys = useQueryKeys();

  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [diffEntry, setDiffEntry] = useState<PreviewEntry | null>(null);
  // Permanent deletion is the one entry action with no way back, so it is
  // always confirmed by name.
  const [confirmPurge, setConfirmPurge] = useState<PreviewEntry | null>(null);
  // Bulk action awaiting confirmation (bulk selections are tedious to rebuild,
  // so the whole batch is confirmed once before it runs).
  const [confirmBulk, setConfirmBulk] = useState<'publish' | 'unpublish' | null>(null);
  // Per-item failures from the last bulk action, with resolved titles so the
  // editor knows WHICH entries failed, not just how many.
  const [bulkFailures, setBulkFailures] = useState<
    { id: string; title: string; error?: string }[] | null
  >(null);
  // Filter state is bound to the type it was authored for and reset in-render
  // when the type changes, so a stale filter (naming another type's fields)
  // can never be combined with the new type's query key — not even for the
  // 250ms the debounce would otherwise lag.
  const [filterState, setFilterState] = useState<{
    typeId: string | undefined;
    query: EntryListQuery;
  }>({ typeId, query: {} });
  if (filterState.typeId !== typeId) {
    setFilterState({ typeId, query: {} });
    setPicked(new Set());
    setDiffEntry(null);
    setConfirmPurge(null);
    setConfirmBulk(null);
    setBulkFailures(null);
  }
  const query = filterState.typeId === typeId ? filterState.query : {};
  const setQuery = (q: EntryListQuery) => setFilterState({ typeId, query: q });

  const selectedType = types.find((t) => t.apiId === typeId);

  // The list is keyed by type + debounced filters; edits to the filter bar
  // re-key the query after 250ms while the previous page stays visible.
  const debounced = useDebouncedValue(filterState, 250);
  const debouncedQuery = debounced.typeId === typeId ? debounced.query : {};
  const entriesQuery = useEntriesQuery(typeId, debouncedQuery);
  const entries = entriesQuery.data ?? [];
  const loading = entriesQuery.isPending;
  const entriesKey = keys.entries(typeId, debouncedQuery);

  const togglePick = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Optimistically reflect a status change in the cached list; roll back on failure.
  const optimisticStatus = (ids: Set<string>, status: string) =>
    queryClient.setQueryData<PreviewEntry[]>(entriesKey, (es) =>
      es?.map((e) => (ids.has(e.id) ? { ...e, status } : e)),
    );

  const refreshEntries = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: keys.entriesRoot }),
      // Publish/unpublish change an entry's status/version, which the editor's
      // detail query also holds.
      queryClient.invalidateQueries({ queryKey: keys.entryRoot }),
    ]);

  // Shared mutation shell: cancel in-flight list refetches so they can't stomp
  // the optimistic write, skip the optimistic write entirely while the table
  // shows placeholder rows from another key, and always revalidate — success
  // or failure — so the cache never keeps a rolled-back or half-applied list.
  const mutateEntries = (act: () => Promise<void>) =>
    run(async () => {
      await queryClient.cancelQueries({ queryKey: keys.entriesRoot });
      try {
        await act();
      } finally {
        await refreshEntries();
      }
    });

  const viewingTrash = query.trashed === true;
  const setViewingTrash = (trashed: boolean) => {
    setPicked(new Set());
    setDiffEntry(null);
    setQuery({ ...query, trashed: trashed || undefined });
  };

  // Trashing a live entry also unpublishes it (server-side, one transaction),
  // so Undo restores it and, only when the live version was exactly the
  // current draft, republishes it. A "changed" entry's old live version is
  // gone, and republishing would ship the unreviewed draft, so it comes back
  // as a draft and the toast says so.
  const trash = (e: PreviewEntry) =>
    mutateEntries(async () => {
      const title = titleOf(e.id);
      await client.trashEntry(e.id);
      toast.success(
        e.status === 'draft'
          ? `“${title}” moved to the trash`
          : `“${title}” unpublished and moved to the trash`,
        { action: { label: 'Undo', onAction: () => void undoTrash(e, title) } },
      );
    });
  const undoTrash = (e: PreviewEntry, title: string) =>
    mutateEntries(async () => {
      await client.restoreEntry(e.id);
      if (e.status === 'published') {
        await client.publishEntry(e.id);
        toast.success(`“${title}” restored and live again`);
      } else if (e.status === 'changed') {
        toast.success(`“${title}” restored as a draft; publish it to put it back live`);
      } else {
        toast.success(`“${title}” restored`);
      }
    });
  // Undo for an unpublish is a republish, which is a true inverse only for an
  // entry whose draft matched the live version (status "published").
  const undoUnpublish = (ids: readonly string[], label: string) =>
    mutateEntries(async () => {
      if (ids.length === 1) {
        await client.publishEntry(ids[0] ?? '');
      } else {
        const r = await client.bulkEntryAction('publish', [...ids]);
        if (r.failed > 0) {
          toast.error(`Republished ${r.succeeded}; ${r.failed} failed`);
          return;
        }
      }
      toast.success(label);
    });
  const restore = (e: PreviewEntry) =>
    mutateEntries(async () => {
      await client.restoreEntry(e.id);
      toast.success(`“${titleOf(e.id)}” restored as a draft`);
    });
  const purge = (e: PreviewEntry) =>
    mutateEntries(async () => {
      await client.purgeEntry(e.id);
      toast.success('Entry permanently deleted');
    });
  const duplicate = (e: PreviewEntry) =>
    mutateEntries(async () => {
      const { entry } = await client.duplicateEntry(e.id);
      toast.success('Entry duplicated');
      navigate(`/content/${selectedType?.apiId}/${entry.id}`);
    });

  const titleOf = (id: string) => {
    const entry = entries.find((e) => e.id === id);
    const value = selectedType
      ? (entry?.fields[selectedType.displayField] as Record<string, unknown> | undefined)?.[
          conn.locale
        ]
      : undefined;
    return typeof value === 'string' && value ? value : id;
  };

  // One bulk API call handles the whole selection server-side, reporting
  // per-item outcomes; partial failures are surfaced by entry, not as a count.
  const bulk = (action: 'publish' | 'unpublish', verb: string, status: string) => {
    const ids = [...picked];
    setPicked(new Set());
    setBulkFailures(null);
    return mutateEntries(async () => {
      const optimistic = !entriesQuery.isPlaceholderData;
      const snapshot = entries;
      if (optimistic) optimisticStatus(new Set(ids), status);
      let summary: Awaited<ReturnType<typeof client.bulkEntryAction>>;
      try {
        summary = await client.bulkEntryAction(action, ids);
      } catch (e) {
        if (optimistic) queryClient.setQueryData(entriesKey, snapshot);
        throw e;
      }
      if (summary.failed > 0) {
        setBulkFailures(
          summary.results
            .filter((r) => !r.ok)
            .map((r) => ({ id: r.id, title: titleOf(r.id), error: r.error })),
        );
        toast.error(`${verb} ${summary.succeeded}; ${summary.failed} failed (details in the list)`);
      } else {
        const done = summary.results.filter((r) => r.ok).map((r) => r.id);
        const wasLive = new Set(snapshot.filter((e) => e.status === 'published').map((e) => e.id));
        const undoable =
          action === 'unpublish' && done.length > 0 && done.every((id) => wasLive.has(id));
        toast.success(
          `${verb} ${summary.succeeded} ${summary.succeeded === 1 ? 'entry' : 'entries'}`,
          undoable
            ? {
                action: {
                  label: 'Undo',
                  onAction: () =>
                    void undoUnpublish(
                      done,
                      `Republished ${done.length} ${done.length === 1 ? 'entry' : 'entries'}`,
                    ),
                },
              }
            : undefined,
        );
      }
    });
  };

  const setStatus = (
    id: string,
    status: string,
    act: (id: string) => Promise<unknown>,
    msg: string,
    toastOptions?: ToastOptions,
  ) =>
    mutateEntries(async () => {
      const optimistic = !entriesQuery.isPlaceholderData;
      const snapshot = entries;
      if (optimistic) optimisticStatus(new Set([id]), status);
      try {
        await act(id);
      } catch (e) {
        if (optimistic) queryClient.setQueryData(entriesKey, snapshot);
        throw e;
      }
      toast.success(msg, toastOptions);
    });

  // Per-row actions for the table; each calls the same handler the list always
  // used, so optimistic status, Undo toasts and confirmations are unchanged.
  const rowActions: EntryRowActions = {
    publish: (e) =>
      void setStatus(e.id, 'published', (id) => client.publishEntry(id), 'Entry published'),
    diff: (e) => setDiffEntry(e),
    duplicate: (e) => void duplicate(e),
    unpublish: (e) =>
      void setStatus(
        e.id,
        'draft',
        (id) => client.unpublishEntry(id),
        `“${titleOf(e.id)}” unpublished`,
        // Republishing restores exactly what was live only for a "published"
        // entry; for a changed one it would ship the unreviewed draft. (An edit
        // made during the toast's 10s window would ship with the Undo too — an
        // accepted edge, since the person chose to edit and then undo.)
        e.status === 'published'
          ? {
              action: {
                label: 'Undo',
                onAction: () => void undoUnpublish([e.id], `“${titleOf(e.id)}” is live again`),
              },
            }
          : undefined,
      ),
    // Trashing is recoverable (Undo in the toast), so it needs no confirmation —
    // unlike the permanent delete offered from the trash.
    trash: (e) => void trash(e),
    restore: (e) => void restore(e),
    purge: (e) => setConfirmPurge(e),
  };

  if (!selectedType) {
    return (
      <Empty icon={<FileText />} title="No such content type" className="card mt-6">
        Pick a content type from the list to browse its entries.
      </Empty>
    );
  }

  const count = entries.length;
  const hasQuery = (query.filters?.length ?? 0) > 0 || !!query.search;
  return (
    <div className="space-y-4">
      <PageHeader
        title={viewingTrash ? `${selectedType.name} trash` : `${selectedType.name} entries`}
        description={
          loading
            ? undefined
            : viewingTrash
              ? `${count} in the trash — restore, or delete permanently`
              : `${count} ${count === 1 ? 'entry' : 'entries'}`
        }
      >
        {picked.size > 0 && !viewingTrash && (
          <>
            <span className="text-sm text-muted-foreground">{picked.size} selected</span>
            <Button type="button" onClick={() => setConfirmBulk('publish')} disabled={busy}>
              Publish selected
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => setConfirmBulk('unpublish')}
              disabled={busy}
            >
              Unpublish selected
            </Button>
          </>
        )}
        <Button
          type="button"
          variant="ghost"
          onClick={() => setViewingTrash(!viewingTrash)}
          disabled={busy}
        >
          {viewingTrash ? 'Back to entries' : 'View trash'}
        </Button>
        {!viewingTrash && (
          <>
            <Button
              type="button"
              variant="outline"
              onClick={() => navigate(`/content/${selectedType.apiId}/import`)}
              disabled={busy}
            >
              Import
            </Button>
            {/* New entry is the shell's (layout/NewEntry.tsx), which links to this type here. */}
          </>
        )}
      </PageHeader>

      <EntryFilterBar type={selectedType} value={query} onChange={setQuery} />

      {bulkFailures && bulkFailures.length > 0 && (
        <Alert variant="destructive">
          <AlertTitle>
            {bulkFailures.length} {bulkFailures.length === 1 ? 'entry' : 'entries'} failed
          </AlertTitle>
          <AlertDescription>
            <ul className="space-y-0.5">
              {bulkFailures.map((f) => (
                <li key={f.id}>
                  <span className="font-medium">{f.title}</span>
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

      {loading ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : entries.length === 0 && hasQuery ? (
        <EmptyState
          icon={FileText}
          title="No matching entries"
          description="No entries match the current filters. Try loosening or clearing them."
        >
          <Button type="button" variant="outline" onClick={() => setQuery({})} disabled={busy}>
            Clear filters
          </Button>
        </EmptyState>
      ) : entries.length === 0 ? (
        <EmptyState
          icon={FileText}
          title="No entries yet"
          description={`Create the first ${selectedType.name} entry to get started.`}
        >
          <Button
            type="button"
            onClick={() => navigate(`/content/${selectedType.apiId}/new`)}
            disabled={busy}
          >
            Create entry
          </Button>
        </EmptyState>
      ) : (
        <EntriesTable
          type={selectedType}
          entries={entries}
          locale={conn.locale}
          picked={picked}
          busy={busy}
          viewingTrash={viewingTrash}
          hrefFor={(e) => `/content/${selectedType.apiId}/${e.id}`}
          onTogglePick={togglePick}
          onPickAll={(all) => setPicked(all ? new Set(entries.map((e) => e.id)) : new Set())}
          actions={rowActions}
        />
      )}

      <AlertDialog
        open={confirmBulk !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmBulk(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmBulk === 'publish' ? 'Publish' : 'Unpublish'} {picked.size}{' '}
              {picked.size === 1 ? 'entry' : 'entries'}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmBulk === 'publish'
                ? 'The current draft of each selected entry goes live on the delivery API.'
                : 'Each selected entry is removed from the delivery API and returns to draft.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep as is</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={() => {
                const action = confirmBulk;
                setConfirmBulk(null);
                if (action === 'publish') void bulk('publish', 'Published', 'published');
                else if (action === 'unpublish') void bulk('unpublish', 'Unpublished', 'draft');
              }}
            >
              {confirmBulk === 'publish' ? 'Publish entries' : 'Unpublish entries'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Permanent deletion names the entry and says plainly that it cannot be
          undone — it is the only entry action with no way back. */}
      <AlertDialog
        open={confirmPurge !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmPurge(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Permanently delete “{confirmPurge ? titleOf(confirmPurge.id) : ''}”?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This deletes the entry and its entire version history. It can&rsquo;t be undone. If
              other published entries link to it, the delete is refused so their links don&rsquo;t
              break.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep in trash</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={() => {
                const entry = confirmPurge;
                setConfirmPurge(null);
                if (entry) void purge(entry);
              }}
            >
              Delete permanently
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Sheet open={!!diffEntry} onOpenChange={(o) => !o && setDiffEntry(null)}>
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-xl">
          <SheetHeader>
            <SheetTitle>Diff vs published</SheetTitle>
            <SheetDescription>Draft changes since this entry was last published.</SheetDescription>
          </SheetHeader>
          <div className="px-4 pb-4">
            {diffEntry && <EntryDiff client={client} entry={diffEntry} locale={conn.locale} />}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
