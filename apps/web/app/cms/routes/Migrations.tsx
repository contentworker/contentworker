import { holdsScope, type MigrationRun, SCOPES } from '@contentworker/domain';
import { Alert, AlertDescription, AlertTitle } from '@contentworker/ui/alert';
import { Button } from '@contentworker/ui/button';
import { Catalog, CatalogRow, CatalogTile } from '@contentworker/ui/catalog';
import { SkeletonPill, SkeletonText } from '@contentworker/ui/skeleton';
import { Import, ListTree, Plus, Waypoints } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Ago } from '~/cms/components/ago';
import { LoadingStatus, rememberCount, rememberedCount } from '~/cms/components/loading';
import { NewMigrationSheet } from '~/cms/components/migrations/NewMigrationForm';
import { Empty, PageHeader, Section } from '~/cms/components/page';
import { ToneBadge } from '~/cms/components/status';
import { useClient } from '~/cms/lib/client-context';
import { plural } from '~/cms/lib/format';
import { apiErrorMessage, isForbidden } from '~/cms/lib/management';
import { KIND_LABEL, RUN_STATUS } from '~/cms/lib/migrations';
import { useInvalidate, useScopedQuery } from '~/cms/lib/queries';
import { useSpaceScopes } from '~/cms/lib/space-access';
import { useToast } from '~/cms/lib/toast';

/*
 * Migrations: the environment's site migration runs, newest first, each with where its pages come
 * from, its status, its pages by stage and when it was made. Reading them takes migration:run or
 * content:manage (the API's rule); starting one takes migration:run. A run's page takes its steps.
 */

/** The list of runs: apart from each run's own keys, so reading one again never reads them all. */
export const MIGRATIONS_KEY = ['migrations', 'runs'] as const;
/** Runs the list reads: the API's most for one request (newest first, no cursor). */
export const RUNS_SHOWN = 100;
export const migrationRunKey = (id: string) => ['migrations', 'run', id] as const;
/** The list's skeleton comes back as long as the list was last time. */
const COUNT_KEY = 'migrations';

const SKELETON_WIDTHS = ['52%', '38%', '61%', '45%', '57%', '41%', '49%', '36%'];

/** What a migration does, said once where there are none yet. */
const ABOUT =
  'A migration brings a published website in as structured content. It lists the site’s pages, fetches them, and groups pages that share a layout into templates, each one a content type to be.';

export function Migrations() {
  const { client } = useClient();
  const navigate = useNavigate();
  const invalidate = useInvalidate();
  const toast = useToast();
  const scopes = useSpaceScopes();
  const canRun = scopes !== undefined && holdsScope(scopes, SCOPES.migrationRun);
  const canRead = scopes === undefined || canRun || holdsScope(scopes, SCOPES.contentManage);
  const runs = useScopedQuery(MIGRATIONS_KEY, () => client.listMigrationRuns(RUNS_SHOWN), {
    silent: true,
    enabled: canRead,
  });
  const refused = !canRead || (runs.isError && isForbidden(runs.error));
  useEffect(() => {
    if (runs.data) rememberCount(COUNT_KEY, runs.data.length);
  }, [runs.data]);

  const [open, setOpen] = useState(false);
  const created = async (run: MigrationRun) => {
    setOpen(false);
    toast.success(`Created “${run.name}”`);
    await invalidate(MIGRATIONS_KEY);
    navigate(`/migrations/${encodeURIComponent(run.id)}`);
  };

  const list = runs.data ?? [];
  return (
    <>
      <PageHeader
        title="Migrations"
        subtitle="Bring a published website in as structured content, a step at a time."
        actions={
          canRun ? (
            <NewMigrationSheet
              open={open}
              onOpenChange={setOpen}
              onUnconfirmed={() => void invalidate(MIGRATIONS_KEY)}
              onCreated={created}
            />
          ) : null
        }
      />
      {refused ? (
        <Section title="All runs">
          <Empty>
            Your role in this space can’t see migrations: reading them takes migration:run or
            content:manage. A space administrator can change your role.
          </Empty>
        </Section>
      ) : runs.isError ? (
        <Alert variant="destructive">
          <AlertTitle>The migrations didn’t load</AlertTitle>
          <AlertDescription>
            <p>{apiErrorMessage(runs.error)}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={() => void runs.refetch()}
            >
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      ) : runs.isPending ? (
        <Section title="All runs" flush>
          <div aria-busy="true">
            <LoadingStatus>Loading migrations…</LoadingStatus>
            <ul aria-hidden="true" className="space-y-2 p-3">
              {SKELETON_WIDTHS.slice(0, rememberedCount(COUNT_KEY, 3, 8)).map((w, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: placeholder rows, never reordered
                <li key={i} className="flex items-center gap-3 rounded-xl bg-muted/50 p-3">
                  <span className="size-10 shrink-0 rounded-lg bg-card" />
                  <span className="flex flex-1 flex-col gap-1.5">
                    <SkeletonText width={w} />
                    <SkeletonText width="40%" className="text-xs" />
                  </span>
                  <SkeletonPill />
                </li>
              ))}
            </ul>
          </div>
        </Section>
      ) : list.length === 0 ? (
        <Section title="All runs">
          <Empty
            icon={<Import aria-hidden="true" />}
            title="No migrations yet"
            action={
              canRun ? (
                <Button type="button" onClick={() => setOpen(true)}>
                  <Plus aria-hidden="true" /> Migrate a website
                </Button>
              ) : (
                <p className="text-muted-foreground text-xs">
                  Starting one takes migration:run, which a space administrator can grant.
                </p>
              )
            }
          >
            {ABOUT}
          </Empty>
        </Section>
      ) : (
        <Section
          title="All runs"
          flush
          actions={
            <span className="text-muted-foreground text-xs tabular">
              {list.length >= RUNS_SHOWN ? `Newest ${RUNS_SHOWN}` : plural(list.length, 'run')}
            </span>
          }
        >
          <Catalog aria-label="All runs">
            {list.map((run) => (
              <RunRow key={run.id} run={run} />
            ))}
          </Catalog>
          {!canRun && scopes !== undefined ? (
            <p className="px-4 pb-4 text-muted-foreground text-xs">
              You can follow these runs. Starting one, or a step of one, takes migration:run.
            </p>
          ) : null}
        </Section>
      )}
    </>
  );
}

/**
 * One run as a catalog row: its source's kind as its tile, its name (the link) over the source URL
 * in mono, its kind and when it was made, then its status. Its pages are counted on its own page:
 * the list response carries none, and reading every run again to count them would be a request a
 * row.
 */
function RunRow({ run }: { run: MigrationRun }) {
  const status = RUN_STATUS[run.status];
  const Icon = run.source.kind === 'crawl' ? Waypoints : ListTree;
  return (
    <CatalogRow
      media={
        <CatalogTile>
          <Icon aria-hidden="true" />
        </CatalogTile>
      }
      title={
        <Link
          to={`/migrations/${encodeURIComponent(run.id)}`}
          className="hit-area font-medium text-foreground hover:underline"
        >
          {run.name}
        </Link>
      }
      meta={
        <span className="flex flex-wrap gap-x-2">
          <span className="w-full truncate font-mono" title={run.source.url}>
            {run.source.url}
          </span>
          <span>{KIND_LABEL[run.source.kind]}</span>
          <span>
            Created <Ago at={run.createdAt} />
          </span>
        </span>
      }
      aside={<ToneBadge tone={status.tone} label={status.label} />}
    />
  );
}
