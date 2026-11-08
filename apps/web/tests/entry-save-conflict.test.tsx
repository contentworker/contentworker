// @vitest-environment jsdom
// The entry form's save, held to the version the form was filled from: a save someone made
// meanwhile is met with the same question the canvas asks (Keep editing, Load theirs, Save mine
// over it), and is never overwritten unseen.
import type { ContentType } from '@contentworker/domain';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type PreviewEntry } from '~/cms/lib/management';

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const client = {
  getEntry: vi.fn<(id: string) => Promise<PreviewEntry>>(),
  listEntries: vi.fn(async () => []),
  listAssets: vi.fn(async () => []),
  listAppExtensions: vi.fn(async () => []),
  updateEntry: vi.fn(),
};
vi.mock('~/cms/lib/client-context', () => ({
  useClient: () => ({
    client,
    conn: { space: 's', environment: 'main', locale: 'en-US' },
    busy: false,
    run: async (fn: () => Promise<void>) => {
      try {
        await fn();
      } catch {}
    },
  }),
}));
// Coworker, when a test gives it the edit; otherwise absent (`null`), and the page saves itself.
const assistantEdit = vi.fn(async (..._args: unknown[]): Promise<unknown> => null);
vi.mock('~/cms/lib/assistant', async (original) => ({
  ...(await original<typeof import('~/cms/lib/assistant')>()),
  useAssistantEdit: () => assistantEdit,
}));
vi.mock('~/cms/components/CollaborationPanel', () => ({ CollaborationPanel: () => null }));
vi.mock('~/cms/components/EntryMetadataPanel', () => ({ EntryMetadataPanel: () => null }));
vi.mock('~/cms/components/VersionHistory', () => ({ VersionHistory: () => null }));
vi.mock('~/cms/components/ReferencedBy', () => ({ ReferencedBy: () => null }));
vi.mock('~/cms/components/SemanticPanel', () => ({ SemanticPanel: () => null }));
vi.mock('~/cms/components/AiAssistPanel', () => ({ AiAssistPanel: () => null }));

const { ToastProvider } = await import('~/cms/lib/toast');
const { EntryEditor } = await import('~/cms/routes/EntryEditor');

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  assistantEdit.mockImplementation(async () => null);
});

const article = {
  apiId: 'article',
  name: 'Article',
  displayField: 'title',
  version: 1,
  status: 'published',
  fields: [
    {
      apiId: 'title',
      name: 'Title',
      type: 'Symbol',
      localized: false,
      required: false,
      position: 0,
    },
  ],
} as ContentType;

const entry = (version: number, title: string): PreviewEntry => ({
  id: 'e1',
  contentType: 'article',
  status: 'draft',
  version,
  fields: { title: { 'en-US': title } },
});
const view = (version: number, title: string) => ({
  entry: {
    id: 'e1',
    contentTypeApiId: 'article',
    status: 'draft',
    currentVersion: version,
    publishedVersion: null,
  },
  fields: { title: { 'en-US': title } },
});
const stale = (theirs: number) =>
  new ApiError(409, 'stale', {
    error: { code: 'conflict', details: { currentVersion: theirs, expectedVersion: 2 } },
  });

async function edited(title = 'Mine') {
  client.getEntry.mockResolvedValue(entry(2, 'Pricing'));
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const outlet = { types: [article], locales: ['en-US'], defaultLocale: 'en-US', reload() {} };
  const router = createMemoryRouter(
    [
      {
        path: '/content',
        element: <Outlet context={outlet} />,
        children: [{ path: ':typeId/:entryId', element: <EntryEditor /> }],
      },
    ],
    { initialEntries: ['/content/article/e1'] },
  );
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  await screen.findByRole('heading', { level: 1, name: 'Pricing' });
  fireEvent.change(screen.getByRole('textbox', { name: /Title/ }), { target: { value: title } });
}
const saveDraft = () => act(() => screen.getByRole('button', { name: 'Save draft' }).click());
const fieldsOf = (call: number) =>
  (client.updateEntry.mock.calls[call]![1] as { title: Record<string, string> }).title['en-US'];

describe('the entry form’s save', () => {
  it('is held to the version the form was filled from, then to its own last save', async () => {
    client.updateEntry.mockResolvedValueOnce(view(3, 'Mine'));
    client.updateEntry.mockResolvedValueOnce(view(4, 'Mine again'));
    await edited();
    saveDraft();
    await waitFor(() => expect(client.updateEntry).toHaveBeenCalledTimes(1));
    expect(client.updateEntry.mock.calls[0]?.[2]).toEqual({ expectedVersion: 2 });
    await screen.findByText('All changes saved');
    fireEvent.change(screen.getByRole('textbox', { name: /Title/ }), {
      target: { value: 'Mine again' },
    });
    saveDraft();
    await waitFor(() => expect(client.updateEntry).toHaveBeenCalledTimes(2));
    expect(client.updateEntry.mock.calls[1]?.[2]).toEqual({ expectedVersion: 3 });
  });

  it('asks when someone saved meanwhile, and saves over theirs when told to', async () => {
    client.updateEntry.mockRejectedValueOnce(stale(5));
    client.updateEntry.mockResolvedValueOnce(view(6, 'Mine'));
    await edited();
    saveDraft();
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/It’s at v5 now, and the form started from v2/)).toBeTruthy();
    expect(screen.getByText('Unsaved changes')).toBeTruthy();
    act(() => within(dialog).getByRole('button', { name: 'Save mine over it' }).click());
    await waitFor(() => expect(client.updateEntry).toHaveBeenCalledTimes(2));
    expect(client.updateEntry.mock.calls[1]?.[2]).toEqual({ expectedVersion: 5 });
    expect(fieldsOf(1)).toBe('Mine');
  });

  it('keeps editing, saving nothing, or loads theirs into the form', async () => {
    client.updateEntry.mockRejectedValue(stale(5));
    await edited();
    saveDraft();
    let dialog = await screen.findByRole('alertdialog');
    act(() => within(dialog).getByRole('button', { name: 'Keep editing' }).click());
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect((screen.getByRole('textbox', { name: /Title/ }) as HTMLInputElement).value).toBe('Mine');
    expect(screen.getByText('Unsaved changes')).toBeTruthy();

    saveDraft();
    dialog = await screen.findByRole('alertdialog');
    client.getEntry.mockResolvedValue(entry(5, 'Theirs'));
    act(() => within(dialog).getByRole('button', { name: 'Load theirs' }).click());
    await waitFor(() =>
      expect((screen.getByRole('textbox', { name: /Title/ }) as HTMLInputElement).value).toBe(
        'Theirs',
      ),
    );
    // The next save is held to theirs.
    client.updateEntry.mockReset();
    client.updateEntry.mockResolvedValueOnce(view(6, 'After'));
    fireEvent.change(screen.getByRole('textbox', { name: /Title/ }), {
      target: { value: 'After' },
    });
    saveDraft();
    await waitFor(() => expect(client.updateEntry).toHaveBeenCalledTimes(1));
    expect(client.updateEntry.mock.calls[0]?.[2]).toEqual({ expectedVersion: 5 });
  });

  it('meets the same refusal through Coworker, in its words, and saves over it there', async () => {
    assistantEdit.mockRejectedValueOnce(
      new Error('Entry "e1" is at version 7, not 2: it changed after it was read. Read it again.'),
    );
    assistantEdit.mockResolvedValueOnce({ output: view(8, 'Mine') });
    await edited();
    saveDraft();
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/It’s at v7 now/)).toBeTruthy();
    expect(assistantEdit.mock.calls[0]?.slice(0, 2)).toEqual([
      'entries_update',
      { id: 'e1', fields: { title: { 'en-US': 'Mine' } }, expectedVersion: 2 },
    ]);
    act(() => within(dialog).getByRole('button', { name: 'Save mine over it' }).click());
    await waitFor(() => expect(assistantEdit).toHaveBeenCalledTimes(2));
    expect(assistantEdit.mock.calls[1]?.[1]).toMatchObject({ expectedVersion: 7 });
    expect(client.updateEntry).not.toHaveBeenCalled();
  });

  it('goes on to publish after saving over theirs, when Publish asked for the save', async () => {
    client.updateEntry.mockRejectedValueOnce(stale(5));
    client.updateEntry.mockResolvedValueOnce(view(6, 'Mine'));
    await edited();
    act(() => screen.getByRole('button', { name: 'Publish' }).click());
    const dialog = await screen.findByRole('alertdialog');
    act(() => within(dialog).getByRole('button', { name: 'Save mine over it' }).click());
    await waitFor(() => expect(client.updateEntry).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole('heading', { name: /^Publish “/ })).toBeTruthy();
  });

  it('says any other refusal as it did', async () => {
    client.updateEntry.mockRejectedValueOnce(new ApiError(409, 'title is taken'));
    await edited();
    saveDraft();
    await waitFor(() => expect(client.updateEntry).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});
