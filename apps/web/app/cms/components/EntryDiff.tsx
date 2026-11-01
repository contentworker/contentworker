import { Alert, AlertDescription, AlertTitle } from '@contentworker/ui/alert';
import { Button } from '@contentworker/ui/button';
import { cn } from '@contentworker/ui/lib/utils';
import {
  Table,
  TableBody,
  Td as TableCell,
  Th as TableHead,
  TableHead as TableHeader,
  Tr as TableRow,
} from '@contentworker/ui/table';
import { TriangleAlert } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { ToneBadge } from '~/cms/components/status';
import type { ManagementClient, PreviewEntry } from '../lib/management';

/** A single field's draft-vs-published comparison. */
interface FieldDelta {
  readonly apiId: string;
  readonly published: unknown;
  readonly draft: unknown;
  readonly changed: boolean;
}

/** A rich-text document's words, block by block (`nodeType`/`value`/`content`). */
function richText(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  const n = node as { nodeType?: unknown; value?: unknown; content?: unknown };
  if (n.nodeType === 'text') return typeof n.value === 'string' ? n.value : '';
  const parts = Array.isArray(n.content) ? n.content.map(richText) : [];
  // Blocks under the document break onto their own lines; inline runs join as they are.
  return n.nodeType === 'document' ? parts.filter(Boolean).join('\n') : parts.join('');
}

/**
 * A field value as words a reviewer can read: text as it is, a rich-text document as its text, a
 * link as what it points at, a list joined; anything else as JSON. Empty for nothing.
 */
export function valueText(v: unknown): string {
  if (v === undefined || v === null || v === '') return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.map(valueText).filter(Boolean).join(', ');
  if (typeof v === 'object') {
    const o = v as { nodeType?: unknown; sys?: { type?: unknown; linkType?: unknown } };
    if (o.nodeType === 'document') return richText(v);
    if (o.sys?.type === 'Link') return o.sys.linkType === 'Asset' ? 'Linked asset' : 'Linked entry';
  }
  return JSON.stringify(v, null, 2);
}

/** Past this many characters or lines a value folds behind "Show all". */
const FOLD_CHARS = 280;
const FOLD_LINES = 4;

/**
 * One field value, folded to a few lines with a "Show all" disclosure when it is long, so a long
 * body never pushes the decision off the screen. An empty value says so in words.
 */
export function FieldValue({ value, muted }: { value: unknown; muted?: boolean }) {
  const text = valueText(value);
  const [open, setOpen] = useState(false);
  const id = useId();
  if (!text) return <span className="text-muted-foreground italic">Empty</span>;
  const long = text.length > FOLD_CHARS || text.split('\n').length > FOLD_LINES;
  return (
    <div className="min-w-0">
      <p
        id={id}
        className={cn(
          'whitespace-pre-wrap break-words',
          muted && 'text-muted-foreground',
          long && !open && 'line-clamp-4',
        )}
      >
        {text}
      </p>
      {long ? (
        <Button
          variant="link"
          size="xs"
          className="px-0"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? 'Show less' : 'Show all'}
        </Button>
      ) : null}
    </div>
  );
}

/** One field's before and after, named for a person (`label`) with an optional mono detail. */
export interface FieldChange {
  readonly key: string;
  readonly label: string;
  /** Secondary, in mono: a locale, say. Never the field's only name. */
  readonly detail?: string;
  readonly before: unknown;
  readonly after: unknown;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * A before/after table of field changes: what the entry holds now beside what would replace it.
 * Rows stack into cards on a phone. Shared by the draft-vs-published diff and agent proposals.
 */
export function FieldChanges(props: {
  changes: readonly FieldChange[];
  caption: string;
  beforeLabel?: string;
  afterLabel?: string;
}) {
  const before = props.beforeLabel ?? 'Current';
  const after = props.afterLabel ?? 'Proposed';
  return (
    <Table stack="cards" caption={props.caption}>
      <TableHeader>
        <TableRow>
          <TableHead className="w-40">Field</TableHead>
          <TableHead>{before}</TableHead>
          <TableHead>{after}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {props.changes.map((c) => (
          <TableRow key={c.key}>
            <TableCell className="align-top">
              <span className="flex flex-wrap items-baseline gap-x-1.5">
                <span className="font-medium">{c.label}</span>
                {c.detail ? (
                  <span className="font-mono text-muted-foreground text-xs">{c.detail}</span>
                ) : null}
              </span>
              {same(c.before, c.after) ? (
                <span className="block text-muted-foreground text-xs">No change</span>
              ) : null}
            </TableCell>
            <TableCell label={before} className="align-top max-md:basis-full">
              <FieldValue value={c.before} muted />
            </TableCell>
            <TableCell label={after} className="align-top max-md:basis-full">
              <FieldValue value={c.after} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/**
 * Compares an entry's current draft against its published version. Draft fields
 * come from Preview (localized shape), published from Delivery (locale-collapsed,
 * links embedded) — so we unwrap the draft to the connection locale before diffing.
 */
export function EntryDiff(props: {
  client: ManagementClient;
  entry: PreviewEntry;
  locale: string;
}) {
  const { client, entry, locale } = props;
  const [deltas, setDeltas] = useState<FieldDelta[]>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const published = await client.getPublished(entry.id);
        if (!live) return;
        const keys = new Set([...Object.keys(entry.fields), ...Object.keys(published.fields)]);
        const rows: FieldDelta[] = [];
        for (const apiId of keys) {
          const raw = entry.fields[apiId];
          const draft =
            raw && typeof raw === 'object' ? (raw as Record<string, unknown>)[locale] : raw;
          const pub = published.fields[apiId];
          rows.push({
            apiId,
            draft,
            published: pub,
            changed: JSON.stringify(draft ?? null) !== JSON.stringify(pub ?? null),
          });
        }
        setDeltas(rows.sort((a, b) => Number(b.changed) - Number(a.changed)));
      } catch (e) {
        // A draft that was never published has no delivery row (404) — say so plainly.
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      live = false;
    };
  }, [client, entry, locale]);

  const changedCount = deltas?.filter((d) => d.changed).length ?? 0;

  return (
    <div className="space-y-3">
      {!error && (
        <p className="text-sm text-muted-foreground">
          {deltas ? `${changedCount} field${changedCount === 1 ? '' : 's'} changed` : 'Comparing…'}
        </p>
      )}
      {error && (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertTitle>No published version</AlertTitle>
          <AlertDescription>
            This entry hasn’t been published yet, so there’s nothing to compare against.
          </AlertDescription>
        </Alert>
      )}
      {deltas && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-32">Field</TableHead>
              <TableHead>Published</TableHead>
              <TableHead>Draft</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {deltas.map((d) => (
              <TableRow key={d.apiId} className={cn(d.changed && 'bg-wait/5')}>
                <TableCell>
                  <span className="flex items-center gap-1.5">
                    {d.apiId}
                    {d.changed && <ToneBadge tone="wait" label="Changed" />}
                  </span>
                </TableCell>
                <TableCell className="align-top">
                  <FieldValue value={d.published} muted />
                </TableCell>
                <TableCell className="align-top">
                  <FieldValue value={d.draft} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
