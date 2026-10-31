import type { EntryFields } from '@contentworker/domain';
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
import { Badge } from '@contentworker/ui/badge';
import { Button } from '@contentworker/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@contentworker/ui/dropdown-menu';
import { Skeleton } from '@contentworker/ui/skeleton';
import { useQueryClient } from '@tanstack/react-query';
import { Ellipsis, FileText, Link2, PenLine } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useBlocker, useNavigate, useParams, useSearchParams } from 'react-router';
import { AiAssistPanel } from '~/cms/components/AiAssistPanel';
import { CollaborationPanel } from '~/cms/components/CollaborationPanel';
import { CollapsibleCard } from '~/cms/components/CollapsibleCard';
import { EntryMetadataPanel } from '~/cms/components/EntryMetadataPanel';
import { ExtensionFrame } from '~/cms/components/ExtensionFrame';
import { ReferencedBy } from '~/cms/components/ReferencedBy';
import { SemanticPanel } from '~/cms/components/SemanticPanel';
import { StatusBadge, ToneBadge } from '~/cms/components/status';
import { VersionHistory } from '~/cms/components/VersionHistory';
import { CanvasDialog } from '../components/CanvasDialog';
import type { Pickers, PickOption } from '../components/EntryForm';
import { EntryForm } from '../components/EntryForm';
import { GenerateEntryDialog } from '../components/GenerateEntryDialog';
import { useClient } from '../lib/client-context';
import type { EntryAggregate, FieldChange, ModelTier } from '../lib/management';
import {
  useAllEntriesQuery,
  useAppExtensionsQuery,
  useAssetsQuery,
  useEntryQuery,
  useQueryKeys,
} from '../lib/queries';
import { useToast } from '../lib/toast';
import { useContentOutlet } from './content-context';

const FORM_ID = 'entry-form';

const submitForm = () =>
  (document.getElementById(FORM_ID) as HTMLFormElement | null)?.requestSubmit();

/**
 * Create (/content/:typeId/new) or edit (/content/:typeId/:entryId) one entry.
 *
 * The editor is a place you stay: saving keeps you here (a new entry navigates
 * to its edit URL), the header always shows status/version/unsaved state, and
 * Publish lives next to Save — with unsaved edits it saves first, then asks for
 * confirmation with a changed-fields summary.
 */
export function EntryEditor() {
  const { typeId, entryId } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { client, conn, busy, run } = useClient();
  const { types, locales, defaultLocale, fallbacks } = useContentOutlet();
  const queryClient = useQueryClient();
  const keys = useQueryKeys();

  // An inline-edit deep link from a previewed page: which field it came from,
  // and which space it was rendered against.
  const linkedField = searchParams.get('field');
  const linkedSpace = searchParams.get('space');
  const linkedEnv = searchParams.get('env');
  const wrongScope =
    (linkedSpace && linkedSpace !== conn.space) || (linkedEnv && linkedEnv !== conn.environment);

  const isEdit = Boolean(entryId);
  const selectedType = types.find((t) => t.apiId === typeId);
  const backTo = `/content/${typeId}`;

  // AI generation/canvas/assist results are merged into the live form via a
  // sequenced patch — the form never remounts for them, so other unsaved edits
  // survive. Bound to the entry they were generated for and reset in-render on
  // navigation (e.g. via a "referenced by" link), so they never leak.
  const [patchState, setPatchState] = useState<{
    target: string;
    patch: { seq: number; fields: EntryFields } | null;
  }>({ target: `${typeId}:${entryId ?? 'new'}`, patch: null });
  // Freshest aggregate we hold (from save/publish responses); backs the
  // publish confirmation's changed-fields diff.
  const [lastAggregate, setLastAggregate] = useState<EntryAggregate | null>(null);
  const [publishConfirm, setPublishConfirm] = useState<{ changes: FieldChange[] | null } | null>(
    null,
  );
  if (patchState.target !== `${typeId}:${entryId ?? 'new'}`) {
    setPatchState({ target: `${typeId}:${entryId ?? 'new'}`, patch: null });
    setLastAggregate(null);
    setPublishConfirm(null);
  }
  const applyPatch = (fields: EntryFields) =>
    setPatchState((s) => ({ ...s, patch: { seq: (s.patch?.seq ?? 0) + 1, fields } }));
  const [genOpen, setGenOpen] = useState(false);
  const [canvasOpen, setCanvasOpen] = useState(false);
  // Bumped after a restore to re-seed the form (EntryForm reads `initial` once).
  const [formKey, setFormKey] = useState(0);

  // Unsaved-edit tracking: guards in-app navigation and tab close. The
  // generation counter lets `save` detect edits typed WHILE the request was in
  // flight — those must survive the post-save markDirty(false).
  const dirtyRef = useRef(false);
  const dirtyGen = useRef(0);
  const [dirty, setDirty] = useState(false);
  const markDirty = (d: boolean) => {
    if (d) dirtyGen.current += 1;
    dirtyRef.current = d;
    setDirty(d);
  };
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirtyRef.current && currentLocation.pathname !== nextLocation.pathname,
  );
  const blockerProceededRef = useRef(false);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  // The existing draft (edit mode) seeds the form's initial values.
  const entryQuery = useEntryQuery(isEdit ? entryId : undefined);
  const meta = entryQuery.data
    ? { version: entryQuery.data.version, status: entryQuery.data.status }
    : null;
  const baseFields = isEdit ? ((entryQuery.data?.fields as EntryFields) ?? null) : {};
  const initial: EntryFields | null = baseFields;

  // A failed load already toasts via the query cache; leave the broken editor.
  useEffect(() => {
    if (entryQuery.isError) navigate(backTo);
  }, [entryQuery.isError, navigate, backTo]);

  // Header + tab title: the entry's display-field value when it has one.
  const displayTitle = useMemo(() => {
    const df = selectedType?.displayField;
    const v = df
      ? (baseFields?.[df] as Record<string, unknown> | undefined)?.[defaultLocale]
      : undefined;
    return typeof v === 'string' && v.trim() ? v : null;
  }, [selectedType, baseFields, defaultLocale]);
  const pageTitle =
    displayTitle ??
    (selectedType ? `${isEdit ? 'Edit' : 'New'} ${selectedType.name}` : 'Entry editor');
  useEffect(() => {
    const prev = document.title;
    document.title = `${pageTitle} · contentworker admin`;
    return () => {
      document.title = prev;
    };
  }, [pageTitle]);

  // Build reference/asset picker options (all entries + all assets) for Link
  // fields. Both queries are best-effort; the form still works without them.
  const allEntriesQuery = useAllEntriesQuery();
  const assetsQuery = useAssetsQuery();
  /**
   * Resolves reference matches on the server.
   *
   * The seeded `pickers.entries` list is capped by the list endpoint, so
   * filtering it cannot reach an entry beyond that page — not slowly, at all.
   * One request per content type the field allows, because a reference field
   * restricted to two types should not search the rest of the space.
   */
  const searchEntries = useCallback(
    async (query: string, contentTypes?: readonly string[]): Promise<PickOption[]> => {
      const targets = contentTypes?.length ? contentTypes : [undefined];
      const batches = await Promise.all(
        targets.map((contentType) =>
          client.suggestEntries({ q: query, ...(contentType ? { contentType } : {}) }),
        ),
      );
      return batches.flat().map((hit) => ({
        id: hit.id,
        contentType: hit.contentType,
        label: `${hit.title} (${hit.contentType})`,
      }));
    },
    [client],
  );

  const pickers: Pickers = useMemo(() => {
    const displayFieldOf = new Map(types.map((t) => [t.apiId, t.displayField]));
    return {
      entries: (allEntriesQuery.data ?? []).map((e) => {
        const df = displayFieldOf.get(e.contentType);
        const title = df
          ? (e.fields[df] as Record<string, unknown> | undefined)?.[conn.locale]
          : undefined;
        return {
          id: e.id,
          contentType: e.contentType,
          label: `${String(title ?? e.id)} (${e.contentType})`,
        };
      }),
      assets: (assetsQuery.data ?? []).map((a) => ({
        id: a.id,
        label: String(a.title?.[conn.locale] ?? a.file.fileName),
      })),
    };
  }, [allEntriesQuery.data, assetsQuery.data, types, conn.locale]);

  // Installed UI extensions (sidebar widgets + custom field editors); optional.
  const extensionsQuery = useAppExtensionsQuery();
  const extensions = useMemo(
    () => (extensionsQuery.data ?? []).filter((e) => e.active),
    [extensionsQuery.data],
  );

  // Re-seed the form from the server after a restore (server state changed).
  const reseedFromServer = async () => {
    if (entryId) await queryClient.invalidateQueries({ queryKey: keys.entry(entryId) });
    markDirty(false);
    // The aggregate predates the restore; a publish diff based on it would
    // compare the wrong versions.
    setLastAggregate(null);
    setFormKey((k) => k + 1);
  };

  // ⌘S / Ctrl+S saves the draft (validation still runs via the form submit).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        submitForm();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Builds the publish confirmation, diffing published → current when we know
  // the published version (fresh save/publish response). No `run` here: callers
  // wrap it, and `run` doesn't nest.
  const computePublishConfirm = async (agg: EntryAggregate | null) => {
    if (!entryId) return;
    let changes: FieldChange[] | null = null;
    if (agg && agg.publishedVersion != null) {
      const diff = await client.diffVersions(entryId, agg.publishedVersion, agg.currentVersion);
      changes = diff.changes.filter((c) => c.kind !== 'unchanged');
    }
    setPublishConfirm({ changes });
  };

  // Set just before a Publish-triggered form submit; consumed synchronously by
  // `save` (requestSubmit dispatches inline), then cleared either way so a
  // failed validation can't leak the flag into a later plain save.
  const publishAfterSaveRef = useRef(false);

  const save = (fields: EntryFields) => {
    const chainPublish = publishAfterSaveRef.current;
    publishAfterSaveRef.current = false;
    return run(async () => {
      if (!selectedType) return;
      const genAtSubmit = dirtyGen.current;
      const view =
        isEdit && entryId
          ? await client.updateEntry(entryId, fields)
          : await client.createEntry(selectedType.apiId, fields);
      setLastAggregate(view.entry);
      // Edit mode: only clear dirty if nothing was typed while the request was
      // in flight — those keystrokes are NOT in the saved payload. Create mode
      // clears unconditionally: the URL swap below remounts the form from the
      // server state, and blocking our own navigation would trap the user.
      if (!isEdit || dirtyGen.current === genAtSubmit) markDirty(false);
      if (entryId) void queryClient.invalidateQueries({ queryKey: keys.entry(entryId) });
      void queryClient.invalidateQueries({ queryKey: keys.entriesRoot });
      if (!isEdit) {
        // Stay in the editor: swap /new for the created entry's edit URL. The
        // swap remounts the form from the server state, and route loaders make
        // it asynchronous — so announce success only once it has landed, or
        // keystrokes made after the toast would be wiped by the remount.
        await navigate(`/content/${typeId}/${view.entry.id}`, { replace: true });
        toast.success('Entry created');
        return;
      }
      toast.success('Draft updated');
      if (chainPublish) await computePublishConfirm(view.entry);
    });
  };

  const requestPublish = () => {
    if (!entryId) return;
    if (dirtyRef.current) {
      // Save first, then confirm publish — one decisive action. If validation
      // fails, the submit never reaches `save` and the flag is cleared below.
      publishAfterSaveRef.current = true;
      submitForm();
      publishAfterSaveRef.current = false;
      return;
    }
    void run(() => computePublishConfirm(lastAggregate?.id === entryId ? lastAggregate : null));
  };

  const confirmPublish = () =>
    run(async () => {
      if (!entryId) return;
      const agg = await client.publishEntry(entryId);
      setLastAggregate(agg);
      void queryClient.invalidateQueries({ queryKey: keys.entry(entryId) });
      void queryClient.invalidateQueries({ queryKey: keys.entriesRoot });
      toast.success(`Published v${agg.publishedVersion ?? agg.currentVersion}`);
      setPublishConfirm(null);
    });

  const copyPreviewLink = () => {
    if (!entryId) return;
    void run(async () => {
      const link = await client.createPreviewLink(entryId, {
        previewBaseUrl: window.location.origin,
      });
      await navigator.clipboard.writeText(link.url);
      toast.success(`Preview link copied (expires ${new Date(link.expiresAt).toLocaleString()})`);
    });
  };

  if (!selectedType) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 max-w-2xl" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* The record-page header: the title wraps (never truncates); the facts and the
          actions wrap below it as groups. Below md the secondary actions fold into a ⋯ menu. */}
      <div className="flex flex-wrap items-end justify-between gap-3 pt-3 sm:pt-5">
        <div className="min-w-0">
          <h1 className="break-words font-semibold text-[1.75rem] leading-tight tracking-title">
            {pageTitle}
          </h1>
          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-muted-foreground text-sm">
            {meta && <StatusBadge status={meta.status} />}
            {meta && <span className="font-mono text-xs">v{meta.version}</span>}
            {dirty ? (
              <ToneBadge tone="wait" label="Unsaved changes" />
            ) : (
              isEdit && meta && <span>All changes saved</span>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="hidden md:contents">
            <Button type="button" variant="outline" size="sm" onClick={() => setCanvasOpen(true)}>
              <PenLine className="size-4" /> Draft from prose
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => setGenOpen(true)}>
              <FileText className="size-4" /> Generate with AI
            </Button>
            {isEdit && entryId && (
              <Button type="button" variant="ghost" size="sm" onClick={copyPreviewLink}>
                <Link2 className="size-4" /> Copy preview link
              </Button>
            )}
          </span>
          <Button type="submit" size="sm" form={FORM_ID} disabled={busy || initial === null}>
            Save draft
          </Button>
          {isEdit && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              // A published entry with UNSAVED edits can still publish: the
              // click saves first (status becomes "changed"), then confirms.
              disabled={busy || (meta?.status === 'published' && !dirty)}
              onClick={requestPublish}
            >
              {meta?.status === 'published' && !dirty ? 'Published' : 'Publish'}
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="md:hidden"
                aria-label="More entry actions"
              >
                <Ellipsis aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuItem onSelect={() => setCanvasOpen(true)}>
                <PenLine /> Draft from prose
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setGenOpen(true)}>
                <FileText /> Generate with AI
              </DropdownMenuItem>
              {isEdit && entryId && (
                <DropdownMenuItem onSelect={() => void copyPreviewLink()}>
                  <Link2 /> Copy preview link
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {wrongScope && (
        // Said rather than silently followed: the id in the link belongs to a
        // different space, so loading it here either 404s or — worse, if the id
        // happens to exist in both — opens the wrong entry looking right.
        <p role="alert" className="rounded-lg border border-wait/40 bg-wait/10 px-3 py-2 text-sm">
          This link was made against space <strong>{linkedSpace ?? conn.space}</strong> /{' '}
          <strong>{linkedEnv ?? conn.environment}</strong>, but you are connected to{' '}
          <strong>{conn.space}</strong> / <strong>{conn.environment}</strong>. Switch connection to
          open what the link points at.
        </p>
      )}

      <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
        <div className="min-w-0 flex-1">
          {initial === null ? (
            <div className="max-w-2xl space-y-3">
              <Skeleton className="h-8 w-1/3" />
              <Skeleton className="h-24" />
              <Skeleton className="h-24" />
            </div>
          ) : (
            <EntryForm
              key={`${typeId}:${entryId ?? 'new'}:${formKey}`}
              formId={FORM_ID}
              hideActions
              contentType={selectedType}
              initial={initial}
              locales={locales}
              defaultLocale={defaultLocale}
              fallbacks={fallbacks}
              pickers={pickers}
              onSearchEntries={searchEntries}
              fieldEditors={extensions.filter((e) => e.target === 'field-editor')}
              focusField={
                linkedField
                  ? { apiId: linkedField, locale: searchParams.get('locale') ?? undefined }
                  : undefined
              }
              entryContext={{
                spaceId: conn.space,
                environmentId: conn.environment,
                entryId,
                contentType: selectedType.apiId,
              }}
              busy={busy}
              onDirtyChange={markDirty}
              onValidationFailed={(count) => {
                // Called synchronously from the submit; the publish flag is
                // still set when this was a Publish-triggered save.
                const goal = publishAfterSaveRef.current ? 'publish' : 'save';
                toast.error(`Fix ${count} field ${count === 1 ? 'error' : 'errors'} to ${goal}`);
              }}
              mergePatch={patchState.patch}
              onSave={save}
              onCancel={() => navigate(backTo)}
            />
          )}
        </div>

        {/* Panels are keyed by entry so proposal/draft/diff state can never
            survive an entry-to-entry navigation and act on the wrong entry.
            Each key is prefixed with the panel's own name because keys must be
            unique *among siblings*: four panels all keyed `entryId` let React
            match one panel's state to another's element, which is the very
            thing the keying is here to prevent. */}
        {isEdit && entryId && (
          <aside className="w-full shrink-0 space-y-4 lg:w-[360px] xl:w-[380px]">
            {/* Editor work first; AI assist sits last and starts collapsed. */}
            <CollaborationPanel key={`collab:${entryId}`} entryId={entryId} />
            <EntryMetadataPanel key={`metadata:${entryId}`} entryId={entryId} />
            {meta && (
              <VersionHistory
                key={`versions:${entryId}`}
                entryId={entryId}
                currentVersion={meta.version}
                publishedVersion={
                  lastAggregate?.id === entryId
                    ? lastAggregate.publishedVersion
                    : meta.status === 'published'
                      ? meta.version
                      : null
                }
                hasUnsavedChanges={() => dirtyRef.current}
                onRestored={() => void reseedFromServer()}
              />
            )}
            <ReferencedBy id={entryId} types={types} />
            <SemanticPanel entryId={entryId} entries={pickers.entries} />
            {extensions
              .filter((e) => e.target === 'sidebar')
              .map((ext) => (
                <CollapsibleCard key={ext.id} defaultOpen title={ext.name}>
                  <ExtensionFrame
                    extension={ext}
                    context={{
                      target: 'sidebar',
                      spaceId: conn.space,
                      environmentId: conn.environment,
                      entryId,
                      contentType: selectedType.apiId,
                    }}
                  />
                </CollapsibleCard>
              ))}
            <AiAssistPanel
              key={`assist:${entryId}`}
              entryId={entryId}
              contentType={selectedType}
              locales={locales}
              defaultLocale={defaultLocale}
              onMergeFields={applyPatch}
            />
          </aside>
        )}
      </div>

      <AlertDialog
        open={blocker.state === 'blocked'}
        onOpenChange={(open) => {
          // Radix fires onOpenChange(false) after the action's onClick; if the
          // user chose to proceed, don't follow up with a reset().
          if (!open && blocker.state === 'blocked' && !blockerProceededRef.current) {
            blocker.reset();
          }
          if (open) blockerProceededRef.current = false;
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle>
            <AlertDialogDescription>
              This entry has edits that haven’t been saved. Leaving now will discard them.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => blocker.state === 'blocked' && blocker.reset()}>
              Keep editing
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (blocker.state !== 'blocked') return;
                blockerProceededRef.current = true;
                markDirty(false);
                blocker.proceed();
              }}
            >
              Discard changes
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={publishConfirm !== null}
        onOpenChange={(open) => {
          if (!open) setPublishConfirm(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Publish “{pageTitle}”?</AlertDialogTitle>
            <AlertDialogDescription>
              {publishConfirm?.changes
                ? publishConfirm.changes.length === 0
                  ? 'The draft matches the published version; publishing re-confirms it.'
                  : `${publishConfirm.changes.length} ${
                      publishConfirm.changes.length === 1 ? 'field goes' : 'fields go'
                    } live:`
                : meta?.status === 'draft'
                  ? 'This entry hasn’t been published before, so the whole entry goes live.'
                  : 'Everything changed since the last publish goes live.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {publishConfirm?.changes && publishConfirm.changes.length > 0 && (
            <ul className="max-h-48 space-y-1 overflow-y-auto text-sm">
              {publishConfirm.changes.map((c) => (
                <li key={c.field} className="flex items-center gap-2">
                  <span className="font-medium">
                    {selectedType.fields.find((f) => f.apiId === c.field)?.name ?? c.field}
                  </span>
                  <Badge variant="outline" className="capitalize">
                    {c.kind}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Keep as draft</AlertDialogCancel>
            <AlertDialogAction disabled={busy} onClick={() => void confirmPublish()}>
              Publish entry
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <GenerateEntryDialog
        open={genOpen}
        onOpenChange={setGenOpen}
        contentType={selectedType}
        onGenerate={generate}
        onApply={(fields) => {
          applyPatch(fields);
          toast.success('Applied the draft to the form. Save to keep it');
        }}
      />
      <CanvasDialog
        open={canvasOpen}
        onOpenChange={setCanvasOpen}
        contentTypeName={selectedType.name}
        onMap={mapCanvas}
      />
    </div>
  );

  // Generate field values from a prompt. Returns the draft for the dialog to
  // show as a proposal; the form only changes on its Apply (throws on error so
  // the dialog can surface it; not wrapped in `run`).
  async function generate(prompt: string, tier: ModelTier) {
    if (!selectedType) throw new Error('Content type not loaded');
    return client.generateEntry({ contentTypeApiId: selectedType.apiId, prompt, tier });
  }

  // Canvas: map free-form prose into the form's fields (throws so the dialog can
  // surface the error; not wrapped in `run`).
  async function mapCanvas(prose: string, tier: ModelTier) {
    if (!selectedType) return;
    const res = await client.canvasEntry({ contentTypeApiId: selectedType.apiId, prose, tier });
    applyPatch(res.fields);
    const total = res.usage.inputTokens + res.usage.outputTokens;
    toast.success(`Mapped ${Object.keys(res.fields).length} field(s) · ${total} tokens`);
  }
}
