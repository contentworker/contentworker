import {
  blockVariants,
  type ContentType,
  type ContentTypeDraft,
  FIELD_TYPES,
  type FieldDefinition,
  type FieldType,
  isValidApiId,
  UNIQUE_FIELD_TYPES,
} from '@contentworker/domain';
import { Button } from '@contentworker/ui/button';
import { Checkbox } from '@contentworker/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@contentworker/ui/dialog';
import { Input } from '@contentworker/ui/input';
import { Label } from '@contentworker/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@contentworker/ui/select';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toApiId } from '../lib/api-id';
import {
  BlockVariantsEditor,
  newVariant,
  type VariantRow,
  variantRowsFrom,
  variantRowsProblem,
  variantsFromRows,
} from './BlockVariantsEditor';

interface FieldRow {
  name: string;
  apiId: string;
  apiIdTouched: boolean;
  type: FieldType;
  required: boolean;
  localized: boolean;
  unique?: boolean;
  /**
   * Set when the field is a blocks field: an `Array` of `Component` whose
   * elements take one of these shapes. Offered in the type menu as "Blocks".
   */
  blocks?: VariantRow[];
  /**
   * The definition this row was loaded from, if any.
   *
   * This dialog edits six attributes; a definition has more than a dozen —
   * `linkType`, `items`, `validations`, `defaultValue`, a component's nested
   * `fields`. Rebuilding the field from the row alone silently discarded all of
   * them, so editing a field's name through the admin quietly destroyed
   * configuration made through the API. Everything not edited here is carried
   * through untouched.
   */
  source?: FieldDefinition;
}

/**
 * Types this dialog cannot fully define, so it does not offer to create them.
 *
 * A `Component` needs nested field definitions, and a component with none is
 * refused by the domain. Offering the type without a way to give it a shape
 * would only produce a save that fails. Existing component fields still load,
 * edit and round-trip — they just get their shape from wherever it was
 * authored (the API or MCP).
 */
const UNBUILDABLE_TYPES: readonly FieldType[] = ['Component'];

/**
 * The type menu's entry for a blocks field. Not a field type of its own: it is
 * an `Array` of `Component` with variants, which is what gets saved.
 */
const BLOCKS = 'Blocks';

const newField = (): FieldRow => ({
  name: '',
  apiId: '',
  apiIdTouched: false,
  type: 'Symbol',
  required: false,
  localized: false,
});

/**
 * Builds the definition to save from an edited row.
 *
 * Configuration this dialog does not edit — `linkType`, `items`, `validations`,
 * `defaultValue`, a component's nested `fields` — rides along from the original
 * definition, except when the type changed: that configuration described the
 * old type, and carrying `items` onto a Symbol (or nested `fields` onto
 * anything but a component) is refused by the domain anyway.
 */
function toDefinition(row: FieldRow, position: number): FieldDefinition {
  // Turning a list into blocks (or back) is a change of type too: the old
  // `items` described elements of the other kind.
  const wasBlocks = row.source ? blockVariants(row.source) !== undefined : false;
  const retyped =
    row.source && (row.source.type !== row.type || wasBlocks !== (row.blocks !== undefined));
  const { linkType, items, fields, validations, defaultValue, ...rest } = row.source ?? {};
  const blocksItems = row.blocks
    ? {
        ...(retyped ? {} : { validations: items?.validations }),
        type: 'Component' as const,
        variants: variantsFromRows(row.blocks),
      }
    : undefined;
  return {
    ...rest,
    ...(retyped ? {} : { linkType, items, fields, validations, defaultValue }),
    ...(blocksItems ? { items: blocksItems } : {}),
    apiId: row.apiId,
    name: row.name.trim(),
    type: row.type,
    required: row.required,
    localized: row.localized,
    // Omitted rather than sent as false, so the payload stays the shape the API
    // documents for types that cannot be unique.
    unique: row.unique ? true : undefined,
    position,
  } as FieldDefinition;
}

function fromContentType(ct: ContentType): { name: string; apiId: string; fields: FieldRow[] } {
  return {
    name: ct.name,
    apiId: ct.apiId,
    fields: ct.fields.map((f) => ({
      name: f.name,
      apiId: f.apiId,
      apiIdTouched: true,
      type: f.type,
      required: f.required,
      localized: f.localized,
      unique: f.unique,
      ...(blockVariants(f) ? { blocks: variantRowsFrom(blockVariants(f) ?? []) } : {}),
      source: f,
    })),
  };
}

/**
 * Create or edit a content type and its fields. The save route is idempotent on
 * apiId, so the same dialog serves both (pass `initial` to edit). On save the
 * type is published so entries can be authored immediately.
 */
export function ContentTypeDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial?: ContentType;
  onSave: (draft: ContentTypeDraft) => Promise<void>;
}) {
  const editing = Boolean(props.initial);
  const seed = props.initial
    ? fromContentType(props.initial)
    : {
        name: '',
        apiId: '',
        fields: [
          {
            name: 'Title',
            apiId: 'title',
            apiIdTouched: true,
            type: 'Symbol' as FieldType,
            required: true,
            localized: true,
          },
        ],
      };

  const [name, setName] = useState(seed.name);
  const [apiId, setApiId] = useState(seed.apiId);
  const [apiIdTouched, setApiIdTouched] = useState(editing);
  const [fields, setFields] = useState<FieldRow[]>(seed.fields);
  const [displayField, setDisplayField] = useState(props.initial?.displayField ?? 'title');
  const [urlPattern, setUrlPattern] = useState(props.initial?.urlPattern ?? '');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const setField = (i: number, patch: Partial<FieldRow>) =>
    setFields((prev) => prev.map((f, idx) => (idx === i ? { ...f, ...patch } : f)));

  const namedFields = fields.filter((f) => f.apiId && f.name);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(undefined);
    const finalApiId = apiId || toApiId(name);
    if (!name.trim() || !isValidApiId(finalApiId)) {
      setError('A name and a valid API ID (letter, then letters/numbers/_) are required.');
      return;
    }
    if (namedFields.length === 0) {
      setError('Add at least one field.');
      return;
    }
    const apiIds = namedFields.map((f) => f.apiId);
    if (new Set(apiIds).size !== apiIds.length) {
      setError('Field API IDs must be unique.');
      return;
    }
    if (!apiIds.includes(displayField)) {
      setError('The display field must be one of the fields.');
      return;
    }
    for (const f of namedFields) {
      const problem = f.blocks ? variantRowsProblem(f.name, f.blocks) : null;
      if (problem) {
        setError(problem);
        return;
      }
    }
    setBusy(true);
    try {
      await props.onSave({
        apiId: finalApiId,
        name: name.trim(),
        displayField,
        fields: namedFields.map(toDefinition),
        // Cleared with null: left out, a saved pattern would stay.
        urlPattern: urlPattern.trim() || null,
      });
      props.onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{editing ? 'Edit content type' : 'New content type'}</DialogTitle>
          <DialogDescription>
            Define the schema for a class of entries. Saving publishes it so you can author entries.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="ct-name">Name</Label>
              <Input
                id="ct-name"
                value={name}
                placeholder="Blog Post"
                onChange={(e) => {
                  setName(e.target.value);
                  if (!apiIdTouched) setApiId(toApiId(e.target.value));
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ct-apiid">API ID</Label>
              <Input
                id="ct-apiid"
                value={apiId}
                placeholder="blogPost"
                disabled={editing}
                className="font-mono"
                onChange={(e) => {
                  setApiIdTouched(true);
                  setApiId(e.target.value);
                }}
              />
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Fields</Label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setFields((f) => [...f, newField()])}
              >
                <Plus className="size-4" /> Add field
              </Button>
            </div>
            <div className="space-y-2">
              {fields.map((f, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: field rows have no stable id pre-save
                <div key={i} className="flex flex-wrap items-end gap-2 rounded-lg border p-2">
                  <div className="flex-1 space-y-1">
                    {/* The <span> is a visual heading only — it labels nothing
                        programmatically, and these rows repeat, so each input
                        names itself and says which field it belongs to. */}
                    <span className="text-xs text-muted-foreground">Name</span>
                    <Input
                      aria-label={`Name for field ${i + 1}`}
                      value={f.name}
                      placeholder="Title"
                      onChange={(e) =>
                        setField(i, {
                          name: e.target.value,
                          ...(f.apiIdTouched ? {} : { apiId: toApiId(e.target.value) }),
                        })
                      }
                    />
                  </div>
                  <div className="w-32 space-y-1">
                    <span className="text-xs text-muted-foreground">API ID</span>
                    <Input
                      aria-label={`API ID for ${f.name || `field ${i + 1}`}`}
                      value={f.apiId}
                      className="font-mono text-xs"
                      onChange={(e) => setField(i, { apiId: e.target.value, apiIdTouched: true })}
                    />
                  </div>
                  <div className="w-28 space-y-1">
                    <span className="text-xs text-muted-foreground">Type</span>
                    <Select
                      value={f.blocks ? BLOCKS : f.type}
                      onValueChange={(v) =>
                        setField(
                          i,
                          v === BLOCKS
                            ? { type: 'Array', blocks: f.blocks ?? [newVariant()] }
                            : { type: v as FieldType, blocks: undefined },
                        )
                      }
                    >
                      <SelectTrigger
                        aria-label={`Type for ${f.name || f.apiId || 'field'}`}
                        size="sm"
                        className="w-full"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {FIELD_TYPES.filter(
                          (t) =>
                            (!UNBUILDABLE_TYPES.includes(t) || f.type === t) &&
                            // A type has one Seo field: offered until another row is one.
                            (t !== 'Seo' ||
                              f.type === 'Seo' ||
                              !fields.some((g) => g.type === 'Seo')),
                        ).map((t) => (
                          <SelectItem key={t} value={t}>
                            {t}
                          </SelectItem>
                        ))}
                        <SelectItem value={BLOCKS}>{BLOCKS}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  {/* A wrapping label does not name a <button role="checkbox">
                      (see Settings.tsx). The names spell the abbreviations out:
                      "Req" and "Loc" are fine to read in a dense row but poor to
                      hear, and they repeat per field, so each says which one. */}
                  <Label className="h-9 gap-1.5 font-normal">
                    <Checkbox
                      aria-label={`${f.name || f.apiId || 'Field'}: required`}
                      checked={f.required}
                      onCheckedChange={(c) => setField(i, { required: c === true })}
                    />
                    Req
                  </Label>
                  <Label className="h-9 gap-1.5 font-normal">
                    <Checkbox
                      aria-label={`${f.name || f.apiId || 'Field'}: localized`}
                      checked={f.localized}
                      onCheckedChange={(c) => setField(i, { localized: c === true })}
                    />
                    Loc
                  </Label>
                  {/* Only offered where it can be enforced — the server refuses
                      `unique` on types with no single comparable value. */}
                  {UNIQUE_FIELD_TYPES.includes(f.type) && (
                    <Label className="h-9 gap-1.5 font-normal">
                      <Checkbox
                        aria-label={`${f.name || f.apiId || 'Field'}: unique`}
                        checked={f.unique === true}
                        onCheckedChange={(c) => setField(i, { unique: c === true })}
                      />
                      Uniq
                    </Label>
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label="Remove field"
                    onClick={() => setFields((prev) => prev.filter((_, idx) => idx !== i))}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                  {f.blocks && (
                    <BlockVariantsEditor
                      fieldLabel={f.name || f.apiId || `field ${i + 1}`}
                      value={f.blocks}
                      onChange={(blocks) => setField(i, { blocks })}
                    />
                  )}
                </div>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="ct-display">Display field</Label>
            <Select value={displayField} onValueChange={setDisplayField}>
              <SelectTrigger id="ct-display" className="w-64">
                <SelectValue placeholder="Pick a field" />
              </SelectTrigger>
              <SelectContent>
                {namedFields.map((f) => (
                  <SelectItem key={f.apiId} value={f.apiId}>
                    {f.name} ({f.apiId})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="ct-url">URL pattern</Label>
            <Input
              id="ct-url"
              className="max-w-sm font-mono"
              placeholder="/blog/{slug}"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              aria-describedby="ct-url-hint"
              value={urlPattern}
              onChange={(e) => setUrlPattern(e.target.value)}
            />
            <p id="ct-url-hint" className="max-w-measure text-muted-foreground text-ui">
              Where entries live on your site: {'{id}'}, {'{locale}'} or a Slug field’s API ID.
              Publishing a changed slug then redirects the old path. Optional.
            </p>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => props.onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? 'Saving…' : editing ? 'Save changes' : 'Create content type'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
