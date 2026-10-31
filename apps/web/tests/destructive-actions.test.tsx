// @vitest-environment jsdom
import type { ContentType } from '@contentworker/domain';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const client = {
  listReleases: vi.fn(),
  listScheduledActions: vi.fn(async () => []),
  getRelease: vi.fn(),
  getEntry: vi.fn(),
  listContentTypes: vi.fn(),
  listEntries: vi.fn(async () => []),
  publishRelease: vi.fn(async () => ({})),
  deleteRelease: vi.fn(async () => {}),
  listWorkflows: vi.fn(async () => [
    { id: 'wf-1', name: 'Editorial', steps: [{ id: 'st-1', name: 'Draft', requiredScope: 'x' }] },
  ]),
  listWorkflowGraphs: vi.fn(async () => [
    {
      id: 'wf-1',
      name: 'Editorial',
      description: '',
      contentTypes: [],
      gatesPublish: false,
      graph: { nodes: [], edges: [] },
      steps: [],
      latestVersion: 1,
      legacy: false,
      updatedAt: null,
    },
  ]),
  deleteWorkflow: vi.fn(async () => {}),
  listSchemes: vi.fn(async () => [{ id: 'sc-1', name: 'Topics' }]),
  listConcepts: vi.fn(async () => []),
  deleteScheme: vi.fn(async () => {}),
  listTags: vi.fn(async () => []),
  listAIActions: vi.fn(async () => [
    {
      id: 'ai-1',
      name: 'Shorten',
      promptTemplate: 'Shorten this',
      variables: [],
      tier: 'fast',
      createdAt: '2026-10-01T00:00:00.000Z',
    },
  ]),
  deleteAIAction: vi.fn(async () => {}),
  listComments: vi.fn(async () => [
    {
      id: 'c-1',
      entryId: 'e-1',
      parentId: null,
      author: 'Ada',
      body: 'Looks good',
      createdAt: '2026-10-01T00:00:00.000Z',
    },
  ]),
  deleteComment: vi.fn(async () => {}),
  listTasks: vi.fn(async () => []),
  getEntryWorkflowState: vi.fn(async () => null),
};
vi.mock('~/cms/lib/client-context', () => ({
  useClient: () => ({
    client,
    conn: { space: 's', environment: 'main', locale: 'en-US' },
    busy: false,
    run: (fn: () => Promise<void>) => fn(),
  }),
  useLocalRun: () => ({ busy: false, run: (fn: () => Promise<void>) => fn() }),
}));

const { ConfirmButton, InlineConfirm } = await import('~/cms/components/InlineConfirm');
const { ToastProvider, useToast } = await import('~/cms/lib/toast');
const { Releases } = await import('~/cms/routes/Releases');
const { Workflows } = await import('~/cms/routes/Workflows');
const { Taxonomy } = await import('~/cms/routes/Taxonomy');
const { AiActions } = await import('~/cms/components/AiActions');
const { CollaborationPanel } = await import('~/cms/components/CollaborationPanel');
type ManagementClient = import('~/cms/lib/management').ManagementClient;

function renderWithProviders(ui: React.ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>{ui}</ToastProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('InlineConfirm', () => {
  function Harness(props: { onConfirm: () => void }) {
    return (
      <ConfirmButton
        message="Delete “Spring”?"
        note="This can’t be undone."
        confirmLabel="Delete release"
        onConfirm={props.onConfirm}
      >
        {(ask) => (
          <button type="button" onClick={ask}>
            Delete
          </button>
        )}
      </ConfirmButton>
    );
  }

  it('asks in place, focusing the safe choice, and only acts on the named action', () => {
    const onConfirm = vi.fn();
    render(<Harness onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    const dialog = screen.getByRole('alertdialog', { name: 'Delete “Spring”?' });
    expect(dialog.getAttribute('aria-describedby')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
    expect(onConfirm).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Delete release' }));
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('backs out on Escape and returns focus to the trigger it replaced', () => {
    const onConfirm = vi.fn();
    render(<Harness onConfirm={onConfirm} />);
    const trigger = screen.getByRole('button', { name: 'Delete' });
    trigger.focus();
    fireEvent.click(trigger);

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Delete' }));
  });

  it('cancels only the newest confirm and keeps Escape from reaching an enclosing sheet', () => {
    const outerEscape = vi.fn();
    document.addEventListener('keydown', outerEscape);
    function Two() {
      const [a, setA] = useState(true);
      const [b, setB] = useState(true);
      return (
        <>
          {a && (
            <InlineConfirm message="First?" onCancel={() => setA(false)}>
              <button type="button">Do first</button>
            </InlineConfirm>
          )}
          {b && (
            <InlineConfirm message="Second?" onCancel={() => setB(false)}>
              <button type="button">Do second</button>
            </InlineConfirm>
          )}
        </>
      );
    }
    render(<Two />);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(screen.queryByRole('alertdialog', { name: 'Second?' })).toBeNull();
    expect(screen.getByRole('alertdialog', { name: 'First?' })).toBeTruthy();
    expect(outerEscape).not.toHaveBeenCalled();
    document.removeEventListener('keydown', outerEscape);
  });
});

describe('toast actions', () => {
  it('offers an action that runs once and dismisses the toast', () => {
    const undo = vi.fn();
    function Probe() {
      const toast = useToast();
      return (
        <button
          type="button"
          onClick={() =>
            toast.success('“Hello” moved to the trash', {
              action: { label: 'Undo', onAction: undo },
            })
          }
        >
          go
        </button>
      );
    }
    render(
      <ToastProvider>
        <Probe />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'go' }));
    // The action lives inside the polite live region with its message.
    const message = screen.getByText('“Hello” moved to the trash');
    expect(message.closest('[aria-live="polite"]')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(undo).toHaveBeenCalledOnce();
    expect(screen.queryByText('“Hello” moved to the trash')).toBeNull();
  });
});

describe('Releases destructive actions', () => {
  const article: ContentType = {
    apiId: 'article',
    name: 'Article',
    displayField: 'title',
    version: 1,
    status: 'published',
    fields: [],
  };
  const release = {
    id: 'rel-1',
    title: 'Spring campaign',
    status: 'open',
    createdAt: '2026-10-01T00:00:00.000Z',
  };
  const entry = (id: string, title: string, status: string) => ({
    id,
    contentType: 'article',
    status,
    version: 1,
    fields: { title: { 'en-US': title } },
  });

  function setup() {
    client.listReleases.mockResolvedValue([release]);
    client.listContentTypes.mockResolvedValue([article]);
    client.getRelease.mockResolvedValue({
      release,
      items: [
        { entityType: 'Entry', entityId: 'e-1', action: 'publish' },
        { entityType: 'Entry', entityId: 'e-2', action: 'publish' },
        { entityType: 'Entry', entityId: 'e-3', action: 'unpublish' },
      ],
    });
    client.getEntry.mockImplementation(async (id: string) => {
      if (id === 'e-1') return entry('e-1', 'Hello world', 'changed');
      if (id === 'e-2') return entry('e-2', 'Brand new', 'draft');
      throw new Error('Not found');
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <Releases />
        </ToastProvider>
      </QueryClientProvider>,
    );
  }

  it('confirms a card publish with the member titles and flags before shipping', async () => {
    setup();
    fireEvent.click(await screen.findByRole('button', { name: 'Publish' }));

    const dialog = screen.getByRole('alertdialog', { name: 'Publish “Spring campaign”?' });
    expect(client.publishRelease).not.toHaveBeenCalled();
    expect(await within(dialog).findByText('Hello world')).toBeTruthy();
    expect(await within(dialog).findByText('Brand new')).toBeTruthy();
    expect(within(dialog).getByText('unpublish')).toBeTruthy();
    expect(await within(dialog).findByText('missing')).toBeTruthy();
    expect(within(dialog).getByText('1 entry has never been published.')).toBeTruthy();
    expect(within(dialog).getByText(/in the trash or missing/)).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Publish 3 entries' }));
    await waitFor(() => expect(client.publishRelease).toHaveBeenCalledWith('rel-1'));
  });

  it('confirms a release delete by name; cancelling sends nothing', async () => {
    setup();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete “Spring campaign”' }));
    expect(screen.getByRole('alertdialog', { name: 'Delete “Spring campaign”?' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(client.deleteRelease).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Delete “Spring campaign”' }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Delete “Spring campaign”' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete release' }));
    await waitFor(() => expect(client.deleteRelease).toHaveBeenCalledWith('rel-1'));
  });
});

describe('permanent deletes', () => {
  const cases = [
    {
      name: 'Workflows route',
      ui: () => (
        <MemoryRouter>
          <Workflows />
        </MemoryRouter>
      ),
      trigger: 'Delete “Editorial”',
      dialog: 'Delete “Editorial”?',
      confirm: 'Delete workflow',
      call: () => client.deleteWorkflow,
      arg: 'wf-1',
    },
    {
      name: 'Taxonomy scheme',
      ui: () => <Taxonomy />,
      trigger: 'Delete “Topics”',
      dialog: 'Delete “Topics”?',
      confirm: 'Delete scheme',
      call: () => client.deleteScheme,
      arg: 'sc-1',
    },
    {
      name: 'AI action',
      ui: () => <AiActions client={client as unknown as ManagementClient} />,
      trigger: 'Delete',
      dialog: 'Delete “Shorten”?',
      confirm: 'Delete action',
      call: () => client.deleteAIAction,
      arg: 'ai-1',
    },
    {
      name: 'collaboration comment',
      ui: () => <CollaborationPanel entryId="e-1" />,
      trigger: 'Delete comment by Ada',
      dialog: 'Delete this comment?',
      confirm: 'Delete comment',
      call: () => client.deleteComment,
      arg: 'c-1',
    },
  ];

  it.each(cases)(
    'permanent deletes ask in place and send nothing until confirmed ($name)',
    async ({ ui, trigger, dialog, confirm, call, arg }) => {
      renderWithProviders(ui());
      fireEvent.click(await screen.findByRole('button', { name: trigger }));
      expect(screen.getByRole('alertdialog', { name: dialog })).toBeTruthy();
      expect(call()).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByRole('alertdialog')).toBeNull();
      expect(document.activeElement).toBe(screen.getByRole('button', { name: trigger }));
      expect(call()).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole('button', { name: trigger }));
      fireEvent.click(screen.getByRole('button', { name: confirm }));
      await waitFor(() => expect(call()).toHaveBeenCalledExactlyOnceWith(arg));
    },
  );
});

describe('Release publish confirm', () => {
  const release = {
    id: 'rel-1',
    title: 'Spring campaign',
    status: 'open',
    createdAt: '2026-10-01T00:00:00.000Z',
  };

  it('keeps the publish button disabled while members load and for an empty release', async () => {
    client.listReleases.mockResolvedValue([release]);
    client.listContentTypes.mockResolvedValue([]);
    let resolveDetail: (v: unknown) => void = () => {};
    client.getRelease.mockImplementation(
      () =>
        new Promise((r) => {
          resolveDetail = r;
        }),
    );
    renderWithProviders(<Releases />);
    fireEvent.click(await screen.findByRole('button', { name: 'Publish' }));

    const dialog = screen.getByRole('alertdialog', { name: 'Publish “Spring campaign”?' });
    expect(within(dialog).getByText('Checking its entries…')).toBeTruthy();
    const publish = () => within(dialog).getByRole('button', { name: 'Publish' });
    expect((publish() as HTMLButtonElement).disabled).toBe(true);

    resolveDetail({ release, items: [] });
    expect(
      await within(dialog).findByText('It has no entries yet, so there is nothing to ship.'),
    ).toBeTruthy();
    expect((publish() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(publish());
    expect(client.publishRelease).not.toHaveBeenCalled();
  });
});
