// @vitest-environment jsdom
import { nodeSpec, type WorkflowGraph, withDefaults } from '@contentworker/domain';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowListItem } from '~/cms/lib/management';

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

/**
 * A workflow as the list route returns it. By default its draft and published version start on
 * the same trigger and nothing starts alongside it; the API decides both, so tests set them.
 */
const workflow = (
  id: string,
  name: string,
  trigger: string,
  over: Partial<WorkflowListItem> = {},
): WorkflowListItem => ({
  id,
  name,
  description: '',
  contentTypes: [],
  gatesPublish: false,
  publishGated: false,
  graph: graph(trigger),
  steps: [],
  latestVersion: 1,
  legacy: false,
  updatedAt: null,
  publishedTrigger: { type: trigger, label: nodeSpec(trigger)?.label ?? trigger },
  startsAlongside: [],
  ...over,
});

const UNPUBLISHED = { latestVersion: null, publishedTrigger: null, startsAlongside: null };

const client = {
  listWorkflowGraphs: vi.fn<() => Promise<WorkflowListItem[]>>(),
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

function setup(workflows: WorkflowListItem[]) {
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
        publishGated: true,
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

  it('names the other published workflows the API says start the same way', async () => {
    setup([
      workflow('wf-1', 'Editorial review', 'trigger.manual', { startsAlongside: ['wf-2'] }),
      workflow('wf-2', 'Legal review', 'trigger.manual', { startsAlongside: ['wf-1'] }),
      workflow('wf-3', 'Tag on publish', 'trigger.entry_published'),
      workflow('wf-4', 'Unpublished draft', 'trigger.manual', UNPUBLISHED),
    ]);
    const editorial = await rowOf('Editorial review');
    expect(editorial.getByText('Editors choose between this and Legal review')).toBeTruthy();
    const legal = await rowOf('Legal review');
    expect(legal.getByText('Editors choose between this and Editorial review')).toBeTruthy();
    const tagging = await rowOf('Tag on publish');
    expect(tagging.queryByText(/choose between|Also starts/)).toBeNull();
    // A draft never published starts nothing; the row says what it would start on.
    const draft = await rowOf('Unpublished draft');
    expect(draft.getByText('Not published')).toBeTruthy();
    expect(draft.getByText('Draft starts on Submit for review')).toBeTruthy();
    expect(draft.queryByText(/choose between|Also starts/)).toBeNull();
  });

  it('says which event-started workflows run together', async () => {
    setup([
      workflow('wf-1', 'Tag on publish', 'trigger.entry_published', { startsAlongside: ['wf-2'] }),
      workflow('wf-2', 'Notify on publish', 'trigger.entry_published', {
        contentTypes: ['article'],
        startsAlongside: ['wf-1'],
      }),
    ]);
    const row = await rowOf('Tag on publish');
    expect(row.getByText('Also starts: Notify on publish')).toBeTruthy();
  });

  it('describes the published version, and the draft only where its trigger differs', async () => {
    setup([
      // Published on "Entry published"; the draft has since moved to "Submit for review".
      workflow('wf-1', 'Announce', 'trigger.manual', {
        publishedTrigger: { type: 'trigger.entry_published', label: 'Entry published' },
      }),
      // Two manual workflows for every type that the API reports as not overlapping: the list
      // renders what it is told and works nothing out from the draft graphs.
      workflow('wf-2', 'Review', 'trigger.manual'),
      workflow('wf-3', 'Second review', 'trigger.manual'),
    ]);
    const announce = await rowOf('Announce');
    expect(announce.getByText('Entry published')).toBeTruthy();
    expect(announce.getByText('Draft starts on Submit for review')).toBeTruthy();
    const review = await rowOf('Review');
    expect(review.getByText('Submit for review')).toBeTruthy();
    expect(review.queryByText(/Draft starts on|choose between|Also starts/)).toBeNull();
  });
});
