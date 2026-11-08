/**
 * The canvas editor (/content/:typeId/:entryId/canvas): an entry's page laid out on the
 * customer's own frontend, framed nearly full width, with the guardrails drawn over it as the
 * toolbox. The slots a developer declared show as seams between blocks; choosing one opens the
 * dock with exactly the blocks that slot takes; the inspector edits the selected block; Layers is
 * the outline, and the keyboard and screen-reader path to every block.
 *
 * It edits the same draft as the entry form. Every change is a block-patch op applied here with
 * the domain's `applyBlockPatch` and kept with its inverse for undo (`cms/lib/canvas/history.ts`);
 * the page re-renders each one before anything is saved, over the live preview channel (the Site
 * frame, `useSiteFrame`). Save draft is the entry's ordinary save, held to the version the canvas
 * started from (`expectedVersion`), so a save someone made meanwhile is never overwritten unseen.
 *
 * At lg it edits: Layers (on demand) | the page | the inspector. From md it edits by tap, the dock,
 * the inspector and Layers in sheets. Below md it is review-only, and says so in place.
 */
import {
  type BlockOp,
  type ComponentVariant,
  type EntryFields,
  SCOPES,
} from '@contentworker/domain';
import type { LiveRect } from '@contentworker/sdk-core/live-preview';
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
import { cn } from '@contentworker/ui/lib/utils';
import { Segmented, SegmentedItem } from '@contentworker/ui/segmented';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@contentworker/ui/sheet';
import { Skeleton } from '@contentworker/ui/skeleton';
import { useQueryClient } from '@tanstack/react-query';
import { ListTree, Redo2, Undo2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useBlocker, useNavigate, useParams } from 'react-router';
import { CanvasStage } from '~/cms/components/canvas/CanvasStage';
import { Dock } from '~/cms/components/canvas/Dock';
import { Inspector, type InspectorTab } from '~/cms/components/canvas/Inspector';
import { Layers } from '~/cms/components/canvas/Layers';
import { SaveConflictDialog } from '~/cms/components/entries/SaveConflictDialog';
import { LoadingStatus } from '~/cms/components/loading';
import { DEVICES, SiteNotice, useDevice } from '~/cms/components/pane/SitePane';
import { useSiteFrame } from '~/cms/components/pane/use-site-frame';
import { ResponsiveSheetContent } from '~/cms/components/responsive-sheet';
import { StatusBadge, ToneBadge } from '~/cms/components/status';
import { canvasChecks } from '~/cms/lib/canvas/checks';
import {
  applyOps,
  type CanvasHistory,
  type CanvasStep,
  EMPTY_HISTORY,
  record,
  redo as redoStep,
  undo as undoStep,
} from '~/cms/lib/canvas/history';
import {
  type CanvasBlock,
  type CanvasPlace,
  canvasAvailable,
  canvasTree,
  duplicateOp,
  findBlock,
  findSlot,
  flattenBlocks,
  insertOp,
  moveOp,
  newBlock,
  parentBlock,
  placeAfter,
  removeOp,
  setPropOp,
} from '~/cms/lib/canvas/model';
import { blockKeyOfRef, blockRects, type RefContext, seamsFrom } from '~/cms/lib/canvas/seams';
import { useClient } from '~/cms/lib/client-context';
import { useMedia, WIDE } from '~/cms/lib/device';
import {
  DEVICE_WIDTHS,
  type Device,
  type FrameGeometry,
} from '~/cms/lib/live-preview/frame-channel';
import { capabilitiesFor, SELECT_ONLY } from '~/cms/lib/live-preview/host';
import { refForField } from '~/cms/lib/live-preview/pick';
import { useEntryPickers } from '~/cms/lib/pickers';
import {
  useContentTypesQuery,
  useEntryQuery,
  useQueryKeys,
  useScopedQuery,
  useSpaceConfigQuery,
} from '~/cms/lib/queries';
import { plainKeyAllowed, type ShortcutGroup, usePageShortcuts } from '~/cms/lib/shortcuts';
import { staleSave } from '~/cms/lib/stale-save';
import { useToast } from '~/cms/lib/toast';

/** iPad upright and up: the canvas edits by tap there, its panels in sheets. */
const TABLET = '(min-width: 768px)';

export const CANVAS_SHORTCUTS: ShortcutGroup = {
  id: 'canvas-editor',
  title: 'Canvas editor',
  items: [
    { keys: ['↑'], label: 'Previous block' },
    { keys: ['↓'], label: 'Next block' },
    { keys: ['←'], label: 'The block holding this one' },
    { keys: ['→'], label: 'Its first block inside' },
    { keys: ['Mod', '↑'], label: 'Move the block up', chord: true },
    { keys: ['Mod', '↓'], label: 'Move the block down', chord: true },
    { keys: ['/'], label: 'Add a block here (the dock)' },
    { keys: ['Delete'], label: 'Remove the block' },
    { keys: ['Mod', 'Z'], label: 'Undo', chord: true },
    { keys: ['Mod', 'Shift', 'Z'], label: 'Redo', chord: true },
    { keys: ['Mod', 'S'], label: 'Save draft', chord: true },
    { keys: ['Esc'], label: 'Close the dock, or deselect' },
  ],
};

const newKey = () => crypto.randomUUID();

/** The dock's height at lg: its `max-h-40` below, in pixels. Keep the two together. */
const DOCK_HEIGHT = 160;
/** The room a chosen seam keeps from the edge of the page's view, or from the dock. */
const SEAM_ROOM = 24;

/** Why the canvas reviews rather than edits, in the words it says so with. */
type ReviewReason = 'narrow' | 'role' | 'published';

export function EntryCanvas() {
  const { typeId, entryId } = useParams();
  const types = useContentTypesQuery();
  const config = useSpaceConfigQuery();
  const entry = useEntryQuery(entryId);
  const contentType = types.data?.find((t) => t.apiId === typeId);
  const formPath = `/content/${typeId}/${entryId}`;

  if (types.isPending || config.isPending || entry.isPending) return <CanvasSkeleton />;
  if (!contentType || !entryId || !entry.data) {
    return (
      <Unavailable title="This entry can’t be opened here" formPath={formPath}>
        It isn’t in this space and environment, or it has gone.
      </Unavailable>
    );
  }
  if (!canvasAvailable(contentType)) {
    return (
      <Unavailable
        title={
          contentType.preview?.urlTemplate
            ? `${contentType.name} has no Blocks field`
            : `${contentType.name} has no preview URL`
        }
        formPath={formPath}
        settings={!contentType.preview?.urlTemplate}
      >
        {contentType.preview?.urlTemplate
          ? 'The canvas lays out the blocks of a Blocks field on your site. Give the type one, or push a block catalog that targets one.'
          : 'The canvas frames the entry on your site, at the address the type’s preview URL makes. Set one in the type’s settings, under Content.'}
      </Unavailable>
    );
  }
  return (
    <Canvas
      // A new entry (or a reload of theirs) starts its own canvas: history and selection with it.
      key={entryId}
      entryId={entryId}
      typeId={contentType.apiId}
      formPath={formPath}
    />
  );
}

function Canvas({
  entryId,
  typeId,
  formPath,
}: {
  entryId: string;
  typeId: string;
  formPath: string;
}) {
  const { client, conn, busy, run } = useClient();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const keys = useQueryKeys();
  usePageShortcuts(CANVAS_SHORTCUTS);
  const wide = useMedia(WIDE);
  const tablet = useMedia(TABLET);

  const contentType = useContentTypesQuery().data?.find((t) => t.apiId === typeId);
  const cfg = useSpaceConfigQuery().data;
  const entryQuery = useEntryQuery(entryId);
  const catalog = useScopedQuery(['block-catalog'], () => client.getBlockCatalog(), {
    silent: true,
  }).data;
  const access = useScopedQuery(['space-access'], () => client.getSpaceAccess(), { silent: true });
  const workflowState = useScopedQuery(
    ['workflow-state', entryId],
    () => client.getEntryWorkflowState(entryId),
    { silent: true },
  ).data;
  const workflows = useScopedQuery(['workflows'], () => client.listWorkflows(), {
    silent: true,
    enabled: !!workflowState,
  }).data;
  const { pickers, searchEntries } = useEntryPickers();

  const locales = cfg?.locales ?? [conn.locale];
  const defaultLocale = cfg?.defaultLocale ?? conn.locale;
  const locale = locales.includes(conn.locale) ? conn.locale : defaultLocale;

  // The draft as the canvas holds it, the version it started from, and its history.
  const [doc, setDoc] = useState<{
    base: { version: number; fields: EntryFields; status: string };
    fields: EntryFields;
    history: CanvasHistory;
  } | null>(null);
  const [reloading, setReloading] = useState(false);
  useEffect(() => {
    const data = entryQuery.data;
    if (!data || (doc && !reloading)) return;
    const fields = data.fields as EntryFields;
    setDoc({
      base: { version: data.version, fields, status: data.status },
      fields,
      history: EMPTY_HISTORY,
    });
    setReloading(false);
  }, [entryQuery.data, doc, reloading]);
  const docRef = useRef(doc);
  docRef.current = doc;

  const [selected, setSelected] = useState<string | null>(null);
  const [dockAt, setDockAt] = useState<{ path: string; index: number } | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [layersOpen, setLayersOpen] = useState(false);
  const [tab, setTab] = useState<InspectorTab>('content');
  const [kept, setKept] = useState<ReadonlySet<string>>(new Set());
  const [draftStarted, setDraftStarted] = useState(false);
  const [conflict, setConflict] = useState<{ theirs: number } | null>(null);
  const [said, setSaid] = useState('');
  const [focusInspector, setFocusInspector] = useState(false);
  const [focusChecks, setFocusChecks] = useState(false);
  /** Focus to put back after the dock closes, or onto the selected layer after an edit there. */
  const [restoreFocus, setRestoreFocus] = useState<'dock' | 'layer' | null>(null);
  const [geometry, setGeometry] = useState<FrameGeometry | null>(null);
  const [hover, setHover] = useState<{ ref: string; rect: LiveRect } | null>(null);
  const [device, setDevice] = useDevice();

  const fields = doc?.fields ?? (entryQuery.data?.fields as EntryFields | undefined) ?? {};
  const tree = useMemo(
    () => (contentType ? canvasTree(contentType, fields, locale, defaultLocale) : []),
    [contentType, fields, locale, defaultLocale],
  );
  const block = selected ? findBlock(tree, selected) : undefined;
  const dirty = !!doc && JSON.stringify(doc.fields) !== JSON.stringify(doc.base.fields);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  // --- what this person may do here ----------------------------------------------------------
  const scopes = access.data?.scopes;
  const canWrite = scopes ? scopes.includes(SCOPES.contentWrite) : false;
  const published = doc?.base.status === 'published' && !dirty && !draftStarted;
  const review: ReviewReason | null = !tablet
    ? 'narrow'
    : scopes && !canWrite
      ? 'role'
      : published
        ? 'published'
        : null;
  const editable = review === null && !!scopes;
  const allowed = scopes ? capabilitiesFor(scopes) : access.isError ? SELECT_ONLY : undefined;

  const refCtx: RefContext = {
    space: conn.space,
    environment: conn.environment,
    entryId,
    contentType: typeId,
    locale,
    defaultLocale,
  };
  /** A block's ref as the page writes it: what `select` and `scroll` name. */
  const refOf = (b: CanvasBlock) =>
    contentType
      ? refForField(
          { space: conn.space, environment: conn.environment, entryId, contentType },
          locale,
          b.slot.address.field,
          b.key,
          (fields[b.slot.address.field] as Record<string, unknown> | undefined)?.[b.slot.locale],
        )
      : null;
  const selectedRef = block ? refOf(block) : null;

  const treeRef = useRef(tree);
  treeRef.current = tree;
  const site = useSiteFrame({
    spaceId: conn.space,
    environmentId: conn.environment,
    entryId,
    contentType: contentType ?? { apiId: typeId, fields: [] },
    fields,
    locale,
    defaultLocale,
    allowed,
    selected: selectedRef,
    mode: 'edit',
    device,
    canvas: true,
    onPick: (ref, pageEntries) => {
      if (!pageEntries.includes(entryId)) return;
      const key = blockKeyOfRef(ref, treeRef.current, refCtx);
      if (!key) return;
      setSelected(key);
      setDockAt(null);
      setInspectorOpen(true);
    },
    onGeometry: setGeometry,
    onHover: (ref, rect) => setHover(ref && rect ? { ref, rect } : null),
  });
  const hasLayout = site.capabilities.includes('layout');

  // --- edits --------------------------------------------------------------------------------
  const apply = useCallback(
    (ops: readonly BlockOp[], label: string, burst?: string): CanvasStep | null => {
      const d = docRef.current;
      if (!d || !contentType) return null;
      const r = applyOps(contentType, d.fields, ops, newKey, { label, burst, at: Date.now() });
      if (!r.ok) {
        toast.error(r.issues[0]?.message ?? 'That change can’t be made here');
        return null;
      }
      const next = { ...d, fields: r.fields, history: record(d.history, r.step) };
      docRef.current = next;
      setDoc(next);
      if (!burst) setSaid(label);
      return r.step;
    },
    [contentType, toast],
  );

  const travel = (way: 'undo' | 'redo') => {
    const d = docRef.current;
    if (!d || !contentType || !editable) return;
    const r = (way === 'undo' ? undoStep : redoStep)(contentType, d.fields, d.history);
    if (!r.ok) return;
    const next = { ...d, fields: r.fields, history: r.history };
    docRef.current = next;
    setDoc(next);
    setSaid(`${way === 'undo' ? 'Undone' : 'Redone'}: ${r.step.label}`);
    // The block the step put back (or put in again) is selected; one it took away is not.
    const after = canvasTree(contentType, r.fields, locale, defaultLocale);
    const op = (way === 'undo' ? r.step.inverse : r.step.ops)[0];
    const touched =
      op?.op === 'insert' && typeof op.block._key === 'string'
        ? op.block._key
        : op && 'key' in op
          ? op.key
          : undefined;
    if (touched && findBlock(after, touched)) setSelected(touched);
    else if (selected && !findBlock(after, selected)) setSelected(null);
  };

  /** A step's undo from its toast: the last step is undone; one further back is put back anew. */
  const revert = (step: CanvasStep) => {
    const d = docRef.current;
    if (!d) return;
    if (d.history.past.at(-1) === step) travel('undo');
    else apply(step.inverse, `Put back: ${step.label}`);
  };

  const place = (p: { path: string; index: number } | null): CanvasPlace | undefined => {
    if (!p) return undefined;
    const slot = findSlot(tree, p.path);
    return slot ? { slot, index: Math.min(p.index, slot.blocks.length) } : undefined;
  };
  const dockPlace = place(dockAt);
  /** What had focus when the dock opened: focus goes back there when it closes. */
  const dockOpener = useRef<HTMLElement | null>(null);
  const openDock = (at: CanvasPlace | undefined) => {
    if (!at || !editable) return;
    const active = document.activeElement;
    if (!dockAt) dockOpener.current = active instanceof HTMLElement ? active : null;
    setDockAt({ path: at.slot.path, index: at.index });
  };
  const closeDock = () => {
    setDockAt(null);
    setRestoreFocus('dock');
  };

  const insert = (variant: ComponentVariant) => {
    if (!dockPlace) return;
    const made = newBlock(variant, newKey);
    const step = apply([insertOp(dockPlace, made)], `Added ${variant.name}`);
    if (!step) return;
    setDockAt(null);
    setSelected(made._key as string);
    setInspectorOpen(true);
    setFocusInspector(true);
  };
  /** An edit from Layers: focus follows the selection there once the outline re-renders. */
  const fromLayers = () => !!document.activeElement?.closest('[role="tree"]');
  const move = (b: CanvasBlock, by: -1 | 1) => {
    const op = moveOp(b, by);
    const inLayers = fromLayers();
    if (op && apply([op], `Moved ${b.name} ${by < 0 ? 'up' : 'down'}`) && inLayers) {
      setRestoreFocus('layer');
    }
  };
  const remove = (b: CanvasBlock) => {
    if (fromLayers()) setRestoreFocus('layer');
    const step = apply([removeOp(b)], `Removed ${b.name}`);
    if (!step) return;
    // The selection steps to a neighbour, so the keyboard keeps its place.
    const sibling = b.slot.blocks[b.index + 1] ?? b.slot.blocks[b.index - 1];
    setSelected(sibling?.key ?? parentBlock(tree, b)?.key ?? null);
    toast.success(`Removed ${b.name}`, { action: { label: 'Undo', onAction: () => revert(step) } });
  };
  const duplicate = (b: CanvasBlock) => {
    const step = apply([duplicateOp(b)], `Duplicated ${b.name}`);
    const copy = step?.ops[0];
    if (copy?.op === 'insert' && typeof copy.block._key === 'string') setSelected(copy.block._key);
  };
  const setProp = (b: CanvasBlock, prop: string, value: unknown) =>
    apply([setPropOp(b, prop, value)], `Edited ${b.name}`, `${b.key}:${prop}`);

  /** The checks are the right column's with nothing selected; below lg, the panel sheet's. */
  const showChecks = () => {
    setSelected(null);
    setInspectorOpen(true);
    setFocusChecks(true);
  };

  // --- saving -------------------------------------------------------------------------------
  const save = (over?: number) =>
    run(async () => {
      const d = docRef.current;
      if (!d || !editable || !contentType) return;
      // Judged here first, as the form judges itself: what the save would refuse, said in place.
      const blocking = canvasChecks(
        contentType,
        d.fields,
        canvasTree(contentType, d.fields, locale, defaultLocale),
        { locales, defaultLocale, locale, previous: d.base.fields },
      );
      if (blocking.length > 0) {
        showChecks();
        toast.error(
          `Fix ${blocking.length} ${blocking.length === 1 ? 'check' : 'checks'} to save the draft`,
        );
        return;
      }
      const expectedVersion = over ?? d.base.version;
      try {
        const saved = await client.updateEntry(entryId, d.fields, { expectedVersion });
        const now = docRef.current ?? d;
        // What was typed while it saved stays unsaved; the history holds while the save kept
        // the blocks as the canvas made them.
        const same = JSON.stringify(saved.fields) === JSON.stringify(d.fields);
        const next = {
          base: {
            version: saved.entry.currentVersion,
            fields: saved.fields,
            status: saved.entry.status,
          },
          fields: now.fields === d.fields ? saved.fields : now.fields,
          history: same ? now.history : EMPTY_HISTORY,
        };
        docRef.current = next;
        setDoc(next);
        setConflict(null);
        void queryClient.invalidateQueries({ queryKey: keys.entry(entryId) });
        void queryClient.invalidateQueries({ queryKey: keys.entryActivityPages(entryId) });
        void queryClient.invalidateQueries({ queryKey: keys.entriesRoot });
        toast.success('Draft updated');
      } catch (err) {
        const stale = staleSave(err);
        if (stale) {
          setConflict(stale);
          return;
        }
        throw err;
      }
    });
  const loadTheirs = () => {
    setConflict(null);
    setSelected(null);
    setDockAt(null);
    setReloading(true);
    void queryClient.invalidateQueries({ queryKey: keys.entry(entryId) });
  };

  // --- leaving with unsaved changes ------------------------------------------------------------
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirtyRef.current && currentLocation.pathname !== nextLocation.pathname,
  );
  const leaving = useRef(false);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  // --- keys ---------------------------------------------------------------------------------
  const keysRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keysRef.current = (e: KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey;
    const el = e.target instanceof Element ? e.target : null;
    const typing =
      (el instanceof HTMLElement && el.isContentEditable) ||
      !!el?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])');
    if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault();
      if (dirtyRef.current) void save();
      return;
    }
    if (mod && !e.altKey && e.key.toLowerCase() === 'z') {
      // In a field, ⌘Z is the field's own undo.
      if (typing || e.defaultPrevented) return;
      e.preventDefault();
      travel(e.shiftKey ? 'redo' : 'undo');
      return;
    }
    if (mod && !e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      if (typing || !block || !editable) return;
      e.preventDefault();
      move(block, e.key === 'ArrowUp' ? -1 : 1);
      return;
    }
    if (e.key === 'Escape' && !typing) {
      if (dockAt) {
        closeDock();
        return;
      }
      if (!plainKeyAllowed(e)) return;
      setSelected(null);
      return;
    }
    if (!plainKeyAllowed(e)) return;
    // Plain keys act on the page, Layers and the panels' headings, never on a button or a tab
    // (whose own keys they are: Backspace on Save draft must not remove a block).
    const onCanvas =
      !el ||
      el === document.body ||
      !!el.closest(
        '[role="tree"], [data-canvas-stage], [data-inspector-heading], [data-checks-heading]',
      );
    if (!onCanvas) return;
    const order = flattenBlocks(tree);
    const at = order.findIndex((b) => b.key === selected);
    switch (e.key) {
      case '/':
        e.preventDefault();
        openDock(placeAfter(tree, block));
        return;
      case 'Delete':
      case 'Backspace':
        if (!block || !editable) return;
        e.preventDefault();
        remove(block);
        return;
      case 'ArrowDown':
      case 'ArrowUp': {
        const next = e.key === 'ArrowDown' ? order[at + 1] : at > 0 ? order[at - 1] : undefined;
        if (!next && at >= 0) return;
        e.preventDefault();
        setSelected((next ?? order[0])?.key ?? null);
        return;
      }
      case 'ArrowLeft':
        if (!block) return;
        e.preventDefault();
        setSelected(parentBlock(tree, block)?.key ?? block.key);
        return;
      case 'ArrowRight': {
        const child = block?.slots.find((s) => s.blocks.length > 0)?.blocks[0];
        if (!child) return;
        e.preventDefault();
        setSelected(child.key);
        return;
      }
    }
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keysRef.current(e);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // A block just put in from the dock: its settings take focus (the dock went with the insert).
  useEffect(() => {
    if (!focusInspector) return;
    const heading = document.querySelector<HTMLElement>('[data-inspector-heading]');
    if (!heading) return;
    heading.focus();
    setFocusInspector(false);
  });

  useEffect(() => {
    if (!focusChecks) return;
    const heading = document.querySelector<HTMLElement>('[data-checks-heading]');
    if (!heading) return;
    heading.focus();
    setFocusChecks(false);
  });

  // The dock closed: focus goes back to what opened it, or, when that was a seam (pointer-only,
  // hidden from assistive technology) or is gone, to the selected block in Layers, else the page.
  useEffect(() => {
    if (!restoreFocus) return;
    setRestoreFocus(null);
    const opener = dockOpener.current;
    if (restoreFocus === 'dock' && opener?.isConnected && !opener.closest('[aria-hidden="true"]')) {
      opener.focus();
      return;
    }
    const layer = selected
      ? [...document.querySelectorAll<HTMLElement>('[data-layer]')].find(
          (el) => el.dataset.layer === selected,
        )
      : undefined;
    if (layer) layer.focus();
    else if (restoreFocus === 'dock')
      document.querySelector<HTMLElement>('[data-canvas-stage]')?.focus();
  });

  // --- what's drawn -----------------------------------------------------------------------------
  const seams = editable && hasLayout ? seamsFrom(geometry, tree, refCtx) : [];
  const rects = blockRects(geometry, tree, refCtx);
  const selectedRect = block ? (rects.get(block.key) ?? null) : null;
  const hoverKey = hover ? blockKeyOfRef(hover.ref, tree, refCtx) : undefined;
  const hoverRect =
    hover && hoverKey && hoverKey !== selected ? (rects.get(hoverKey) ?? hover.rect) : null;
  const checks =
    contentType && doc
      ? canvasChecks(contentType, doc.fields, tree, {
          locales,
          defaultLocale,
          locale,
          previous: doc.base.fields,
        })
      : [];
  const title = titleOf(contentType, fields, defaultLocale) ?? 'Untitled entry';
  const history = doc?.history ?? EMPTY_HISTORY;
  const loading = site.status.status === 'loading';
  const dockOpenAt = dockPlace && editable ? dockPlace : undefined;
  const chosenSeam = dockOpenAt ? `${dockOpenAt.slot.path}#${dockOpenAt.index}` : null;
  const geometryNote =
    editable && site.live && site.status.status === 'live'
      ? !hasLayout
        ? 'This site’s SDK doesn’t report its layout, so seams aren’t shown. Click a block in the page or pick one in Layers to select it; add blocks from Layers or the block’s settings.'
        : geometry && geometry.slots.length === 0
          ? 'The page marks no slots, so seams aren’t shown. Add blocks from Layers or the block’s settings.'
          : geometry?.truncated
            ? 'Some seams far from view aren’t drawn on a page this long: scroll the page to reach them.'
            : null
      : null;

  // The chosen seam stays in view above the dock: when the dock would cover it (or it is off the
  // top), the page brings the block beside it to the middle of its view. Once per choice.
  const stageBox = useRef<HTMLDivElement>(null);
  const scrolledFor = useRef<string | null>(null);
  const chosenRect = seams.find((x) => x.id === chosenSeam)?.rect;
  useEffect(() => {
    if (!chosenSeam || !dockPlace) {
      scrolledFor.current = null;
      return;
    }
    if (scrolledFor.current === chosenSeam || !chosenRect) return;
    scrolledFor.current = chosenSeam;
    const height = stageBox.current?.clientHeight ?? 0;
    // At lg the dock covers the stage's foot (max-h-40); in a sheet below lg, about half of it.
    const covered = wide ? DOCK_HEIGHT : height / 2;
    const middle = chosenRect.y + chosenRect.h / 2;
    if (middle >= 0 && middle <= height - covered - SEAM_ROOM) return;
    const { slot, index } = dockPlace;
    // The seam is the top edge of the block after it: that block's top goes near the top of the
    // view. With none after it, it is the bottom edge of the block before it, which goes just
    // above the dock. An empty slot's seam is inside the block holding it: that block's top.
    const holder = slot.address.parent ? findBlock(tree, slot.address.parent.key) : undefined;
    const after = slot.blocks[index];
    const before = slot.blocks[index - 1];
    const target = after ?? before ?? holder;
    const ref = target ? refOf(target) : null;
    if (!ref) return;
    site.scrollTo(
      ref,
      target === before
        ? { align: 'end', inset: covered + SEAM_ROOM }
        : { align: 'start', inset: SEAM_ROOM },
    );
  });

  const inspectorBody = block ? (
    <Inspector
      block={block}
      locale={block.slot.locale}
      pickers={pickers}
      onSearchEntries={searchEntries}
      readOnly={!editable}
      tab={tab}
      onTab={setTab}
      onChange={(prop, value) => setProp(block, prop, value)}
      onMove={(by) => move(block, by)}
      onDuplicate={() => duplicate(block)}
      onRemove={() => remove(block)}
      onAdd={(slot) => openDock({ slot, index: slot.blocks.length })}
      inSheet={!wide}
      kept={kept.has(block.key)}
      onKeep={() => setKept((k) => new Set(k).add(block.key))}
    />
  ) : null;
  const pageBody = (
    <PagePanel
      checks={checks}
      onSelect={(key) => {
        setSelected(key);
        setInspectorOpen(true);
      }}
      editable={editable}
      formPath={formPath}
    />
  );
  const layersBody = (
    <Layers
      slots={tree}
      selected={selected}
      onSelect={(key) => {
        setSelected(key);
        setDockAt(null);
      }}
      onOpen={(key) => {
        setSelected(key);
        setInspectorOpen(true);
        setFocusInspector(true);
      }}
      onAdd={editable ? (slot) => openDock({ slot, index: slot.blocks.length }) : undefined}
    />
  );

  if (!doc || !contentType) return <CanvasSkeleton />;

  return (
    <div className="flex h-[calc(100dvh-var(--shell-h)-var(--tabbar-h,0px))] flex-col md:h-[calc(100dvh-var(--shell-h))] lg:pb-safe-0">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-2.5 sm:px-5">
        <div className="min-w-0">
          <div className="caption md:hidden">
            <Link to={`/content/${typeId}`} className="hover:text-foreground hover:underline">
              {contentType.name}
            </Link>
          </div>
          <h1 className="break-words font-semibold text-lg leading-tight tracking-title">
            {title}
          </h1>
        </div>
        <Segmented
          aria-label="Editor view"
          value="canvas"
          onValueChange={(v) => {
            if (v === 'form') navigate(formPath);
          }}
        >
          <SegmentedItem value="form">Form</SegmentedItem>
          <SegmentedItem value="canvas">Canvas</SegmentedItem>
        </Segmented>
        <div className="flex items-center gap-2 text-muted-foreground text-sm">
          <StatusBadge
            status={dirty && doc.base.status === 'published' ? 'changed' : doc.base.status}
          />
          <span className="font-mono text-xs">v{doc.base.version}</span>
          {dirty ? <ToneBadge tone="wait" label="Unsaved changes" /> : null}
          {checks.length > 0 ? (
            // The checks are the right column's when nothing is selected: this shows them.
            <button
              type="button"
              className="hit-area rounded-full px-1.5 text-destructive text-xs underline-offset-2 hover:underline"
              onClick={showChecks}
            >
              {checks.length} {checks.length === 1 ? 'check' : 'checks'} to fix
            </button>
          ) : null}
        </div>
        <span className="sr-only" aria-live="polite">
          {said}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Segmented
            aria-label="Device width"
            value={device}
            onValueChange={(v) => setDevice(v as Device)}
          >
            {DEVICES.map(({ value, label, icon: Icon }) => (
              <SegmentedItem
                key={value}
                value={value}
                aria-label={`${label}, ${DEVICE_WIDTHS[value]} pixels`}
                title={`${label} (${DEVICE_WIDTHS[value]}px)`}
              >
                <Icon aria-hidden="true" />
              </SegmentedItem>
            ))}
          </Segmented>
          <Button
            type="button"
            variant={layersOpen ? 'secondary' : 'ghost'}
            size="sm"
            aria-pressed={layersOpen}
            onClick={() => setLayersOpen((o) => !o)}
          >
            <ListTree aria-hidden="true" /> Layers
          </Button>
          {editable ? (
            <>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Undo"
                title={history.past.at(-1) ? `Undo: ${history.past.at(-1)?.label}` : 'Undo'}
                disabled={history.past.length === 0}
                onClick={() => travel('undo')}
              >
                <Undo2 aria-hidden="true" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Redo"
                title={history.future.at(-1) ? `Redo: ${history.future.at(-1)?.label}` : 'Redo'}
                disabled={history.future.length === 0}
                onClick={() => travel('redo')}
              >
                <Redo2 aria-hidden="true" />
              </Button>
              <Button type="button" size="sm" disabled={busy || !dirty} onClick={() => void save()}>
                Save draft
              </Button>
            </>
          ) : null}
        </div>
      </header>

      <Notices
        review={review}
        workflow={
          workflowState
            ? (workflows
                ?.find((w) => w.id === workflowState.workflowId)
                ?.steps.find((s) => s.id === workflowState.currentStepId)?.name ??
              'a workflow step')
            : null
        }
        geometryNote={geometryNote}
        onStartDraft={() => setDraftStarted(true)}
        formPath={formPath}
      />
      {site.status.status === 'loading' || site.status.status === 'live' ? null : (
        <div className="border-b px-4 py-3 sm:px-5">
          <SiteNotice status={site.status} origin={site.origin} onReload={site.reload} />
        </div>
      )}

      <div
        className={cn(
          'grid min-h-0 flex-1',
          wide && layersOpen
            ? 'lg:grid-cols-[16rem_minmax(0,1fr)_340px]'
            : 'lg:grid-cols-[minmax(0,1fr)_340px]',
        )}
      >
        {wide && layersOpen ? (
          <aside aria-label="Layers" className="min-h-0 overflow-y-auto border-r p-3">
            {layersBody}
          </aside>
        ) : null}
        <div ref={stageBox} className="relative min-h-0" aria-busy={loading || undefined}>
          <CanvasStage
            frameRef={site.frameRef}
            frameKey={site.frameKey}
            src={site.src}
            loading={loading}
            seams={seams}
            chosenSeam={chosenSeam}
            hovered={editable || site.live ? hoverRect : null}
            selected={selectedRect}
            onChooseSeam={(seam) => openDock(seam)}
          >
            {loading ? (
              <>
                <LoadingStatus>Loading the entry’s page…</LoadingStatus>
                <Skeleton aria-hidden="true" className="absolute inset-0 rounded-none" />
              </>
            ) : null}
            {wide && dockOpenAt ? (
              // max-h-40 is DOCK_HEIGHT: what the chosen seam is kept clear of.
              <div className="absolute inset-x-0 bottom-0 max-h-40 border-t bg-background shadow-float">
                <Dock
                  key={`${dockOpenAt.slot.path}#${dockOpenAt.index}`}
                  place={dockOpenAt}
                  catalog={catalog}
                  onInsert={insert}
                  onClose={closeDock}
                />
              </div>
            ) : null}
          </CanvasStage>
          <p role="status" className="sr-only">
            {site.note
              ? 'The page couldn’t apply an edit, so it was sent the whole entry again.'
              : ''}
          </p>
        </div>
        {wide ? (
          <aside
            aria-label={block ? 'Block settings' : 'Page'}
            className="min-h-0 overflow-y-auto border-l p-4"
          >
            {inspectorBody ?? pageBody}
          </aside>
        ) : null}
      </div>

      {/* Below lg: the panels come as sheets, by tap. */}
      {!wide ? (
        <>
          <Sheet open={layersOpen} onOpenChange={setLayersOpen}>
            <SheetContent side="left" className="w-80" bodyClassName="px-4 pb-4">
              <SheetHeader>
                <SheetTitle>Layers</SheetTitle>
              </SheetHeader>
              {layersBody}
            </SheetContent>
          </Sheet>
          {/* The right column's sheet: the selected block's settings, or with none, the checks. */}
          <Sheet open={inspectorOpen} onOpenChange={setInspectorOpen}>
            <ResponsiveSheetContent className="sm:max-w-md" bodyClassName="px-4 pb-4">
              <SheetHeader>
                <SheetTitle>{block?.name ?? 'Checks'}</SheetTitle>
              </SheetHeader>
              {inspectorBody ?? pageBody}
            </ResponsiveSheetContent>
          </Sheet>
          <Sheet open={!!dockOpenAt} onOpenChange={(open) => !open && closeDock()}>
            <SheetContent side="bottom">
              <SheetHeader>
                <SheetTitle>
                  {dockOpenAt ? `Add to ${dockOpenAt.slot.name}` : 'Add a block'}
                </SheetTitle>
              </SheetHeader>
              {dockOpenAt ? (
                <Dock
                  inSheet
                  place={dockOpenAt}
                  catalog={catalog}
                  onInsert={insert}
                  onClose={closeDock}
                />
              ) : null}
            </SheetContent>
          </Sheet>
        </>
      ) : null}

      <SaveConflictDialog
        open={conflict !== null}
        theirs={conflict?.theirs ?? 0}
        mine={doc.base.version}
        where="the canvas"
        onOpenChange={(open) => !open && setConflict(null)}
        onLoadTheirs={loadTheirs}
        onSaveOver={() => {
          const theirs = conflict?.theirs;
          setConflict(null);
          if (theirs) void save(theirs);
        }}
      />

      <AlertDialog
        open={blocker.state === 'blocked'}
        onOpenChange={(open) => {
          // Escape or a press outside keeps editing, as Keep editing does.
          if (!open && blocker.state === 'blocked' && !leaving.current) blocker.reset();
          if (open) leaving.current = false;
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle>
            <AlertDialogDescription>
              The canvas has edits that haven’t been saved. Leaving now will discard them.
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
                leaving.current = true;
                dirtyRef.current = false;
                blocker.proceed();
              }}
            >
              Discard changes
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function titleOf(
  contentType: { displayField?: string | null } | undefined,
  fields: EntryFields,
  defaultLocale: string,
): string | null {
  const df = contentType?.displayField;
  const v = df ? (fields[df] as Record<string, unknown> | undefined)?.[defaultLocale] : undefined;
  return typeof v === 'string' && v.trim() ? v : null;
}

/** Why the canvas reviews instead of editing, and what's happening to the entry, in place. */
function Notices(props: {
  review: ReviewReason | null;
  workflow: string | null;
  geometryNote: string | null;
  onStartDraft: () => void;
  formPath: string;
}) {
  const lines: React.ReactNode[] = [];
  if (props.review === 'narrow') {
    lines.push(
      <span key="narrow">
        Arranging blocks needs a wider screen. Here you can review the page and its layers.
      </span>,
    );
  } else if (props.review === 'role') {
    lines.push(
      <span key="role">
        Your role can read this entry but not edit it: the canvas is for review here.
      </span>,
    );
  } else if (props.review === 'published') {
    lines.push(
      <span key="published" className="flex flex-wrap items-center gap-x-3 gap-y-1">
        This is the published version. Edits make a draft; the site keeps showing this until you
        publish.
        <Button type="button" size="sm" variant="outline" onClick={props.onStartDraft}>
          Edit a draft
        </Button>
      </span>,
    );
  }
  if (props.workflow) {
    lines.push(
      <span key="workflow">
        In review at <b className="font-semibold">{props.workflow}</b>. Edits save as a draft; the
        workflow decides when it publishes.
      </span>,
    );
  }
  if (props.geometryNote) lines.push(<span key="geometry">{props.geometryNote}</span>);
  if (lines.length === 0) return null;
  return (
    <div className="flex flex-col gap-1 border-b bg-muted/50 px-4 py-2 text-muted-foreground text-sm sm:px-5">
      {lines}
    </div>
  );
}

/** The right column with nothing selected: the checks a save needs, and how to begin. */
function PagePanel(props: {
  checks: ReturnType<typeof canvasChecks>;
  onSelect: (key: string) => void;
  editable: boolean;
  formPath: string;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 tabIndex={-1} data-checks-heading className="section-title outline-none">
          Checks
        </h2>
        <p className="max-w-measure text-muted-foreground text-xs">
          What has to change before this draft saves and publishes.
        </p>
      </div>
      {props.checks.length === 0 ? (
        <p className="text-sm">Nothing stands in the way.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {props.checks.map((c) => (
            <li key={c.id}>
              {c.blockKey ? (
                <button
                  type="button"
                  className="w-full rounded-lg px-2 py-1 text-left text-destructive text-sm hover:bg-muted"
                  onClick={() => props.onSelect(c.blockKey as string)}
                >
                  {c.message}
                </button>
              ) : (
                <p className="px-2 py-1 text-destructive text-sm">{c.message}</p>
              )}
            </li>
          ))}
        </ul>
      )}
      {props.checks.some((c) => c.inForm) ? (
        <Button asChild size="sm" variant="outline" className="self-start">
          <Link to={props.formPath}>Fix in the form</Link>
        </Button>
      ) : null}
      {props.editable ? (
        <p className="max-w-measure text-muted-foreground text-sm">
          Choose a seam between blocks to see what fits there, or a block to edit it. Press{' '}
          <kbd className="font-mono">/</kbd> to add after the selected block.
        </p>
      ) : null}
    </div>
  );
}

function Unavailable(props: {
  title: string;
  formPath: string;
  settings?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto flex max-w-page flex-col gap-4 px-4 pt-6 sm:px-5">
      <h1 className="font-semibold text-[1.75rem] leading-tight tracking-title">Canvas</h1>
      <Alert>
        <AlertTitle className="line-clamp-none">{props.title}</AlertTitle>
        <AlertDescription>
          <p>{props.children}</p>
          <div className="flex flex-wrap gap-2">
            <Button asChild size="sm" variant="outline">
              <Link to={props.formPath}>Edit in the form</Link>
            </Button>
            {props.settings ? (
              <Button asChild size="sm" variant="ghost">
                <Link to="/content">Content types</Link>
              </Button>
            ) : null}
          </div>
        </AlertDescription>
      </Alert>
    </div>
  );
}

/** The canvas as it will stand, while the entry and its type load. */
export function CanvasSkeleton() {
  return (
    <div
      className="flex h-[calc(100dvh-var(--shell-h)-var(--tabbar-h,0px))] flex-col md:h-[calc(100dvh-var(--shell-h))]"
      aria-busy="true"
    >
      <LoadingStatus>Loading the canvas…</LoadingStatus>
      <div className="flex items-center gap-3 border-b px-5 py-2.5" aria-hidden="true">
        <Skeleton className="h-6 w-56" />
        <Skeleton className="ml-auto h-8 w-48" />
      </div>
      <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,1fr)_340px]" aria-hidden="true">
        <Skeleton className="m-3 rounded-xl" />
        <div className="hidden border-l p-4 lg:block">
          <Skeleton className="h-40" />
        </div>
      </div>
    </div>
  );
}
