/**
 * The canvas editor (/content/:typeId/:entryId/canvas): an entry's page laid out on the
 * customer's own frontend, framed nearly full width, with the guardrails drawn over it as the
 * toolbox. The slots a developer declared show as seams between blocks; choosing one opens the
 * dock with exactly the blocks that slot takes; the inspector edits the selected block; Layers is
 * the outline, and the keyboard and screen-reader path to every block.
 *
 * What each slot offers follows the block config (`GET …/block-config/effective`, read with the
 * catalog as the canvas opens): the dock lists only the blocks a slot's narrowed rule takes, a locked slot draws
 * no seams and its blocks keep their place, and the checks judge the edit as the server will
 * (`blockConfigIssues`), so a refusal is said on the block or slot it is about before a save, or
 * after one when the config changed meanwhile. Blocks stored before the config stay as they are.
 *
 * The entry's locked regions (`GET …/entries/:id/block-locks`, `cms/lib/block-locks.ts`) hold the
 * same way: no seams inside a run or a block locked with everything inside, a lock on the region's
 * outline and in Layers, and its blocks keep their place. Someone with the `lock` action on the
 * type locks the selected block (or a run shift-selected in Layers) from the inspector, and
 * unlocks one there; each is its own request, held to the version the canvas has, never the save.
 *
 * It edits the same draft as the entry form. Every change is a block-patch op applied here with
 * the domain's `applyBlockPatch` and kept with its inverse for undo (`cms/lib/canvas/history.ts`);
 * the page re-renders each one before anything is saved, over the live preview channel (the Site
 * frame, `useSiteFrame`). Save draft is the entry's ordinary save, held to the version the canvas
 * started from (`expectedVersion`), so a save someone made meanwhile is never overwritten unseen.
 *
 * The frame's widths are the catalog's breakpoints when it declares any (Base, then one per
 * breakpoint, `cms/lib/breakpoints.ts`): the width in view is the breakpoint the inspector's Look
 * tab edits, each override an `update` op setting the block's `_responsive` whole (`setOverrideOp`),
 * so it undoes and saves as any edit. An override the server refuses is a check on its block.
 *
 * A block moves by its grip on the page with a fine pointer (a drag to a seam), and from the
 * inspector (Move up, Move down, Move to) and Layers (⌘↑ ⌘↓) with the keyboard or a finger; each
 * is one `move` op held to the same judgement as the dock and the save (`cms/lib/canvas/drag.ts`).
 *
 * At lg it edits: Layers (on demand) | the page | the inspector. From md it edits by tap, the dock,
 * the inspector and Layers in sheets. Below md it is review-only, and says so in place.
 */
import {
  type BlockOp,
  blockVariants,
  type ComponentVariant,
  type ContentType,
  type EntryFields,
  SCOPES,
  withoutStaleOverrides,
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
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link, useBlocker, useNavigate, useParams } from 'react-router';
import { CanvasStage } from '~/cms/components/canvas/CanvasStage';
import { Dock } from '~/cms/components/canvas/Dock';
import { Inspector, type InspectorTab } from '~/cms/components/canvas/Inspector';
import { Layers } from '~/cms/components/canvas/Layers';
import { ProposalLine } from '~/cms/components/canvas/ProposalLine';
import { SaveConflictDialog } from '~/cms/components/entries/SaveConflictDialog';
import { LoadingStatus } from '~/cms/components/loading';
import { SiteNotice, useWidthPreset, WidthSwitch } from '~/cms/components/pane/SitePane';
import { useSiteFrame } from '~/cms/components/pane/use-site-frame';
import { ResponsiveSheetContent } from '~/cms/components/responsive-sheet';
import { StatusBadge, ToneBadge } from '~/cms/components/status';
import { useAssistantIfAny, useProposedBlocks } from '~/cms/lib/assistant';
import type { ActorDirectory } from '~/cms/lib/authorship';
import {
  canLock,
  lockedLine,
  lockId,
  lockRefusal,
  regionRefusal,
  withLock,
  withoutLock,
} from '~/cms/lib/block-locks';
import { configIssues, configRefusal, overrideRefusal, rulesOver } from '~/cms/lib/block-rules';
import { widthPresets } from '~/cms/lib/breakpoints';
import { canvasChecks, type RefusedIssue } from '~/cms/lib/canvas/checks';
import {
  canDrag,
  type DropVerdict,
  judgeDrop,
  configRefusal as moveRefusal,
  moveTargets,
} from '~/cms/lib/canvas/drag';
import { fillAsk, fillFor, proposedLayers, slotTitle } from '~/cms/lib/canvas/fill';
import {
  type Applied,
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
  type CanvasRules,
  canDuplicate,
  canMove,
  canRemove,
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
  runBetween,
  setOverrideOp,
  setPropOp,
} from '~/cms/lib/canvas/model';
import {
  blockKeyOfRef,
  blockRects,
  ghostRects,
  type RefContext,
  regionRects,
  seamsFrom,
} from '~/cms/lib/canvas/seams';
import { useClient } from '~/cms/lib/client-context';
import { useMedia, WIDE } from '~/cms/lib/device';
import { fieldAccessFor, withoutHiddenFields, writableFields } from '~/cms/lib/field-access';
import type { FrameGeometry } from '~/cms/lib/live-preview/frame-channel';
import { capabilitiesFor, SELECT_ONLY } from '~/cms/lib/live-preview/host';
import { refForField } from '~/cms/lib/live-preview/pick';
import { type GhostKind, ghostKeys, ghostOps } from '~/cms/lib/live-preview/proposals';
import { ApiError, type BlockLockInput, type EntryBlockLock } from '~/cms/lib/management';
import { useEntryPickers } from '~/cms/lib/pickers';
import {
  useContentTypesQuery,
  useEntryQuery,
  useQueryKeys,
  useScopedQuery,
  useSpaceConfigQuery,
} from '~/cms/lib/queries';
import {
  plainKeyAllowed,
  type ShortcutGroup,
  useFinePointer,
  usePageShortcuts,
} from '~/cms/lib/shortcuts';
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

/** The same, for someone who may lock: Shift with an arrow takes a neighbour into a run. */
export const CANVAS_LOCK_SHORTCUTS: ShortcutGroup = {
  ...CANVAS_SHORTCUTS,
  items: [
    ...CANVAS_SHORTCUTS.items.slice(0, 4),
    { keys: ['Shift', '↑'], label: 'Take the block above in too, to lock them together' },
    { keys: ['Shift', '↓'], label: 'Take the block below in too, to lock them together' },
    ...CANVAS_SHORTCUTS.items.slice(4),
  ],
};

const newKey = () => crypto.randomUUID();

/** The dock's height at lg: its `max-h-40` below, in pixels. Keep the two together. */
const DOCK_HEIGHT = 160;
/** The room a chosen seam keeps from the edge of the page's view, or from the dock. */
const SEAM_ROOM = 24;

/** A move judged against the draft: a drop verdict, carrying the applied edit when it may land. */
type Judged =
  | Exclude<DropVerdict, { kind: 'move' }>
  | (Extract<DropVerdict, { kind: 'move' }> & { readonly applied: Applied & { ok: true } });

/** Why the canvas reviews rather than edits, in the words it says so with. */
type ReviewReason = 'narrow' | 'role' | 'fields' | 'published';

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
  const wide = useMedia(WIDE);
  const tablet = useMedia(TABLET);

  const typesQuery = useContentTypesQuery();
  const storedType = typesQuery.data?.find((t) => t.apiId === typeId);
  const cfg = useSpaceConfigQuery().data;
  const entryQuery = useEntryQuery(entryId);
  const catalog = useScopedQuery(['block-catalog'], () => client.getBlockCatalog(), {
    silent: true,
  }).data;
  // Read as the canvas opens: a config set after that is the server's to refuse, and is said on
  // the block or slot it falls on. Rules made over another catalog than this one narrow nothing.
  const rulesQuery = useScopedQuery(
    ['block-config', 'effective'],
    () => client.getEffectiveBlockRules(),
    { silent: true, staleTime: 0 },
  );
  const rules = rulesOver(rulesQuery.data, catalog);
  const access = useScopedQuery(['space-access'], () => client.getSpaceAccess(), { silent: true });
  // The fields this person's role hides or makes read-only (`cms/lib/field-access.ts`): a hidden
  // one isn't drawn, and a save sends neither (the api keeps what they hold).
  const fieldAccess = useMemo(() => fieldAccessFor(access.data, typeId), [access.data, typeId]);
  const contentType = useMemo(
    () => storedType && withoutHiddenFields(storedType, fieldAccess),
    [storedType, fieldAccess],
  );
  // Field rules name top-level fields only, so one over a blocks field covers every block in it:
  // a role that may not change one of the type's blocks fields reviews the canvas, and edits what
  // it may in the form. Only the ones it can read are named.
  const ruledBlocks = (storedType?.fields ?? []).filter(
    (f) =>
      blockVariants(f) !== undefined &&
      (fieldAccess.readOnly.has(f.apiId) || fieldAccess.hidden.has(f.apiId)),
  );
  const ruledNames = ruledBlocks.filter((f) => !fieldAccess.hidden.has(f.apiId)).map((f) => f.name);
  // The entry's locked regions: read with the canvas, again after each save and each lock set.
  const locksKey = [conn.space, conn.environment, 'block-locks', entryId];
  const locksQuery = useScopedQuery(
    ['block-locks', entryId],
    () => client.getEntryBlockLocks(entryId),
    { silent: true, staleTime: 0 },
  );
  const locks = locksQuery.data?.locks;
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
  /** Where a shift-selection started: with `selected` in one slot, the run a Lock takes. */
  const [anchor, setAnchor] = useState<string | null>(null);
  /** Why the last lock or unlock was refused, in the inspector's words. */
  const [lockRefused, setLockRefused] = useState<readonly string[]>([]);
  const [dockAt, setDockAt] = useState<{ path: string; index: number } | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [layersOpen, setLayersOpen] = useState(false);
  const [tab, setTab] = useState<InspectorTab>('content');
  const [kept, setKept] = useState<ReadonlySet<string>>(new Set());
  const [draftStarted, setDraftStarted] = useState(false);
  const [conflict, setConflict] = useState<{ theirs: number } | null>(null);
  /** What the server's block config (or override check) refused of a save, for those fields. */
  const [refused, setRefused] = useState<{
    fields: EntryFields;
    issues: readonly RefusedIssue[];
  } | null>(null);
  const [said, setSaid] = useState('');
  const [focusInspector, setFocusInspector] = useState(false);
  const [focusChecks, setFocusChecks] = useState(false);
  /** Focus to put back after the dock closes, or onto the selected layer after an edit there. */
  const [restoreFocus, setRestoreFocus] = useState<'dock' | 'layer' | null>(null);
  const [geometry, setGeometry] = useState<FrameGeometry | null>(null);
  const [hover, setHover] = useState<{ ref: string; rect: LiveRect } | null>(null);

  const fields = doc?.fields ?? (entryQuery.data?.fields as EntryFields | undefined) ?? {};
  const storedFields = doc?.base.fields;
  const under = useMemo<CanvasRules>(
    () => ({ rules, stored: storedFields, ...(locks ? { locks } : {}) }),
    [rules, storedFields, locks],
  );
  const tree = useMemo(
    () => (contentType ? canvasTree(contentType, fields, locale, defaultLocale, under) : []),
    [contentType, fields, locale, defaultLocale, under],
  );
  const block = selected ? findBlock(tree, selected) : undefined;
  // The frame's widths: Base and the catalog's breakpoints when it declares any. While the catalog
  // is loading, or couldn't be read, the blocks fields' own (the push wrote them there), so a
  // field with breakpoints always has a Base to edit its bare props at.
  const ownBreakpoints = tree.find((s) => s.breakpoints.length > 0)?.breakpoints;
  const breakpoints = catalog?.breakpoints?.length ? catalog.breakpoints : ownBreakpoints;
  const presets = useMemo(() => widthPresets(breakpoints), [breakpoints]);
  const [preset, setPreset] = useWidthPreset(presets);
  const fine = useFinePointer();
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
      : ruledBlocks.length > 0
        ? 'fields'
        : published
          ? 'published'
          : null;
  const editable = review === null && !!scopes;
  // Locking isn't editing the draft: offered in review too, but not where the canvas can't arrange.
  const locking = review !== 'narrow' && canLock(access.data, typeId);
  usePageShortcuts(locking ? CANVAS_LOCK_SHORTCUTS : CANVAS_SHORTCUTS);
  const chosenRun = runBetween(tree, anchor, selected);
  const assistant = useAssistantIfAny();
  const coworker = assistant?.enabled === true;
  const allowed = scopes
    ? capabilitiesFor(scopes, { assistant: coworker })
    : access.isError
      ? SELECT_ONLY
      : undefined;

  // --- Coworker's proposal -------------------------------------------------------------------
  // A block patch Coworker proposes for this entry shows on the page as ghosts while its card
  // waits; once it is saved the canvas reads the entry again (unless it holds edits of its own,
  // whose save then asks about the newer draft as any other).
  const proposal = useProposedBlocks(entryId, () => {
    void locksQuery.refetch();
    if (dirtyRef.current) {
      // The canvas's own edits stay; their save meets the newer draft and asks, as any other.
      toast.success(
        'Saved Coworker’s change. Your unsaved edits are kept: saving them asks about the newer draft.',
      );
      return;
    }
    toast.success('Saved Coworker’s change');
    setSelected(null);
    setDockAt(null);
    void queryClient.invalidateQueries({ queryKey: keys.entryActivityPages(entryId) });
    // Read again first, then taken in: the draft the canvas holds becomes the saved one.
    void queryClient
      .invalidateQueries({ queryKey: keys.entry(entryId) })
      .then(() => setReloading(true));
  });
  const shownOps = useMemo(() => (proposal ? ghostOps(proposal.ops) : null), [proposal]);
  const ghosts = useMemo(
    () => (shownOps ? ghostKeys(shownOps) : new Map<string, GhostKind>()),
    [shownOps],
  );
  const proposedInLayers = useMemo(
    () => (proposal ? proposedLayers(tree, proposal.ops) : undefined),
    [proposal, tree],
  );

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
    width: preset.width,
    canvas: true,
    proposal: shownOps,
    onPick: (ref, pageEntries) => {
      if (!pageEntries.includes(entryId)) return;
      const key = blockKeyOfRef(ref, treeRef.current, refCtx);
      if (!key) return;
      setAnchor(null);
      setSelected(key);
      setDockAt(null);
      setInspectorOpen(true);
    },
    onGeometry: setGeometry,
    onHover: (ref, rect) => setHover(ref && rect ? { ref, rect } : null),
  });
  const hasLayout = site.capabilities.includes('layout');

  // --- edits --------------------------------------------------------------------------------
  /** Takes an applied edit in: the draft, its history step, and the live region's words. */
  const commit = useCallback((r: Applied & { ok: true }, burst?: string): CanvasStep | null => {
    const d = docRef.current;
    if (!d) return null;
    const next = { ...d, fields: r.fields, history: record(d.history, r.step) };
    docRef.current = next;
    setDoc(next);
    if (!burst) setSaid(r.step.label);
    return r.step;
  }, []);
  const apply = useCallback(
    (ops: readonly BlockOp[], label: string, burst?: string): CanvasStep | null => {
      const d = docRef.current;
      if (!d || !contentType) return null;
      const r = applyOps(contentType, d.fields, ops, newKey, { label, burst, at: Date.now() });
      if (!r.ok) {
        toast.error(r.issues[0]?.message ?? 'That change can’t be made here');
        return null;
      }
      return commit(r, burst);
    },
    [contentType, toast, commit],
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
    const after = canvasTree(contentType, r.fields, locale, defaultLocale, under);
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
  // A locked slot's dock opens (from `/` or Add) only to say so: it offers nothing.
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
    if (!dockPlace || dockPlace.slot.locked) return;
    const made = newBlock(variant, newKey);
    const step = apply([insertOp(dockPlace, made)], `Added ${variant.name}`);
    if (!step) return;
    setDockAt(null);
    setSelected(made._key as string);
    setInspectorOpen(true);
    setFocusInspector(true);
  };
  /**
   * Ask Coworker to fill the dock's place: the blocks the dock offers there, the slot's bounds and
   * the blocks around it go with that one message, and Coworker's answer is a card to confirm.
   * Nothing is put in here: the proposal shows on the page as ghosts until the card is answered.
   */
  const askFill = () => {
    if (!assistant || !dockPlace || !editable) return;
    const fill = fillFor(tree, dockPlace, catalog);
    if (!fill) return;
    assistant.ask(fillAsk(tree, dockPlace), {
      kind: 'entry',
      entryId,
      contentType: typeId,
      label: title,
      fill,
    });
    // Below lg the dock is a sheet, which would hand focus back to the seam as it closes.
    askedFromDock.current = !wide;
    setDockAt(null);
    setSaid('Asked Coworker to fill this place: its proposal comes as a card to confirm.');
  };
  /** The dock closed because Coworker was asked: its sheet leaves focus where the panel put it. */
  const askedFromDock = useRef(false);
  /** Why Ask Coworker to fill this waits, when it does. */
  const askHeld = dirty
    ? 'Save the draft first: Coworker works from the draft as it is saved.'
    : proposal?.state === 'saving'
      ? 'Coworker’s proposal is being saved.'
      : proposal
        ? 'Answer Coworker’s proposal first: confirm it or choose Not now.'
        : undefined;

  /** An edit from Layers: focus follows the selection there once the outline re-renders. */
  const fromLayers = () => !!document.activeElement?.closest('[role="tree"]');
  const move = (b: CanvasBlock, by: -1 | 1) => {
    if (!canMove(b, by)) return;
    const op = moveOp(b, by);
    const inLayers = fromLayers();
    if (op && apply([op], `Moved ${b.name} ${by < 0 ? 'up' : 'down'}`) && inLayers) {
      setRestoreFocus('layer');
    }
  };
  const remove = (b: CanvasBlock) => {
    if (!canRemove(b)) return;
    if (fromLayers()) setRestoreFocus('layer');
    const step = apply([removeOp(b)], `Removed ${b.name}`);
    if (!step) return;
    // The selection steps to a neighbour, so the keyboard keeps its place.
    const sibling = b.slot.blocks[b.index + 1] ?? b.slot.blocks[b.index - 1];
    setSelected(sibling?.key ?? parentBlock(tree, b)?.key ?? null);
    toast.success(`Removed ${b.name}`, { action: { label: 'Undo', onAction: () => revert(step) } });
  };
  const duplicate = (b: CanvasBlock) => {
    if (!canDuplicate(b)) return;
    const step = apply([duplicateOp(b)], `Duplicated ${b.name}`);
    const copy = step?.ops[0];
    if (copy?.op === 'insert' && typeof copy.block._key === 'string') setSelected(copy.block._key);
  };
  const setProp = (b: CanvasBlock, prop: string, value: unknown) =>
    apply([setPropOp(b, prop, value)], `Edited ${b.name}`, `${b.key}:${prop}`);
  /** One prop's override at one breakpoint; a Reset is a step of its own. */
  /**
   * Where `b` may move to `at`: judged first as the dock judges a place (`judgeDrop`), then the
   * moved draft as the save will (the block config and the entry's locks), so a seam shows the
   * reason before the drop and Move to lists only what lands. Kept per draft, block and place: a
   * drag asks for every seam on every pointer move.
   */
  const judged = useRef<{ fields: EntryFields | null; verdicts: Map<string, Judged> }>({
    fields: null,
    verdicts: new Map(),
  });
  const judgeMove = (b: CanvasBlock, at: CanvasPlace): Judged => {
    const d = docRef.current;
    if (!d || !contentType) return { kind: 'refused', reason: `${b.name} can’t go there` };
    if (judged.current.fields !== d.fields) {
      judged.current = { fields: d.fields, verdicts: new Map() };
    }
    const id = `${b.key}|${at.slot.path}#${at.index}`;
    const kept = judged.current.verdicts.get(id);
    if (kept) return kept;
    const verdict = ((): Judged => {
      const first = judgeDrop(b, at);
      if (first.kind !== 'move') return first;
      // Named as Move to lists it: "Section “Features” › Items".
      const label =
        at.slot.path === b.slot.path
          ? first.label
          : `Moved ${b.name} to ${slotTitle(tree, at.slot)}`;
      const r = applyOps(contentType, d.fields, [first.op], newKey, { label, at: Date.now() });
      if (!r.ok) {
        return { kind: 'refused', reason: r.issues[0]?.message ?? `${b.name} can’t go there` };
      }
      const issue = moveRefusal(
        (f) => configIssues(contentType, catalog, rules, d.base.fields, f, locales, locks),
        d.fields,
        r.fields,
      );
      if (issue) return { kind: 'refused', reason: `${b.name} can’t go there: ${issue.message}` };
      return { kind: 'move', op: first.op, label, applied: r };
    })();
    judged.current.verdicts.set(id, verdict);
    return verdict;
  };
  /** Moves `b` to `at` as one `move` op; refused, it says why (in place and aloud) and stays. */
  const moveTo = (b: CanvasBlock, at: CanvasPlace): boolean => {
    if (!editable) return false;
    const verdict = judgeMove(b, at);
    if (verdict.kind === 'home') return false;
    if (verdict.kind === 'refused') {
      setSaid(verdict.reason);
      toast.error(verdict.reason);
      return false;
    }
    commit({ ...verdict.applied, step: { ...verdict.applied.step, at: Date.now() } });
    setSelected(b.key);
    return true;
  };

  const setOverride = (b: CanvasBlock, bp: string, prop: string, value: unknown) => {
    const name = b.slot.breakpoints.find((x) => x.id === bp)?.name ?? bp;
    apply(
      [setOverrideOp(b, bp, prop, value)],
      value === undefined ? `Reset ${b.name} at ${name}` : `Edited ${b.name} at ${name}`,
      value === undefined ? undefined : `${b.key}:${bp}:${prop}`,
    );
  };

  // --- locks --------------------------------------------------------------------------------
  /** Takes `key` into the selection with what's selected: a run, when they share a slot. */
  const extend = (key: string) => {
    setAnchor((a) => a ?? selected ?? key);
    setSelected(key);
    setDockAt(null);
  };
  /**
   * Sends the whole new list, held to the version the canvas has: a lock names stored blocks, so
   * one made over a save someone else made since is a 409, and the canvas reads the entry again.
   */
  const setLocks = (next: BlockLockInput[], done: string) =>
    run(async () => {
      const d = docRef.current;
      if (!d) return;
      setLockRefused([]);
      try {
        const saved = await client.setEntryBlockLocks(entryId, next, d.base.version);
        queryClient.setQueryData(locksKey, saved);
        void queryClient.invalidateQueries({ queryKey: keys.entryActivityPages(entryId) });
        setAnchor(null);
        setSaid(done);
        toast.success(done);
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          void locksQuery.refetch();
          if (dirtyRef.current) {
            setLockRefused([
              'Someone saved this entry since the canvas opened it. Save the draft to see theirs, then lock again.',
            ]);
          } else {
            loadTheirs();
            setLockRefused([
              'Someone changed this entry since the canvas opened it: it was read again. Try again.',
            ]);
          }
          return;
        }
        const words = lockRefusal(err);
        if (words.length > 0) {
          setLockRefused(words);
          return;
        }
        throw err;
      }
    });
  const lock = (l: BlockLockInput) =>
    setLocks(
      withLock(locks ?? [], l),
      l.keys.length > 1 ? `Locked ${l.keys.length} blocks` : 'Locked',
    );
  const unlock = (l: EntryBlockLock) => setLocks(withoutLock(locks ?? [], l), 'Unlocked');

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
        canvasTree(contentType, d.fields, locale, defaultLocale, under),
        {
          locales,
          defaultLocale,
          locale,
          previous: d.base.fields,
          blocks: { catalog, rules },
          ...(locks ? { locks } : {}),
        },
      );
      if (blocking.length > 0) {
        showChecks();
        toast.error(
          `Fix ${blocking.length} ${blocking.length === 1 ? 'check' : 'checks'} to save the draft`,
        );
        return;
      }
      const expectedVersion = over ?? d.base.version;
      // Overrides the type no longer takes (a push removed their breakpoint, or narrowed their
      // prop) go before the save, as the save drops them: the canvas makes none by mistake, and
      // an undo across several saves may bring back a block that holds them.
      const send = (type: ContentType) =>
        client.updateEntry(
          entryId,
          writableFields(withoutStaleOverrides(type, d.fields), fieldAccess),
          {
            expectedVersion,
          },
        );
      try {
        let saved: Awaited<ReturnType<typeof send>>;
        try {
          saved = await send(contentType);
        } catch (err) {
          // Refused over an override: the type may have changed since the canvas read it. Read
          // it again, and when that drops something more, send once more.
          if (overrideRefusal(err).length === 0) throw err;
          const fresh = (await typesQuery.refetch()).data?.find((t) => t.apiId === typeId);
          const unchanged =
            !fresh ||
            JSON.stringify(withoutStaleOverrides(fresh, d.fields)) ===
              JSON.stringify(withoutStaleOverrides(contentType, d.fields));
          if (unchanged) throw err;
          saved = await send(fresh);
        }
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
        // A save can leave a lock stale (its blocks gone): read which are now.
        void locksQuery.refetch();
        toast.success('Draft updated');
      } catch (err) {
        const stale = staleSave(err);
        if (stale) {
          setConflict(stale);
          return;
        }
        // The config, or a lock, changed since the canvas read it: said on the blocks and slots
        // it names, with the locks read again so the canvas holds what the server does.
        const issues = configRefusal(err);
        if (issues.length > 0) {
          setRefused({ fields: d.fields, issues });
          showChecks();
          const what = issues.length === 1 ? 'a change' : `${issues.length} changes`;
          if (regionRefusal(issues)) void locksQuery.refetch();
          toast.error(
            regionRefusal(issues)
              ? `A locked region refused ${what}: see the checks`
              : `The block config refused ${what}: see the checks`,
          );
          return;
        }
        // An override no stored version holds, that the catalog no longer declares: said on its
        // block, where it is reset or undone.
        const overrides = overrideRefusal(err);
        if (overrides.length > 0) {
          setRefused({ fields: d.fields, issues: overrides });
          showChecks();
          toast.error(
            overrides.length === 1
              ? 'The site no longer takes an override in this draft: see the checks'
              : `The site no longer takes ${overrides.length} overrides in this draft: see the checks`,
          );
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
        if (!canRemove(block)) {
          setSaid(
            block.lock
              ? `${block.name} is locked: it keeps its place`
              : `${block.slot.name} is locked: ${block.name} keeps its place`,
          );
          return;
        }
        remove(block);
        return;
      case 'ArrowDown':
      case 'ArrowUp': {
        if (e.shiftKey && block && locking) {
          // Takes the neighbour in the same slot in too: a run to lock.
          const sibling = block.slot.blocks[block.index + (e.key === 'ArrowDown' ? 1 : -1)];
          e.preventDefault();
          if (sibling) extend(sibling.key);
          return;
        }
        const next = e.key === 'ArrowDown' ? order[at + 1] : at > 0 ? order[at - 1] : undefined;
        if (!next && at >= 0) return;
        e.preventDefault();
        setAnchor(null);
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
  const regions = regionRects(tree, rects);
  const ghostBoxes = site.proposal.shown ? ghostRects(geometry, ghosts, refCtx) : [];
  const selectedRect = block ? (rects.get(block.key) ?? null) : null;
  // The grip, for a fine pointer only (iPadOS drag is unreliable): touch and keyboard move blocks
  // from the inspector and Layers. Never while Coworker's proposal shows on the page.
  const drag =
    fine && editable && hasLayout && block && selectedRect && canDrag(block) && !site.proposal.shown
      ? {
          key: block.key,
          name: block.name,
          rect: selectedRect,
          judge: (seam: CanvasPlace) => judgeMove(block, seam),
          onStart: () => {
            setDockAt(null);
            setHover(null);
          },
          onDrop: (seam: CanvasPlace) => void moveTo(block, seam),
          onRefused: (reason: string) => setSaid(reason),
          onCancel: () => setSaid(`${block.name} stays where it was`),
        }
      : undefined;
  /** Who's who for "Locked by …": the team isn't read here, so a teammate reads as one. */
  const directory = { me: access.data?.subject };
  // Locks name stored blocks: a change to the blocks waits for its save before anything locks.
  const blocksDirty =
    !!doc &&
    !!contentType &&
    contentType.fields.some(
      (f) =>
        blockVariants(f) !== undefined &&
        JSON.stringify(doc.fields[f.apiId]) !== JSON.stringify(doc.base.fields[f.apiId]),
    );
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
          blocks: { catalog, rules },
          ...(locks ? { locks } : {}),
          // Until the next edit: the refusal was of these fields.
          refused: refused?.fields === doc.fields ? refused.issues : [],
        })
      : [];
  const title = titleOf(contentType, fields, defaultLocale) ?? 'Untitled entry';
  const history = doc?.history ?? EMPTY_HISTORY;
  const loading = site.status.status === 'loading';
  const dockOpenAt = dockPlace && editable ? dockPlace : undefined;
  // Offered with Coworker on, to someone who edits, where Coworker can be asked for what the dock
  // offers (never a locked place or a full slot: `fillFor` is null there).
  const dockAsk =
    coworker && editable && dockOpenAt && fillFor(tree, dockOpenAt, catalog)
      ? { onAsk: askFill, ...(askHeld ? { held: askHeld } : {}) }
      : undefined;
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
      preset={preset}
      onOverride={(bp, prop, value) => setOverride(block, bp, prop, value)}
      onMove={(by) => move(block, by)}
      moveTargets={moveTargets(tree, block)
        .filter(
          (t) => judgeMove(block, { slot: t.slot, index: t.slot.blocks.length }).kind === 'move',
        )
        .map((t) => ({ path: t.slot.path, name: slotTitle(tree, t.slot) }))}
      onMoveTo={(path) => {
        const slot = findSlot(tree, path);
        return slot ? moveTo(block, { slot, index: slot.blocks.length }) : false;
      }}
      onDuplicate={() => duplicate(block)}
      onRemove={() => remove(block)}
      onAdd={(slot) => openDock({ slot, index: slot.blocks.length })}
      inSheet={!wide}
      kept={kept.has(block.key)}
      onKeep={() => setKept((k) => new Set(k).add(block.key))}
      directory={directory}
      {...(locking
        ? {
            locking: {
              run: chosenRun,
              ...(blocksDirty
                ? {
                    held: 'Save the draft first: a lock holds the blocks as they are saved.',
                  }
                : {}),
              busy,
              refused: lockRefused,
              onLock: lock,
              onUnlock: unlock,
            },
          }
        : {})}
    />
  ) : null;
  const pageBody = (
    <PagePanel
      checks={checks}
      onSelect={(key) => {
        setAnchor(null);
        setSelected(key);
        setInspectorOpen(true);
      }}
      editable={editable}
      formPath={formPath}
      stale={locksQuery.data?.stale ?? []}
      fieldName={(apiId) => contentType?.fields.find((f) => f.apiId === apiId)?.name ?? apiId}
      onClear={
        locking ? (l) => setLocks(withoutLock(locks ?? [], l), 'Cleared the lock') : undefined
      }
      busy={busy}
      directory={directory}
      refused={block ? [] : lockRefused}
    />
  );
  const layersBody = (
    <Layers
      slots={tree}
      selected={selected}
      run={locking && chosenRun.length > 1 ? chosenRun.map((b) => b.key) : undefined}
      onExtend={locking ? extend : undefined}
      directory={directory}
      onSelect={(key) => {
        setAnchor(null);
        setSelected(key);
        setDockAt(null);
      }}
      onOpen={(key) => {
        setSelected(key);
        setInspectorOpen(true);
        setFocusInspector(true);
      }}
      onAdd={editable ? (slot) => openDock({ slot, index: slot.blocks.length }) : undefined}
      {...(proposedInLayers ? { proposed: proposedInLayers } : {})}
    />
  );

  if (!doc || !contentType || rulesQuery.isPending) return <CanvasSkeleton />;

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
          <WidthSwitch presets={presets} value={preset} onChange={setPreset} />
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
        ruledFields={ruledNames}
      />
      {site.status.status === 'loading' || site.status.status === 'live' ? null : (
        <div className="border-b px-4 py-3 sm:px-5">
          <SiteNotice status={site.status} origin={site.origin} onReload={site.reload} />
        </div>
      )}
      <ProposalLine
        waiting={!!proposal}
        saving={proposal?.state === 'saving'}
        shown={site.proposal.shown}
        refused={site.proposal.refused}
        unsupported={site.live && !site.capabilities.includes('proposals')}
        className="border-b px-4 py-2 sm:px-5"
      />

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
            regions={regions}
            ghosts={ghostBoxes}
            onChooseSeam={(seam) => openDock(seam)}
            {...(drag ? { drag } : {})}
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
                  {...(dockAsk ? { ask: dockAsk } : {})}
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
            <SheetContent
              side="bottom"
              onCloseAutoFocus={(e) => {
                // Asked Coworker: focus is Coworker's prompt now, not back on the seam.
                if (!askedFromDock.current) return;
                askedFromDock.current = false;
                e.preventDefault();
              }}
            >
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
                  {...(dockAsk ? { ask: dockAsk } : {})}
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

/** Field names in a sentence: "Main, Sidebar and Footer". */
const LIST = new Intl.ListFormat('en', { type: 'conjunction' });

/** Why the canvas reviews instead of editing, and what's happening to the entry, in place. */
function Notices(props: {
  review: ReviewReason | null;
  workflow: string | null;
  geometryNote: string | null;
  onStartDraft: () => void;
  formPath: string;
  /** The blocks fields the person's role makes read-only, by name (none named when hidden). */
  ruledFields: readonly string[];
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
  } else if (props.review === 'fields') {
    lines.push(
      props.ruledFields.length ? (
        <span key="fields">
          Your role can’t change {LIST.format(props.ruledFields)}: the canvas is for review here.
          Edit the other fields in{' '}
          <Link to={props.formPath} className="underline underline-offset-2">
            the form
          </Link>
          .
        </span>
      ) : (
        // Every blocks field ruled is one the role can't read: nothing of them is drawn.
        <span key="fields">
          Your role can’t see this entry’s blocks, so there is nothing to arrange here. Edit the
          fields you can in{' '}
          <Link to={props.formPath} className="underline underline-offset-2">
            the form
          </Link>
          .
        </span>
      ),
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
  /** Locks whose blocks are gone: they hold nothing, and someone with `lock` clears them. */
  stale: readonly EntryBlockLock[];
  onClear?: (lock: EntryBlockLock) => void;
  busy: boolean;
  directory: ActorDirectory;
  /** Why the last lock set was refused, when no block is selected to say it on. */
  refused: readonly string[];
  /** A blocks field's name, by its apiId. */
  fieldName: (apiId: string) => string;
}) {
  const staleId = useId();
  /** "1 block in Main", "2 blocks in Main". */
  const what = (l: EntryBlockLock) =>
    `${l.keys.length === 1 ? '1 block' : `${l.keys.length} blocks`} in ${props.fieldName(l.field)}`;
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
      {props.stale.length > 0 ? (
        <section aria-labelledby={staleId} className="flex flex-col gap-2">
          <h3 id={staleId} className="caption">
            Locks with nothing to hold
          </h3>
          <p className="max-w-measure text-muted-foreground text-xs">
            Their blocks are gone, so they lock nothing and never stop a save.
          </p>
          <ul className="flex flex-col gap-1">
            {props.stale.map((l) => (
              <li
                key={lockId(l)}
                className="flex items-center justify-between gap-2 rounded-lg bg-secondary/40 px-2 py-1.5 text-sm"
              >
                <span className="min-w-0">
                  <span className="block truncate">{what(l)}</span>
                  <span className="block text-muted-foreground text-xs">
                    {lockedLine(l, props.directory)}
                  </span>
                </span>
                {props.onClear ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={props.busy}
                    aria-label={`Clear the lock on ${what(l)}`}
                    onClick={() => props.onClear?.(l)}
                  >
                    Clear
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {props.refused.length > 0 ? (
        <ul role="alert" className="flex flex-col gap-1 text-destructive text-xs">
          {props.refused.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
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
