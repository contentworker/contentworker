import { Button } from '@contentworker/ui/button';
import { Input } from '@contentworker/ui/input';
import { Skeleton } from '@contentworker/ui/skeleton';
import { SearchX } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { entryPath, entryRef } from '~/cms/components/dashboard/entry-titles';
import { LiveActivityCard } from '~/cms/components/dashboard/LiveActivityCard';
import { useEntriesById } from '~/cms/components/dashboard/use-entries-by-id';
import {
  DecisionsCard,
  UnpublishedWorkCard,
  UpcomingCard,
} from '~/cms/components/dashboard/WorkCards';
import { Empty, PageHeader, Section } from '~/cms/components/page';
import {
  usePendingAgentReviews,
  usePendingApprovalsCount,
  usePendingModerationHolds,
  usePendingWorkflowTasks,
} from '../lib/approvals';
import { useClient } from '../lib/client-context';
import type { SearchHit } from '../lib/management';
import { useAllEntriesQuery, useContentTypesQuery, useScopedQuery } from '../lib/queries';
import { useToast } from '../lib/toast';
import { useNow } from '../lib/use-now';

/** Unpublished entries fetched for the work card; the card says "N+" at the cap. */
const UNPUBLISHED_CAP = 50;
/** How often overdue schedules and deadlines are re-read against the clock. */
const NOW_REFRESH_MS = 60_000;

/**
 * The editor's start page: what needs attention (unpublished work, what's
 * scheduled and what missed its time, what waits on a decision in Approvals),
 * then search. AI token usage lives in Settings → AI, not here.
 */
export function Dashboard() {
  const { client, conn } = useClient();
  const toast = useToast();
  const types = useContentTypesQuery().data ?? [];
  const now = useNow(NOW_REFRESH_MS);
  // The inbox's own lists and the shell's own count, so the card agrees with both.
  const tasksQuery = usePendingWorkflowTasks({ silent: true });
  const reviewsQuery = usePendingAgentReviews({ silent: true });
  const holdsQuery = usePendingModerationHolds({ silent: true });
  const pendingTotal = usePendingApprovalsCount();

  // Silent: each card shows its own inline failure instead of a toast storm
  // when a token lacks one of these scopes.
  const unpublishedQuery = useScopedQuery(
    // Under the 'entries' prefix so every entry mutation's invalidation refreshes it.
    ['entries', 'dashboard-unpublished'],
    () =>
      client.listEntries(undefined, {
        filters: [{ field: 'sys.status', op: 'in', value: ['draft', 'changed'] }],
        limit: UNPUBLISHED_CAP,
      }),
    { silent: true },
  );
  const scheduledQuery = useScopedQuery(
    ['scheduled-actions', 'pending'],
    () => client.listScheduledActions('pending'),
    { silent: true },
  );
  const releasesQuery = useScopedQuery(['releases'], () => client.listReleases(), {
    silent: true,
  });
  // Titles for the live activity feed (best-effort: the list is capped).
  const allEntries = useAllEntriesQuery().data;

  const unpublished = useMemo(
    () =>
      (unpublishedQuery.data ?? [])
        .map((e) => entryRef(e, types, conn.locale))
        // UUIDv7 ids sort by creation time: newest first.
        .sort((a, b) => (a.id < b.id ? 1 : -1)),
    [unpublishedQuery.data, types, conn.locale],
  );
  const refs = useMemo(() => {
    const map = new Map(
      (allEntries ?? []).map((e) => [e.id, entryRef(e, types, conn.locale)] as const),
    );
    for (const e of unpublished) map.set(e.id, e);
    return map;
  }, [allEntries, unpublished, types, conn.locale]);
  // The card splits and orders these against the clock.
  const scheduled = scheduledQuery.data;
  const openReleases = useMemo(
    () => releasesQuery.data?.filter((r) => r.status === 'open'),
    [releasesQuery.data],
  );

  // Every entry a card names by id is resolved by id, in one batched lookup: the capped list
  // above can't be trusted to hold them, and an id is never a name.
  const namedIds = useMemo(
    () => [
      ...(tasksQuery.data ?? []).map((t) => t.entryId),
      ...(reviewsQuery.data ?? []).map((r) => r.entryId),
      ...(holdsQuery.data ?? []).map((h) => h.entryId),
      ...(scheduled ?? []).filter((a) => a.entityType === 'Entry').map((a) => a.entityId),
    ],
    [tasksQuery.data, reviewsQuery.data, holdsQuery.data, scheduled],
  );
  const named = useEntriesById(namedIds);
  const entryById = (id: string) => named.refs.get(id) ?? refs.get(id);

  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searched, setSearched] = useState(false);
  const [searching, setSearching] = useState(false);
  const hitIds = useMemo(() => hits.map((h) => h.entryId), [hits]);
  const hitEntries = useEntriesById(hitIds);

  const runSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;
    setSearching(true);
    try {
      setHits(await client.search(query));
      setSearched(true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSearching(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Overview"
        subtitle={`What needs attention in ${conn.space} / ${conn.environment}.`}
      />

      <section aria-label="Needs attention" className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <UnpublishedWorkCard
          entries={{
            data: unpublishedQuery.data ? unpublished : undefined,
            isLoading: unpublishedQuery.isLoading,
            isError: unpublishedQuery.isError,
          }}
          cap={UNPUBLISHED_CAP}
        />
        <UpcomingCard
          scheduled={{
            data: scheduled,
            isLoading: scheduledQuery.isLoading || named.isLoading,
            isError: scheduledQuery.isError,
          }}
          releases={{
            data: openReleases,
            isLoading: releasesQuery.isLoading,
            isError: releasesQuery.isError,
          }}
          entryById={entryById}
          now={now}
        />
        <DecisionsCard
          tasks={{
            data: tasksQuery.data,
            isLoading: tasksQuery.isLoading || named.isLoading,
            isError: tasksQuery.isError,
          }}
          reviews={{
            data: reviewsQuery.data,
            isLoading: reviewsQuery.isLoading || named.isLoading,
            isError: reviewsQuery.isError,
          }}
          holds={{
            data: holdsQuery.data,
            isLoading: holdsQuery.isLoading || named.isLoading,
            isError: holdsQuery.isError,
          }}
          total={pendingTotal}
          entryById={entryById}
          now={now}
        />
        <LiveActivityCard entryById={entryById} />
      </section>

      <Section
        title="Search published content"
        description="Finds published entries by meaning, not only by their words."
      >
        <form className="flex items-center gap-2" onSubmit={runSearch}>
          <Input
            aria-label="Search published content"
            type="search"
            enterKeyHint="search"
            autoCorrect="off"
            placeholder="Describe what you’re looking for…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <Button type="submit" variant="outline" disabled={searching}>
            {searching ? 'Searching…' : 'Search'}
          </Button>
        </form>
        {hits.length > 0 && (
          <ul className="divide-y divide-border">
            {hits.map((h) => {
              const ref = hitEntries.refs.get(h.entryId) ?? refs.get(h.entryId);
              return (
                <li key={h.entryId} className="flex min-w-0 items-start gap-3 py-2">
                  <div className="min-w-0 flex-1">
                    {ref ? (
                      <Link
                        to={entryPath(ref)}
                        className="block truncate font-medium text-sm underline-offset-2 hover:underline"
                      >
                        {ref.title}
                      </Link>
                    ) : hitEntries.isLoading ? (
                      <Skeleton className="h-5 w-1/2" aria-hidden />
                    ) : (
                      // Published, but its draft is gone or hidden from this principal.
                      <span className="block truncate font-medium text-muted-foreground text-sm">
                        Entry no longer available
                      </span>
                    )}
                    <p className="line-clamp-2 text-muted-foreground text-xs">{h.snippet}</p>
                  </div>
                  <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
                    {Math.round(h.score * 100)}% match
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        {searched && hits.length === 0 && (
          <Empty icon={<SearchX />} title="No matches">
            No published content matched that query. Try different wording.
          </Empty>
        )}
      </Section>
    </div>
  );
}
