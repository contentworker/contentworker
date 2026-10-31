// @vitest-environment jsdom
import type { ContentType } from '@contentworker/domain';
import { cleanup, render, screen, within } from '@testing-library/react';
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

const runs: AgentRun[] = [
  {
    id: 'run-1',
    workflow: 'moderate',
    entryId: '0190a000-0000-7000-8000-000000000002',
    status: 'needs_review',
    decisions: ['flagged tone'],
    inputTokens: 1200,
    outputTokens: 300,
    createdAt: iso(-1 * DAY),
  },
  {
    id: 'run-2',
    workflow: 'enrich',
    entryId: '',
    status: 'completed',
    decisions: [],
    inputTokens: 9000,
    outputTokens: 600,
    // Outside the 14-day window: must not count toward any usage card.
    createdAt: iso(-30 * DAY),
  },
];

const client = {
  listEntries: vi.fn(async () => unpublished),
  listScheduledActions: vi.fn(async () => [
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
  useScopedQuery: <T,>(_segments: readonly unknown[], queryFn: () => Promise<T>) => {
    const [data, setData] = useState<T>();
    // biome-ignore lint/correctness/useExhaustiveDependencies: load once per mount
    useEffect(() => {
      queryFn().then(setData);
    }, []);
    return { data, isLoading: data === undefined, isError: false };
  },
  useContentTypesQuery: () => ({ data: [article] }),
  useAllEntriesQuery: () => ({ data: unpublished }),
  useAgentRunsQuery: () => ({ data: runs, isLoading: false, isError: false }),
}));

const { Dashboard } = await import('~/cms/components/Dashboard');
const { ToastProvider } = await import('~/cms/lib/toast');

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

  it('lists scheduled actions soonest first and only open releases', async () => {
    renderDashboard();
    const upcoming = card('Coming up');
    await within(upcoming).findByText('Older draft');
    const titles = within(upcoming)
      .getAllByRole('listitem')
      .map((li) => li.querySelector('a, span')?.textContent);
    // Scheduled (soonest first), then open releases.
    expect(titles).toEqual(['Older draft', 'Spring campaign', 'Spring campaign']);
    expect(within(upcoming).queryByText('Shipped bundle')).toBeNull();
  });

  it('shows agent runs that stopped for review', async () => {
    renderDashboard();
    const review = card('Agent proposals awaiting review');
    expect(within(review).getByText('needs review')).toBeTruthy();
    expect(within(review).getByText('moderate · flagged tone')).toBeTruthy();
    expect(within(review).getByRole('link', { name: 'Edited launch post' })).toBeTruthy();
  });

  it('keeps AI usage in one labelled 14-day window and drops the credentials card', async () => {
    renderDashboard();
    await screen.findAllByText('Edited launch post');
    expect(screen.getByRole('heading', { name: 'AI usage' })).toBeTruthy();
    // Only the in-window run (1.5K) counts — the 30-day-old 9.6K run must not.
    expect(screen.getByText('Tokens by workflow')).toBeTruthy();
    expect(screen.getAllByText('1.5K').length).toBeGreaterThan(0);
    expect(screen.queryByText('9.6K')).toBeNull();
    expect(screen.getAllByText('Last 14 days').length).toBe(3);
    expect(screen.queryByText(/Account Access/i)).toBeNull();
    expect(screen.queryByLabelText(/Access token/i)).toBeNull();
  });
});
