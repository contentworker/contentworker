import { Alert, AlertDescription, AlertTitle } from '@contentworker/ui/alert';
import { Button } from '@contentworker/ui/button';
import { SkeletonPill, SkeletonText } from '@contentworker/ui/skeleton';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useParams, useSearchParams } from 'react-router';
import { Ago } from '~/cms/components/ago';
import { LoadingStatus } from '~/cms/components/loading';
import {
  MigrationPagesTable,
  type PageFilter,
} from '~/cms/components/migrations/MigrationPagesTable';
import { MigrationTemplates } from '~/cms/components/migrations/MigrationTemplates';
import { RunBackground } from '~/cms/components/migrations/RunBackground';
import { RunFinish } from '~/cms/components/migrations/RunFinish';
import { RunSteps } from '~/cms/components/migrations/RunSteps';
import { Empty, PageHeader, Section } from '~/cms/components/page';
import { ToneBadge } from '~/cms/components/status';
import { useClient } from '~/cms/lib/client-context';
import { count } from '~/cms/lib/format';
import {
  ApiError,
  apiErrorMessage,
  isForbidden,
  type MigrationRunView,
} from '~/cms/lib/management';
import { isStage, KIND_LABEL, migrationRights, RUN_STATUS, STAGES } from '~/cms/lib/migrations';
import { useInvalidate, useScopedQuery } from '~/cms/lib/queries';
import { useSpaceScopes } from '~/cms/lib/space-access';
import { MIGRATIONS_KEY, migrationRunKey } from './Migrations';

/*
 * One migration run: its source and status, its pages counted by stage, its steps (inventory,
 * fetch, cluster), its templates and its pages. Every count is the run's own read
 * (`GET …/migrations/runs/:id`), read again after each step. Each template is authored, approved
 * and loaded on its own page; what follows for the whole run (relink, redirects, publish, or all of
 * it in the background) is here.
 */
export function MigrationRunPage() {
  const runId = decodeURIComponent(useParams().runId ?? '');
  const { client, conn } = useClient();
  const queryClient = useQueryClient();
  const invalidate = useInvalidate();
  const scopes = useSpaceScopes();
  // Undefined until the role is known: the steps draw their actions as skeletons meanwhile.
  const rights = migrationRights(scopes);
  const canRun = rights?.run;
  // Started (or told to publish) from here: its driver writes the run meanwhile, so follow it.
  const [following, setFollowing] = useState(false);
  const view = useScopedQuery(migrationRunKey(runId), () => client.getMigrationRun(runId), {
    silent: true,
    staleTime: 0,
    ...(following ? { refetchInterval: 15_000 } : {}),
  });
  const [search, setSearch] = useSearchParams();
  const { key: locationKey } = useLocation();
  // A navigation is a moment behind what was picked: until it lands, the filter is what was asked
  // for, so a second choice builds on the first instead of on the address it is replacing.
  const [asked, setAsked] = useState<{ at: string; filter: PageFilter } | null>(null);
  const stage = search.get('stage');
  const filter: PageFilter =
    asked?.at === locationKey
      ? asked.filter
      : {
          ...(isStage(stage) ? { stage } : {}),
          ...(search.get('template') ? { template: search.get('template') ?? undefined } : {}),
        };
  const setFilter = (next: PageFilter) => {
    setAsked({ at: locationKey, filter: next });
    setSearch(
      (prev) => {
        const out = new URLSearchParams(prev);
        for (const k of ['stage', 'template'] as const) {
          const v = next[k];
          if (v) out.set(k, v);
          else out.delete(k);
        }
        return out;
      },
      { replace: true, preventScrollReset: true },
    );
  };
  const templatesHeading = useRef<HTMLHeadingElement>(null);
  const pagesHeading = useRef<HTMLHeadingElement>(null);

  // After a batch, the run (its counts); after a step, its pages, its templates' samples and the
  // list of runs too. Each key once: the run's own read is the refetch, never also an invalidate.
  const refresh = useCallback(
    async ({ lists = true }: { readonly lists?: boolean } = {}) => {
      const [read] = await Promise.all([
        view.refetch(),
        lists ? invalidate(['migrations', 'run', runId, 'pages'], MIGRATIONS_KEY) : undefined,
      ]);
      // A read that failed keeps the last one on screen, and is no fresh count.
      return read.isError ? undefined : read.data;
    },
    [view.refetch, invalidate, runId],
  );
  const onUpdated = (next: MigrationRunView) =>
    queryClient.setQueryData([conn.space, conn.environment, ...migrationRunKey(runId)], next);

  const ended = view.data?.run.status === 'stopped' || view.data?.run.status === 'failed';
  useEffect(() => {
    if (ended) setFollowing(false);
  }, [ended]);

  // A link to #pages lands once the section is there.
  const here = view.data !== undefined;
  const { hash } = useLocation();
  useEffect(() => {
    if (here && hash === '#pages') document.getElementById('pages')?.scrollIntoView?.();
  }, [here, hash]);

  if (view.isPending) return <RunSkeleton />;
  // Only a first read that failed takes the page: a refresh that fails (after a fetch batch, or on
  // focus) keeps the run on screen, and Fetch until done with it, and says so under the steps.
  if (view.isError && !view.data) {
    const missing = view.error instanceof ApiError && view.error.status === 404;
    return (
      <>
        <PageHeader title={missing ? 'Run not found' : 'Migration run'} />
        {missing || isForbidden(view.error) ? (
          <Section title={missing ? 'Nothing here' : 'Not for your role'}>
            <Empty
              action={
                <Button asChild variant="outline" size="sm">
                  <Link to="/migrations">All migrations</Link>
                </Button>
              }
            >
              {missing
                ? 'This run isn’t in this space and environment. It may be in another environment.'
                : 'Your role in this space can’t see migrations: reading them takes migration:run or content:manage.'}
            </Empty>
          </Section>
        ) : (
          <Alert variant="destructive">
            <AlertTitle>The run didn’t load</AlertTitle>
            <AlertDescription>
              <p>{apiErrorMessage(view.error)}</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-2"
                onClick={() => void view.refetch()}
              >
                Try again
              </Button>
            </AlertDescription>
          </Alert>
        )}
      </>
    );
  }

  const { run, pages, templates } = view.data;
  const status = RUN_STATUS[run.status];
  // A template the run no longer has (clustered again since, or an edited address) filters by
  // nothing the select can show: the pages read as unfiltered by template instead.
  const shown: PageFilter =
    filter.template && !templates.some((t) => t.id === filter.template)
      ? { ...(filter.stage ? { stage: filter.stage } : {}) }
      : filter;
  return (
    <div className="space-y-4">
      <PageHeader
        title={run.name}
        subtitle={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="break-all font-mono">{run.source.url}</span>
            <span>
              {KIND_LABEL[run.source.kind]} · created <Ago at={run.createdAt} />
            </span>
          </span>
        }
        actions={<ToneBadge tone={status.tone} label={status.label} />}
      />
      {run.error ? (
        <Alert variant={run.status === 'stopped' ? 'warning' : 'destructive'}>
          <AlertTitle>
            {run.status === 'stopped' ? 'Its background run stopped' : 'The run failed'}
          </AlertTitle>
          <AlertDescription>
            <p className="wrap-anywhere">{run.error}</p>
            {run.status === 'stopped' ? (
              <p>Its templates can still be approved, loaded and published step by step.</p>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}
      <Section title="Pages by stage">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4 lg:grid-cols-8">
          <Figure label="All pages" value={pages.total} />
          {STAGES.map((s) => (
            <Figure key={s.id} label={s.label} value={pages.byStage[s.id] ?? 0} />
          ))}
        </dl>
      </Section>
      <Section title="Steps" flush>
        <RunSteps
          view={view.data}
          canRun={canRun}
          refresh={refresh}
          onUpdated={onUpdated}
          onClustered={() => {
            // The grouping is new, and so are its templates' ids.
            if (filter.template) setFilter({ ...filter, template: undefined });
            templatesHeading.current?.focus();
          }}
        />
        {view.isError ? (
          <p className="px-4 pb-4 text-muted-foreground text-xs" role="status">
            The counts couldn’t be read again: {apiErrorMessage(view.error)}. They show the last
            read.
          </p>
        ) : null}
      </Section>
      <Section
        id="templates"
        title={
          <span ref={templatesHeading} tabIndex={-1} className="outline-none">
            Templates
          </span>
        }
        flush
        actions={
          <span className="text-muted-foreground text-xs tabular">{count(templates.length)}</span>
        }
      >
        <MigrationTemplates
          templates={templates}
          onShowPages={(template) => {
            setFilter({ template });
            // The card clears the sticky header when scrolled to (its scroll-margin); the heading
            // takes focus without a scroll of its own.
            document.getElementById('pages')?.scrollIntoView({ block: 'start' });
            pagesHeading.current?.focus({ preventScroll: true });
          }}
        />
      </Section>
      {templates.length > 0 ? (
        <Section title="Finish the run" flush>
          <RunFinish key={run.id} view={view.data} rights={rights} refresh={refresh} />
        </Section>
      ) : null}
      <Section title="Run in the background">
        <RunBackground
          key={run.id}
          view={view.data}
          rights={rights}
          refresh={refresh}
          onStarted={() => setFollowing(true)}
        />
      </Section>
      <Section
        id="pages"
        title={
          <span ref={pagesHeading} tabIndex={-1} className="outline-none">
            Pages
          </span>
        }
        flush
      >
        <MigrationPagesTable
          runId={run.id}
          counts={pages}
          templates={templates}
          filter={shown}
          onFilter={setFilter}
        />
      </Section>
    </div>
  );
}

function Figure({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="caption">{label}</dt>
      <dd className={value ? 'font-medium tabular' : 'text-muted-foreground tabular'}>
        {count(value)}
      </dd>
    </div>
  );
}

/** The run before it arrives: its header and sections drawn, its facts as skeletons. */
function RunSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true">
      <LoadingStatus>Loading the migration run…</LoadingStatus>
      <PageHeader
        title={<SkeletonText width="min(18rem, 60vw)" />}
        subtitle={<SkeletonText width="min(24rem, 70vw)" />}
        actions={<SkeletonPill />}
      />
      <Section title="Pages by stage">
        {/* The captions are known before the run is: only the figures wait. */}
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4 lg:grid-cols-8">
          {['All pages', ...STAGES.map((st) => st.label)].map((label) => (
            <div key={label} className="flex flex-col gap-0.5">
              <dt className="caption">{label}</dt>
              <dd>
                <SkeletonText width="2rem" />
              </dd>
            </div>
          ))}
        </dl>
      </Section>
      <Section title="Steps" flush>
        <div aria-hidden="true" className="space-y-3 p-4">
          {['60%', '52%', '48%'].map((w) => (
            <SkeletonText key={w} width={w} />
          ))}
        </div>
      </Section>
      <Section title="Templates" flush>
        <div aria-hidden="true" className="p-4">
          <SkeletonText width="40%" />
        </div>
      </Section>
      <Section title="Pages" flush>
        <div aria-hidden="true" className="p-4">
          <SkeletonText width="55%" />
        </div>
      </Section>
    </div>
  );
}
