/**
 * The inspector: the selected block's settings, in three tabs.
 *
 * - **Content**: the block's own fields, edited with the entry form's field editors.
 * - **Data**: what it points at: references to entries and assets.
 * - **Look**: its token props (a field limited to listed values), as segmented controls or a
 *   select, and the Booleans it lists in `responsive`. Never free CSS: a style prop is an
 *   enumeration the site's design system declares.
 *
 * The Look tab edits the breakpoint in view (docs/specs/breakpoint-overrides.md): the one the
 * frame's width is in, for a block whose field has the catalog's breakpoints. At Base it sets the
 * bare prop. At a breakpoint, a prop in the variant's `responsive` shows what it inherits and from
 * where until it is given its own value, an override (`setOverrideOp`), which Reset takes away;
 * any other prop is the same at every width and is edited at Base only.
 *
 * A block's slots aren't fields here: blocks go into them from the page's seams (or from Add,
 * here and in Layers). Each change is one `update` op (`setPropOp`) on the block, applied on the
 * canvas at once; nothing saves until Save draft. A block the code no longer provides can't be
 * edited, only kept as it is or removed. A block in a slot the block config locks keeps its place:
 * no move, duplicate or remove, and its settings stay editable.
 *
 * A block in a locked region of the entry (`cms/lib/block-locks.ts`) keeps its place the same way,
 * and says who locked it; with the content frozen its settings read only. For someone with the
 * `lock` action on the type, the inspector offers **Lock** on the selected block (or the run
 * selected with it in one slot), **Unlock** on a locked one. A lock is its own request, not the
 * draft's save: it is keyed to stored blocks, so it waits for unsaved block changes to be saved.
 */
import {
  type Breakpoint,
  type FieldDefinition,
  type FieldOption,
  fieldState,
  normalizeOptions,
  optionLabel,
  optionValue,
  responsivePropsOf,
} from '@contentworker/domain';
import { Alert, AlertDescription, AlertTitle } from '@contentworker/ui/alert';
import { Button } from '@contentworker/ui/button';
import { Checkbox } from '@contentworker/ui/checkbox';
import { Label } from '@contentworker/ui/label';
import { Segmented, SegmentedItem } from '@contentworker/ui/segmented';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@contentworker/ui/tabs';
import { ArrowDown, ArrowUp, Copy, Lock, LockOpen, Plus, Trash2 } from 'lucide-react';
import { useId, useState } from 'react';
import { FieldInput, type Pickers, type PickOption } from '~/cms/components/EntryForm';
import { RequiredMark } from '~/cms/components/required-mark';
import type { ActorDirectory } from '~/cms/lib/authorship';
import { lockedLine, lockSays } from '~/cms/lib/block-locks';
import {
  BASE_NAME,
  baseInView,
  breakpointFor,
  overridesOf,
  valueAt,
  type WidthPreset,
} from '~/cms/lib/breakpoints';
import {
  type CanvasBlock,
  type CanvasSlot,
  canDuplicate,
  canMove,
  slotFill,
  slotHeld,
} from '~/cms/lib/canvas/model';
import type { BlockLockInput, EntryBlockLock } from '~/cms/lib/management';

export type InspectorTab = 'content' | 'data' | 'look';

/**
 * Which tab a block prop belongs to; undefined for a slot, which isn't a field here. A Boolean
 * the block lists in `responsive` is a look: it changes per breakpoint as the tokens do.
 */
export function tabOf(
  f: FieldDefinition,
  responsive: readonly string[] = [],
): InspectorTab | undefined {
  if (f.type === 'Array' && f.items?.type === 'Component' && f.items.variants) return undefined;
  if (f.type === 'Link' || (f.type === 'Array' && f.items?.type === 'Link')) return 'data';
  if (f.type === 'Boolean' && responsive.includes(f.apiId)) return 'look';
  if (
    (f.type === 'Symbol' || f.type === 'Integer' || f.type === 'Number') &&
    normalizeOptions(f.validations?.in, f.type).length > 0
  ) {
    return 'look';
  }
  return 'content';
}

const TAB_LABEL: Record<InspectorTab, string> = { content: 'Content', data: 'Data', look: 'Look' };

/** A token prop with this many choices or fewer is a segmented control; more is a select. */
const SEGMENTS = 4;

export interface InspectorProps {
  readonly block: CanvasBlock;
  readonly locale: string;
  readonly pickers: Pickers;
  readonly onSearchEntries?: (
    query: string,
    contentTypes?: readonly string[],
  ) => Promise<PickOption[]>;
  /** Read-only: the canvas is reviewing, not editing. */
  readonly readOnly: boolean;
  readonly tab: InspectorTab;
  readonly onTab: (tab: InspectorTab) => void;
  readonly onChange: (prop: string, value: unknown) => void;
  /** The frame's width preset: the Look tab edits the breakpoint it stands for. Absent, Base. */
  readonly preset?: Pick<WidthPreset, 'id' | 'width'>;
  /** Gives `prop` its own value at breakpoint `bp`, or (undefined) lets it inherit again. */
  readonly onOverride?: (bp: string, prop: string, value: unknown) => void;
  readonly onMove: (by: -1 | 1) => void;
  readonly onDuplicate: () => void;
  readonly onRemove: () => void;
  readonly onAdd: (slot: CanvasSlot) => void;
  /** In a sheet, whose title names the block: the heading here stays for focus, unseen. */
  readonly inSheet?: boolean;
  /** A block removed from code was kept as it is: the notice stops asking. */
  readonly kept: boolean;
  readonly onKeep: () => void;
  /** Who's who, for "Locked by …". */
  readonly directory?: ActorDirectory;
  /** Lock and Unlock, for someone with the `lock` action on the type; absent for anyone else. */
  readonly locking?: LockingProps;
}

export interface LockingProps {
  /** The blocks a Lock takes: the selected one, and the neighbours shift-selected with it. */
  readonly run: readonly CanvasBlock[];
  /** Why nothing can be locked now (unsaved block changes), or undefined. */
  readonly held?: string;
  readonly busy: boolean;
  /** Why the last lock or unlock was refused, in the inspector's words. */
  readonly refused: readonly string[];
  readonly onLock: (lock: BlockLockInput) => void;
  readonly onUnlock: (lock: EntryBlockLock) => void;
}

export function Inspector(props: InspectorProps) {
  const { block, readOnly } = props;
  const headingId = useId();
  const fields = block.variant?.fields ?? [];
  const responsive = responsivePropsOf(block.variant);
  const byTab = (tab: InspectorTab) => fields.filter((f) => tabOf(f, responsive) === tab);
  const breakpoints = block.slot.breakpoints;
  // Absent a preset, Base: the bare props, as without breakpoints.
  const at = props.preset ? breakpointFor(breakpoints, props.preset) : null;
  const tabs = (['content', 'data', 'look'] as const).filter((t) => byTab(t).length > 0);
  const tab = tabs.includes(props.tab) ? props.tab : (tabs[0] ?? 'content');
  const where = block.slot.name;

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-4">
      <div>
        {/* Focus lands here when a block arrives from the dock: the dock it came from is gone. */}
        <h2
          id={headingId}
          tabIndex={-1}
          data-inspector-heading
          className="section-title outline-none"
        >
          {block.name}
        </h2>
        <p className="text-muted-foreground text-xs">
          In {where}, {block.index + 1} of {block.slot.blocks.length}
        </p>
      </div>

      {block.lock ? (
        // Said in review too: why the page holds still is worth knowing either way.
        <div data-block-lock className="flex max-w-measure flex-col gap-1 text-xs">
          <p className="flex items-start gap-1.5 text-muted-foreground">
            <Lock aria-hidden="true" className="mt-0.5 size-3 shrink-0" />
            {lockSays(block.lock, block.name)}
          </p>
          <p className="pl-4.5 text-muted-foreground">
            {lockedLine(block.lock.region.lock, props.directory)}
          </p>
        </div>
      ) : readOnly ? null : block.slot.locked ? (
        <p className="flex max-w-measure items-start gap-1.5 text-muted-foreground text-xs">
          <Lock aria-hidden="true" className="mt-0.5 size-3 shrink-0" />
          {where} is locked: this block keeps its place. Its settings can still be edited.
        </p>
      ) : null}
      {readOnly || block.lock || block.slot.locked ? null : (
        <div className="flex flex-wrap gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Move ${block.name} up`}
            title="Move up (⌘↑)"
            disabled={!canMove(block, -1)}
            onClick={() => props.onMove(-1)}
          >
            <ArrowUp aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Move ${block.name} down`}
            title="Move down (⌘↓)"
            disabled={!canMove(block, 1)}
            onClick={() => props.onMove(1)}
          >
            <ArrowDown aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Duplicate ${block.name}`}
            title={
              block.slot.full
                ? `${where} is full`
                : canDuplicate(block) || !block.variant
                  ? 'Duplicate'
                  : `The block config doesn’t allow another ${block.name} in ${where}`
            }
            disabled={!canDuplicate(block)}
            onClick={props.onDuplicate}
          >
            <Copy aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Remove ${block.name}`}
            title="Remove (Delete)"
            className="text-destructive hover:text-destructive"
            onClick={props.onRemove}
          >
            <Trash2 aria-hidden="true" />
          </Button>
        </div>
      )}

      {block.variant ? null : (
        <Alert variant={props.kept ? 'default' : 'destructive'}>
          <AlertTitle className="line-clamp-none">Removed from code</AlertTitle>
          <AlertDescription>
            <p>
              The site no longer provides <span className="font-mono">{block.type}</span> in {where}
              , so it can’t be edited here, and the entry can’t be saved while it holds it.
            </p>
            {readOnly ? null : (
              <div className="flex flex-wrap gap-2">
                {block.slot.locked ? (
                  <p className="w-full">
                    {where} is locked, so it can’t be removed here: an admin can unlock it in Build
                    → Blocks.
                  </p>
                ) : block.lock ? (
                  <p className="w-full">
                    It is in a locked region, so it can’t be removed here until it is unlocked.
                  </p>
                ) : (
                  <Button type="button" size="sm" variant="outline" onClick={props.onRemove}>
                    Remove
                  </Button>
                )}
                {props.kept ? null : (
                  <Button type="button" size="sm" variant="ghost" onClick={props.onKeep}>
                    Keep for now
                  </Button>
                )}
              </div>
            )}
          </AlertDescription>
        </Alert>
      )}

      {block.variant && tabs.length > 0 ? (
        <Tabs value={tab} onValueChange={(v) => props.onTab(v as InspectorTab)}>
          <TabsList>
            {tabs.map((t) => (
              <TabsTrigger key={t} value={t}>
                {TAB_LABEL[t]}
              </TabsTrigger>
            ))}
          </TabsList>
          {tabs.map((t) => (
            <TabsContent key={t} value={t} className="flex flex-col gap-4 pt-3">
              {t === 'look' && breakpoints.length > 0 ? (
                <p className="max-w-measure text-muted-foreground text-xs">
                  {at ? (
                    <>
                      Editing <b className="font-medium text-foreground">{at.name}</b>, from{' '}
                      {at.minWidth}px up. Change the width above the page to edit another.
                    </>
                  ) : (
                    <>
                      Editing <b className="font-medium text-foreground">{BASE_NAME}</b>
                      {baseInView(breakpoints)
                        ? ': every width shows it unless a breakpoint changes it.'
                        : `: no width shows it, as ${breakpoints[0]?.name} starts at 1px. A frontend that reads no breakpoints shows it.`}
                    </>
                  )}
                </p>
              ) : null}
              {byTab(t).map((f) => (
                <Prop
                  key={f.apiId}
                  field={f}
                  {...props}
                  look={
                    t === 'look' && breakpoints.length > 0
                      ? { at, breakpoints, responsive: responsive.includes(f.apiId) }
                      : undefined
                  }
                />
              ))}
            </TabsContent>
          ))}
        </Tabs>
      ) : block.variant ? (
        <p className="text-muted-foreground text-sm">This block has no settings of its own.</p>
      ) : null}

      {block.variant && block.slots.length > 0 && !readOnly ? (
        <div className="flex flex-col gap-1">
          <h3 className="caption">Slots</h3>
          {block.slots.map((slot) => (
            <div key={slot.path} className="flex items-center justify-between gap-2 text-sm">
              <span className="inline-flex items-center gap-1.5">
                {slotHeld(slot) ? <Lock aria-hidden="true" className="size-3" /> : null}
                {slotFill(slot)}
              </span>
              {slotHeld(slot) ? null : (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  // A full slot's dock says so, as its seam does.
                  onClick={() => props.onAdd(slot)}
                >
                  <Plus aria-hidden="true" /> Add to {slot.name}
                </Button>
              )}
            </div>
          ))}
        </div>
      ) : null}

      {props.locking && block.variant ? (
        // Keyed by block: the choices start over for each one.
        <LockPanel key={block.key} block={block} directory={props.directory} {...props.locking} />
      ) : null}
    </section>
  );
}

/**
 * Lock on a block (or the run shift-selected with it), Unlock on one a region names. A block inside
 * another's region is that region's: it is unlocked from there.
 */
function LockPanel(props: LockingProps & { block: CanvasBlock; directory?: ActorDirectory }) {
  const { block, run } = props;
  const headingId = useId();
  const freezeId = useId();
  const reasonId = useId();
  const [depth, setDepth] = useState<'subtree' | 'self'>('subtree');
  const [freeze, setFreeze] = useState(false);
  const mark = block.lock;
  if (mark && !mark.own) return null;
  const errors =
    props.refused.length > 0 ? (
      <ul role="alert" className="flex flex-col gap-1 text-destructive text-xs">
        {props.refused.map((m) => (
          <li key={m}>{m}</li>
        ))}
      </ul>
    ) : null;

  if (mark) {
    const { lock } = mark.region;
    const many = lock.keys.length > 1;
    return (
      <section aria-labelledby={headingId} className="flex flex-col gap-2">
        <h3 id={headingId} className="caption">
          Lock
        </h3>
        <p className="max-w-measure text-muted-foreground text-xs">
          {many
            ? `Locked with ${lock.keys.length - 1} ${lock.keys.length === 2 ? 'neighbour' : 'neighbours'}: unlocking frees them all.`
            : 'Unlocking lets editors move, remove and add blocks here again.'}
        </p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="self-start"
          disabled={props.busy}
          onClick={() => props.onUnlock(lock)}
        >
          <LockOpen aria-hidden="true" /> Unlock
        </Button>
        {errors}
      </section>
    );
  }

  const blocks = run.length > 0 ? run : [block];
  const many = blocks.length > 1;
  // A block already in a region, or holding a region inside it, can't be in another.
  const taken = blocks.find((b) => b.lock);
  const reason = props.held ?? (taken ? `${taken.name} is already in a locked region.` : undefined);
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h3 id={headingId} className="caption">
          Lock
        </h3>
        <p className="max-w-measure text-muted-foreground text-xs">
          {many
            ? `${blocks.length} blocks together: ${blocks.map((b) => b.name).join(', ')}.`
            : `${
                depth === 'subtree'
                  ? 'Keeps this block where it is, and the blocks inside it as they are, until it is unlocked.'
                  : 'Keeps this block where it is until it is unlocked; blocks inside it can still change.'
              } Shift-click a neighbour in Layers to lock several together.`}
        </p>
      </div>
      <Segmented
        aria-label="What the lock holds"
        orientation="vertical"
        value={depth}
        onValueChange={(v) => setDepth(v as 'subtree' | 'self')}
        className="w-full grid-flow-row auto-rows-fr rounded-2xl"
      >
        <SegmentedItem
          value="subtree"
          className="justify-start rounded-xl whitespace-normal text-left"
        >
          {many ? 'These blocks and everything inside' : 'This block and everything inside'}
        </SegmentedItem>
        <SegmentedItem
          value="self"
          className="justify-start rounded-xl whitespace-normal text-left"
        >
          {many ? 'Only these blocks' : 'Only this block'}
        </SegmentedItem>
      </Segmented>
      <div className="flex items-start gap-2">
        <Checkbox
          id={freezeId}
          aria-label="Also freeze the content"
          checked={freeze}
          onCheckedChange={(on) => setFreeze(on === true)}
          className="mt-0.5"
        />
        <div className="flex flex-col gap-0.5">
          <Label htmlFor={freezeId}>Also freeze the content</Label>
          <p className="max-w-measure text-muted-foreground text-xs">
            No one can edit what it says either.
          </p>
        </div>
      </div>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="self-start"
        disabled={props.busy || reason !== undefined}
        aria-describedby={reason ? reasonId : undefined}
        onClick={() =>
          props.onLock({
            field: block.slot.address.field,
            keys: blocks.map((b) => b.key),
            depth,
            freeze: freeze ? 'all' : 'structure',
          })
        }
      >
        <Lock aria-hidden="true" /> {many ? `Lock ${blocks.length} blocks` : 'Lock'}
      </Button>
      {reason ? (
        <p id={reasonId} className="max-w-measure text-muted-foreground text-xs">
          {reason}
        </p>
      ) : null}
      {errors}
    </section>
  );
}

/** A Look prop on a block whose field has breakpoints: the one in view, and whether it takes one. */
interface LookAt {
  readonly at: Breakpoint | null;
  readonly breakpoints: readonly Breakpoint[];
  /** The variant lists it in `responsive`. */
  readonly responsive: boolean;
}

function Prop(props: InspectorProps & { field: FieldDefinition; look: LookAt | undefined }) {
  const { field: f, block, readOnly, look } = props;
  const id = `canvas-${block.key}-${f.apiId}`;
  const state = fieldState(f, block.value as Record<string, unknown>);
  if (state.hidden) return null;
  const options = normalizeOptions(f.validations?.in, f.type);
  // At a breakpoint: what a responsive prop is there, set or inherited. Otherwise the bare prop.
  const bp = look?.at ?? null;
  const here = bp && look?.responsive ? valueAt(block.value, f.apiId, look.breakpoints, bp) : null;
  const value = here ? here.value : block.value[f.apiId];
  // A frozen region's content reads only, as a disabling rule's does.
  const frozen = readOnly || state.disabled || !!block.lock?.frozen;
  // The same at every width: at a breakpoint it reads only, and is edited at Base.
  const disabled = frozen || (!!bp && !here);
  const change = (v: unknown) => {
    if (bp && here) props.onOverride?.(bp.id, f.apiId, v);
    else props.onChange(f.apiId, v);
  };
  const noteId = `${id}-width`;
  const note = look ? (
    <WidthNote
      id={noteId}
      field={f}
      block={block.value}
      look={look}
      here={here}
      onReset={
        bp && here?.set && !frozen
          ? () => {
              props.onOverride?.(bp.id, f.apiId, undefined);
              // Reset goes with the override: focus moves to the prop's control, not the page.
              queueMicrotask(() => focusProp(id));
            }
          : undefined
      }
    />
  ) : null;
  const describedBy =
    [note ? noteId : undefined, f.help ? `${id}-hint` : undefined].filter(Boolean).join(' ') ||
    undefined;
  if (tabOf(f) === 'look' && options.length > 0 && options.length <= SEGMENTS) {
    return (
      <div data-prop={id} className="flex flex-col gap-1.5">
        <span id={`${id}-label`} className="font-medium text-sm">
          {f.name}
          {f.required ? <RequiredMark /> : null}
        </span>
        <Segmented
          aria-labelledby={`${id}-label`}
          aria-describedby={describedBy}
          value={value === undefined ? '' : String(value)}
          disabled={disabled}
          onValueChange={(v) => {
            const picked = options.find((o: FieldOption) => String(optionValue(o)) === v);
            if (picked !== undefined) change(optionValue(picked));
          }}
          className="w-fit"
        >
          {options.map((o) => (
            <SegmentedItem key={String(optionValue(o))} value={String(optionValue(o))}>
              {optionLabel(o)}
            </SegmentedItem>
          ))}
        </Segmented>
        {note}
        {f.help ? (
          <p id={`${id}-hint`} className="max-w-measure text-muted-foreground text-xs">
            {f.help}
          </p>
        ) : null}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      <Label id={`${id}-label`} htmlFor={id} className="gap-1">
        {f.name}
        {f.required ? <RequiredMark /> : null}
      </Label>
      <FieldInput
        id={id}
        field={f}
        value={value}
        disabled={disabled}
        hintId={describedBy}
        pickers={props.pickers}
        locale={props.locale}
        onSearchEntries={props.onSearchEntries}
        onChange={change}
      />
      {note}
      {f.help ? (
        <p id={`${id}-hint`} className="max-w-measure text-muted-foreground text-xs">
          {f.help}
        </p>
      ) : null}
    </div>
  );
}

/** Focuses a prop's control: a segmented one's chosen segment (else its first), or its input. */
function focusProp(id: string) {
  const group = [...document.querySelectorAll<HTMLElement>('[data-prop]')].find(
    (el) => el.dataset.prop === id,
  );
  const radios = group ? [...group.querySelectorAll<HTMLElement>('[role="radio"]')] : [];
  const target =
    radios.find((r) => r.getAttribute('aria-checked') === 'true') ??
    radios[0] ??
    document.getElementById(id);
  target?.focus();
}

/**
 * Where a Look prop's value comes from at the width in view: set here (marked in brand, what was
 * chosen, with Reset), inherited ("From Base", "From Tablet"), the same at every width, or, at
 * Base, the breakpoints that give it a value of their own.
 */
function WidthNote(props: {
  id: string;
  field: FieldDefinition;
  block: Readonly<Record<string, unknown>>;
  look: LookAt;
  here: ReturnType<typeof valueAt> | null;
  onReset: (() => void) | undefined;
}) {
  const { look, here } = props;
  if (look.at && !here) {
    return (
      <p id={props.id} className="max-w-measure text-muted-foreground text-xs">
        Same at every width: change it at {BASE_NAME}.
      </p>
    );
  }
  if (look.at && here?.set) {
    return (
      <div className="flex items-center gap-2 text-xs">
        <p
          id={props.id}
          data-override
          className="inline-flex items-center gap-1.5 font-medium text-brand"
        >
          <span aria-hidden="true" className="size-1.5 rounded-full bg-brand" />
          Set for {look.at.name}
        </p>
        {props.onReset ? (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            aria-label={`Reset ${props.field.name} at ${look.at.name}`}
            title={`Inherit ${props.field.name} again`}
            onClick={props.onReset}
          >
            Reset
          </Button>
        ) : null}
      </div>
    );
  }
  if (here) {
    return (
      <p id={props.id} className="text-muted-foreground text-xs">
        From {here.from?.name ?? BASE_NAME}
      </p>
    );
  }
  if (!look.responsive) return null;
  const overrides = overridesOf(props.block);
  const changes = look.breakpoints.filter((b) =>
    Object.hasOwn(overrides[b.id] ?? {}, props.field.apiId),
  );
  if (changes.length === 0) return null;
  return (
    <p id={props.id} className="max-w-measure text-muted-foreground text-xs">
      Changes at {changes.map((b) => b.name).join(', ')}
    </p>
  );
}
