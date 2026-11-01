// @vitest-environment jsdom
import { type WorkflowGraph, withDefaults } from '@contentworker/domain';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowSummary } from '~/cms/lib/management';

const graph = (trigger: string): WorkflowGraph => ({
  nodes: [
    {
      id: 'start',
      type: trigger,
      label: 'Start',
      config: withDefaults(trigger),
      position: { x: 0, y: 0 },
    },
  ],
  edges: [],
});

const workflow = (
  id: string,
  name: string,
  trigger: string,
  over: Partial<WorkflowSummary> = {},
): WorkflowSummary => ({
  id,
  name,
  description: '',
  contentTypes: [],
  gatesPublish: false,
  graph: graph(trigger),
  steps: [],
  latestVersion: 1,
  legacy: false,
  updatedAt: null,
  ...over,
});

const client = {
  listWorkflowGraphs: vi.fn<() => Promise<WorkflowSummary[]>>(),
  listContentTypes: vi.fn(async () => [{ apiId: 'article', name: 'Article' }]),
};
vi.mock('~/cms/lib/client-context', () => ({
  useClient: () => ({
    client,
    conn: { space: 's', environment: 'main', locale: 'en-US' },
    busy: false,
    run: (fn: () => Promise<void>) => fn(),
  }),
}));

const { ToastProvider } = await import('~/cms/lib/toast');
const { Workflows } = await import('~/cms/routes/Workflows');

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function setup(workflows: WorkflowSummary[]) {
  client.listWorkflowGraphs.mockResolvedValue(workflows);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter>
          <Workflows />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const rowOf = async (name: string) => {
  const row = (await screen.findByRole('link', { name })).closest('tr');
  if (!row) throw new Error(`no row for ${name}`);
  return within(row);
};

describe('workflows list', () => {
  it('lists each workflow as a row with what starts it, what it covers and its version', async () => {
    setup([
      workflow('wf-1', 'Editorial review', 'trigger.manual', {
        contentTypes: ['article'],
        gatesPublish: true,
      }),
    ]);
    const row = await rowOf('Editorial review');
    expect(row.getByText('Submit for review')).toBeTruthy();
    expect(row.getByText('Article')).toBeTruthy();
    expect(row.getByText('Only through this workflow')).toBeTruthy();
    expect(row.getByText('Published v1')).toBeTruthy();
    // No nested cards: the workflows are rows of one table.
    expect(screen.queryByRole('listitem')).toBeNull();
  });

  it('names the other published workflows that start the same way for the same entries', async () => {
    setup([
      workflow('wf-1', 'Editorial review', 'trigger.manual'),
      workflow('wf-2', 'Legal review', 'trigger.manual'),
      workflow('wf-3', 'Tag on publish', 'trigger.entry_published'),
      workflow('wf-4', 'Unpublished draft', 'trigger.manual', { latestVersion: null }),
    ]);
    const editorial = await rowOf('Editorial review');
    expect(editorial.getByText('Editors choose between this and Legal review')).toBeTruthy();
    const legal = await rowOf('Legal review');
    expect(legal.getByText('Editors choose between this and Editorial review')).toBeTruthy();
    // A different trigger, or a draft that starts no runs, overlaps with nothing.
    const tagging = await rowOf('Tag on publish');
    expect(tagging.queryByText(/choose between|Also starts/)).toBeNull();
    const draft = await rowOf('Unpublished draft');
    expect(draft.queryByText(/choose between|Also starts/)).toBeNull();
  });

  it('says which event-started workflows run together', async () => {
    setup([
      workflow('wf-1', 'Tag on publish', 'trigger.entry_published'),
      workflow('wf-2', 'Notify on publish', 'trigger.entry_published', {
        contentTypes: ['article'],
      }),
    ]);
    const row = await rowOf('Tag on publish');
    expect(row.getByText('Also starts: Notify on publish')).toBeTruthy();
  });
});
