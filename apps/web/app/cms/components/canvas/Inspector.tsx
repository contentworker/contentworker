/**
 * The inspector: the selected block's settings, in three tabs.
 *
 * - **Content**: the block's own fields, edited with the entry form's field editors.
 * - **Data**: what it points at: references to entries and assets.
 * - **Look**: its token props (a field limited to listed values), as segmented controls or a
 *   select. Never free CSS: a style prop is an enumeration the site's design system declares.
 *
 * A block's slots aren't fields here: blocks go into them from the page's seams (or from Add,
 * here and in Layers). Each change is one `update` op (`setPropOp`) on the block, applied on the
 * canvas at once; nothing saves until Save draft. A block the code no longer provides can't be
 * edited, only kept as it is or removed. A block in a slot the block config locks keeps its place:
 * no move, duplicate or remove, and its settings stay editable.
 */
import {
  type FieldDefinition,
  type FieldOption,
  fieldState,
  normalizeOptions,
  optionLabel,
  optionValue,
} from '@contentworker/domain';
import { Alert, AlertDescription, AlertTitle } from '@contentworker/ui/alert';
import { Button } from '@contentworker/ui/button';
import { Label } from '@contentworker/ui/label';
import { Segmented, SegmentedItem } from '@contentworker/ui/segmented';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@contentworker/ui/tabs';
import { ArrowDown, ArrowUp, Copy, Lock, Plus, Trash2 } from 'lucide-react';
import { useId } from 'react';
import { FieldInput, type Pickers, type PickOption } from '~/cms/components/EntryForm';
import { RequiredMark } from '~/cms/components/required-mark';
import {
  type CanvasBlock,
  type CanvasSlot,
  canDuplicate,
  canMove,
  slotFill,
} from '~/cms/lib/canvas/model';

export type InspectorTab = 'content' | 'data' | 'look';

/** Which tab a block prop belongs to; undefined for a slot, which isn't a field here. */
export function tabOf(f: FieldDefinition): InspectorTab | undefined {
  if (f.type === 'Array' && f.items?.type === 'Component' && f.items.variants) return undefined;
  if (f.type === 'Link' || (f.type === 'Array' && f.items?.type === 'Link')) return 'data';
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
  readonly onMove: (by: -1 | 1) => void;
  readonly onDuplicate: () => void;
  readonly onRemove: () => void;
  readonly onAdd: (slot: CanvasSlot) => void;
  /** In a sheet, whose title names the block: the heading here stays for focus, unseen. */
  readonly inSheet?: boolean;
  /** A block removed from code was kept as it is: the notice stops asking. */
  readonly kept: boolean;
  readonly onKeep: () => void;
}

export function Inspector(props: InspectorProps) {
  const { block, readOnly } = props;
  const headingId = useId();
  const fields = block.variant?.fields ?? [];
  const byTab = (tab: InspectorTab) => fields.filter((f) => tabOf(f) === tab);
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

      {readOnly ? null : block.slot.locked ? (
        <p className="flex max-w-measure items-start gap-1.5 text-muted-foreground text-xs">
          <Lock aria-hidden="true" className="mt-0.5 size-3 shrink-0" />
          {where} is locked: this block keeps its place. Its settings can still be edited.
        </p>
      ) : (
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
              {byTab(t).map((f) => (
                <Prop key={f.apiId} field={f} {...props} />
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
                {slot.locked ? <Lock aria-hidden="true" className="size-3" /> : null}
                {slotFill(slot)}
              </span>
              {slot.locked ? null : (
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
    </section>
  );
}

function Prop(props: InspectorProps & { field: FieldDefinition }) {
  const { field: f, block, readOnly } = props;
  const id = `canvas-${block.key}-${f.apiId}`;
  const state = fieldState(f, block.value as Record<string, unknown>);
  if (state.hidden) return null;
  const value = block.value[f.apiId];
  const options = normalizeOptions(f.validations?.in, f.type);
  const disabled = readOnly || state.disabled;
  if (tabOf(f) === 'look' && options.length > 0 && options.length <= SEGMENTS) {
    return (
      <div className="flex flex-col gap-1.5">
        <span id={`${id}-label`} className="font-medium text-sm">
          {f.name}
          {f.required ? <RequiredMark /> : null}
        </span>
        <Segmented
          aria-labelledby={`${id}-label`}
          value={value === undefined ? '' : String(value)}
          disabled={disabled}
          onValueChange={(v) => {
            const picked = options.find((o: FieldOption) => String(optionValue(o)) === v);
            if (picked !== undefined) props.onChange(f.apiId, optionValue(picked));
          }}
          className="w-fit"
        >
          {options.map((o) => (
            <SegmentedItem key={String(optionValue(o))} value={String(optionValue(o))}>
              {optionLabel(o)}
            </SegmentedItem>
          ))}
        </Segmented>
        {f.help ? <p className="max-w-measure text-muted-foreground text-xs">{f.help}</p> : null}
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
        hintId={f.help ? `${id}-hint` : undefined}
        pickers={props.pickers}
        locale={props.locale}
        onSearchEntries={props.onSearchEntries}
        onChange={(v) => props.onChange(f.apiId, v)}
      />
      {f.help ? (
        <p id={`${id}-hint`} className="max-w-measure text-muted-foreground text-xs">
          {f.help}
        </p>
      ) : null}
    </div>
  );
}
