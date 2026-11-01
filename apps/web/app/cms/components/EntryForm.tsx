import type {
  ContentType,
  EntryFields,
  FieldDefinition,
  LocaleConfig,
} from '@contentworker/domain';
import { fallbackChain, resolveLocalizedValue, validateEntryFields } from '@contentworker/domain';
import { Badge } from '@contentworker/ui/badge';
import { Button } from '@contentworker/ui/button';
import { Card, CardContent } from '@contentworker/ui/card';
import { Checkbox } from '@contentworker/ui/checkbox';
import { Input } from '@contentworker/ui/input';
import { Label } from '@contentworker/ui/label';
import { Textarea } from '@contentworker/ui/textarea';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { AppExtension } from '../lib/management';
import { EntityPicker } from './EntityPicker';
import { ExtensionFrame } from './ExtensionFrame';
import { RichTextEditor } from './RichTextEditor';

const SCALAR = new Set(['Symbol', 'Slug', 'Text', 'Integer', 'Number', 'Boolean', 'Date']);

/** A selectable reference target (entry or asset). */
export interface PickOption {
  readonly id: string;
  readonly label: string;
  readonly contentType?: string;
}

export interface Pickers {
  readonly entries: PickOption[];
  readonly assets: PickOption[];
}

/** Per-field, per-locale working state: `{ apiId: { locale: value } }`. */
type Values = Record<string, Record<string, unknown>>;

/** Per-field, per-locale validation messages from the domain validator. */
type FieldErrors = Record<string, string>;

function errorKey(apiId: string, locale: string): string {
  return `${apiId}:${locale}`;
}

function fieldsFromValues(
  contentType: ContentType,
  values: Values,
  locales: readonly string[],
  defaultLocale: string,
): EntryFields {
  const out: EntryFields = {};
  for (const f of contentType.fields) {
    const byLocale = values[f.apiId] ?? {};
    const fieldLocales = f.localized ? locales : [defaultLocale];
    const cleaned: Record<string, unknown> = {};
    for (const loc of fieldLocales) {
      const v = byLocale[loc];
      if (v !== undefined && v !== '') cleaned[loc] = v;
    }
    if (Object.keys(cleaned).length > 0) out[f.apiId] = cleaned;
  }
  return out;
}

function issuesToErrors(
  issues: ReturnType<typeof validateEntryFields>,
  defaultLocale: string,
): FieldErrors {
  const out: FieldErrors = {};
  for (const issue of issues) {
    const locale = issue.locale ?? defaultLocale;
    out[errorKey(issue.field, locale)] = issue.message;
  }
  return out;
}

function formatFallbackPreview(value: unknown): string {
  if (typeof value === 'string') {
    return value.length > 80 ? `${value.slice(0, 77)}…` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '…';
}

function fallbackHint(
  field: FieldDefinition,
  values: Values,
  locale: string,
  localeConfig: LocaleConfig,
): string | undefined {
  if (!field.localized || locale === localeConfig.defaultLocale) return undefined;
  const byLocale = values[field.apiId] ?? {};
  const current = byLocale[locale];
  if (current !== undefined && current !== '') return undefined;

  const resolved = resolveLocalizedValue(byLocale, localeConfig, locale);
  if (resolved === undefined) return undefined;

  for (const loc of fallbackChain(localeConfig, locale)) {
    if (loc === locale) continue;
    const v = byLocale[loc];
    if (v !== undefined && v !== null && v !== '') {
      return `Falls back to ${loc}: ${formatFallbackPreview(v)}`;
    }
  }
  return undefined;
}

/**
 * Turns a validation path into something an editor can act on.
 *
 * The domain reports `cards[2].title`; the summary says "Cards 3 › Title". A
 * path is a precise address and a poor instruction — and the summary exists to
 * send someone to the right place, so it has to read like directions. Falls
 * back to the raw segment wherever the definition cannot be resolved.
 */
function labelForPath(fields: readonly FieldDefinition[], path: string): string {
  const parts: string[] = [];
  let defs: readonly FieldDefinition[] | undefined = fields;

  for (const segment of path.split('.')) {
    const match = /^([^[]+)(?:\[(\d+)\])?$/.exec(segment);
    const apiId = match?.[1] ?? segment;
    const found: FieldDefinition | undefined = defs?.find((f) => f.apiId === apiId);
    const index = match?.[2];
    // 1-based: the third card is "3" to everyone except a programmer.
    parts.push(
      index === undefined ? (found?.name ?? apiId) : `${found?.name ?? apiId} ${+index + 1}`,
    );
    defs = found?.type === 'Component' ? found.fields : found?.items?.fields;
  }
  return parts.join(' › ');
}

const cloneInitial = (initial: EntryFields): Values => {
  const out: Values = {};
  for (const [apiId, byLocale] of Object.entries(initial)) {
    out[apiId] = { ...(byLocale as Record<string, unknown>) };
  }
  return out;
};

/**
 * A form generated from a content type's field definitions. Localized fields are
 * edited per-locale via tabs; non-localized fields are edited once (on the default
 * locale tab). Emits the localized `EntryFields` shape, dropping empty values.
 */
/** The entry being edited, posted to field-editor extensions for context. */
export interface EntryContext {
  readonly spaceId: string;
  readonly environmentId: string;
  readonly entryId?: string;
  readonly contentType?: string;
}

export function EntryForm(props: {
  contentType: ContentType;
  initial: EntryFields;
  locales: readonly string[];
  defaultLocale: string;
  fallbacks?: Readonly<Record<string, string | null>>;
  pickers: Pickers;
  /** Installed custom field editors; the first matching a field's type replaces its input. */
  fieldEditors?: readonly AppExtension[];
  /**
   * Resolves entry matches server-side for reference fields.
   *
   * Without it the picker filters the seeded options, which cannot reach an
   * entry beyond the list endpoint's page.
   */
  onSearchEntries?: (query: string, contentTypes?: readonly string[]) => Promise<PickOption[]>;
  entryContext?: EntryContext;
  busy?: boolean;
  /** DOM id for the form element, so external buttons can submit via `form=`. */
  formId?: string;
  /** Hides the built-in Save/Cancel row when the parent renders its own actions. */
  hideActions?: boolean;
  /** Reports edits so the parent can guard navigation against unsaved changes. */
  onDirtyChange?: (dirty: boolean) => void;
  /** Called when a submit is rejected by validation, so actions living outside
   * the form (header Save/Publish) can give feedback at the point of action. */
  onValidationFailed?: (errorCount: number) => void;
  /** External field values (AI generation/canvas/assist) merged into the live
   * form state per locale — never remounts, so other unsaved edits survive. */
  mergePatch?: { seq: number; fields: EntryFields } | null;
  /**
   * A field to open on, from an inline-edit deep link. Applied once, on mount:
   * afterwards it is the editor's own state, and re-applying it would yank
   * focus back from wherever the editor has since moved.
   */
  focusField?: { apiId: string; locale?: string };
  onSave: (fields: EntryFields) => void;
  onCancel: () => void;
}) {
  const { contentType, locales, defaultLocale, fallbacks, fieldEditors } = props;
  const [values, setValues] = useState<Values>(() => cloneInitial(props.initial));
  const focusField = props.focusField;
  const [activeLocale, setActiveLocale] = useState(() =>
    focusField?.locale && locales.includes(focusField.locale) ? focusField.locale : defaultLocale,
  );
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount only — see the prop's note. Re-running would yank focus back from wherever the editor has since moved.
  useEffect(() => {
    if (!focusField) return;
    const el = document.getElementById(`field-${focusField.apiId}`);
    el?.scrollIntoView({ block: 'center' });
    el?.focus();
  }, []);

  const hasLocalized = useMemo(() => contentType.fields.some((f) => f.localized), [contentType]);

  const localeConfig = useMemo<LocaleConfig>(
    () => ({ defaultLocale, locales, fallbacks }),
    [defaultLocale, locales, fallbacks],
  );

  const markDirty = () => props.onDirtyChange?.(true);

  const clearError = (path: string, locale: string) => {
    setFieldErrors((prev) => {
      const key = errorKey(path, locale);
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const set = (apiId: string, locale: string, v: unknown) => {
    clearError(apiId, locale);
    setValues((p) => ({ ...p, [apiId]: { ...p[apiId], [locale]: v } }));
    markDirty();
  };

  // Merge externally produced values (generate/canvas/AI assist) into live state.
  const appliedPatchSeq = useRef(0);
  useEffect(() => {
    const patch = props.mergePatch;
    if (!patch || patch.seq === appliedPatchSeq.current) return;
    appliedPatchSeq.current = patch.seq;
    setValues((p) => {
      const next = { ...p };
      for (const [apiId, byLocale] of Object.entries(patch.fields)) {
        next[apiId] = { ...next[apiId], ...(byLocale as Record<string, unknown>) };
      }
      return next;
    });
    setFieldErrors({});
    props.onDirtyChange?.(true);
  }, [props.mergePatch, props.onDirtyChange]);

  // Bumped per rejected submit; scrolls the error summary into view once the
  // errors have rendered (not on every fieldErrors change — typing edits those).
  const [failedSubmits, setFailedSubmits] = useState(0);
  const summaryRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (failedSubmits === 0) return;
    summaryRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, [failedSubmits]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    // Guard double-submits (rapid ⌘S / Enter): a second createEntry in flight
    // would duplicate the entry.
    if (props.busy) return;
    const out = fieldsFromValues(contentType, values, locales, defaultLocale);
    const issues = validateEntryFields(contentType, out, {
      defaultLocale,
      locales,
    });
    if (issues.length > 0) {
      const errors = issuesToErrors(issues, defaultLocale);
      setFieldErrors(errors);
      // If the active locale is clean, jump to the first locale that isn't, so
      // the failure is never invisible (errors on unmounted tabs).
      const errorLocales = new Set(Object.keys(errors).map((k) => k.split(':')[1] ?? ''));
      if (!errorLocales.has(activeLocale)) {
        const target = locales.find((l) => errorLocales.has(l));
        if (target) setActiveLocale(target);
      }
      setFailedSubmits((n) => n + 1);
      props.onValidationFailed?.(issues.length);
      return;
    }
    setFieldErrors({});
    props.onSave(out);
  };

  // Per-locale error counts back the locale-tab badges and the summary list.
  const errorsByLocale = useMemo(() => {
    const out = new Map<string, number>();
    for (const key of Object.keys(fieldErrors)) {
      const loc = key.split(':')[1] ?? defaultLocale;
      out.set(loc, (out.get(loc) ?? 0) + 1);
    }
    return out;
  }, [fieldErrors, defaultLocale]);

  const fieldName = (path: string) => labelForPath(contentType.fields, path);

  return (
    <form id={props.formId} onSubmit={submit} className="max-w-2xl space-y-4">
      {hasLocalized && locales.length > 1 && (
        // Locale switcher: a segmented row of <button>s (role=button) — component
        // tests select a locale via getByRole('button', { name: 'de-DE' }).
        <div className="inline-flex flex-wrap gap-1 rounded-lg border bg-muted/40 p-1">
          {locales.map((loc) => {
            const errCount = errorsByLocale.get(loc) ?? 0;
            return (
              <Button
                type="button"
                key={loc}
                size="sm"
                variant={loc === activeLocale ? 'default' : 'ghost'}
                onClick={() => setActiveLocale(loc)}
              >
                {loc}
                {loc === defaultLocale ? ' (default)' : ''}
                {errCount > 0 && (
                  <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-2xl bg-destructive/15 px-1 text-xs text-destructive">
                    {errCount}
                    {/* A bare <span> has no role, and `aria-label` on a roleless
                        element is ignored — the count was announced as a naked
                        number. Visually-hidden text is read instead. */}
                    <span className="sr-only">
                      {` validation ${errCount === 1 ? 'error' : 'errors'}`}
                    </span>
                  </span>
                )}
              </Button>
            );
          })}
        </div>
      )}

      <Card>
        <CardContent className="space-y-5">
          {activeLocale !== defaultLocale &&
            (() => {
              const shared = contentType.fields.filter((f) => !f.localized).length;
              return shared > 0 ? (
                <p className="text-muted-foreground text-xs">
                  {shared} {shared === 1 ? 'field' : 'fields'} shared across all locales{' '}
                  {shared === 1 ? 'is' : 'are'} edited on the {defaultLocale} (default) tab.
                </p>
              ) : null;
            })()}
          {contentType.fields.map((f) => {
            // Non-localized fields are only editable on the default-locale tab.
            const locale = f.localized ? activeLocale : defaultLocale;
            if (!f.localized && activeLocale !== defaultLocale) return null;
            const id = `field-${f.apiId}`;
            const err = fieldErrors[errorKey(f.apiId, locale)];
            const hint =
              f.localized && locales.length > 1
                ? fallbackHint(f, values, locale, localeConfig)
                : undefined;
            return (
              <div className="space-y-1.5" key={f.apiId}>
                <Label id={`${id}-label`} htmlFor={id} className="gap-1">
                  {f.name}
                  {f.required && <span className="text-destructive">*</span>}
                  {locales.length > 1 && (
                    <span className="ml-1 font-normal text-muted-foreground">
                      {f.localized ? activeLocale : 'all locales'}
                    </span>
                  )}
                </Label>
                <FieldInput
                  id={id}
                  field={f}
                  value={values[f.apiId]?.[locale]}
                  invalid={Boolean(err)}
                  errorId={err ? `${id}-error` : undefined}
                  pickers={props.pickers}
                  editor={fieldEditors?.find(
                    (e) =>
                      !e.fieldTypes || e.fieldTypes.length === 0 || e.fieldTypes.includes(f.type),
                  )}
                  editorContext={props.entryContext}
                  locale={locale}
                  path={f.apiId}
                  onSearchEntries={props.onSearchEntries}
                  errorFor={(p) => fieldErrors[errorKey(p, locale)]}
                  // A nested edit clears its own error, not the whole
                  // component's: fixing card 1 must not make card 2 look fine.
                  onEdited={(p) => clearError(p, locale)}
                  onChange={(v) => set(f.apiId, locale, v)}
                />
                {hint && !err && <p className="text-xs text-muted-foreground">{hint}</p>}
                {err && (
                  <p id={`${id}-error`} className="text-xs text-destructive">
                    {err}
                  </p>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>

      {Object.keys(fieldErrors).length > 0 && (
        <div
          ref={summaryRef}
          role="alert"
          className="space-y-1 rounded-2xl border border-destructive/30 bg-destructive/10 p-3 text-sm"
        >
          <p className="font-medium text-destructive">
            Can’t save yet: {Object.keys(fieldErrors).length}{' '}
            {Object.keys(fieldErrors).length === 1 ? 'field needs' : 'fields need'} attention.
          </p>
          <ul className="space-y-0.5">
            {Object.entries(fieldErrors).map(([key, message]) => {
              const [apiId = '', loc = defaultLocale] = key.split(':');
              return (
                <li key={key} className="text-destructive">
                  {loc === activeLocale ? (
                    <span>
                      {fieldName(apiId)} ({loc}): {message}
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="underline underline-offset-2"
                      onClick={() => setActiveLocale(loc)}
                    >
                      {fieldName(apiId)} ({loc}): {message}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {!props.hideActions && (
        <div className="flex items-center gap-2">
          <Button type="submit" disabled={props.busy}>
            Save draft
          </Button>
          <Button type="button" variant="outline" onClick={props.onCancel} disabled={props.busy}>
            Cancel
          </Button>
        </div>
      )}
    </form>
  );
}

function FieldInput(props: {
  id: string;
  field: FieldDefinition;
  value: unknown;
  invalid?: boolean;
  /** id of the error message element, wired to aria-describedby when invalid. */
  errorId?: string;
  pickers: Pickers;
  editor?: AppExtension;
  editorContext?: EntryContext;
  locale: string;
  /** Dotted/indexed path to this value; absent at the top level (= apiId). */
  path?: string;
  /** Looks up the validation message for a nested path, if any. */
  errorFor?: (path: string) => string | undefined;
  /** Reports the exact nested path just edited, so its error can be cleared. */
  onEdited?: (path: string) => void;
  /** Resolves entry matches server-side for Link fields. */
  onSearchEntries?: (query: string, contentTypes?: readonly string[]) => Promise<PickOption[]>;
  onChange: (v: unknown) => void;
}) {
  const { id, field, value, invalid, errorId, onChange, pickers, editor, editorContext, locale } =
    props;
  const inputClass = invalid ? 'border-destructive focus-visible:ring-destructive/30' : undefined;
  const aria = { 'aria-invalid': invalid || undefined, 'aria-describedby': errorId };

  // A custom field editor extension takes over the input entirely (sandboxed iframe).
  if (editor) {
    return (
      <ExtensionFrame
        extension={editor}
        context={{
          target: 'field-editor',
          spaceId: editorContext?.spaceId ?? '',
          environmentId: editorContext?.environmentId ?? '',
          entryId: editorContext?.entryId,
          contentType: editorContext?.contentType,
          field: { apiId: field.apiId, type: field.type, locale },
          value,
        }}
        onChange={onChange}
      />
    );
  }

  // A group of nested fields, edited in place. Rendered as a raised fill
  // rather than a nested card — the design system prohibits boxes-in-boxes,
  // and a component is part of the entry, not a separate object.
  if (field.type === 'Component') {
    return (
      <ComponentInput
        id={id}
        fields={field.fields ?? []}
        value={value}
        path={props.path ?? field.apiId}
        errorFor={props.errorFor}
        onEdited={props.onEdited}
        pickers={pickers}
        locale={locale}
        onChange={onChange}
      />
    );
  }

  if (field.type === 'Array' && field.items?.type === 'Component') {
    return (
      <RepeaterInput
        id={id}
        label={field.name}
        fields={field.items.fields ?? []}
        value={value}
        path={props.path ?? field.apiId}
        errorFor={props.errorFor}
        onEdited={props.onEdited}
        pickers={pickers}
        locale={locale}
        onChange={onChange}
      />
    );
  }

  // Reference fields: a searchable combobox over entries/assets, stored as
  // { id, linkType }.
  if (field.type === 'Link') {
    const linkType = field.linkType ?? 'Entry';
    const allowed = field.validations?.linkContentTypes as string[] | undefined;
    let options = linkType === 'Asset' ? pickers.assets : pickers.entries;
    if (linkType === 'Entry' && allowed?.length) {
      options = options.filter((o) => !o.contentType || allowed.includes(o.contentType));
    }
    const currentId = (value as { id?: string } | undefined)?.id ?? '';
    return (
      <EntityPicker
        id={id}
        options={options}
        value={currentId}
        placeholder={linkType === 'Asset' ? 'Search assets…' : 'Search entries…'}
        invalid={invalid}
        errorId={errorId}
        // Entries are matched server-side; the seeded options only fill the
        // list before anyone types. Assets stay client-side: the media library
        // is fetched whole for the picker already, and narrowing to one link
        // type is the change worth making rather than all of them at once.
        {...(linkType === 'Entry' && props.onSearchEntries
          ? {
              onSearch: (q: string) =>
                (props.onSearchEntries as NonNullable<typeof props.onSearchEntries>)(q, allowed),
            }
          : {})}
        onChange={(picked) => onChange(picked ? { id: picked, linkType } : undefined)}
      />
    );
  }

  // Rich text: a Tiptap-backed document editor. Keyed per locale so each
  // locale gets its own editor instance (isolated content and undo history).
  if (field.type === 'RichText') {
    return (
      <RichTextEditor
        key={locale}
        id={id}
        ariaLabelledBy={`${id}-label`}
        value={value}
        pickers={pickers}
        onChange={onChange}
      />
    );
  }

  if (field.type === 'Boolean') {
    return (
      <div className="flex items-center gap-2">
        <Checkbox id={id} checked={!!value} onCheckedChange={(c) => onChange(c === true)} />
        <span className="text-muted-foreground text-sm">{value ? 'Yes' : 'No'}</span>
      </div>
    );
  }
  if (field.type === 'Integer' || field.type === 'Number') {
    return (
      <Input
        id={id}
        className={inputClass}
        {...aria}
        type="number"
        value={value === undefined || value === null ? '' : String(value)}
        onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
      />
    );
  }
  if (field.type === 'Date') {
    return (
      <Input
        id={id}
        className={inputClass}
        {...aria}
        type="date"
        value={typeof value === 'string' ? value : ''}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  if (field.type === 'Text') {
    return (
      <Textarea
        id={id}
        className={inputClass}
        {...aria}
        rows={4}
        value={typeof value === 'string' ? value : ''}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  if (field.type === 'Slug') {
    return (
      <Input
        id={id}
        className={`${inputClass} font-mono`}
        {...aria}
        // Not normalized as you type: rewriting the value mid-keystroke fights
        // the cursor. The server normalizes on save and returns what it stored.
        placeholder="my-post-title"
        value={typeof value === 'string' ? value : ''}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  if (SCALAR.has(field.type)) {
    return (
      <Input
        id={id}
        className={inputClass}
        {...aria}
        value={typeof value === 'string' ? value : ''}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  if (field.type === 'Array' && field.items?.type === 'Symbol') {
    return (
      <SymbolListInput id={id} label={field.name} aria={aria} value={value} onChange={onChange} />
    );
  }
  // Complex types (Array of Links, JSON, Location): raw JSON editor for the MVP.
  return (
    <JsonFieldInput id={id} inputClass={inputClass} aria={aria} value={value} onChange={onChange} />
  );
}

interface NestedProps {
  id: string;
  fields: readonly FieldDefinition[];
  value: unknown;
  path: string;
  errorFor?: (path: string) => string | undefined;
  /** Reports the exact path just edited, so its error can be cleared. */
  onEdited?: (path: string) => void;
  pickers: Pickers;
  locale: string;
  onChange: (v: unknown) => void;
}

const asObject = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/**
 * The nested fields of one component, edited in place.
 *
 * Nested fields carry no locale of their own — the component field decides
 * that once — so every input here inherits the locale its container is being
 * edited under, and the labels do not repeat it.
 */
function ComponentInput(props: NestedProps) {
  const { fields, path, errorFor, onEdited, pickers, locale, onChange } = props;
  const current = asObject(props.value);

  return (
    <div className="space-y-4 rounded-xl bg-secondary/40 p-4">
      {fields.map((f) => {
        const at = `${path}.${f.apiId}`;
        const nestedId = `${props.id}-${f.apiId}`;
        const err = errorFor?.(at);
        return (
          <div key={f.apiId} className="space-y-1.5">
            <Label id={`${nestedId}-label`} htmlFor={nestedId} className="gap-1">
              {f.name}
              {f.required && <span className="text-destructive">*</span>}
            </Label>
            <FieldInput
              id={nestedId}
              field={f}
              value={current[f.apiId]}
              invalid={Boolean(err)}
              errorId={err ? `${nestedId}-error` : undefined}
              pickers={pickers}
              locale={locale}
              path={at}
              errorFor={errorFor}
              onEdited={onEdited}
              onChange={(v) => {
                onEdited?.(at);
                onChange({ ...current, [f.apiId]: v });
              }}
            />
            {err && (
              <p id={`${nestedId}-error`} className="text-xs text-destructive">
                {err}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * A repeating list of components: the feature-card, timeline, spec-row shape.
 *
 * Every control names the item it acts on ("Remove card 2"), because a column
 * of identical buttons is unusable by keyboard or screen reader otherwise —
 * and removing the wrong card is not a recoverable mistake mid-edit.
 */
function RepeaterInput(props: NestedProps & { label: string }) {
  const { fields, path, errorFor, onEdited, pickers, locale, onChange, label } = props;
  const items = Array.isArray(props.value) ? (props.value as unknown[]) : [];
  const noun = label.replace(/s$/i, '') || 'item';

  const replace = (index: number, item: unknown) =>
    onChange(items.map((existing, i) => (i === index ? item : existing)));

  const move = (index: number, by: number) => {
    const to = index + by;
    if (to < 0 || to >= items.length) return;
    const next = [...items];
    const [moved] = next.splice(index, 1);
    next.splice(to, 0, moved);
    onChange(next);
  };

  return (
    <div className="space-y-2">
      {items.length === 0 && <p className="text-muted-foreground text-sm">Nothing here yet.</p>}
      {items.map((item, index) => {
        const at = `${path}[${index}]`;
        // Index-based keys: these items have no id of their own, and the list
        // is reordered by explicit action rather than re-sorted underneath.
        const key = `${path}-${index}`;
        return (
          <div key={key} className="space-y-2 rounded-xl bg-secondary/40 p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium text-sm">
                {noun} {index + 1}
              </span>
              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={`Move ${noun} ${index + 1} up`}
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                >
                  ↑
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={`Move ${noun} ${index + 1} down`}
                  disabled={index === items.length - 1}
                  onClick={() => move(index, 1)}
                >
                  ↓
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-destructive"
                  aria-label={`Remove ${noun} ${index + 1}`}
                  onClick={() => onChange(items.filter((_, i) => i !== index))}
                >
                  Remove
                </Button>
              </div>
            </div>
            <ComponentInput
              id={`${props.id}-${index}`}
              fields={fields}
              value={item}
              path={at}
              errorFor={errorFor}
              onEdited={onEdited}
              pickers={pickers}
              locale={locale}
              onChange={(v) => replace(index, v)}
            />
          </div>
        );
      })}
      <Button type="button" variant="outline" size="sm" onClick={() => onChange([...items, {}])}>
        Add {noun.toLowerCase()}
      </Button>
    </div>
  );
}

/**
 * A list of short text values (an Array of Symbols, e.g. keywords) edited as
 * removable chips: Enter or a comma adds what's typed, Backspace in the empty
 * field removes the last one. Editors never see the JSON underneath.
 */
function SymbolListInput(props: {
  id: string;
  label: string;
  aria: Record<string, string | boolean | undefined>;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const items = Array.isArray(props.value)
    ? props.value.filter((v): v is string => typeof v === 'string')
    : [];
  const [draft, setDraft] = useState('');
  const add = (raw: string) => {
    const next = raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s && !items.includes(s));
    if (next.length > 0) props.onChange([...items, ...next]);
    setDraft('');
  };
  const remove = (index: number) => props.onChange(items.filter((_, i) => i !== index));
  return (
    <div className="space-y-2">
      {items.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label={props.label}>
          {items.map((item, i) => (
            <li key={item}>
              <Badge variant="secondary" className="gap-1 pr-1">
                {item}
                <button
                  type="button"
                  className="rounded-full px-1 text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                  aria-label={`Remove “${item}”`}
                  onClick={() => remove(i)}
                >
                  ×
                </button>
              </Badge>
            </li>
          ))}
        </ul>
      )}
      <Input
        id={props.id}
        {...props.aria}
        placeholder="Type and press Enter"
        value={draft}
        onChange={(e) => {
          const v = e.target.value;
          if (v.includes(',')) add(v);
          else setDraft(v);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            add(draft);
          } else if (e.key === 'Backspace' && draft === '' && items.length > 0) {
            remove(items.length - 1);
          }
        }}
        onBlur={() => draft.trim() && add(draft)}
      />
    </div>
  );
}

/**
 * Raw JSON editor for complex field types. Typing through invalid syntax is
 * expected; the field says so instead of silently keeping the last valid value.
 */
function JsonFieldInput(props: {
  id: string;
  inputClass?: string;
  aria: Record<string, string | boolean | undefined>;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const [invalid, setInvalid] = useState(false);
  // Controlled text mirrored from the value, so external updates (AI merge
  // patches) show up; `lastEmitted` tells our own onChange echo apart from a
  // real external change (same pattern as RichTextEditor).
  const [text, setText] = useState(() =>
    props.value === undefined ? '' : JSON.stringify(props.value),
  );
  const lastEmitted = useRef(props.value);
  useEffect(() => {
    if (props.value === lastEmitted.current) return;
    if (JSON.stringify(props.value) === JSON.stringify(lastEmitted.current)) return;
    lastEmitted.current = props.value;
    setText(props.value === undefined ? '' : JSON.stringify(props.value));
    setInvalid(false);
  }, [props.value]);
  return (
    <div className="space-y-1">
      <Textarea
        id={props.id}
        className={props.inputClass}
        {...props.aria}
        rows={3}
        placeholder='JSON, e.g. {"lat": 52.52, "lon": 13.4}'
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          if (e.target.value === '') {
            setInvalid(false);
            lastEmitted.current = undefined;
            props.onChange(undefined);
            return;
          }
          try {
            const parsed = JSON.parse(e.target.value);
            lastEmitted.current = parsed;
            props.onChange(parsed);
            setInvalid(false);
          } catch {
            // Keep the last valid value until the text parses again.
            setInvalid(true);
          }
        }}
      />
      {invalid && (
        <p className="text-wait text-xs">
          Not valid JSON yet. Until the syntax is fixed, the last valid value is what saves.
        </p>
      )}
    </div>
  );
}
