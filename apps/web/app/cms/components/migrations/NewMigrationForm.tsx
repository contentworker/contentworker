import {
  MIGRATION_MAX_PAGES,
  type MigrationRun,
  type MigrationSourceKind,
} from '@contentworker/domain';
import { Button } from '@contentworker/ui/button';
import { DialogError } from '@contentworker/ui/dialog';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@contentworker/ui/field';
import { Input } from '@contentworker/ui/input';
import { Segmented, SegmentedItem } from '@contentworker/ui/segmented';
import { SheetFooter } from '@contentworker/ui/sheet';
import { Textarea } from '@contentworker/ui/textarea';
import { useEffect, useId, useRef, useState } from 'react';
import {
  DiscardAsk,
  type DiscardGuard,
  GuardCancel,
  useDiscardGuard,
} from '~/cms/components/discard-guard';
import { FormSheet } from '~/cms/components/form-sheet';
import { useClient } from '~/cms/lib/client-context';
import { refusedSave } from '~/cms/lib/management';
import { globsFrom, type SourceField, sourceIssues } from '~/cms/lib/migrations';

const DEFAULT_MAX_PAGES = '500';

const KINDS: readonly {
  id: MigrationSourceKind;
  label: string;
  hint: string;
  url: string;
  placeholder: string;
}[] = [
  {
    id: 'sitemap',
    label: 'Sitemap',
    hint: 'Takes the pages the sitemap lists. Give the sitemap’s URL, or the site’s address to find it through robots.txt.',
    url: 'Sitemap or site URL',
    placeholder: 'https://example.com/sitemap.xml',
  },
  {
    id: 'crawl',
    label: 'Link crawl',
    hint: 'Starts at one page and follows its links, staying on the same site.',
    url: 'Start page',
    placeholder: 'https://example.com/',
  },
];

/**
 * The list's New migration: the form in a sheet, which asks before dropping what was typed and
 * holds while the create is under way. The caller owns `open`, so its empty state opens it too.
 */
export function NewMigrationSheet({
  open,
  onOpenChange,
  onUnconfirmed,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUnconfirmed: () => void;
  onCreated: (run: MigrationRun) => Promise<void> | void;
}) {
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const guard = useDiscardGuard({ open, dirty, saving, onOpenChange });
  return (
    <FormSheet
      open={open}
      onOpenChange={guard.onOpenChange}
      label="New migration"
      title="Migrate a website"
      description="Where the run finds its pages, and which of them it takes."
    >
      <NewMigrationForm
        guard={guard}
        onDirty={setDirty}
        onSaving={setSaving}
        onUnconfirmed={onUnconfirmed}
        onCreated={onCreated}
      />
    </FormSheet>
  );
}

/**
 * A new run: where its pages come from (a sitemap or a link crawl), which of them it takes (path
 * globs, at most so many pages), and its name. Creating it fetches nothing; the run's page starts
 * the inventory. The API checks the source (a loopback or private address, a glob not starting
 * with "/") and its refusals land beside the field they name.
 */
export function NewMigrationForm({
  guard,
  onDirty,
  onSaving,
  onUnconfirmed,
  onCreated,
}: {
  guard: DiscardGuard;
  onDirty: (dirty: boolean) => void;
  onSaving: (saving: boolean) => void;
  /** A create that may have landed without an answer: the list behind the sheet shows it. */
  onUnconfirmed: () => void;
  onCreated: (run: MigrationRun) => Promise<void> | void;
}) {
  const { client } = useClient();
  const id = useId();
  const [kind, setKind] = useState<MigrationSourceKind>('sitemap');
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [include, setInclude] = useState('');
  const [exclude, setExclude] = useState('');
  const [maxPages, setMaxPages] = useState(DEFAULT_MAX_PAGES);
  const [issues, setIssues] = useState<Partial<Record<SourceField | 'form', string>>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fields = useRef<Partial<Record<SourceField, HTMLElement | null>>>({});
  const chosen = KINDS.find((k) => k.id === kind) ?? (KINDS[0] as (typeof KINDS)[number]);

  const dirty =
    url.trim() !== '' ||
    name.trim() !== '' ||
    include.trim() !== '' ||
    exclude.trim() !== '' ||
    maxPages !== DEFAULT_MAX_PAGES;
  useEffect(() => {
    onDirty(dirty);
    return () => onDirty(false);
  }, [dirty, onDirty]);
  useEffect(() => {
    onSaving(busy);
    return () => onSaving(false);
  }, [busy, onSaving]);

  /** Says what's wrong beside each field it names, and takes the first of them. */
  const refuse = (next: Partial<Record<SourceField | 'form', string>>) => {
    setIssues(next);
    const first = (['url', 'name', 'include', 'exclude', 'maxPages'] as const).find((f) => next[f]);
    if (first) fields.current[first]?.focus();
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!url.trim()) {
      refuse({
        url:
          kind === 'sitemap'
            ? 'Enter the sitemap’s or the site’s URL.'
            : 'Enter the page to start from.',
      });
      return;
    }
    const most = maxPages.trim() === '' ? undefined : Number(maxPages);
    setIssues({});
    setBusy(true);
    try {
      const run = await client.createMigrationRun({
        ...(name.trim() ? { name: name.trim() } : {}),
        source: {
          kind,
          url: url.trim(),
          include: globsFrom(include),
          exclude: globsFrom(exclude),
          ...(most !== undefined ? { maxPages: most } : {}),
        },
      });
      await onCreated(run);
    } catch (err) {
      // Through the guard either way, so it tells a refusal from a create that may have landed.
      const message = guard.saveFailed(err);
      const said = sourceIssues(err);
      const { form, ...byField } = said;
      if (Object.keys(byField).length > 0) {
        refuse(said);
        if (form) setError(form);
      } else {
        setError(message);
        if (!refusedSave(err)) onUnconfirmed();
      }
    } finally {
      setBusy(false);
    }
  };

  /** A field's error or its hint, whichever it has now, for its `aria-describedby`. */
  const describedBy = (field: SourceField, hint: boolean) =>
    issues[field] ? `${id}-${field}-error` : hint ? `${id}-${field}-hint` : undefined;
  const said = (field: SourceField, hint?: string) =>
    issues[field] ? (
      <p id={`${id}-${field}-error`} className="text-destructive text-ui">
        {issues[field]}
      </p>
    ) : hint ? (
      <FieldDescription id={`${id}-${field}-hint`} className="text-xs">
        {hint}
      </FieldDescription>
    ) : null;

  return (
    <form onSubmit={(e) => void submit(e)} noValidate>
      <FieldGroup className="gap-5">
        <FieldSet aria-describedby={`${id}-kind-hint`} className="gap-0">
          <FieldLegend variant="label" className="mb-2">
            Find pages from
          </FieldLegend>
          <Segmented
            aria-label="Find pages from"
            value={kind}
            onValueChange={(v) => setKind(v as MigrationSourceKind)}
            className="grid w-full grid-cols-2"
          >
            {KINDS.map((k) => (
              <SegmentedItem key={k.id} value={k.id}>
                {k.label}
              </SegmentedItem>
            ))}
          </Segmented>
          <FieldDescription id={`${id}-kind-hint`} className="mt-2 text-xs" aria-live="polite">
            {chosen.hint}
          </FieldDescription>
        </FieldSet>
        <Field>
          <FieldLabel htmlFor={`${id}-url`}>{chosen.url}</FieldLabel>
          <Input
            id={`${id}-url`}
            ref={(el) => {
              fields.current.url = el;
            }}
            type="url"
            inputMode="url"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className="h-8 font-mono"
            placeholder={chosen.placeholder}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            aria-invalid={issues.url ? true : undefined}
            aria-describedby={describedBy('url', true)}
          />
          {said('url', 'Every page the run takes is on this address’s site.')}
        </Field>
        <Field>
          <div className="flex items-baseline justify-between gap-2">
            <FieldLabel htmlFor={`${id}-name`}>Name</FieldLabel>
            <span className="text-muted-foreground text-xs">Optional</span>
          </div>
          <Input
            id={`${id}-name`}
            ref={(el) => {
              fields.current.name = el;
            }}
            className="h-8"
            placeholder="The site’s host"
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-invalid={issues.name ? true : undefined}
            aria-describedby={describedBy('name', false)}
          />
          {said('name')}
        </Field>
        <Field>
          <div className="flex items-baseline justify-between gap-2">
            <FieldLabel htmlFor={`${id}-include`}>Include paths</FieldLabel>
            <span className="text-muted-foreground text-xs">Optional</span>
          </div>
          <Textarea
            id={`${id}-include`}
            ref={(el) => {
              fields.current.include = el;
            }}
            rows={3}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className="font-mono"
            placeholder={'/blog/**\n/products/*'}
            value={include}
            onChange={(e) => setInclude(e.target.value)}
            aria-invalid={issues.include ? true : undefined}
            aria-describedby={describedBy('include', true)}
          />
          {said(
            'include',
            'One path per line, starting with /. * matches within a segment and ** across them. Empty takes every page.',
          )}
        </Field>
        <Field>
          <div className="flex items-baseline justify-between gap-2">
            <FieldLabel htmlFor={`${id}-exclude`}>Exclude paths</FieldLabel>
            <span className="text-muted-foreground text-xs">Optional</span>
          </div>
          <Textarea
            id={`${id}-exclude`}
            ref={(el) => {
              fields.current.exclude = el;
            }}
            rows={2}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className="font-mono"
            placeholder="/tag/**"
            value={exclude}
            onChange={(e) => setExclude(e.target.value)}
            aria-invalid={issues.exclude ? true : undefined}
            aria-describedby={describedBy('exclude', true)}
          />
          {said('exclude', 'Leaves matching pages out, even where Include takes them.')}
        </Field>
        <Field>
          <FieldLabel htmlFor={`${id}-maxPages`}>Most pages</FieldLabel>
          <Input
            id={`${id}-maxPages`}
            ref={(el) => {
              fields.current.maxPages = el;
            }}
            type="number"
            inputMode="numeric"
            min={1}
            max={MIGRATION_MAX_PAGES}
            step={1}
            className="h-8 w-32 tabular"
            value={maxPages}
            onChange={(e) => setMaxPages(e.target.value)}
            aria-invalid={issues.maxPages ? true : undefined}
            aria-describedby={describedBy('maxPages', true)}
          />
          {said(
            'maxPages',
            `The run takes up to this many pages, at most ${MIGRATION_MAX_PAGES.toLocaleString('en-US')}.`,
          )}
        </Field>
        {error ? <DialogError>{error}</DialogError> : null}
        <FieldDescription className="text-xs">
          Nothing is fetched until you inventory the run.
        </FieldDescription>
        <SheetFooter className="-mx-4 -mb-4">
          <DiscardAsk guard={guard} message="Discard this migration?">
            <GuardCancel guard={guard} />
            <Button type="submit" disabled={busy}>
              {/* A run has no natural key, so a retry could make a second one: the button says so. */}
              {busy ? 'Creating…' : guard.unconfirmed ? 'Create again' : 'Create run'}
            </Button>
          </DiscardAsk>
        </SheetFooter>
      </FieldGroup>
    </form>
  );
}
