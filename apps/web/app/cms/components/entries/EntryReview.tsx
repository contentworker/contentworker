/**
 * What publishing an entry would change, for every place that asks: the assistant's confirm card,
 * the page's own confirmation and the entries list's diff. All of them read `useEntryReview`, which
 * reads the version diff (`GET …/versions/diff`, the same read as MCP's `entries_diff_versions`), so
 * what they say can't drift, and nothing a model wrote can reach it.
 */

import type { DiffKind, FieldDiff, FieldType } from '@contentworker/domain';
import { Alert, AlertDescription, AlertTitle } from '@contentworker/ui/alert';
import { Button } from '@contentworker/ui/button';
import { Collapsible, CollapsibleContent } from '@contentworker/ui/collapsible';
import { TriangleAlert } from 'lucide-react';
import { useEffect, useId, useMemo, useState } from 'react';
import { humanize } from '../../lib/format';
import { ApiError, type ManagementClient, type PreviewEntry } from '../../lib/management';
import { entryRef, fetchEntriesById } from '../dashboard/entry-titles';
import { FieldValue, type LinkTitles, linkOf, valueText } from '../EntryDiff';
import { KindBadge } from '../RevisionDiff';

/** One value's before and after, as words. A field holds one per locale that changed. */
interface ReviewRow {
  /** Named only when the field holds several locales. */
  readonly locale?: string;
  readonly before: string;
  readonly after: string;
}

/** One field of the entry, named for a person. */
export interface ReviewField {
  readonly field: string;
  readonly name: string;
  readonly kind: DiffKind;
  readonly rows: readonly ReviewRow[];
}

export type EntryReview =
  /** Nothing was asked: the card is for another kind of action. */
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  /** Never published: there is nothing to compare, and the whole entry goes live. */
  | { readonly status: 'first'; readonly title?: string }
  | { readonly status: 'ready'; readonly fields: readonly ReviewField[]; readonly title?: string }
  /** The diff couldn't be read, so nothing can be said about what changes. */
  | { readonly status: 'failed' };

export interface ReviewTarget {
  readonly entryId: string;
  /** What would go live, when it isn't the current draft: the version a card is held to. */
  readonly version?: number;
  /** The diff, when the caller already has it (the editor, right after a save). */
  readonly changes?: readonly FieldDiff[];
  /** Also read the entry's title, for a card nobody named (one the model proposed). */
  readonly named?: boolean;
}

/** The first publish, in the words every confirmation uses. */
export const FIRST_PUBLISH =
  'This entry hasn’t been published before, so the whole entry goes live.';
/** A publish that changes nothing. */
export const NO_CHANGES = 'The draft matches the published version; publishing re-confirms it.';
export const fieldsGoLive = (n: number) => `${n} ${n === 1 ? 'field goes' : 'fields go'} live:`;

const isChanged = (f: ReviewField) => f.kind !== 'unchanged';

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && !('nodeType' in v) && !linkOf(v);

/**
 * A stored value as words: a group of fields (a component, a block, SEO, a location) as a line per
 * field, a list by its elements, the rest as `valueText` reads it. A JSON field's JSON is its value.
 */
function readable(v: unknown, type: FieldType | undefined, titles: LinkTitles): string {
  if (type === 'JSON') return valueText(v);
  if (Array.isArray(v) && v.some(isPlainObject))
    return v.map((x) => readable(x, undefined, titles)).join('\n');
  if (!isPlainObject(v)) return valueText(v, titles);
  return Object.entries(v)
    .filter(([k]) => !k.startsWith('_'))
    .map(
      ([k, x]) =>
        `${humanize(k.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase())}: ${readable(x, undefined, titles) || 'Empty'}`,
    )
    .join('\n');
}

/** The diff as it reads for a person: each changed locale, or an unchanged field's one value. */
export function reviewFields(
  changes: readonly FieldDiff[],
  locale: string,
  titles: LinkTitles = new Map(),
): ReviewField[] {
  return changes.map((f) => {
    const changed = f.locales.filter((l) => l.kind !== 'unchanged');
    const same = f.locales.find((l) => l.locale === locale) ?? f.locales[0];
    const shown = changed.length ? changed : same ? [same] : [];
    return {
      field: f.field,
      name: f.name ?? humanize(f.field),
      kind: changed.length ? f.kind : 'unchanged',
      rows: shown.map((l) => ({
        ...(f.locales.length > 1 ? { locale: l.locale } : {}),
        before: readable(l.before, f.fieldType, titles),
        after: readable(l.after, f.fieldType, titles),
      })),
    };
  });
}

/** Every link a value holds, however deep (a list of them, a component's). */
function collectLinks(v: unknown, into: { entries: Set<string>; assets: Set<string> }) {
  const link = linkOf(v);
  if (link) (link.linkType === 'Asset' ? into.assets : into.entries).add(link.id);
  else if (Array.isArray(v)) for (const x of v) collectLinks(x, into);
  else if (v && typeof v === 'object' && !('nodeType' in v))
    for (const x of Object.values(v)) collectLinks(x, into);
}

/** More assets than this and the rest read "Linked asset": each one is a request of its own. */
const MAX_ASSET_TITLES = 20;

/** Assets by id, by their title in `locale`, else any locale's, else the file's name. */
async function assetTitles(client: ManagementClient, ids: readonly string[], locale: string) {
  const read = await Promise.allSettled(
    ids.slice(0, MAX_ASSET_TITLES).map((id) => client.getAsset(id)),
  );
  return read.flatMap((r): [string, string][] => {
    if (r.status !== 'fulfilled') return [];
    const { id, title, file } = r.value;
    const named = title[locale] ?? Object.values(title).find((t) => typeof t === 'string' && t);
    return [[id, typeof named === 'string' && named ? named : file.fileName]];
  });
}

async function readReview(
  client: ManagementClient,
  target: ReviewTarget,
  locale: string,
): Promise<EntryReview> {
  const { entryId, named } = target;
  let changes = target.changes;
  let entry: PreviewEntry | null = null;
  if (!changes) {
    try {
      const diff = await client.diffVersions(entryId, 'published', target.version ?? 'draft');
      changes = diff.changes;
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 404) return { status: 'failed' };
      // No published version, or no such entry: only the entry can say which.
      entry = await client.getEntry(entryId).catch(() => null);
      if (entry?.status !== 'draft') return { status: 'failed' };
    }
  }
  const links = { entries: new Set<string>(), assets: new Set<string>() };
  for (const f of changes ?? [])
    for (const l of f.locales) {
      collectLinks(l.before, links);
      collectLinks(l.after, links);
    }
  // Titles are a courtesy: one that can't be read stays out, and its link reads "Linked entry".
  const [types, linked, assets, self] = await Promise.all([
    named || links.entries.size ? client.listContentTypes().catch(() => []) : [],
    fetchEntriesById(client, [...links.entries]).catch(() => []),
    assetTitles(client, [...links.assets], locale),
    named && !entry ? client.getEntry(entryId).catch(() => null) : entry,
  ]);
  const title = named && self ? { title: entryRef(self, types, locale).title } : {};
  if (!changes) return { status: 'first', ...title };
  const titles = new Map([
    ...linked.map((e): [string, string] => [e.id, entryRef(e, types, locale).title]),
    ...assets,
  ]);
  return { status: 'ready', fields: reviewFields(changes, locale, titles), ...title };
}

const LOADING: EntryReview = { status: 'loading' };
const IDLE: EntryReview = { status: 'idle' };

/** Reads what publishing `target` would change; a read only, with no `target` nothing at all. */
export function useEntryReview(
  client: ManagementClient,
  target: ReviewTarget | null,
  locale: string,
): EntryReview {
  const [review, setReview] = useState(LOADING);
  const entryId = target?.entryId;
  const version = target?.version;
  const changes = target?.changes;
  const named = target?.named;
  useEffect(() => {
    if (!entryId) return;
    let live = true;
    setReview(LOADING);
    readReview(
      client,
      {
        entryId,
        ...(version === undefined ? {} : { version }),
        ...(changes ? { changes } : {}),
        ...(named ? { named } : {}),
      },
      locale,
    ).then(
      (r) => {
        if (live) setReview(r);
      },
      () => {
        if (live) setReview({ status: 'failed' });
      },
    );
    return () => {
      live = false;
    };
  }, [client, entryId, version, changes, named, locale]);
  return target ? review : IDLE;
}

/** Past this many a list of names stops and says how many more: Review changes has them all. */
const LIST_MAX = 6;

/** The changed fields by name, with how each changed. */
export function ChangedFields({ fields }: { fields: readonly ReviewField[] }) {
  const changed = fields.filter(isChanged);
  const more = changed.length - LIST_MAX;
  return (
    <ul aria-label="Changed fields" className="space-y-1 text-sm">
      {changed.slice(0, LIST_MAX).map((f) => (
        <li key={f.field} className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 break-words font-medium">{f.name}</span>
          <KindBadge kind={f.kind} />
        </li>
      ))}
      {more > 0 ? <li className="text-muted-foreground text-xs">and {more} more</li> : null}
    </ul>
  );
}

function FieldHeading({ field, locale }: { field: ReviewField; locale?: string }) {
  return (
    <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
      <span className="min-w-0 break-words font-medium">{field.name}</span>
      {locale ? <span className="font-mono text-muted-foreground text-xs">{locale}</span> : null}
      {isChanged(field) ? <KindBadge kind={field.kind} /> : null}
    </span>
  );
}

/**
 * Each changed field's published value and its draft, side by side only where the space around them
 * allows (a container query, not the viewport: a dialog on a tablet and the assistant's column on a
 * desktop are as narrow as a phone). Each value carries its own label, so stacked they still read.
 * Unchanged fields wait behind a disclosure.
 */
export function FieldReview({ fields }: { fields: readonly ReviewField[] }) {
  const changed = fields.filter(isChanged);
  const same = fields.filter((f) => !isChanged(f));
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="@container min-w-0 space-y-2 text-sm">
      {changed.length ? (
        <ul aria-label="Changes" className="divide-y">
          {changed.flatMap((f) =>
            f.rows.map((r) => (
              <li key={`${f.field}:${r.locale ?? ''}`} className="space-y-1 py-2 first:pt-0">
                <FieldHeading field={f} {...(r.locale ? { locale: r.locale } : {})} />
                <dl className="grid gap-x-4 gap-y-1 @md:grid-cols-2">
                  <div className="min-w-0">
                    <dt className="caption">Published</dt>
                    <dd>
                      <FieldValue value={r.before} muted />
                    </dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="caption">Draft</dt>
                    <dd>
                      <FieldValue value={r.after} />
                    </dd>
                  </div>
                </dl>
              </li>
            )),
          )}
        </ul>
      ) : null}
      {same.length ? (
        <Collapsible open={open} onOpenChange={setOpen}>
          <Button
            variant="link"
            size="xs"
            className="px-0"
            aria-expanded={open}
            aria-controls={id}
            onClick={() => setOpen((o) => !o)}
          >
            {open
              ? 'Hide unchanged fields'
              : `Show ${same.length} unchanged ${same.length === 1 ? 'field' : 'fields'}`}
          </Button>
          <CollapsibleContent id={id}>
            <ul aria-label="Unchanged fields" className="divide-y">
              {same.map((f) => (
                <li key={f.field} className="space-y-1 py-2">
                  <FieldHeading field={f} />
                  <FieldValue value={f.rows[0]?.after} muted />
                </li>
              ))}
            </ul>
          </CollapsibleContent>
        </Collapsible>
      ) : null}
    </div>
  );
}

/** The diff couldn't be read: said as plainly as the decision beside it deserves. */
export function ReviewFailed() {
  return (
    <Alert variant="destructive">
      <TriangleAlert />
      <AlertTitle>Couldn’t load what changed</AlertTitle>
      <AlertDescription>Check the entry before you go on.</AlertDescription>
    </Alert>
  );
}

/**
 * An entry's draft against its published version, in full. With `changes` (a diff the caller
 * already read and has said aloud) it shows them; otherwise it reads them and says how many.
 */
export function EntryDiff(props: {
  client: ManagementClient;
  entry: PreviewEntry;
  locale: string;
  changes?: readonly FieldDiff[];
}) {
  const { client, entry, locale, changes } = props;
  const target = useMemo(
    () => ({ entryId: entry.id, ...(changes ? { changes } : {}) }),
    [entry.id, changes],
  );
  const review = useEntryReview(client, target, locale);
  if (review.status === 'first')
    return (
      <Alert variant="destructive">
        <TriangleAlert />
        <AlertTitle>No published version</AlertTitle>
        <AlertDescription>
          This entry hasn’t been published yet, so there’s nothing to compare against.
        </AlertDescription>
      </Alert>
    );
  if (review.status === 'failed') return <ReviewFailed />;
  if (review.status !== 'ready') return <p className="text-muted-foreground text-sm">Comparing…</p>;
  const count = review.fields.filter(isChanged).length;
  return (
    <div className="space-y-3">
      {changes ? null : (
        <p className="text-muted-foreground text-sm">
          {`${count} field${count === 1 ? '' : 's'} changed`}
        </p>
      )}
      <FieldReview fields={review.fields} />
    </div>
  );
}
