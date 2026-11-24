// @vitest-environment jsdom
// Settings → AI's usage section: agent token spend and the run ledger, moved off the Overview.
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentRun } from '~/cms/lib/management';

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const DAY = 86_400_000;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

let runs: AgentRun[] = [];

vi.mock('~/cms/lib/client-context', () => ({
  useClient: () => ({
    client: { listEntries: vi.fn(async () => []) },
    conn: { space: 'demo', environment: 'main', locale: 'en-US' },
  }),
}));

vi.mock('~/cms/lib/queries', () => ({
  useScopedQuery: () => ({ data: [], isLoading: false, isError: false }),
  useContentTypesQuery: () => ({ data: [] }),
  useAgentRunsQuery: () => ({ data: runs, isLoading: false, isError: false }),
}));

const { AiUsage } = await import('~/cms/components/AiUsage');

afterEach(cleanup);

const run = (id: string, status: string, tokens: [number, number], ageDays: number): AgentRun => ({
  id,
  workflow: 'moderate',
  entryId: '',
  status,
  decisions: [],
  inputTokens: tokens[0],
  outputTokens: tokens[1],
  createdAt: iso(-ageDays * DAY),
});

const renderUsage = () =>
  render(
    <MemoryRouter>
      <AiUsage />
    </MemoryRouter>,
  );

describe('AI usage in Settings', () => {
  it('keeps the token cards in one labelled 14-day window', () => {
    runs = [
      run('run-1', 'needs_review', [1200, 300], 1),
      // Outside the 14-day window: must not count toward any usage card.
      run('run-2', 'completed', [9000, 600], 30),
    ];
    renderUsage();
    expect(screen.getByRole('heading', { name: 'AI usage' })).toBeTruthy();
    expect(screen.getByText('Total tokens')).toBeTruthy();
    expect(screen.getByText('Tokens by workflow')).toBeTruthy();
    // Only the in-window run (1.5K) counts; the 30-day-old 9.6K run must not.
    expect(screen.getAllByText('1.5K').length).toBeGreaterThan(0);
    expect(screen.queryByText('9.6K')).toBeNull();
    expect(screen.getAllByText('Last 14 days').length).toBe(3);
  });

  it('says what Needs review and Held mean beside the run ledger', () => {
    runs = [run('run-1', 'needs_review', [1, 1], 1), run('run-2', 'held', [1, 1], 2)];
    renderUsage();
    const ledger = screen
      .getByRole('heading', { name: 'Recent agent runs' })
      .closest('[data-slot="card"]') as HTMLElement;
    expect(within(ledger).getByText(/Needs review: the run proposed changes/)).toBeTruthy();
    expect(within(ledger).getByText(/Held: moderation flagged a published entry/)).toBeTruthy();
    expect(within(ledger).getByText('Held')).toBeTruthy();
  });

  it('points to how runs start when there are none, without a caption for statuses', () => {
    runs = [];
    renderUsage();
    expect(screen.getByText('No agent runs yet')).toBeTruthy();
    expect(screen.queryByText(/Held: moderation/)).toBeNull();
  });
});
