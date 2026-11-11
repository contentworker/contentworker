import type { Promotion } from '@contentworker/domain';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@contentworker/ui/alert';
import { Button } from '@contentworker/ui/button';
import { Catalog, CatalogRow, CatalogTile, ListToolbar } from '@contentworker/ui/catalog';
import { Segmented, SegmentedItem } from '@contentworker/ui/segmented';
import { SkeletonPill, SkeletonText } from '@contentworker/ui/skeleton';
import { ArrowUpRight } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Ago } from '~/cms/components/ago';
import { LoadingStatus, rememberCount, rememberedCount } from '~/cms/components/loading';
import { Empty, Section } from '~/cms/components/page';
import { StatusBadge } from '~/cms/components/status';
import { actorLabel } from '~/cms/lib/authorship';
import { dateTime, toMs } from '~/cms/lib/format';
import { apiErrorMessage, isForbidden } from '~/cms/lib/management';
import { useClient } from '../../lib/client-context';
import { useScopedQuery } from '../../lib/queries';
import { copiesLine, statusWords, usePromotionViewer } from './parts';

type Filter = 'all' | 'awaiting_approval';

/** How often a list holding an apply under way asks again: it moves on within the request. */
const APPLYING_REFRESH_MS = 4000;
const COUNT_KEY = 'promotions';

/**
 * The space's promotions, newest first (the 50 most recent, which is all the API lists): each
 * row its source → target, which opens its record, then who asked and when, what it copies, and
 * its status as a badge. Awaiting approval narrows it to what waits on a decision (asked of the
 * API, not filtered here). While one is applying the list asks again every few seconds.
 */
export function PromotionList(props: { onOpen: (id: string) => void }) {
  const { client } = useClient();
  const [filter, setFilter] = useState<Filter>('all');
  const { directory } = usePromotionViewer();
  // Poll only while something is moving, judged from the last answer.
  const [polling, setPolling] = useState(false);
  const query = useScopedQuery(
    ['promotions', filter],
    () => client.listPromotions(filter === 'all' ? undefined : filter),
    {
      silent: true,
      keepPrevious: true,
      ...(polling ? { refetchInterval: APPLYING_REFRESH_MS } : {}),
    },
  );
  const items = query.data;
  const applying = items?.some((p) => p.status === 'applying') ?? false;
  useEffect(() => setPolling(applying), [applying]);
  useEffect(() => {
    if (items) rememberCount(COUNT_KEY, items.length);
  }, [items]);

  const summary = items
    ? filter === 'all'
      ? `${items.length} shown`
      : `${items.length} awaiting approval`
    : undefined;

  return (
    <Section title="Promotions" description="Newest first, the 50 most recent." flush>
      <ListToolbar summary={summary}>
        <Segmented
          aria-label="Show promotions"
          value={filter}
          onValueChange={(v) => setFilter(v as Filter)}
        >
          <SegmentedItem value="all">All</SegmentedItem>
          <SegmentedItem value="awaiting_approval">Awaiting approval</SegmentedItem>
        </Segmented>
      </ListToolbar>
      {isForbidden(query.error) && !items ? (
        // Not a failure: listing promotions takes content:publish, as deciding them does.
        <p className="border-t px-5 py-4 text-muted-foreground text-sm">
          Promotions are listed for roles that can publish content.
        </p>
      ) : query.isError && !items ? (
        <div className="p-3">
          <Alert variant="destructive">
            <AlertTitle>Couldn’t read the promotions</AlertTitle>
            <AlertDescription>
              <p>{apiErrorMessage(query.error)}</p>
            </AlertDescription>
            <AlertAction>
              <Button type="button" variant="outline" size="xs" onClick={() => query.refetch()}>
                Retry
              </Button>
            </AlertAction>
          </Alert>
        </div>
      ) : !items ? (
        <RowsSkeleton />
      ) : items.length === 0 ? (
        <Empty className="border-t" title={filter === 'all' ? 'No promotions yet' : undefined}>
          {filter === 'all'
            ? 'A promotion you request above shows here, with its risk check and who decided it.'
            : 'Nothing is waiting for approval.'}
        </Empty>
      ) : (
        <Catalog aria-label="Promotions" className="border-t">
          {items.map((p) => (
            <Row key={p.id} promotion={p} directory={directory} onOpen={props.onOpen} />
          ))}
        </Catalog>
      )}
    </Section>
  );
}

/**
 * One promotion: the whole row opens its record. Its title is the one button, stretched over the
 * row, so a press anywhere on it, Enter or Space opens it, and its name says which promotion it
 * is (rows can read alike: what it copies, its status, who asked and when tell them apart).
 */
function Row(props: {
  promotion: Promotion;
  directory: ReturnType<typeof usePromotionViewer>['directory'];
  onOpen: (id: string) => void;
}) {
  const { promotion: p } = props;
  // The moment as well: a promotion requested again after one failed reads alike otherwise.
  const at = toMs(p.createdAt);
  const name = `Open promotion ${p.source} → ${p.target}, ${copiesLine(p).toLowerCase()}, ${statusWords(p).toLowerCase()}, requested by ${actorLabel(p.requestedBy, props.directory, 'inSentence')}${at ? ` ${dateTime(at)}` : ''}`;
  return (
    <CatalogRow
      className="relative cursor-pointer transition-colors hover:bg-muted"
      media={
        <CatalogTile>
          <ArrowUpRight aria-hidden="true" />
        </CatalogTile>
      }
      title={
        <button
          type="button"
          aria-label={name}
          className="rounded-sm text-left font-medium outline-none after:absolute after:inset-0 after:rounded-xl after:content-[''] focus-visible:after:outline-2 focus-visible:after:outline-ring"
          onClick={() => props.onOpen(p.id)}
        >
          <span className="font-mono text-xs">{p.source}</span> →{' '}
          <span className="font-mono text-xs">{p.target}</span>
        </button>
      }
      meta={
        <span className="flex flex-wrap gap-x-2">
          <span>
            {actorLabel(p.requestedBy, props.directory)} ·{' '}
            {/* Over the stretched button, so its full time stays a hover away. */}
            <span className="relative z-10">
              <Ago at={p.createdAt} />
            </span>
          </span>
          <span>{copiesLine(p)}</span>
        </span>
      }
      aside={<StatusBadge status={p.status} label={statusWords(p)} />}
    />
  );
}

/** Rows in the shape of the real ones, as long as the list was last time. */
function RowsSkeleton() {
  const n = rememberedCount(COUNT_KEY, 3, 8);
  return (
    <div aria-busy="true" className="border-t">
      <LoadingStatus>Loading promotions…</LoadingStatus>
      <ul className="flex flex-col gap-2 p-3" aria-hidden="true">
        {Array.from({ length: n }, (_, i) => (
          <li key={i} className="flex items-center gap-4 rounded-xl bg-muted/50 px-3 py-2.5">
            <span className="size-10 rounded-lg border bg-card" />
            <span className="flex flex-1 flex-col gap-1.5">
              <SkeletonText width="8rem" />
              <SkeletonText width="14rem" className="text-xs" />
            </span>
            <SkeletonPill />
          </li>
        ))}
      </ul>
    </div>
  );
}
