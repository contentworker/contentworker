// The Approvals inbox: pending workflow steps and agent proposals, decided in place, through the
// real Management client against a mocked same-origin fetch.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { ClientProvider } from '~/cms/lib/client-context';
import { ToastProvider } from '~/cms/lib/toast';
import { Approvals } from '~/cms/routes/Approvals';

const BASE = '/spaces/space-1/environments/main';

const task = {
  id: 'task-1',
  runId: 'run-1',
  workflowId: 'wf-1',
  nodeId: 'n1',
  eventType: 'approve:n1',
  kind: 'approval',
  entryId: 'entry-1',
  contentTypeApiId: 'article',
  title: 'Legal sign-off',
  instructions: 'Check the claims.',
  assignee: null,
  event: null,
  requiredScope: 'workflow:approve',
  separateDuties: false,
  reviewId: null,
  deadline: new Date(Date.now() + 3_600_000).toISOString(),
  status: 'pending',
  requestedAt: new Date(Date.now() - 600_000).toISOString(),
  decidedAt: null,
  decidedBy: null,
  note: null,
  startedBy: 'someone',
};

const review = {
  id: 'review-1',
  workflow: 'enrich',
  entryId: 'entry-2',
  proposed: { summary: { 'en-US': 'A summary' } },
  notes: ['Added a summary from the body.'],
  status: 'pending',
  awaiting: false,
  createdAt: new Date(Date.now() - 300_000).toISOString(),
};

function setup() {
  const calls: { method: string; url: string; body?: unknown }[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    if (url === '/spaces') return json({ items: [{ id: 'space-1', name: 'Space 1' }] });
    if (url.startsWith(`${BASE}/workflow-tasks?`)) return json({ items: [task] });
    if (url.startsWith(`${BASE}/agent-reviews?`)) return json({ items: [review] });
    // One entry's draft, through the preview list filtered by id.
    if (url.startsWith('/preview/space-1/main/entries') && url.includes('entry-2'))
      return json({
        items: [{ id: 'entry-2', contentType: 'post', status: 'draft', version: 1, fields: {} }],
      });
    if (url.endsWith('/decide'))
      return json({ taskId: 'task-1', runId: 'run-1', decision: 'approved', by: 'me' });
    if (url.endsWith('/approve')) return json({ ...review, status: 'approved' });
    return json({});
  }) as unknown as typeof fetch;
  render(
    <MemoryRouter>
      <ToastProvider>
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <ClientProvider
            initial={{ space: 'space-1', environment: 'main', locale: 'en-US' }}
            fetchImpl={fetchImpl}
          >
            <Approvals />
          </ClientProvider>
        </QueryClientProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
  return calls;
}

describe('Approvals', () => {
  it('lists pending workflow steps and agent proposals', async () => {
    const calls = setup();
    const step = await screen.findByRole('listitem', { name: 'Legal sign-off' });
    expect(within(step).getByText('Check the claims.')).toBeTruthy();
    expect(within(step).getByText('Pending')).toBeTruthy();
    expect(within(step).getByRole('link', { name: 'entry-1' }).getAttribute('href')).toBe(
      '/content/article/entry-1',
    );
    const proposal = await screen.findByRole('listitem', { name: 'enrich proposal' });
    expect(within(proposal).getByText('Added a summary from the body.')).toBeTruthy();
    expect(within(proposal).getByText('summary')).toBeTruthy();
    // The proposal's entry link comes from the entry's own content type.
    await waitFor(() =>
      expect(within(proposal).getByRole('link', { name: 'entry-2' }).getAttribute('href')).toBe(
        '/content/post/entry-2',
      ),
    );
    expect(calls.some((c) => c.url === `${BASE}/workflow-tasks?status=pending`)).toBe(true);
    expect(calls.some((c) => c.url === `${BASE}/agent-reviews?status=pending`)).toBe(true);
  });

  it('approves a workflow step', async () => {
    const calls = setup();
    const step = await screen.findByRole('listitem', { name: 'Legal sign-off' });
    fireEvent.click(within(step).getByRole('button', { name: 'Approve' }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'POST',
        url: `${BASE}/workflow-tasks/task-1/decide`,
        body: { decision: 'approved' },
      }),
    );
  });

  it('approves an agent proposal', async () => {
    const calls = setup();
    const proposal = await screen.findByRole('listitem', { name: 'enrich proposal' });
    fireEvent.click(within(proposal).getByRole('button', { name: 'Approve and apply' }));
    await waitFor(() =>
      expect(
        calls.some(
          (c) => c.method === 'POST' && c.url === `${BASE}/agent-reviews/review-1/approve`,
        ),
      ).toBe(true),
    );
  });
});
