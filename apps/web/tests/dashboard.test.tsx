// @vitest-environment jsdom
import type { ContentType } from '@contentworker/domain';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentRun, PreviewEntry } from '~/cms/lib/management';

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const DAY = 86_400_000;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

const article = {
  apiId: 'article',
  name: 'Article',
  displayField: 'title',
  fields: [{ apiId: 'title', name: 'Title', type: 'Symbol' }],
} as unknown as ContentType;

const entry = (id: string, title: string, status: string): PreviewEntry => ({
  id,
  contentType: 'article',
  status,
  version: 1,
  fields: { title: { 'en-US': title } },
});

const unpublished = [
  entry('0190a000-0000-7000-8000-000000000001', 'Older draft', 'draft'),
  entry('0190a000-0000-7000-8000-000000000002', 'Edited launch post', 'changed'),
];

// Not in the capped list the dashboard loads: only the by-id lookup can name these. Their ids
// share a UUIDv7 prefix with every other, so a prefix would read the same for all of them.
const offList = [
  entry('0190a000-0000-7000-8000-0000000000a1', 'Spring menu', 'draft'),
  { ...entry('0190a000-0000-7000-8000-0000000000a2', '', 'draft'), fields: {} },
];
const DELETED = '0190a000-0000-7000-8000-0000000000ff';

const review = (id: string, entryId: string, createdAt = iso(-2 * DAY)) => ({
  id,
  workflow: 'enrich',
  entryId,
  proposed: {},
  notes: [],
  status: 'pending',
  awaiting: false,
  createdAt,
});

const reviews = [
  review('review-1', '0190a000-0000-7000-8000-000000000002', iso(-1 * DAY)),
  review('review-2', offList[0]!.id),
  review('review-3', offList[1]!.id),
  review('review-4', DELETED),
];

const tasks = [
  {
    id: 'task-1',
    kind: 'approval',
    entryId: '0190a000-0000-7000-8000-000000000001',
    contentTypeApiId: 'article',
    title: 'Legal sign-off',
    status: 'pending',
    requestedAt: iso(-3 * DAY),
    // Its deadline has passed: overdue, said in words.
    deadline: iso(-DAY),
  },
];

// The agent-run ledger is history: these old runs stopped for review once, and must not be
// counted as waiting now.
const runs: AgentRun[] = Array.from({ length: 23 }, (_, i) => ({
  id: `run-${i}`,
  workflow: 'moderate',
  entryId: '',
  status: i % 2 ? 'held' : 'needs_review',
  decisions: [],
  inputTokens: 10,
  outputTokens: 5,
  createdAt: iso(-(i + 1) * DAY),
}));

/** The server's uncapped count: what the shell's badge shows. */
const COUNT = { workflowTasks: 1, agentReviews: 4, total: 5 };

type ListArgs = [string | undefined, { filters?: { field: string; value?: unknown }[] }?];

const client = {
  // The by-id lookup filters on `sys.id[in]`; any other list is the unpublished work.
  listEntries: vi.fn(async (...[, query]: ListArgs) => {
    const byId = query?.filters?.find((f) => f.field === 'sys.id');
    if (!byId) return unpublished;
    const ids = byId.value as string[];
    return [...unpublished, ...offList].filter((e) => ids.includes(e.id));
  }),
  listWorkflowTasks: vi.fn(async () => tasks),
  listAgentReviews: vi.fn(async () => reviews),
  countPendingApprovals: vi.fn(async () => COUNT),
  listScheduledActions: vi.fn(async () => [
    {
      // Past its time and still pending: the scheduler never picked it up.
      id: 'sa-0',
      action: 'publish',
      entityType: 'Entry',
      entityId: '0190a000-0000-7000-8000-000000000002',
      scheduledFor: iso(-21 * DAY),
      status: 'pending',
      createdAt: iso(-23 * DAY),
    },
    {
      // Due this minute: still on its way, not overdue.
      id: 'sa-3',
      action: 'unpublish',
      entityType: 'Entry',
      entityId: offList[0]!.id,
      scheduledFor: iso(-30_000),
      status: 'pending',
      createdAt: iso(-DAY),
    },
    {
      id: 'sa-2',
      action: 'publish',
      entityType: 'Release',
      entityId: 'rel-1',
      scheduledFor: iso(3 * DAY),
      status: 'pending',
      createdAt: iso(-DAY),
    },
    {
      id: 'sa-1',
      action: 'publish',
      entityType: 'Entry',
      entityId: '0190a000-0000-7000-8000-000000000001',
      scheduledFor: iso(DAY),
      status: 'pending',
      createdAt: iso(-DAY),
    },
  ]),
  listReleases: vi.fn(async () => [
    { id: 'rel-1', title: 'Spring campaign', status: 'open', createdAt: iso(-2 * DAY) },
    { id: 'rel-0', title: 'Shipped bundle', status: 'published', createdAt: iso(-9 * DAY) },
  ]),
  subscribeLive: vi.fn(() => new Promise<void>(() => {})),
  search: vi.fn(async () => []),
};

vi.mock('~/cms/lib/client-context', () => ({
  useClient: () => ({
    client,
    conn: { space: 'demo', environment: 'main', locale: 'en-US' },
  }),
}));

vi.mock('~/cms/lib/queries', () => ({
  useScopedQuery: <T,>(segments: readonly unknown[], queryFn: () => Promise<T>) => {
    const [data, setData] = useState<T>();
    // Loads again when its key changes: the by-id lookup's ids arrive with the lists it names.
    const key = JSON.stringify(segments);
    useEffect(() => {
      queryFn().then(setData);
    }, [key]);
    return { data, isLoading: data === undefined, isError: false };
  },
  useContentTypesQuery: () => ({ data: [article] }),
  useAllEntriesQuery: () => ({ data: unpublished }),
  useAgentRunsQuery: () => ({ data: runs, isLoading: false, isError: false }),
}));

const { Dashboard } = await import('~/cms/components/Dashboard');
const { ToastProvider } = await import('~/cms/lib/toast');
const { fetchEntriesById } = await import('~/cms/components/dashboard/entry-titles');
const { splitSchedule, OVERDUE_GRACE_MS } = await import('~/cms/components/dashboard/WorkCards');

afterEach(cleanup);

const renderDashboard = () =>
  render(
    <MemoryRouter>
      <ToastProvider>
        <Dashboard />
      </ToastProvider>
    </MemoryRouter>,
  );

const card = (heading: string) =>
  screen.getByRole('heading', { name: heading }).closest('[data-slot="card"]') as HTMLElement;

describe('Dashboard', () => {
  it('shows two live events that arrive in the same millisecond as two rows', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(Date, 'now').mockReturnValue(1_793_580_044_816);
    client.subscribeLive.mockImplementationOnce(((emit: (e: { type: string }) => void) => {
      // Two assets published at once: no entry id, one type, one clock reading.
      emit({ type: 'asset.published' });
      emit({ type: 'asset.published' });
      return new Promise<void>(() => {});
    }) as never);
    renderDashboard();
    const live = card('Live activity');
    await waitFor(() => expect(within(live).getAllByRole('listitem')).toHaveLength(2));
    expect(errors.mock.calls.flat().join(' ')).not.toMatch(/same key/);
    vi.restoreAllMocks();
  });

  it('leads with unpublished work, newest first, linked by title', async () => {
    renderDashboard();
    const work = card('Not yet published');
    const links = await within(work).findAllByRole('link');
    expect(links.map((l) => l.textContent)).toEqual(['Edited launch post', 'Older draft']);
    expect(links[0]?.getAttribute('href')).toBe(
      '/content/article/0190a000-0000-7000-8000-000000000002',
    );
    expect(within(work).getByText('Changed')).toBeTruthy();
    expect(client.listEntries).toHaveBeenCalledWith(undefined, {
      filters: [{ field: 'sys.status', op: 'in', value: ['draft', 'changed'] }],
      limit: 50,
    });
  });

  it('splits past-due schedules into Overdue and keeps Coming up for the rest', async () => {
    renderDashboard();
    const upcoming = card('Coming up');
    // Named only once the by-id lookup answers.
    await within(upcoming).findByText('Spring menu');
    const group = (name: string) =>
      within(upcoming).getByRole('heading', { name }).parentElement as HTMLElement;
    const titles = (el: HTMLElement) =>
      within(el)
        .getAllByRole('listitem')
        .map((li) => li.querySelector('a, span')?.textContent);
    // The missed one is still shown, not hidden, and says so in words.
    const overdue = group('Overdue');
    expect(titles(overdue)).toEqual(['Edited launch post']);
    expect(within(within(overdue).getByRole('listitem')).getByText('Overdue')).toBeTruthy();
    expect(within(overdue).getByText(/was due/)).toBeTruthy();
    // Soonest first; one due this minute is inside the sweep's grace, not overdue.
    expect(titles(group('Scheduled'))).toEqual(['Spring menu', 'Older draft', 'Spring campaign']);
    expect(titles(group('Open releases'))).toEqual(['Spring campaign']);
    expect(within(upcoming).queryByText('Shipped bundle')).toBeNull();
  });

  it('splits a schedule at the grace boundary', () => {
    const now = Date.parse('2026-11-23T12:00:00Z');
    const at = (ms: number) =>
      ({ id: String(ms), scheduledFor: new Date(now + ms).toISOString() }) as never;
    const { overdue, upcoming } = splitSchedule(
      [at(DAY), at(-OVERDUE_GRACE_MS - 1), at(-OVERDUE_GRACE_MS), at(-21 * DAY)],
      now,
    );
    expect(overdue.map((a: { id: string }) => a.id)).toEqual([
      String(-21 * DAY),
      String(-OVERDUE_GRACE_MS - 1),
    ]);
    expect(upcoming.map((a: { id: string }) => a.id)).toEqual([
      String(-OVERDUE_GRACE_MS),
      String(DAY),
    ]);
    expect(splitSchedule([], now)).toEqual({ overdue: [], upcoming: [] });
  });

  it('counts what waits on a decision as Approvals and the nav badge do, not the run ledger', async () => {
    renderDashboard();
    const waiting = card('Waiting on a decision');
    await within(waiting).findByRole('link', { name: 'Spring menu' });
    // The server's count, the one the badge shows; never the 23 old runs.
    expect(within(waiting).getByText('5')).toBeTruthy();
    expect(within(waiting).queryByText('23')).toBeNull();
    expect(within(waiting).queryByText('Held')).toBeNull();
    expect(client.countPendingApprovals).toHaveBeenCalled();
    // Steps first, overdue in words; then proposals, oldest first.
    expect(within(waiting).getByRole('link', { name: 'Legal sign-off' }).getAttribute('href')).toBe(
      '/content/article/0190a000-0000-7000-8000-000000000001',
    );
    expect(within(waiting).getByText('Overdue')).toBeTruthy();
    expect(within(waiting).getAllByText('Needs review').length).toBe(4);
    expect(within(waiting).getByRole('link', { name: 'Review in Approvals' })).toBeTruthy();
  });

  it('names and links every agent proposal by its entry, never by an id', async () => {
    renderDashboard();
    const waiting = card('Waiting on a decision');
    // Resolved by one batched lookup, including entries the capped list doesn't hold.
    const spring = await within(waiting).findByRole('link', { name: 'Spring menu' });
    expect(spring.getAttribute('href')).toBe(`/content/article/${offList[0]!.id}`);
    expect(within(waiting).getByRole('link', { name: 'Edited launch post' })).toBeTruthy();
    // Untitled: named as such (its type beside it) and still linked.
    expect(within(waiting).getByRole('link', { name: 'Untitled entry' }).getAttribute('href')).toBe(
      `/content/article/${offList[1]!.id}`,
    );
    // Gone: said in words, not shown as an id.
    expect(within(waiting).getByText('Entry no longer available')).toBeTruthy();
    expect(within(waiting).queryByText(/0190a000/)).toBeNull();
    expect(within(waiting).getAllByText(/^Article · Enrich agent · /).length).toBe(3);
    const lookups = client.listEntries.mock.calls.filter(([, q]) =>
      q?.filters?.some((f) => f.field === 'sys.id'),
    );
    expect(lookups.length).toBeGreaterThan(0);
  });

  it('batches the by-id lookup under the preview page cap', async () => {
    const listEntries = vi.fn(async () => []);
    const ids = Array.from({ length: 230 }, (_, i) => `id-${i}`);
    await fetchEntriesById({ listEntries }, [...ids, ...ids.slice(0, 10), '']);
    expect(listEntries).toHaveBeenCalledTimes(3);
    const sizes = listEntries.mock.calls.map(
      (c) => ((c as unknown as ListArgs)[1]?.filters?.[0]?.value as string[] | undefined)?.length,
    );
    expect(sizes).toEqual([100, 100, 30]);
    listEntries.mockClear();
    expect(await fetchEntriesById({ listEntries }, [])).toEqual([]);
    expect(listEntries).not.toHaveBeenCalled();
  });

  it('leaves AI token usage to Settings and drops the credentials card', async () => {
    renderDashboard();
    await screen.findAllByText('Edited launch post');
    expect(screen.queryByRole('heading', { name: 'AI usage' })).toBeNull();
    expect(screen.queryByText('Total tokens')).toBeNull();
    expect(screen.queryByText('Tokens by workflow')).toBeNull();
    expect(screen.queryByText(/Account Access/i)).toBeNull();
    expect(screen.queryByLabelText(/Access token/i)).toBeNull();
  });
});
