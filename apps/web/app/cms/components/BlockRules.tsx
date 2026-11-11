/**
 * Build → Blocks' rules: what editors may place, per blocks field and per slot, narrowed from what
 * the code allows (the block config, `PUT …/block-config`). One row per place, the code's rule and
 * the one in force side by side; Edit opens the place's controls in a panel under its row (the
 * blocks it takes, chosen from the code's; its fewest and most, bounded by the code's), and Lock is
 * a switch on the row. Nothing saves until Save rules, which sends the whole config with the version
 * it was edited from: someone else's save in between is a 409, and the rules are read again.
 *
 * Without content:manage it reads only: the rows, no controls. The parts of the config the catalog
 * no longer has (`stale`) are listed as ignored; saving removes them.
 *
 * Two more views read the same rules as code (`block-config/code-views.tsx`): Code, the config as
 * `PUT …/block-config` takes it, and Narrowed from code, each place's code rule against the one in
 * force. With unsaved edits both show the draft, marked so: the exact request before it is sent.
 * Which view is open isn't remembered.
 */
import {
  type BlockCatalog,
  type EffectiveBlockRules,
  type EffectiveSlotRules,
  effectiveBlockRules,
  SCOPES,
} from '@contentworker/domain';
import { Alert, AlertDescription, AlertTitle } from '@contentworker/ui/alert';
import { Button } from '@contentworker/ui/button';
import { Catalog, CatalogFigure, CatalogRow, CatalogTile } from '@contentworker/ui/catalog';
import { Checkbox } from '@contentworker/ui/checkbox';
import { Input } from '@contentworker/ui/input';
import { Label } from '@contentworker/ui/label';
import { Segmented, SegmentedItem } from '@contentworker/ui/segmented';
import { SkeletonText } from '@contentworker/ui/skeleton';
import { Switch } from '@contentworker/ui/switch';
import { LayoutList, Lock } from 'lucide-react';
import { Fragment, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useBlocker } from 'react-router';
import { Ago } from '~/cms/components/ago';
import {
  BlockConfigCode,
  BlockConfigDiff,
  loadEditor,
} from '~/cms/components/block-config/code-views';
import { InlineConfirm } from '~/cms/components/InlineConfirm';
import { LoadingStatus } from '~/cms/components/loading';
import { Section } from '~/cms/components/page';
import { actorLabel } from '~/cms/lib/authorship';
import { configJson, ignoredElsewhere, placesAsCode } from '~/cms/lib/block-config-code';
import {
  type CodeRule,
  configFromDraft,
  type Draft,
  draftErrors,
  issuesByControl,
  type PartDraft,
  type Place,
  placesOf,
  sameConfig,
  seedDraft,
} from '~/cms/lib/block-config-draft';
import { useClient } from '~/cms/lib/client-context';
import { plural } from '~/cms/lib/format';
import { ApiError, apiErrorMessage, conflictVersion, type TeamPerson } from '~/cms/lib/management';
import { useInvalidate, useScopedQuery } from '~/cms/lib/queries';
import { useToast } from '~/cms/lib/toast';

/** How many blocks a place holds, in words: "1–6", "at least 2", "up to 4", "any number". */
export function boundsText(min?: number, max?: number): string {
  if (min !== undefined && min > 0 && max !== undefined) {
    return min === max ? `exactly ${min}` : `${min}–${max}`;
  }
  if (min !== undefined && min > 0) return `at least ${min}`;
  if (max !== undefined) return `up to ${max}`;
  return 'any number';
}

/** A rule in words: the blocks it takes and how many ("Hero, Grid · up to 4"). */
function ruleText(
  rule: { readonly allowed: readonly string[]; readonly min?: number; readonly max?: number },
  blockName: (id: string) => string,
): string {
  return `${rule.allowed.map(blockName).join(', ')} · ${boundsText(rule.min, rule.max)}`;
}

/** The card's views: the rows (and their controls), the config as code, and the diff. */
type View = 'rules' | 'code' | 'narrowed';
const isView = (v: string): v is View => v === 'rules' || v === 'code' || v === 'narrowed';

export interface BlockRulesProps {
  readonly catalog: BlockCatalog;
  /** "Page › Main" for a target, "Grid › Items" for a slot. */
  readonly placeName: (place: Place) => string;
  readonly blockName: (id: string) => string;
  readonly people: readonly TeamPerson[];
}

export function BlockRules({ catalog, placeName, blockName, people }: BlockRulesProps) {
  const { client } = useClient();
  const toast = useToast();
  const invalidate = useInvalidate();
  const id = useId();
  // Silent: a failed read is said here, in place, with Try again.
  const configQuery = useScopedQuery(['block-config'], () => client.getBlockConfig(), {
    silent: true,
  });
  const rulesQuery = useScopedQuery(
    ['block-config', 'effective'],
    () => client.getEffectiveBlockRules(),
    { silent: true },
  );
  const access = useScopedQuery(['space-access'], () => client.getSpaceAccess(), { silent: true });
  const canManage = access.data?.scopes.includes(SCOPES.contentManage) === true;

  const places = useMemo(() => placesOf(catalog), [catalog]);
  const config = configQuery.data;
  const rules = rulesQuery.data;

  const [draft, setDraft] = useState<Draft | null>(null);
  const [base, setBase] = useState<Draft | null>(null);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [view, setView] = useState<View>('rules');
  const [saving, setSaving] = useState(false);
  /** What the server refused of the last save, by control, until the next edit. */
  const [refused, setRefused] = useState<Record<string, string>>({});
  /** Someone else's save beat this one: the rules were read again. */
  const [overtaken, setOvertaken] = useState<number | null>(null);
  // The draft follows the rules in force when they load, and again after a save or a conflict;
  // never under an edit in progress (a background refetch keeps what is being typed).
  const reseed = useRef(true);
  useEffect(() => {
    if (!rules || !reseed.current) return;
    reseed.current = false;
    const seeded = seedDraft(places, rules);
    setDraft(seeded);
    setBase(seeded);
  }, [rules, places]);

  const errors = useMemo(
    () => (draft ? draftErrors(places, draft, catalog) : {}),
    [places, draft, catalog],
  );
  const shown = { ...refused, ...errors };
  const dirty = !!draft && !!base && !sameConfig(places, draft, base);
  const stale = rules?.stale ?? [];
  const valid = Object.keys(errors).length === 0;

  // The rules as code: the draft's while it has unsaved edits (what a save would send and set), the
  // rules in force otherwise. The ignored parts are always the stored config's: a save removes them.
  const body = useMemo(() => (draft ? configFromDraft(places, draft) : null), [places, draft]);
  const shownRules = useMemo(() => {
    if (!rules || !config || !body) return undefined;
    return dirty ? effectiveBlockRules(catalog, { version: config.version, ...body }) : rules;
  }, [rules, config, body, dirty, catalog]);
  const asCode = useMemo(
    () => (shownRules && rules ? placesAsCode(places, shownRules, rules.stale) : []),
    [places, shownRules, rules],
  );
  const narrowedCount = asCode.filter((p) => p.narrowed).length;

  const edit = (key: string, change: Partial<PartDraft>) => {
    setRefused({});
    setOvertaken(null);
    setDraft((d) => (d?.[key] ? { ...d, [key]: { ...d[key], ...change } } : d));
  };

  const save = async () => {
    if (!draft || !config || !valid) return;
    setSaving(true);
    try {
      const { targets, blocks } = configFromDraft(places, draft);
      const done = await client.setBlockConfig({
        expectedVersion: config.version,
        targets,
        blocks,
      });
      reseed.current = true;
      setRefused({});
      await invalidate(['block-config']);
      toast.success(
        done.unchanged ? 'The rules were already these' : `Rules saved as v${done.config.version}`,
      );
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // Read again, shown as they are now: the change is made again over theirs.
        reseed.current = true;
        await invalidate(['block-config']);
        setOvertaken(conflictVersion(err) ?? (config.version ?? 0) + 1);
        return;
      }
      const issues = (
        err instanceof ApiError && err.status === 422
          ? (err.body as { error?: { issues?: unknown } } | undefined)?.error?.issues
          : undefined
      ) as { field: string; message: string }[] | undefined;
      if (Array.isArray(issues) && issues.length > 0) {
        const byControl = issuesByControl(places, issues);
        setRefused(byControl);
        // The refusal lands on the controls, so they are what shows.
        setView('rules');
        // Each refused place opens, so its controls show what to change.
        setOpen((o) => {
          const next = new Set(o);
          for (const key of Object.keys(byControl)) {
            const place = places.find((p) => key === p.key || key.startsWith(`${p.key}.`));
            if (place) next.add(place.key);
          }
          return next;
        });
        toast.error(`The rules weren’t saved: ${plural(issues.length, 'problem')} to fix`);
        return;
      }
      toast.error(apiErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const discard = () => {
    setDraft(base);
    setRefused({});
    setOvertaken(null);
    setOpen(new Set());
  };

  // A draft is never left quietly: leaving the page asks, closing the tab warns.
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirty && currentLocation.pathname !== nextLocation.pathname,
  );
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const loading = configQuery.isPending || rulesQuery.isPending;

  /** How many places are narrowed, and which view: drawn while the rules load too, held till then. */
  const toolbar = (ready: boolean) => (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b px-4 py-3">
      {ready ? (
        <p className="text-muted-foreground text-xs tabular">
          {narrowedCount === 0
            ? `Nothing narrowed in ${plural(places.length, 'place')}`
            : `${narrowedCount} of ${plural(places.length, 'place')} narrowed`}
          {dirty ? ' (unsaved)' : ''}
        </p>
      ) : (
        <SkeletonText width="9rem" className="text-xs" />
      )}
      <Segmented
        aria-label="Show the rules as"
        disabled={!ready}
        value={view}
        onValueChange={(v) => {
          if (isView(v)) setView(v);
        }}
      >
        <SegmentedItem value="rules">Rules</SegmentedItem>
        {/* The editor is fetched ahead as soon as a pointer or the keyboard comes near. */}
        <SegmentedItem
          value="code"
          onPointerEnter={() => void loadEditor().catch(() => {})}
          onFocus={() => void loadEditor().catch(() => {})}
        >
          Code
        </SegmentedItem>
        {/* "Narrowed" on a phone, where three equal segments must fit; named in full. */}
        <SegmentedItem
          value="narrowed"
          aria-label="Narrowed from code"
          onPointerEnter={() => void loadEditor().catch(() => {})}
          onFocus={() => void loadEditor().catch(() => {})}
        >
          Narrowed<span className="max-sm:hidden">{' from code'}</span>
        </SegmentedItem>
      </Segmented>
    </div>
  );
  const failed = configQuery.isError || rulesQuery.isError;

  return (
    <Section
      title="Rules"
      description="What editors may place, per blocks field and per slot. The rules only narrow what the code allows: to allow more, change the code and push again."
      actions={
        config ? (
          <span className="text-muted-foreground text-xs">
            <span className="font-mono">v{config.version}</span>
            {config.updatedAt ? (
              <>
                {' · set '}
                <Ago at={config.updatedAt} />
                {` by ${actorLabel(config.updatedBy, { people, me: access.data?.subject }, 'inSentence')}`}
              </>
            ) : (
              ' · not set yet'
            )}
          </span>
        ) : null
      }
      flush
    >
      {failed && !loading ? (
        <div className="p-4">
          <Alert variant="destructive">
            <AlertTitle>The rules couldn’t be loaded</AlertTitle>
            <AlertDescription>
              <p>{apiErrorMessage(configQuery.error ?? rulesQuery.error)}</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-2"
                onClick={() => {
                  void configQuery.refetch();
                  void rulesQuery.refetch();
                }}
              >
                Try again
              </Button>
            </AlertDescription>
          </Alert>
        </div>
      ) : loading || !draft || !rules || !config ? (
        <>
          {toolbar(false)}
          <div className="space-y-2 p-4" aria-busy="true">
            <LoadingStatus>Loading the rules…</LoadingStatus>
            <SkeletonText width="18rem" />
            <SkeletonText width="12rem" />
          </div>
        </>
      ) : (
        <>
          {toolbar(true)}
          {overtaken !== null ? (
            <div className="px-4 pt-4">
              <Alert role="alert">
                <AlertTitle className="line-clamp-none">Someone else changed the rules</AlertTitle>
                <AlertDescription>
                  They saved v{overtaken} first, so yours weren’t saved. Here are the rules as they
                  are now: make your change again over theirs.
                </AlertDescription>
              </Alert>
            </div>
          ) : null}
          {stale.length > 0 ? (
            <div className="px-4 pt-4">
              <Alert>
                <AlertTitle className="line-clamp-none">
                  {stale.length === 1
                    ? '1 part of the rules is ignored'
                    : `${stale.length} parts of the rules are ignored`}
                </AlertTitle>
                <AlertDescription>
                  <p>
                    They name what the catalog no longer has, so the code’s rule applies there.
                    Saving the rules removes them.
                  </p>
                  <ul className="space-y-0.5">
                    {stale.map((s) => (
                      <li key={`${s.at}:${s.message}`}>
                        <code className="font-mono text-xs">{s.at}</code>: {s.message}
                      </li>
                    ))}
                  </ul>
                  {canManage ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="mt-1"
                      disabled={saving || !valid}
                      onClick={() => void save()}
                    >
                      {dirty ? 'Save rules and remove them' : 'Remove ignored parts'}
                    </Button>
                  ) : null}
                </AlertDescription>
              </Alert>
            </div>
          ) : null}
          {!canManage && access.data ? (
            <p className="max-w-measure px-4 pt-4 text-muted-foreground text-sm">
              Changing the rules takes content:manage.
            </p>
          ) : null}
          {shown[''] ? (
            <p role="alert" className="px-4 pt-4 text-destructive text-sm">
              {shown['']}
            </p>
          ) : null}
          {view === 'code' && body ? (
            <BlockConfigCode
              text={configJson(places, body)}
              unsaved={dirty}
              invalid={!valid}
              version={config.version}
              ignored={stale.length}
            />
          ) : null}
          {view === 'narrowed' ? (
            <BlockConfigDiff
              list={asCode}
              elsewhere={ignoredElsewhere(places, stale)}
              placeName={placeName}
              unsaved={dirty}
            />
          ) : null}
          {view === 'rules' ? (
            <Catalog aria-label="Rules by place">
              {places.map((p) => {
                const d = draft[p.key];
                if (!d) return null;
                const rule = ruleOf(rules, p);
                const panelId = `${id}-${places.indexOf(p)}`;
                const isOpen = open.has(p.key);
                const name = placeName(p);
                const invalid = Object.keys(shown).some(
                  (k) => k === p.key || k.startsWith(`${p.key}.`),
                );
                return (
                  <Fragment key={p.key}>
                    <CatalogRow
                      media={
                        <CatalogTile>
                          {(canManage ? d.locked : rule?.locked) ? (
                            <Lock aria-hidden="true" />
                          ) : (
                            <LayoutList aria-hidden="true" />
                          )}
                        </CatalogTile>
                      }
                      title={<span className="font-medium text-foreground">{name}</span>}
                      meta={
                        <span className="flex flex-col gap-0.5">
                          <span>Code allows {ruleText(p.code, blockName)}</span>
                          {invalid ? (
                            <span className="text-destructive">Needs fixing before it saves</span>
                          ) : null}
                          <span className={rule?.narrowed ? 'text-foreground' : undefined}>
                            {rule?.narrowed
                              ? `Editors may place ${ruleText(
                                  {
                                    allowed: rule.allowedChildren,
                                    ...(rule.min !== undefined ? { min: rule.min } : {}),
                                    ...(rule.max !== undefined ? { max: rule.max } : {}),
                                  },
                                  blockName,
                                )}${rule.locked ? ' · locked' : ''}`
                              : 'Editors may place what the code allows'}
                          </span>
                        </span>
                      }
                      aside={
                        canManage ? (
                          <CatalogFigure label="Locked">
                            <Switch
                              checked={d.locked}
                              disabled={saving}
                              aria-label={`Lock ${name}`}
                              onCheckedChange={(on) => edit(p.key, { locked: on })}
                            />
                          </CatalogFigure>
                        ) : rule?.locked ? (
                          <CatalogFigure label="Locked">Yes</CatalogFigure>
                        ) : null
                      }
                      actions={
                        canManage ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="xs"
                            aria-expanded={isOpen}
                            aria-controls={isOpen ? panelId : undefined}
                            aria-label={`${isOpen ? 'Done editing' : 'Edit'} the rules for ${name}${
                              invalid ? ' (needs fixing)' : ''
                            }`}
                            className={invalid ? 'text-destructive' : undefined}
                            onClick={() =>
                              setOpen((o) => {
                                const next = new Set(o);
                                if (next.has(p.key)) next.delete(p.key);
                                else next.add(p.key);
                                return next;
                              })
                            }
                          >
                            {isOpen ? 'Done' : 'Edit'}
                          </Button>
                        ) : null
                      }
                    />
                    {canManage && isOpen ? (
                      <li>
                        <PlacePanel
                          id={panelId}
                          place={p}
                          name={name}
                          draft={d}
                          errors={shown}
                          blockName={blockName}
                          disabled={saving}
                          onChange={(change) => edit(p.key, change)}
                        />
                      </li>
                    ) : null}
                  </Fragment>
                );
              })}
            </Catalog>
          ) : null}
          {blocker.state === 'blocked' ? (
            <InlineConfirm
              className="rounded-none border-t bg-wait/10 px-4"
              message="The rules have unsaved changes. Leave without saving them?"
              cancelLabel="Stay"
              onCancel={() => blocker.reset?.()}
            >
              <Button type="button" size="sm" variant="outline" onClick={() => blocker.proceed?.()}>
                Leave without saving
              </Button>
            </InlineConfirm>
          ) : null}
          {canManage ? (
            <div className="flex flex-wrap items-center gap-2 border-t px-4 py-3">
              <Button
                type="button"
                size="sm"
                disabled={saving || !dirty || !valid}
                onClick={() => void save()}
              >
                Save rules
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={saving || !dirty}
                onClick={discard}
              >
                Discard changes
              </Button>
              {!valid ? (
                <span className="text-destructive text-xs">Fix the rules marked to save.</span>
              ) : dirty ? (
                <span className="text-muted-foreground text-xs">Unsaved changes</span>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </Section>
  );
}

/** The rule in force at a place, from `/effective`. */
function ruleOf(rules: EffectiveBlockRules, p: Place): EffectiveSlotRules | undefined {
  if (p.kind === 'slot') return rules.blocks.find((b) => b.block === p.block)?.slots[p.slot];
  const t = rules.targets.find(
    (t) => t.contentTypeApiId === p.contentTypeApiId && t.field === p.field,
  );
  return t
    ? {
        allowedChildren: t.blocks,
        ...(t.min !== undefined ? { min: t.min } : {}),
        ...(t.max !== undefined ? { max: t.max } : {}),
        locked: t.locked,
        narrowed: t.narrowed,
      }
    : undefined;
}

/**
 * One place's controls, under its row: the blocks it takes (the code's, ticked; the last can't be
 * unticked) and its fewest and most (blank is the code's, which the hints say).
 */
function PlacePanel(props: {
  id: string;
  place: Place;
  name: string;
  draft: PartDraft;
  errors: Record<string, string>;
  blockName: (id: string) => string;
  disabled: boolean;
  onChange: (change: Partial<PartDraft>) => void;
}) {
  const { place: p, draft: d, errors, name } = props;
  const list = `${p.key}.${p.kind === 'target' ? 'blocks' : 'allowedChildren'}`;
  const chosen = new Set(d.allowed);
  const both = errors[p.key];
  return (
    <fieldset
      id={props.id}
      className="m-0 min-w-0 space-y-4 rounded-xl border-0 bg-secondary/40 p-4"
    >
      <legend className="sr-only">Rules for {name}</legend>
      <div className="space-y-2">
        <p id={`${props.id}-takes`} className="caption">
          Takes
        </p>
        <ul aria-labelledby={`${props.id}-takes`} className="flex flex-wrap gap-x-5 gap-y-2">
          {p.code.allowed.map((block) => {
            const on = chosen.has(block);
            const boxId = `${props.id}-b-${block}`;
            // The last ticked stays ticked, and focusable, saying why.
            const last = on && chosen.size === 1;
            const described = [
              last ? `${props.id}-last` : undefined,
              errors[list] ? `${props.id}-list-error` : undefined,
            ].filter(Boolean);
            return (
              <li key={block} className="flex items-center gap-2">
                <Checkbox
                  id={boxId}
                  checked={on}
                  disabled={props.disabled}
                  // At least one: a place that takes nothing isn't a narrowing the code allows.
                  aria-disabled={last || undefined}
                  aria-invalid={errors[list] ? true : undefined}
                  aria-describedby={described.length ? described.join(' ') : undefined}
                  onCheckedChange={(c) => {
                    if (last) return;
                    props.onChange({
                      allowed: p.code.allowed.filter((id) =>
                        id === block ? c === true : chosen.has(id),
                      ),
                    });
                  }}
                />
                <Label htmlFor={boxId} className="font-normal">
                  {props.blockName(block)}
                </Label>
              </li>
            );
          })}
        </ul>
        {chosen.size === 1 ? (
          <p id={`${props.id}-last`} className="text-muted-foreground text-xs">
            A place takes at least one block.
          </p>
        ) : null}
        {errors[list] ? (
          <p id={`${props.id}-list-error`} className="text-destructive text-xs">
            {errors[list]}
          </p>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-x-6 gap-y-3">
        <Bound
          id={`${props.id}-min`}
          label="Fewest"
          value={d.min}
          hint={codeBound(p.code, 'min')}
          error={errors[`${p.key}.min`] ?? both}
          disabled={props.disabled}
          min={p.code.min ?? 0}
          max={p.code.max}
          onChange={(min) => props.onChange({ min })}
        />
        <Bound
          id={`${props.id}-max`}
          label="Most"
          value={d.max}
          hint={codeBound(p.code, 'max')}
          error={errors[`${p.key}.max`] ?? both}
          disabled={props.disabled}
          min={Math.max(1, p.code.min ?? 0)}
          max={p.code.max}
          onChange={(max) => props.onChange({ max })}
        />
      </div>
    </fieldset>
  );
}

/** The code's bound, as a field's hint: what blank means and how far the field may go. */
function codeBound(code: CodeRule, which: 'min' | 'max'): string {
  if (which === 'min') {
    return code.min !== undefined && code.min > 0
      ? `Blank is the code’s ${code.min}; no fewer.`
      : 'Blank is none.';
  }
  return code.max !== undefined
    ? `Blank is the code’s ${code.max}; no more.`
    : 'Blank is any number.';
}

function Bound(props: {
  id: string;
  label: string;
  value: string;
  hint: string;
  error: string | undefined;
  disabled: boolean;
  min: number;
  max: number | undefined;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={props.id}>{props.label}</Label>
      <Input
        id={props.id}
        type="number"
        inputMode="numeric"
        className="w-24"
        min={props.min}
        max={props.max}
        value={props.value}
        disabled={props.disabled}
        aria-invalid={props.error ? true : undefined}
        aria-describedby={props.error ? `${props.id}-error ${props.id}-hint` : `${props.id}-hint`}
        onChange={(e) => props.onChange(e.target.value)}
      />
      <p id={`${props.id}-hint`} className="max-w-measure text-muted-foreground text-xs">
        {props.hint}
      </p>
      {props.error ? (
        <p id={`${props.id}-error`} className="text-destructive text-xs">
          {props.error}
        </p>
      ) : null}
    </div>
  );
}
