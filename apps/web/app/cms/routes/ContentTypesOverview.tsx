import type { ContentType, ContentTypeDraft } from '@contentworker/domain';
import { Button } from '@contentworker/ui/button';
import { Skeleton, SkeletonText } from '@contentworker/ui/skeleton';
import { Table, TableBody, TableHead, Td, Th, Tr } from '@contentworker/ui/table';
import { Plus, Shapes } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { ContentTypeDialog } from '~/cms/components/ContentTypeDialog';
import { LoadingStatus } from '~/cms/components/loading';
import { Empty, PageHeader } from '~/cms/components/page';
import { StatusBadge } from '~/cms/components/status';
import { count, plural } from '~/cms/lib/format';
import { useClient } from '../lib/client-context';
import type { ContentTypeEntryCounts } from '../lib/management';
import { useScopedQuery } from '../lib/queries';
import { useToast } from '../lib/toast';
import { useContentOutlet } from './content-context';

/**
 * Content-types overview: one row per type with what an editor needs before opening it (how many
 * entries it holds, and how many of them wait to be published), and create / edit / publish for
 * the schema. A type reads as published unless it says otherwise: only a draft schema carries a
 * badge, since a badge every row shares tells nobody anything.
 */
export function ContentTypesOverview() {
  const { client, run } = useClient();
  const { types, typesPending, reload } = useContentOutlet();
  const toast = useToast();
  const [dialog, setDialog] = useState<{ open: boolean; initial?: ContentType }>({ open: false });
  // Under the entries prefix, so every entry mutation's invalidation refreshes them too. Silent:
  // the counts are a summary beside the list, which works without them.
  const countsQuery = useScopedQuery(['entries', 'counts'], () => client.contentTypeEntryCounts(), {
    silent: true,
  });
  const countsFor = (apiId: string): ContentTypeEntryCounts | undefined =>
    countsQuery.data?.find((c) => c.contentType === apiId);

  const save = (draft: ContentTypeDraft) =>
    run(async () => {
      await client.saveContentType(draft);
      await client.publishContentType(draft.apiId);
      reload();
      toast.success(`Content type “${draft.name}” saved`);
    });

  const publish = (ct: ContentType) =>
    run(async () => {
      await client.publishContentType(ct.apiId);
      reload();
      toast.success(`Published “${ct.name}”`);
    });

  /** A count cell: a skeleton while loading, a dash when the counts couldn't be read. */
  const figure = (n: number | undefined) =>
    countsQuery.isPending ? (
      <Skeleton className="ml-auto h-4 w-8" />
    ) : n === undefined ? (
      <span className="text-muted-foreground">—</span>
    ) : (
      <span className={n === 0 ? 'text-muted-foreground' : undefined}>{count(n)}</span>
    );

  return (
    <div>
      <PageHeader
        title="Content"
        subtitle="Each content type is a schema; its entries are the content. Open one to browse and edit its entries."
        actions={
          <Button size="sm" onClick={() => setDialog({ open: true })}>
            <Plus aria-hidden="true" /> New content type
          </Button>
        }
      />
      {typesPending ? (
        // Never "No content types yet" before the types have arrived.
        <div className="card overflow-clip" aria-busy="true">
          <LoadingStatus>Loading content types…</LoadingStatus>
          <div className="divide-y text-sm">
            {['38%', '52%', '44%', '60%'].map((w) => (
              <div key={w} className="flex items-center gap-3 px-4 py-3">
                <SkeletonText width={w} className="flex-1" />
                <Skeleton className="h-4 w-8" />
              </div>
            ))}
          </div>
        </div>
      ) : types.length === 0 ? (
        <Empty icon={<Shapes />} title="No content types yet" className="card">
          A content type defines the fields its entries have. Make one to start writing content, or{' '}
          <Link to="/content/space-import" className="underline underline-offset-4">
            import a space export
          </Link>{' '}
          with its model, entries and assets.
        </Empty>
      ) : (
        <div className="card overflow-clip">
          <Table stack="cards" caption="Content types">
            <TableHead>
              <Tr>
                <Th>Content type</Th>
                <Th numeric>Entries</Th>
                <Th numeric>Drafts</Th>
                <Th numeric>Changed</Th>
                <Th numeric>Fields</Th>
                <Th>
                  <span className="sr-only">Actions</span>
                </Th>
              </Tr>
            </TableHead>
            <TableBody>
              {types.map((ct) => {
                const n = countsFor(ct.apiId);
                return (
                  <Tr key={ct.apiId}>
                    <Td>
                      <div className="flex flex-wrap items-center gap-2">
                        <Link
                          to={`/content/${ct.apiId}`}
                          className="font-medium text-foreground hover:underline"
                        >
                          {ct.name}
                        </Link>
                        {ct.status === 'draft' ? <StatusBadge status="draft" /> : null}
                      </div>
                      <div className="font-mono text-muted-foreground text-xs">{ct.apiId}</div>
                    </Td>
                    <Td numeric label="Entries">
                      {figure(n?.total)}
                    </Td>
                    <Td numeric label="Drafts">
                      {figure(n?.draft)}
                    </Td>
                    <Td numeric label="Changed">
                      {figure(n?.changed)}
                    </Td>
                    <Td numeric label="Fields">
                      <span title={plural(ct.fields.length, 'field')}>{ct.fields.length}</span>
                    </Td>
                    <Td className="text-right">
                      <div className="flex justify-end gap-1">
                        {ct.status === 'draft' ? (
                          <Button size="sm" variant="outline" onClick={() => publish(ct)}>
                            Publish
                          </Button>
                        ) : null}
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={`Edit “${ct.name}”`}
                          onClick={() => setDialog({ open: true, initial: ct })}
                        >
                          Edit
                        </Button>
                      </div>
                    </Td>
                  </Tr>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Key on the target so the form seeds fresh each time it opens. */}
      <ContentTypeDialog
        key={`${dialog.open}:${dialog.initial?.apiId ?? 'new'}`}
        open={dialog.open}
        onOpenChange={(open) => setDialog((d) => ({ ...d, open }))}
        initial={dialog.initial}
        onSave={save}
      />
    </div>
  );
}
