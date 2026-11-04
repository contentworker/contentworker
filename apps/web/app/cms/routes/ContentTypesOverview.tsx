import type { ContentType, ContentTypeDraft } from '@contentworker/domain';
import { Button } from '@contentworker/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@contentworker/ui/dropdown-menu';
import { Skeleton, SkeletonText } from '@contentworker/ui/skeleton';
import { Table, TableBody, TableHead, Td, Th, Tr } from '@contentworker/ui/table';
import { MoreHorizontalIcon, Plus, Shapes } from 'lucide-react';
import { useRef, useState } from 'react';
import { Link } from 'react-router';
import {
  CloneContentTypeDialog,
  DeleteContentTypeDialog,
} from '~/cms/components/ContentTypeActions';
import { ContentTypeDeleteJobCard } from '~/cms/components/ContentTypeDeleteJob';
import { ContentTypeDialog } from '~/cms/components/ContentTypeDialog';
import { LoadingStatus } from '~/cms/components/loading';
import { Empty, PageHeader } from '~/cms/components/page';
import { StatusBadge } from '~/cms/components/status';
import { count, plural } from '~/cms/lib/format';
import { useClient } from '../lib/client-context';
import { apiErrorMessage, type ContentTypeEntryCounts } from '../lib/management';
import { useInvalidate, useScopedQuery } from '../lib/queries';
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
  const { types, typesPending, reload, deleteJob } = useContentOutlet();
  const toast = useToast();
  const [dialog, setDialog] = useState<{ open: boolean; initial?: ContentType }>({ open: false });
  // A type's menu: Clone and Delete, each in its own dialog.
  const [cloning, setCloning] = useState<ContentType | null>(null);
  const [deleting, setDeleting] = useState<ContentType | null>(null);
  const invalidate = useInvalidate();
  // Each row's ⋯ button, so focus comes back to it when a dialog it opened closes (the menu item
  // that opened the dialog is gone by then, and focus would otherwise fall to the page).
  const triggers = useRef(new Map<string, HTMLButtonElement>());
  // Set when a delete removed the type at once: its row (and button) go with it.
  const deletedNow = useRef(false);
  const focusTrigger = (apiId: string) => (event: Event) => {
    event.preventDefault();
    triggers.current.get(apiId)?.focus();
  };
  /** After a delete: the next row's button, or the page's heading when it was the last row. */
  const focusAfterDelete = (apiId: string) => (event: Event) => {
    if (!deletedNow.current) return focusTrigger(apiId)(event);
    event.preventDefault();
    deletedNow.current = false;
    const next = types[types.findIndex((t) => t.apiId === apiId) + 1];
    const to = next ? triggers.current.get(next.apiId) : undefined;
    if (to) return to.focus();
    const heading = document.querySelector<HTMLElement>('h1');
    if (heading) {
      heading.tabIndex = -1;
      heading.focus();
    }
  };
  // Under the entries prefix, so every entry mutation's invalidation refreshes them too. Silent:
  // the counts are a summary beside the list, which works without them.
  const countsQuery = useScopedQuery(['entries', 'counts'], () => client.contentTypeEntryCounts(), {
    silent: true,
  });
  const countsFor = (apiId: string): ContentTypeEntryCounts | undefined =>
    countsQuery.data?.find((c) => c.contentType === apiId);

  // A failure goes back to the dialog, which keeps the form and says what happened.
  const save = async (draft: ContentTypeDraft) => {
    let failed: unknown;
    await run(async () => {
      try {
        await client.saveContentType(draft);
        // The draft has landed by now, so a refused publish doesn't mean nothing was saved.
        await client.publishContentType(draft.apiId).catch((err) => {
          throw new Error(`The draft saved but wasn’t published: ${apiErrorMessage(err)}`);
        });
        reload();
        toast.success(`Content type “${draft.name}” saved`);
      } catch (err) {
        failed = err;
      }
    });
    if (failed !== undefined) throw failed;
  };

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
      {/* Kept by the Content layout, so it is still here after a visit to an entry. */}
      <ContentTypeDeleteJobCard job={deleteJob} />
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
                          // A singleton opens its one entry, as the sidebar does.
                          to={ct.singleton ? `/content/${ct.apiId}/entry` : `/content/${ct.apiId}`}
                          className="font-medium text-foreground hover:underline"
                        >
                          {ct.name}
                        </Link>
                        {ct.status === 'draft' ? <StatusBadge status="draft" /> : null}
                      </div>
                      <div className="text-muted-foreground text-xs">
                        <span className="font-mono">{ct.apiId}</span>
                        {ct.singleton ? ' · one entry only' : null}
                      </div>
                      {ct.description && (
                        <p className="line-clamp-2 max-w-measure text-muted-foreground text-xs">
                          {ct.description}
                        </p>
                      )}
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
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              ref={(el) => {
                                if (el) triggers.current.set(ct.apiId, el);
                                else triggers.current.delete(ct.apiId);
                              }}
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`More actions for “${ct.name}”`}
                            >
                              <MoreHorizontalIcon aria-hidden="true" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-auto min-w-40">
                            <DropdownMenuItem onSelect={() => setCloning(ct)}>
                              Clone…
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              variant="destructive"
                              onSelect={() => setDeleting(ct)}
                            >
                              Delete…
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </Td>
                  </Tr>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {cloning && (
        <CloneContentTypeDialog
          key={cloning.apiId}
          source={cloning}
          open
          onOpenChange={(open) => !open && setCloning(null)}
          onCloseAutoFocus={focusTrigger(cloning.apiId)}
          onCloned={(clone) => {
            reload();
            toast.success(`Cloned as “${clone.name}”, a draft`);
          }}
        />
      )}
      {deleting && (
        <DeleteContentTypeDialog
          key={deleting.apiId}
          type={deleting}
          open
          onOpenChange={(open) => !open && setDeleting(null)}
          onCloseAutoFocus={focusAfterDelete(deleting.apiId)}
          onDeleted={(job) => {
            if (job) deleteJob.start(job, deleting);
            else {
              deletedNow.current = true;
              reload();
              void invalidate(['entries']);
              toast.success(`Deleted “${deleting.name}”`);
            }
          }}
        />
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
