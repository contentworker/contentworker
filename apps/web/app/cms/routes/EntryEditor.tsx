import type { EntryFields, FieldDiff } from '@contentworker/domain';
import { topLevelField } from '@contentworker/sdk-core';
import type { Capability } from '@contentworker/sdk-core/live-preview';
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@contentworker/ui/dropdown-menu';
import { cn } from '@contentworker/ui/lib/utils';
import { Segmented, SegmentedItem } from '@contentworker/ui/segmented';
import { Skeleton } from '@contentworker/ui/skeleton';
import { useQueryClient } from '@tanstack/react-query';
import { Ellipsis, FileText, Link2, PenLine } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useBlocker, useNavigate, useParams, useSearchParams } from 'react-router';
import { AiAssistPanel } from '~/cms/components/AiAssistPanel';
import { CollaborationPanel } from '~/cms/components/CollaborationPanel';
import { CollapsibleCard } from '~/cms/components/CollapsibleCard';
import { EntryMetadataPanel } from '~/cms/components/EntryMetadataPanel';
import { EntryPreview } from '~/cms/components/EntryPreview';
import { ExtensionFrame } from '~/cms/components/ExtensionFrame';
import { PaneDivider } from '~/cms/components/pane/PaneDivider';
import { SitePane } from '~/cms/components/pane/SitePane';
import {
  type PaneView,
  paneViews,
  usePaneLayout,
  usePaneView,
} from '~/cms/components/pane/use-pane-layout';
import { ReferencedBy } from '~/cms/components/ReferencedBy';
import { SemanticPanel } from '~/cms/components/SemanticPanel';
import { StatusBadge, ToneBadge } from '~/cms/components/status';
import { VersionHistory } from '~/cms/components/VersionHistory';
import { CanvasDialog } from '../components/CanvasDialog';
import type { FocusRequest } from '../components/EntryForm';
import { EntryForm } from '../components/EntryForm';
import { EntryActivity } from '../components/entries/EntryActivity';
import { EntryAuthorship } from '../components/entries/EntryAuthorship';
import { PublishConfirm } from '../components/entries/PublishConfirm';
import { SaveConflictDialog } from '../components/entries/SaveConflictDialog';
import { GenerateEntryDialog } from '../components/GenerateEntryDialog';
import { orDirect, useAssistantEdit, usePageContext } from '../lib/assistant';
import { canvasAvailable } from '../lib/canvas/model';
import { useClient } from '../lib/client-context';
import { dateTime, toMs } from '../lib/format';
import { capabilitiesFor, SELECT_ONLY } from '../lib/live-preview/host';
import { liveFields } from '../lib/live-preview/ops';
import { focusForRef, refForField } from '../lib/live-preview/pick';
import type { EntryAggregate, EntryView, ModelTier } from '../lib/management';
import { useEntryPickers } from '../lib/pickers';
import { useAppExtensionsQuery, useEntryQuery, useQueryKeys, useScopedQuery } from '../lib/queries';
import { staleSave } from '../lib/stale-save';
import { useToast } from '../lib/toast';
import { useContentOutlet } from './content-context';

/** The side pane's segments, by view. */
const PANE_LABELS: Record<PaneView, string> = {
  details: 'Details',
  preview: 'Preview',
  site: 'Site',
  activity: 'Activity',
};

/** The scope that reads the team (`GET …/team`), and with it teammates' names. */
const SPACE_ADMIN = 'space:admin';

const FORM_ID = 'entry-form';

const submitForm = () =>
  (document.getElementById(FORM_ID) as HTMLFormElement | null)?.requestSubmit();

/**
 * Create (/content/:typeId/new) or edit (/content/:typeId/:entryId) one entry.
 *
 * The editor is a place you stay: saving keeps you here (a new entry navigates
 * to its edit URL), the header always shows status/version/unsaved state, and
 * Publish lives next to Save — with unsaved edits it saves first, then asks for
 * confirmation.
 *
 * Its edits go through the assistant (`useAssistantEdit`): Save draft runs at once and leaves a
 * line in the conversation; Publish stops at a confirm card in the panel and waits for the answer.
 * When the assistant can't be reached they go straight to the API, Publish confirming in its own
 * dialog with a changed-fields summary, as it did before.
 */
export function EntryEditor() {
  const { typeId, entryId } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { client, conn, busy, run } = useClient();
  const { types, locales, defaultLocale, fallbacks, directions, delivered } = useContentOutlet();
  const queryClient = useQueryClient();
  const keys = useQueryKeys();
  const edit = useAssistantEdit();

  // An inline-edit deep link from a previewed page: which field it came from,
  // and which space it was rendered against. A ref inside blocks names a path
  // (`body[<key>].heading`); the form opens the top-level field it is in.
  // A ref's field is a path (`body[k1].heading`): the form opens its top-level field.
  const linkedFieldParam = searchParams.get('field');
  const linkedField = linkedFieldParam ? topLevelField(linkedFieldParam) || null : null;
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
  const [publishConfirm, setPublishConfirm] = useState<{
    changes: FieldDiff[] | null;
    hiddenChanges: number;
  } | null>(null);
  if (patchState.target !== `${typeId}:${entryId ?? 'new'}`) {
    setPatchState({ target: `${typeId}:${entryId ?? 'new'}`, patch: null });
    setLastAggregate(null);
    setPublishConfirm(null);
  }
  const applyPatch = (fields: EntryFields) =>
    setPatchState((s) => ({ ...s, patch: { seq: (s.patch?.seq ?? 0) + 1, fields } }));
  const [genOpen, setGenOpen] = useState(false);
  const [canvasOpen, setCanvasOpen] = useState(false);
  const publishButton = useRef<HTMLButtonElement>(null);
  const publishAnswered = useRef(false);
  // Bumped after a restore to re-seed the form (EntryForm reads `initial` once).
  const [formKey, setFormKey] = useState(0);
  // A new entry being created: from its save until the created entry's editor takes over, this
  // form is about to be replaced by one seeded from the server, so nothing typed into it would
  // survive. It is removed meanwhile, the loading placeholder in its place (`navigate` is a
  // transition: this form could stay on screen after it resolves, so "it has landed" is not enough).
  const [swapping, setSwapping] = useState(false);

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
  // The version the form was filled from, and then the version of its last save: what a save is
  // held to. A refetch of the entry (someone else's save) never moves it.
  const [baseVersion, setBaseVersion] = useState<number | null>(null);
  if (baseVersion === null && meta) setBaseVersion(meta.version);
  /** A save refused as stale: the dialog's question, with the fields it would have saved. */
  const [conflict, setConflict] = useState<{
    theirs: number;
    fields: EntryFields;
    publish: boolean;
  } | null>(null);
  const baseFields = isEdit ? ((entryQuery.data?.fields as EntryFields) ?? null) : {};
  // Who wrote it: the freshest aggregate (a save names its author) over the loaded entry. Names
  // come from the team, which only an administrator may read; anyone else sees "You" and kinds.
  const authorship =
    lastAggregate?.id === entryId ? { ...entryQuery.data, ...lastAggregate } : entryQuery.data;
  const accessQuery = useScopedQuery(['space-access'], () => client.getSpaceAccess(), {
    silent: true,
    enabled: isEdit,
  });
  const isAdmin = accessQuery.data?.scopes.includes(SPACE_ADMIN) === true;
  const teamQuery = useScopedQuery(['team'], () => client.getTeam(), {
    silent: true,
    enabled: isEdit && isAdmin,
  });
  const directory = {
    me: accessQuery.data?.subject,
    people: teamQuery.data?.people,
  };
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
  // What the assistant's chip, cards and lines call this entry.
  const about = displayTitle ?? 'Untitled entry';
  usePageContext(
    () =>
      entryId && typeId
        ? { kind: 'entry', entryId, contentType: typeId, label: about }
        : { kind: 'content-type', contentType: typeId ?? '', label: selectedType?.name ?? '' },
    [entryId, typeId, about, selectedType?.name],
  );
  useEffect(() => {
    const prev = document.title;
    document.title = `${pageTitle} · ContentWorker admin`;
    return () => {
      document.title = prev;
    };
  }, [pageTitle]);

  // Reference and asset picker options for Link fields; best-effort, the form works without them.
  const { pickers, searchEntries } = useEntryPickers();

  // Installed UI extensions (sidebar widgets + custom field editors); optional.
  const extensionsQuery = useAppExtensionsQuery();
  const extensions = useMemo(
    () => (extensionsQuery.data ?? []).filter((e) => e.active),
    [extensionsQuery.data],
  );

  // Re-seed the form from the server after a restore (server state changed).
  const reseedFromServer = async () => {
    if (entryId) {
      void queryClient.invalidateQueries({ queryKey: keys.entryActivityPages(entryId) });
      await queryClient.invalidateQueries({ queryKey: keys.entry(entryId) });
      // The form starts again from the entry as it is now: later saves are held to that version.
      const now = queryClient.getQueryData<{ version: number }>(keys.entry(entryId));
      setBaseVersion(now?.version ?? null);
    }
    markDirty(false);
    // The aggregate predates the restore; a publish diff based on it would
    // compare the wrong versions.
    setLastAggregate(null);
    setFormKey((k) => k + 1);
  };

  // ⌘S / Ctrl+S saves the draft (validation still runs via the form submit), as Save draft
  // would: a saved entry with no edits has nothing to save.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (isEdit && !dirtyRef.current) return;
        submitForm();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isEdit]);

  // Builds the publish confirmation, diffing published → current when we know
  // the published version (fresh save/publish response). No `run` here: callers
  // wrap it, and `run` doesn't nest.
  const computePublishConfirm = async (agg: EntryAggregate | null) => {
    if (!entryId) return;
    let changes: FieldDiff[] | null = null;
    let hiddenChanges = 0;
    if (agg && agg.publishedVersion != null) {
      const diff = await client.diffVersions(entryId, agg.publishedVersion, agg.currentVersion);
      changes = diff.changes.filter((c) => c.kind !== 'unchanged');
      hiddenChanges = diff.hiddenChanges;
    }
    publishAnswered.current = false;
    setPublishConfirm({ changes, hiddenChanges });
  };

  // Set just before a Publish-triggered form submit; consumed synchronously by
  // `save` (requestSubmit dispatches inline), then cleared either way so a
  // failed validation can't leak the flag into a later plain save.
  const publishAfterSaveRef = useRef(false);

  const save = (fields: EntryFields, over?: number) => {
    const chainPublish = publishAfterSaveRef.current;
    publishAfterSaveRef.current = false;
    // Held to the version the form was filled from (or the newer one being saved over): a save
    // someone made meanwhile is never overwritten unseen.
    const expected = over ?? baseVersion ?? undefined;
    const held = expected !== undefined ? { expectedVersion: expected } : {};
    return run(async () => {
      if (!selectedType) return;
      if (!isEdit) setSwapping(true);
      let swapped = false;
      try {
        const genAtSubmit = dirtyGen.current;
        const r =
          isEdit && entryId
            ? await orDirect(
                await edit<EntryView>('entries_update', { id: entryId, fields, ...held }, about),
                () => client.updateEntry(entryId, fields, held),
              )
            : await orDirect(
                await edit<EntryView>(
                  'entries_create',
                  { contentType: selectedType.apiId, fields },
                  titleOf(fields) ?? `New ${selectedType.name.toLowerCase()}`,
                ),
                () => client.createEntry(selectedType.apiId, fields),
              );
        // A save runs at once; it is never a card to decline.
        if (!('output' in r)) return;
        const view = r.output;
        setLastAggregate(view.entry);
        setBaseVersion(view.entry.currentVersion);
        // Edit mode: only clear dirty if nothing was typed while the request was
        // in flight — those keystrokes are NOT in the saved payload. Create mode
        // clears unconditionally: the form was removed while it saved, and the URL
        // swap below remounts it from the server state.
        if (!isEdit || dirtyGen.current === genAtSubmit) markDirty(false);
        if (entryId) {
          void queryClient.invalidateQueries({ queryKey: keys.entry(entryId) });
          // The save's audit row is written before the response: the Activity view can show it.
          void queryClient.invalidateQueries({ queryKey: keys.entryActivityPages(entryId) });
        }
        void queryClient.invalidateQueries({ queryKey: keys.entriesRoot });
        if (!isEdit) {
          // Stay in the editor: swap /new for the created entry's edit URL. The swap remounts the
          // form from the server state; this one stays removed (`swapping`) until then.
          swapped = true;
          await navigate(`/content/${typeId}/${view.entry.id}`, { replace: true });
          toast.success('Entry created');
          return;
        }
        toast.success('Draft updated');
        // Named as just saved: this render's title is from before the save.
        if (chainPublish) await publish(view.entry, titleOf(fields) ?? about);
      } catch (err) {
        const stale = isEdit ? staleSave(err) : undefined;
        if (!stale) throw err;
        // Publish waits on the answer: saving over theirs goes on to publish, as was asked.
        setConflict({ ...stale, fields, publish: chainPublish });
      } finally {
        // A create that failed or wasn't saved hands the form back.
        if (!isEdit && !swapped) setSwapping(false);
      }
    });
  };

  // The display field's value in the fields being saved (a new entry has no title until then).
  function titleOf(fields: EntryFields): string | null {
    const df = selectedType?.displayField;
    const v = df ? (fields[df] as Record<string, unknown> | undefined)?.[defaultLocale] : undefined;
    return typeof v === 'string' && v.trim() ? v : null;
  }

  // Publishing: a card in the assistant, or, when it can't be reached, the page's own dialog. No
  // `run` here: callers wrap it, and `run` doesn't nest.
  const publish = async (agg: EntryAggregate | null, label = about) => {
    if (!entryId) return;
    // Held to the version on screen: confirmed after someone saved a newer draft, it is refused.
    const version = agg?.currentVersion ?? meta?.version;
    const r = await edit<EntryAggregate>(
      'entries_publish',
      { id: entryId, ...(version ? { expectedVersion: version } : {}) },
      label,
    );
    if (r === null) return computePublishConfirm(agg);
    if ('output' in r) published(r.output, neverPublished(agg));
  };

  // `firstPublish`: nothing was live before, so unpublishing is the exact inverse and the toast
  // offers it. Replacing a live version can't be undone that way (the old one is gone).
  const published = (agg: EntryAggregate, firstPublish: boolean) => {
    if (!entryId) return;
    setLastAggregate(agg);
    void queryClient.invalidateQueries({ queryKey: keys.entry(entryId) });
    void queryClient.invalidateQueries({ queryKey: keys.entryActivityPages(entryId) });
    void queryClient.invalidateQueries({ queryKey: keys.entriesRoot });
    toast.success(
      `Published v${agg.publishedVersion ?? agg.currentVersion}`,
      firstPublish
        ? { action: { label: 'Undo', onAction: () => void undoPublish(entryId) } }
        : undefined,
    );
  };

  // Undo in a toast goes straight to the API, as on the entries list.
  const undoPublish = (id: string) =>
    run(async () => {
      const agg = await client.unpublishEntry(id);
      if (id === entryId) setLastAggregate(agg);
      void queryClient.invalidateQueries({ queryKey: keys.entry(id) });
      void queryClient.invalidateQueries({ queryKey: keys.entryActivityPages(id) });
      void queryClient.invalidateQueries({ queryKey: keys.entriesRoot });
      toast.success(`“${about}” is back to draft`);
    });

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
    void run(() => publish(lastAggregate?.id === entryId ? lastAggregate : null));
  };

  // The page's own confirm, when the assistant isn't there to show its card.
  const confirmPublish = () =>
    run(async () => {
      if (!entryId) return;
      const first = neverPublished(lastAggregate?.id === entryId ? lastAggregate : null);
      published(await client.publishEntry(entryId), first);
      setPublishConfirm(null);
    });

  // Whether nothing is live yet: the freshest aggregate says so exactly; else the loaded status.
  function neverPublished(agg: EntryAggregate | null) {
    return agg ? agg.publishedVersion == null : meta?.status === 'draft';
  }

  // The side pane (after felix's): beside the form where the row has room for both, under it
  // where it hasn't. It shows the draft as a document (live, saved or not) or the entry's panels.
  const [draft, setDraft] = useState<{ fields: EntryFields; locale: string } | null>(null);
  const onValuesChange = useCallback(
    (fields: EntryFields, locale: string) => setDraft({ fields, locale }),
    [],
  );
  const pane = usePaneLayout();
  const [chosenView, setPaneView] = usePaneView();
  // Activity is the audit log for this entry, so it takes what the log takes (space:admin): anyone
  // else, or anyone while that is still being read, sees Details in its place. Site frames the
  // customer's page for the entry, so it needs a preview URL on the type.
  const views = paneViews({
    isEdit,
    hasSite: Boolean(selectedType?.preview?.urlTemplate),
    isAdmin,
  });
  const paneView: PaneView = views.includes(chosenView) ? chosenView : 'details';

  // A click in the Site pane's page focuses that field (or block) in the form.
  const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(null);
  const onSitePick = useCallback(
    (ref: string, pageEntries: readonly string[]) => {
      if (!selectedType || !entryId) return;
      const at = focusForRef(ref, {
        space: conn.space,
        environment: conn.environment,
        entryId,
        contentType: selectedType,
        locales,
        pageEntries,
      });
      if (at) setFocusRequest((r) => ({ seq: (r?.seq ?? 0) + 1, ...at }));
    },
    [selectedType, entryId, conn.space, conn.environment, locales],
  );
  // The form's focused field (or block) as the page names it: outlined there and scrolled to.
  const [siteSelected, setSiteSelected] = useState<string | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const formBox = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const box = formBox.current;
    if (!box || !selectedType || !entryId) return;
    const onFocusIn = (e: FocusEvent) => {
      const el = e.target as Element;
      const apiId = el.closest('[data-field]')?.getAttribute('data-field');
      if (!apiId) return;
      const blockKey = el.closest('[data-block-key]')?.getAttribute('data-block-key') ?? undefined;
      const locale = draftRef.current?.locale ?? defaultLocale;
      const values = liveFields(
        selectedType,
        draftRef.current?.fields ?? initial ?? {},
        locale,
        defaultLocale,
      );
      setSiteSelected(
        refForField(
          { space: conn.space, environment: conn.environment, entryId, contentType: selectedType },
          locale,
          apiId,
          blockKey,
          values[apiId],
        ),
      );
    };
    // Focus leaving every field (for the toolbar, the pane, another window) clears the outline.
    const onFocusOut = (e: FocusEvent) => {
      const next = e.relatedTarget as Element | null;
      if (!next?.closest?.('[data-field]')) setSiteSelected(null);
    };
    box.addEventListener('focusin', onFocusIn);
    box.addEventListener('focusout', onFocusOut);
    return () => {
      box.removeEventListener('focusin', onFocusIn);
      box.removeEventListener('focusout', onFocusOut);
    };
  }, [selectedType, entryId, conn.space, conn.environment, defaultLocale, initial]);
  // What the page may do for this person: a role that can't write content only selects.
  // Undefined while the person's access is read: the frame holds the page's offer until it is
  // known, so a session is never settled on less than they may do. Unread, select only.
  const siteAllowed: readonly Capability[] | undefined = accessQuery.data
    ? capabilitiesFor(accessQuery.data.scopes)
    : accessQuery.isError
      ? SELECT_ONLY
      : undefined;
  const localeConfig = useMemo(
    () => ({ defaultLocale, locales, fallbacks }),
    [defaultLocale, locales, fallbacks],
  );

  // The side pane sticks under the action bar, which wraps to two lines on a narrow page: its
  // height is measured rather than assumed.
  const rootRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const hasType = selectedType !== undefined;
  useEffect(() => {
    const root = rootRef.current;
    const bar = barRef.current;
    if (!hasType || !root || !bar || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() =>
      root.style.setProperty('--editor-bar-h', `${bar.offsetHeight}px`),
    );
    ro.observe(bar);
    return () => ro.disconnect();
  }, [hasType]);

  // On a phone the actions are their own bar above the tab bar. Its drawn height (0 while the
  // on-screen keyboard hides it, or once it's back in the flow from md) is --page-bar-h on the
  // root: the toasts lift by it and the editor pads its foot by it, so neither assumes a height.
  const pageBarRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const pageBar = pageBarRef.current;
    const html = document.documentElement;
    if (!pageBar || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      const pinned = getComputedStyle(pageBar).position === 'fixed';
      html.style.setProperty('--page-bar-h', `${pinned ? pageBar.offsetHeight : 0}px`);
    };
    const ro = new ResizeObserver(measure);
    ro.observe(pageBar);
    window.addEventListener('resize', measure);
    measure();
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
      html.style.removeProperty('--page-bar-h');
    };
  }, [hasType]);

  const copyPreviewLink = () => {
    if (!entryId) return;
    void run(async () => {
      const link = await client.createPreviewLink(entryId, {
        previewBaseUrl: window.location.origin,
      });
      // The entry on the customer's site when its type names a preview URL; else the Preview API.
      await navigator.clipboard.writeText(link.frontendUrl ?? link.url);
      const expires = toMs(link.expiresAt);
      toast.success(
        expires === null
          ? 'Preview link copied'
          : `Preview link copied (expires ${dateTime(expires)})`,
      );
    });
  };

  // The title's line is held while the entry loads, so the title arriving never moves the actions.
  const titleSkeleton = (
    <>
      <span className="sr-only">{pageTitle}</span>
      <Skeleton aria-hidden="true" className="h-[1lh] w-2/3 max-w-sm" />
    </>
  );
  const h1 = 'break-words font-semibold text-[1.75rem] leading-tight tracking-title';

  if (!selectedType) {
    return (
      <div className="space-y-4 pt-3 sm:pt-5">
        <h1 className={h1}>{titleSkeleton}</h1>
        <Skeleton className="h-40 max-w-2xl" />
      </div>
    );
  }

  const loadingEntry = isEdit && !meta;
  const live = meta?.status === 'published' && !dirty;
  // A new entry can always be created; a saved one has nothing to save until it is edited.
  const canSave = !busy && initial !== null && (dirty || !isEdit);
  // Publish can't always take focus back: answered yes, it is off while the publish runs and for
  // good once the entry is live, which may be a moment after the dialog has gone. Then the action
  // beside it does (⋯, or Copy preview link where the row has room).
  const afterPublishConfirm = () => {
    const publish = publishButton.current;
    if (publish && !publish.disabled && !publishAnswered.current) return publish;
    return Array.from(pageBarRef.current?.querySelectorAll('button:enabled') ?? [])
      .filter((b): b is HTMLButtonElement => b instanceof HTMLButtonElement)
      .findLast((b) => b !== publish && b.type === 'button' && (b.checkVisibility?.() ?? true));
  };
  const secondary = [
    { label: 'Draft from prose', icon: PenLine, onSelect: () => setCanvasOpen(true) },
    { label: 'Generate with AI', icon: FileText, onSelect: () => setGenOpen(true) },
  ];

  return (
    // A named container: the secondary actions show by the room the editor has (beside the
    // assistant's column it is narrower than the screen), and fold into ⋯ below it. On a phone the
    // foot leaves room for the action bar above the tab bar.
    <div ref={rootRef} className="@container/editor space-y-4 max-md:pb-(--page-bar-h)">
      {/* The record-page header: the title wraps (never truncates). Under it, the action bar: the
          facts (status, version, save state) and the one primary verb for the entry's state. From
          md it stays under the shell's header on a long entry; below md its buttons sit above the
          tab bar, in thumb reach. */}
      <h1 className={cn(h1, 'pt-3 sm:pt-5')}>{loadingEntry ? titleSkeleton : pageTitle}</h1>
      <div
        ref={barRef}
        className="-mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b bg-background py-2 md:sticky md:top-(--shell-h) md:z-20"
      >
        <div className="flex min-h-8 flex-wrap items-center gap-2 text-muted-foreground text-sm">
          {loadingEntry ? (
            <Skeleton className="h-5 w-32" />
          ) : (
            <>
              {/* Form or canvas: two views of one draft, for a type with blocks and a site. */}
              {isEdit && entryId && canvasAvailable(selectedType) ? (
                <Segmented
                  aria-label="Editor view"
                  value="form"
                  onValueChange={(v) => {
                    if (v === 'canvas') navigate(`/content/${typeId}/${entryId}/canvas`);
                  }}
                >
                  <SegmentedItem value="form">Form</SegmentedItem>
                  <SegmentedItem value="canvas">Canvas</SegmentedItem>
                </Segmented>
              ) : null}
              {meta && <StatusBadge status={meta.status} />}
              {meta && <span className="font-mono text-xs">v{meta.version}</span>}
              {dirty ? (
                <ToneBadge tone="wait" label="Unsaved changes" />
              ) : (
                isEdit && meta && <span>All changes saved</span>
              )}
            </>
          )}
        </div>
        <div
          ref={pageBarRef}
          data-page-bar
          className="flex items-center gap-2 max-md:fixed max-md:inset-x-0 max-md:bottom-(--tabbar-h) max-md:z-20 max-md:border-t max-md:bg-background max-md:px-safe-4 max-md:py-2 max-md:in-data-keyboard:hidden"
        >
          <span className="hidden @4xl/editor:contents">
            {secondary.map(({ label, icon: Icon, onSelect }) => (
              <Button key={label} type="button" variant="ghost" size="sm" onClick={onSelect}>
                <Icon className="size-4" aria-hidden="true" /> {label}
              </Button>
            ))}
            {isEdit && entryId && (
              <Button type="button" variant="ghost" size="sm" onClick={copyPreviewLink}>
                <Link2 className="size-4" aria-hidden="true" /> Copy preview link
              </Button>
            )}
            <span aria-hidden="true" className="mx-1 h-5 w-px bg-border" />
          </span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="@4xl/editor:hidden"
                aria-label="More entry actions"
              >
                <Ellipsis aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              {secondary.map(({ label, icon: Icon, onSelect }) => (
                <DropdownMenuItem key={label} onSelect={onSelect}>
                  <Icon /> {label}
                </DropdownMenuItem>
              ))}
              {isEdit && entryId && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => void copyPreviewLink()}>
                    <Link2 /> Copy preview link
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          {/* One primary verb by state: a new entry's is Save draft; a saved one's is Publish
              while anything isn't live (Save draft steps back, enabled once there are edits); live
              and clean, both rest and Publish reads "Published". */}
          <Button
            type="submit"
            size="sm"
            variant={isEdit ? 'outline' : 'default'}
            form={FORM_ID}
            disabled={!canSave}
            className="max-md:h-9 max-md:flex-1"
          >
            Save draft
          </Button>
          {isEdit && (
            <Button
              ref={publishButton}
              type="button"
              size="sm"
              // A published entry with UNSAVED edits can still publish: the
              // click saves first (status becomes "changed"), then confirms.
              disabled={busy || loadingEntry || live}
              onClick={requestPublish}
              className="max-md:h-9 max-md:flex-1"
            >
              {live ? 'Published' : 'Publish'}
            </Button>
          )}
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

      <div ref={pane.ref} className={cn('flex', pane.split ? 'items-start' : 'flex-col gap-4')}>
        <div
          className={cn('min-w-0 flex-1', pane.split && 'pr-5')}
          aria-busy={swapping || undefined}
          ref={formBox}
        >
          {initial === null || swapping ? (
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
              directions={directions}
              delivered={delivered}
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
              focusRequest={focusRequest}
              mergePatch={patchState.patch}
              onValuesChange={onValuesChange}
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
        {pane.split ? (
          <PaneDivider
            share={pane.share}
            min={pane.min}
            max={pane.max}
            onChange={pane.onChange}
            onCommit={pane.onCommit}
            onReset={pane.onReset}
            controls="entry-pane"
          />
        ) : null}
        <aside
          id="entry-pane"
          aria-label="Side pane"
          style={pane.split ? { width: `${(pane.share * 100).toFixed(2)}%` } : undefined}
          className={cn(
            'w-full min-w-0 shrink-0 space-y-4',
            // Beside the form it holds still while the form scrolls, and scrolls on its own.
            pane.split &&
              'sticky top-[calc(var(--shell-h)+var(--editor-bar-h,0px)+1rem)] max-h-[calc(100dvh-var(--shell-h)-var(--editor-bar-h,0px)-2rem)] overflow-y-auto pl-5',
          )}
        >
          {/* A new entry has no panels yet: its pane is the preview alone. */}
          {isEdit ? (
            <Segmented
              aria-label="Side pane"
              value={paneView}
              onValueChange={(v) => setPaneView(v as PaneView)}
              className="grid w-full"
            >
              {views.map((v) => (
                <SegmentedItem key={v} value={v}>
                  {PANE_LABELS[v]}
                </SegmentedItem>
              ))}
            </Segmented>
          ) : null}
          {!isEdit || paneView === 'preview' ? (
            <EntryPreview
              contentType={selectedType}
              fields={draft?.fields ?? initial ?? {}}
              locale={draft?.locale ?? defaultLocale}
              localeConfig={localeConfig}
              direction={directions?.[draft?.locale ?? defaultLocale]}
              pickers={pickers}
            />
          ) : null}
          {isEdit && entryId && paneView === 'site' ? (
            <SitePane
              key={`site:${entryId}`}
              spaceId={conn.space}
              environmentId={conn.environment}
              entryId={entryId}
              contentType={selectedType}
              fields={draft?.fields ?? initial ?? {}}
              locale={draft?.locale ?? defaultLocale}
              defaultLocale={defaultLocale}
              allowed={siteAllowed}
              selected={siteSelected}
              split={pane.split}
              onPick={onSitePick}
            />
          ) : null}
          {isEdit && entryId && paneView === 'activity' ? (
            <EntryActivity
              key={`activity:${entryId}`}
              entryId={entryId}
              contentType={selectedType}
              directory={directory}
            />
          ) : null}
          {isEdit && entryId && paneView === 'details' && (
            <>
              {authorship && <EntryAuthorship authorship={authorship} directory={directory} />}
              {/* Editor work first; AI assist sits last and starts collapsed. */}
              <CollaborationPanel key={`collab:${entryId}`} entryId={entryId} />
              <EntryMetadataPanel key={`metadata:${entryId}`} entryId={entryId} />
              {meta && (
                <VersionHistory
                  key={`versions:${entryId}`}
                  entryId={entryId}
                  about={about}
                  currentVersion={meta.version}
                  publishedVersion={
                    lastAggregate?.id === entryId
                      ? lastAggregate.publishedVersion
                      : meta.status === 'published'
                        ? meta.version
                        : null
                  }
                  isLive={meta.status === 'published' || meta.status === 'changed'}
                  contentType={selectedType}
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
            </>
          )}
        </aside>
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
              variant="destructive"
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

      <SaveConflictDialog
        open={conflict !== null}
        theirs={conflict?.theirs ?? 0}
        mine={baseVersion ?? meta?.version ?? 0}
        where="the form"
        onOpenChange={(open) => !open && setConflict(null)}
        onLoadTheirs={() => {
          setConflict(null);
          void reseedFromServer();
        }}
        onSaveOver={() => {
          const c = conflict;
          setConflict(null);
          if (!c) return;
          publishAfterSaveRef.current = c.publish;
          void save(c.fields, c.theirs);
        }}
      />

      <PublishConfirm
        open={publishConfirm !== null}
        onOpenChange={(open) => {
          if (!open) setPublishConfirm(null);
        }}
        title={about}
        status={lastAggregate && lastAggregate.id === entryId ? lastAggregate.status : meta?.status}
        changes={publishConfirm?.changes}
        hiddenChanges={publishConfirm?.hiddenChanges ?? 0}
        compare={
          entryQuery.data ? { client, entry: entryQuery.data, locale: conn.locale } : undefined
        }
        busy={busy}
        onConfirm={() => {
          publishAnswered.current = true;
          void confirmPublish();
        }}
        returnFocus={afterPublishConfirm}
      />

      <GenerateEntryDialog
        // A draft under review stays when the dialog closes, but it was written for this entry.
        key={entryId ?? 'new'}
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
  async function generate(prompt: string, tier: ModelTier, signal: AbortSignal) {
    if (!selectedType) throw new Error('Content type not loaded');
    return client.generateEntry({ contentTypeApiId: selectedType.apiId, prompt, tier }, signal);
  }

  // Canvas: map free-form prose into the form's fields (throws so the dialog can
  // surface the error; not wrapped in `run`).
  async function mapCanvas(prose: string, tier: ModelTier, signal: AbortSignal) {
    if (!selectedType) return;
    const res = await client.canvasEntry(
      { contentTypeApiId: selectedType.apiId, prose, tier },
      signal,
    );
    if (signal.aborted) return;
    applyPatch(res.fields);
    const total = res.usage.inputTokens + res.usage.outputTokens;
    toast.success(`Mapped ${Object.keys(res.fields).length} field(s) · ${total} tokens`);
  }
}
