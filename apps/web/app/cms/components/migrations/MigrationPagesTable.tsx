import type { MigrationPageStage } from '@contentworker/domain';
import { Alert, AlertDescription, AlertTitle } from '@contentworker/ui/alert';
import { Button } from '@contentworker/ui/button';
import { ListToolbar } from '@contentworker/ui/catalog';
import { Label } from '@contentworker/ui/label';
import { NativeSelect, NativeSelectOption } from '@contentworker/ui/native-select';
import { SkeletonPill, SkeletonText } from '@contentworker/ui/skeleton';
import {
  Table,
  TableBody,
  TableEmpty,
  TableFoot,
  TableHead,
  Td,
  Th,
  Tr,
} from '@contentworker/ui/table';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useEffect, useId, useMemo, useRef } from 'react';
import { LoadingStatus, Refreshing } from '~/cms/components/loading';
import { ToneBadge } from '~/cms/components/status';
import { useClient } from '~/cms/lib/client-context';
import { count } from '~/cms/lib/format';
import {
  apiErrorMessage,
  type MigrationPageCounts,
  type MigrationPageView,
  type MigrationTemplateView,
} from '~/cms/lib/management';
import { STAGES, stageOf } from '~/cms/lib/migrations';
import { Empty } from '../page';
import { SourceLink } from './SourceLink';

/** Pages a read of the table brings. */
export const PAGES_PAGE = 50;
const COLUMNS = 5;

export interface PageFilter {
  readonly stage?: MigrationPageStage;
  readonly template?: string;
}

/**
 * A run's pages in discovery order, a page of them at a time, narrowed on the server by stage and
 * by template (the screen's URL holds both). Each row is what the run knows of a page: its address
 * (opening the live page), its title, its stage, its template, whether it was fetched and what
 * the site answered. Never its HTML: the API names that by hash only. Load more appends the next
 * page and hands focus to the first row it brought.
 */
export function MigrationPagesTable({
  runId,
  counts,
  templates,
  filter,
  onFilter,
}: {
  runId: string;
  counts: MigrationPageCounts;
  templates: readonly MigrationTemplateView[];
  filter: PageFilter;
  onFilter: (filter: PageFilter) => void;
}) {
  const { client, conn } = useClient();
  const id = useId();
  const pages = useInfiniteQuery({
    queryKey: [conn.space, conn.environment, 'migrations', 'run', runId, 'pages', filter],
    queryFn: ({ pageParam }) =>
      client.listMigrationPages(runId, {
        ...filter,
        limit: PAGES_PAGE,
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor,
    // Silent: a failed read is said here, in place, with Try again.
    meta: { silent: true },
    // Another filter keeps this run's rows up until its own arrive.
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[4] === runId ? prev : undefined),
  });
  const rows = useMemo(() => pages.data?.pages.flatMap((p) => p.items) ?? [], [pages.data]);
  const label = useMemo(() => new Map(templates.map((t) => [t.id, t.label])), [templates]);
  const filtering = Boolean(filter.stage || filter.template);
  const loading = pages.isPending;

  // Load more hands focus to the first row it brought; to the last if it brought none. A new
  // filter forgets the hand-off.
  const body = useRef<HTMLTableSectionElement>(null);
  const focusFrom = useRef<number | null>(null);
  const key = JSON.stringify(filter);
  useEffect(() => {
    focusFrom.current = null;
  }, [key]);
  const fetchingMore = pages.isFetchingNextPage;
  const more = pages.hasNextPage;
  useEffect(() => {
    const from = focusFrom.current;
    if (from === null || fetchingMore) return;
    focusFrom.current = null;
    const links = body.current?.querySelectorAll<HTMLElement>('[data-row-primary]');
    (links?.[from] ?? (more ? undefined : links?.[links.length - 1]))?.focus();
  }, [fetchingMore, more]);

  if (counts.total === 0) {
    return <Empty>No pages yet. The inventory lists the site’s pages here.</Empty>;
  }

  const summary = loading
    ? ''
    : `${count(rows.length)}${more ? '+' : ''} ${rows.length === 1 && !more ? 'page' : 'pages'} shown`;

  return (
    <>
      <ListToolbar summary={summary} className="justify-start">
        <div className="flex items-center gap-2">
          <Label htmlFor={`${id}-stage`} className="text-ui text-muted-foreground">
            Stage
          </Label>
          <NativeSelect
            id={`${id}-stage`}
            size="sm"
            value={filter.stage ?? ''}
            onChange={(e) =>
              onFilter({
                ...filter,
                stage: (e.target.value || undefined) as MigrationPageStage | undefined,
              })
            }
          >
            <NativeSelectOption value="">All stages</NativeSelectOption>
            {STAGES.map((s) => (
              <NativeSelectOption key={s.id} value={s.id}>
                {`${s.label} (${count(counts.byStage[s.id] ?? 0)})`}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        {templates.length > 0 || filter.template ? (
          <div className="flex items-center gap-2">
            <Label htmlFor={`${id}-template`} className="text-ui text-muted-foreground">
              Template
            </Label>
            <NativeSelect
              id={`${id}-template`}
              size="sm"
              value={filter.template ?? ''}
              onChange={(e) => onFilter({ ...filter, template: e.target.value || undefined })}
            >
              <NativeSelectOption value="">All templates</NativeSelectOption>
              {templates.map((t) => (
                <NativeSelectOption key={t.id} value={t.id}>
                  {`${t.label} (${count(t.pageCount)})`}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
        ) : null}
      </ListToolbar>
      {pages.isError && rows.length === 0 ? (
        <div className="px-4 pb-4">
          <Alert variant="destructive">
            <AlertTitle>The pages didn’t load</AlertTitle>
            <AlertDescription>
              <p>{apiErrorMessage(pages.error)}</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-2"
                onClick={() => void pages.refetch()}
              >
                Try again
              </Button>
            </AlertDescription>
          </Alert>
        </div>
      ) : (
        <Refreshing busy={pages.isPlaceholderData}>
          {loading ? <LoadingStatus>Loading pages…</LoadingStatus> : null}
          <Table edge="card" stack="cards" caption="Pages" aria-busy={loading || undefined}>
            <TableHead>
              <Tr>
                <Th>Page</Th>
                <Th>Stage</Th>
                <Th>Template</Th>
                <Th>Fetch</Th>
                <Th numeric>Answer</Th>
              </Tr>
            </TableHead>
            <TableBody ref={body}>
              {rows.map((p) => (
                <PageRow
                  key={p.id}
                  page={p}
                  template={p.templateId ? label.get(p.templateId) : undefined}
                />
              ))}
              {!loading && rows.length === 0 ? (
                <TableEmpty colSpan={COLUMNS}>
                  <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
                    {filtering ? 'No pages match these filters.' : 'No pages here.'}
                    {filtering ? (
                      <Button
                        type="button"
                        variant="link"
                        size="xs"
                        className="px-0"
                        onClick={() => {
                          document.getElementById(`${id}-stage`)?.focus();
                          onFilter({});
                        }}
                      >
                        Clear filters
                      </Button>
                    ) : null}
                  </span>
                </TableEmpty>
              ) : null}
              {loading
                ? ['46%', '58%', '40%', '52%'].map((w) => (
                    <Tr key={w} aria-hidden="true">
                      <Td>
                        <SkeletonText width={w} />
                      </Td>
                      <Td label="Stage">
                        <SkeletonPill />
                      </Td>
                      <Td label="Template">
                        <SkeletonText width="5rem" />
                      </Td>
                      <Td label="Fetch">
                        <SkeletonPill />
                      </Td>
                      <Td label="Answer" numeric>
                        <SkeletonText width="1.75rem" className="items-end" />
                      </Td>
                    </Tr>
                  ))
                : null}
            </TableBody>
            {more && !loading && !pages.isPlaceholderData ? (
              <TableFoot className="max-md:block">
                <Tr className="border-t max-md:block">
                  <Td colSpan={COLUMNS} className="py-2 text-center max-md:block">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={fetchingMore}
                      onClick={() => {
                        focusFrom.current = rows.length;
                        void pages.fetchNextPage();
                      }}
                    >
                      {fetchingMore ? 'Loading more…' : 'Load more'}
                    </Button>
                  </Td>
                </Tr>
              </TableFoot>
            ) : null}
          </Table>
          {pages.isError && rows.length > 0 ? (
            <p className="px-4 pb-3 text-destructive text-xs" role="alert">
              More pages didn’t load: {apiErrorMessage(pages.error)}
            </p>
          ) : null}
        </Refreshing>
      )}
    </>
  );
}

/** Whether a page was read: waiting, read, or failed with what the site said. */
function FetchState({ page }: { page: MigrationPageView }) {
  if (page.error !== null) return <ToneBadge tone="bad" label="Failed" />;
  if (page.html !== null) return <ToneBadge tone="ok" label="Fetched" />;
  return <ToneBadge tone="idle" label="Waiting" />;
}

function PageRow({ page, template }: { page: MigrationPageView; template: string | undefined }) {
  const stage = stageOf(page.stage);
  return (
    <Tr>
      <Td className="max-w-0 md:w-1/2">
        <span className="flex min-w-0 flex-col gap-0.5">
          <SourceLink url={page.url} label={page.path} primary />
          {page.title ? (
            <span className="truncate text-muted-foreground text-xs" title={page.title}>
              {page.title}
            </span>
          ) : null}
          {page.error ? <span className="text-muted-foreground text-xs">{page.error}</span> : null}
        </span>
      </Td>
      <Td label="Stage">
        <ToneBadge tone={stage?.tone ?? 'idle'} label={stage?.label ?? page.stage} />
      </Td>
      <Td label="Template" className="text-muted-foreground">
        {template ?? '—'}
      </Td>
      <Td label="Fetch">
        <FetchState page={page} />
      </Td>
      <Td label="Answer" numeric className="font-mono text-xs">
        {page.httpStatus === null ? '—' : page.httpStatus === 0 ? 'None' : page.httpStatus}
      </Td>
    </Tr>
  );
}
