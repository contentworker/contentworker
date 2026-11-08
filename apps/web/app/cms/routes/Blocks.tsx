import {
  type BlockManifest,
  blockVariants,
  type ContentType,
  type FieldDefinition,
} from '@contentworker/domain';
import { Button } from '@contentworker/ui/button';
import {
  Catalog,
  CatalogEmpty,
  CatalogFigure,
  CatalogRow,
  CatalogTile,
  ListSearch,
  ListToolbar,
} from '@contentworker/ui/catalog';
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockContent,
  CodeBlockCopyButton,
} from '@contentworker/ui/code-block';
import { Skeleton } from '@contentworker/ui/skeleton';
import { Boxes } from 'lucide-react';
import { useEffect, useId, useMemo, useState } from 'react';
import { Ago } from '~/cms/components/ago';
import { Empty, PageHeader, Section } from '~/cms/components/page';
import { actorLabel } from '~/cms/lib/authorship';
import { count, plural } from '~/cms/lib/format';
import type { BlockCatalogUsage, TeamPerson } from '~/cms/lib/management';
import { useClient } from '../lib/client-context';
import { useContentTypesQuery, useScopedQuery } from '../lib/queries';

/*
 * The block catalog, read-only: the components the site's code pushed (`contentworker blocks
 * push`), each with its props, its slots and what they take, where it may go, and how many entries
 * use it. Nothing here changes the catalog: it lives in the developer's repository, and a change
 * is a push from there, so the code and the admin can't disagree.
 */

/** Where the empty state's example points when the space has no blocks field to fill in. */
export const PLACEHOLDER_TARGET = {
  contentTypeApiId: 'YOUR_CONTENT_TYPE',
  field: 'YOUR_BLOCKS_FIELD',
} as const;

/** The guide the empty state links to. */
export const BLOCKS_GUIDE_URL = 'https://docs.contentworker.app/guides/blocks-from-code/';

/**
 * The first top-level blocks field (an Array of components with block types) among the space's
 * content types, in the model's order: what a push can target. Null when there is none.
 */
export function firstBlocksTarget(
  types: readonly Pick<ContentType, 'apiId' | 'fields'>[],
): { contentTypeApiId: string; field: string } | null {
  for (const t of types) {
    const f = t.fields.find((d) => blockVariants(d) !== undefined);
    if (f) return { contentTypeApiId: t.apiId, field: f.apiId };
  }
  return null;
}

/** A minimal blocks file, as the CLI reads it, pushing one block into `target`. */
export function exampleBlocksFile(target: {
  readonly contentTypeApiId: string;
  readonly field: string;
}): string {
  return `{
  "targets": [
    { "contentTypeApiId": ${JSON.stringify(target.contentTypeApiId)}, "field": ${JSON.stringify(target.field)} }
  ],
  "blocks": [
    {
      "id": "hero",
      "name": "Hero",
      "fields": [
        {
          "apiId": "heading",
          "name": "Heading",
          "type": "Symbol",
          "required": true
        },
        {
          "apiId": "tone",
          "name": "Tone",
          "type": "Symbol",
          "validations": { "in": ["light", "dark"] }
        }
      ]
    }
  ]
}`;
}

const PUSH_COMMAND = 'npx contentworker blocks push --dry-run';

export function Blocks() {
  const { client } = useClient();
  const catalogQuery = useScopedQuery(['block-catalog'], () => client.getBlockCatalog());
  const catalog = catalogQuery.data;
  // Counted only once there is a catalog; a failure shows in each row's figure, not a toast.
  const usageQuery = useScopedQuery(['block-catalog', 'usage'], () => client.getBlockUsage(), {
    enabled: !!catalog,
    silent: true,
  });
  const typesQuery = useContentTypesQuery();
  const [filter, setFilter] = useState('');
  // The example targets a real blocks field when the space has one, so copying it works.
  const target = firstBlocksTarget(typesQuery.data ?? []);
  const example = exampleBlocksFile(target ?? PLACEHOLDER_TARGET);
  const groupId = useId();
  // The team names who pushed; only an administrator may read it, so a refusal leaves the
  // pusher described by kind.
  const [people, setPeople] = useState<readonly TeamPerson[]>([]);
  useEffect(() => {
    let live = true;
    client
      .getTeam()
      .then((team) => live && setPeople(team.people))
      .catch(() => {
        /* not an administrator: the pusher reads by kind */
      });
    return () => {
      live = false;
    };
  }, [client]);

  const typeOf = useMemo(() => {
    const m = new Map((typesQuery.data ?? []).map((t) => [t.apiId, t]));
    return (apiId: string) => m.get(apiId);
  }, [typesQuery.data]);
  const typeName = (apiId: string) => typeOf(apiId)?.name ?? apiId;
  const fieldName = (apiId: string, field: string) =>
    typeOf(apiId)?.fields.find((f) => f.apiId === field)?.name ?? field;
  const blockName = useMemo(() => {
    const m = new Map((catalog?.blocks ?? []).map((b) => [b.id, b.name]));
    return (id: string) => m.get(id) ?? id;
  }, [catalog]);

  const q = filter.trim().toLowerCase();
  const shown = (catalog?.blocks ?? []).filter(
    (b) =>
      !q ||
      b.name.toLowerCase().includes(q) ||
      b.id.toLowerCase().includes(q) ||
      (b.group ?? '').toLowerCase().includes(q),
  );
  // The dock's groups, in the order the catalog first names them; ungrouped blocks last.
  const groups = useMemo(() => {
    const out = new Map<string, BlockManifest[]>();
    for (const b of shown) out.set(b.group ?? '', [...(out.get(b.group ?? '') ?? []), b]);
    return [...out].sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : 0));
  }, [shown]);
  const headed = groups.length > 1 || (groups[0]?.[0] ?? '') !== '';

  return (
    <>
      <PageHeader
        title="Blocks"
        subtitle="The components your site renders, pushed from its code. Editors compose pages from these blocks; to change one, change the code and push again."
      />
      {catalogQuery.isPending ? (
        <div className="card space-y-3 p-5" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : catalogQuery.isError ? (
        <Section title="Block catalog">
          <Empty
            title="The block catalog couldn’t be loaded"
            action={
              <Button size="sm" onClick={() => void catalogQuery.refetch()}>
                Try again
              </Button>
            }
          >
            Nothing has changed: the catalog is still what was last pushed.
          </Empty>
        </Section>
      ) : !catalog ? (
        <Section title="Block catalog">
          <Empty icon={<Boxes aria-hidden="true" />} title="No blocks pushed yet">
            Blocks come from code: each one is a component your site renders, with the props editors
            fill in and the slots that hold other blocks.
          </Empty>
          <div className="mx-auto w-full max-w-xl space-y-3 pb-2">
            <p className="max-w-measure text-muted-foreground text-sm">
              Describe your components in{' '}
              <code className="font-mono">contentworker.blocks.json</code> at the root of your site,
              then push them. The dry run shows what would change.
            </p>
            <p className="max-w-measure text-muted-foreground text-sm">
              {target ? (
                <>
                  The example fills {typeName(target.contentTypeApiId)} ›{' '}
                  {fieldName(target.contentTypeApiId, target.field)}, and its block types become the
                  catalog’s.{' '}
                </>
              ) : (
                <>
                  Replace the target with a Blocks field (an Array of components) on one of your
                  content types: no content type has one yet.{' '}
                </>
              )}
              <a
                href={BLOCKS_GUIDE_URL}
                target="_blank"
                rel="noreferrer noopener"
                className="text-link underline underline-offset-4"
              >
                Blocks from code guide<span className="sr-only"> (opens in a new tab)</span>
              </a>
            </p>
            <CodeBlock size="sm">
              <CodeBlockActions>
                <CodeBlockCopyButton value={example} />
              </CodeBlockActions>
              <CodeBlockContent aria-label="Example contentworker.blocks.json">
                {example}
              </CodeBlockContent>
            </CodeBlock>
            <CodeBlock size="sm">
              <CodeBlockActions>
                <CodeBlockCopyButton value={PUSH_COMMAND} />
              </CodeBlockActions>
              <CodeBlockContent aria-label="Push command">{PUSH_COMMAND}</CodeBlockContent>
            </CodeBlock>
          </div>
        </Section>
      ) : (
        <div className="space-y-5">
          <Section title="Catalog">
            <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
              <div>
                <dt className="caption">Version</dt>
                <dd className="font-mono">v{catalog.version}</dd>
              </div>
              <div>
                <dt className="caption">Pushed</dt>
                <dd>
                  <Ago at={catalog.pushedAt} />
                  {` by ${actorLabel(catalog.pushedBy, { people }, 'inSentence')}`}
                </dd>
              </div>
              <div className="col-span-2">
                <dt className="caption">Goes in</dt>
                <dd>
                  {catalog.targets
                    .map(
                      (t) =>
                        `${typeName(t.contentTypeApiId)} › ${fieldName(t.contentTypeApiId, t.field)}`,
                    )
                    .join(', ')}
                </dd>
              </div>
            </dl>
          </Section>
          <Section
            title="All blocks"
            flush
            actions={
              <span className="text-muted-foreground text-xs tabular">
                {plural(catalog.blocks.length, 'block')}
              </span>
            }
          >
            <ListToolbar summary={`${shown.length} shown`}>
              <ListSearch
                label="Filter blocks"
                placeholder="Filter by name, id or group"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                onClear={() => setFilter('')}
              />
            </ListToolbar>
            {shown.length === 0 ? (
              <CatalogEmpty onClear={() => setFilter('')}>
                No block matches “{filter.trim()}”.
              </CatalogEmpty>
            ) : (
              <div className="space-y-4 pb-4">
                {groups.map(([group, blocks], i) => {
                  // Ids by the group's place, never a slug of its name.
                  const headingId = `${groupId}-g${i}`;
                  return (
                    <div key={group || '(none)'}>
                      {headed ? (
                        <h3 id={headingId} className="caption px-4 pb-1">
                          {group || 'Other'}
                        </h3>
                      ) : null}
                      <Catalog
                        {...(headed
                          ? { 'aria-labelledby': headingId }
                          : { 'aria-label': 'Blocks' })}
                        className="pt-0"
                      >
                        {blocks.map((b) => (
                          <BlockRow
                            key={b.id}
                            block={b}
                            blockName={blockName}
                            typeName={typeName}
                            usage={usageQuery.data}
                            usageFailed={usageQuery.isError}
                          />
                        ))}
                      </Catalog>
                    </div>
                  );
                })}
              </div>
            )}
          </Section>
        </div>
      )}
    </>
  );
}

/** A prop as one phrase: its name and type, and a token prop's choices. */
export function propSummary(f: FieldDefinition): string {
  const options = f.validations?.in;
  const values = options?.map((o) => (typeof o === 'object' && o !== null ? o.label : String(o)));
  const type = f.type === 'Array' && f.items ? `list of ${f.items.type}` : f.type;
  return values?.length ? `${f.name} (${values.join(' | ')})` : `${f.name} (${type})`;
}

/** How many blocks a slot holds, in words, when it says. */
function slotBounds(min?: number, max?: number): string {
  if (min !== undefined && max !== undefined) return min === max ? `${min}` : `${min}–${max}`;
  if (min !== undefined) return `at least ${min}`;
  if (max !== undefined) return `up to ${max}`;
  return '';
}

function BlockRow({
  block,
  blockName,
  typeName,
  usage,
  usageFailed,
}: {
  block: BlockManifest;
  blockName: (id: string) => string;
  typeName: (apiId: string) => string;
  usage: BlockCatalogUsage | undefined;
  usageFailed: boolean;
}) {
  const used = usage?.blocks.find((u) => u.id === block.id);
  const usedOn = used
    ? used.contentTypes
        .map((t) => `${typeName(t.contentTypeApiId)} (${plural(t.entries, 'entry', 'entries')})`)
        .join(', ')
    : '';
  return (
    <CatalogRow
      media={
        <CatalogTile>
          <Boxes aria-hidden="true" />
        </CatalogTile>
      }
      title={
        <span className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-medium text-foreground">{block.name}</span>
          <code className="font-mono text-muted-foreground text-xs">{block.id}</code>
        </span>
      }
      meta={
        <span className="flex flex-col gap-0.5">
          {block.description ? <span className="max-w-measure">{block.description}</span> : null}
          <span>
            {block.fields.length
              ? `Props: ${block.fields.map(propSummary).join(', ')}`
              : 'No props'}
          </span>
          {(block.slots ?? []).map((s) => {
            const bounds = slotBounds(s.min, s.max);
            return (
              <span key={s.apiId}>
                Slot {s.name} takes {s.allowedChildren.map(blockName).join(', ')}
                {bounds ? ` (${bounds})` : ''}
              </span>
            );
          })}
          {block.allowedParents ? (
            <span>Only inside {block.allowedParents.map(blockName).join(', ')}</span>
          ) : null}
          {block.aliases?.length ? <span>Formerly {block.aliases.join(', ')}</span> : null}
          {usedOn ? <span>Used on {usedOn}</span> : null}
        </span>
      }
      aside={
        <CatalogFigure label="Entries">
          {used ? (
            `${usage?.complete ? '' : 'at least '}${count(used.entries)}`
          ) : usageFailed ? (
            'Unknown'
          ) : (
            <>
              <Skeleton className="inline-block h-3 w-6" aria-hidden="true" />
              <span className="sr-only">Counting</span>
            </>
          )}
        </CatalogFigure>
      }
    />
  );
}
