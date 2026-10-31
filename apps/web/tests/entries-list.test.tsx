// @vitest-environment jsdom
import type { ContentType } from '@contentworker/domain';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PreviewEntry } from '~/cms/lib/management';

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;
// jsdom has no layout, so it has no scrollIntoView; every real browser does.
Element.prototype.scrollIntoView ??= () => {};

const client = {
  listEntries: vi.fn<() => Promise<PreviewEntry[]>>(),
  trashEntry: vi.fn(async () => {}),
  restoreEntry: vi.fn(async () => {}),
  publishEntry: vi.fn(async () => ({})),
  unpublishEntry: vi.fn<(id: string) => Promise<unknown>>(async () => ({})),
  bulkEntryAction: vi.fn(async (_action: string, ids: string[]) => ({
    succeeded: ids.length,
    failed: 0,
    results: ids.map((id) => ({ id, ok: true })),
  })),
  purgeEntry: vi.fn(async () => {}),
  duplicateEntry: vi.fn(),
};
vi.mock('~/cms/lib/client-context', () => ({
  useClient: () => ({
    client,
    conn: { space: 's', environment: 'main', locale: 'en-US' },
    busy: false,
    // Like the real runner: a failure is surfaced, never rethrown.
    run: async (fn: () => Promise<void>) => {
      try {
        await fn();
      } catch {}
    },
  }),
}));

const { ToastProvider } = await import('~/cms/lib/toast');
const { EntriesList } = await import('~/cms/routes/EntriesList');

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const article: ContentType = {
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

const entry = (id: string, status: string, title: string): PreviewEntry => ({
  id,
  contentType: 'article',
  status,
  version: 1,
  fields: { title: { 'en-US': title } },
});

const ENTRIES = [
  entry('e-live', 'published', 'About us'),
  entry('e-changed', 'changed', 'Pricing page'),
  entry('e-draft', 'draft', 'Spring launch'),
  entry('e-live2', 'published', 'Careers'),
];

function setup() {
  client.listEntries.mockResolvedValue(ENTRIES);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const outlet = { types: [article], locales: ['en-US'], defaultLocale: 'en-US', reload() {} };
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/content/article']}>
          <Routes>
            <Route path="/content" element={<Outlet context={outlet} />}>
              <Route path=":typeId" element={<EntriesList />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

// Radix menus open on pointerdown (left button, no modifiers).
async function rowMenu(title: string, item: string) {
  fireEvent.pointerDown(await screen.findByRole('button', { name: `More actions for ${title}` }), {
    button: 0,
    ctrlKey: false,
  });
  fireEvent.click(screen.getByRole('menuitem', { name: item }));
}

const rowOf = (title: string) => {
  const row = screen.getByRole('link', { name: title }).closest('[role="row"]');
  if (!(row instanceof HTMLElement)) throw new Error(`no row for ${title}`);
  return row;
};

describe('EntriesList trash and Undo', () => {
  it('undoing the trash of a published entry restores and then republishes it', async () => {
    setup();
    await rowMenu('About us', 'Move to trash');
    await screen.findByText('“About us” unpublished and moved to the trash');
    expect(client.trashEntry).toHaveBeenCalledWith('e-live');

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await screen.findByText('“About us” restored and live again');
    expect(client.restoreEntry).toHaveBeenCalledWith('e-live');
    expect(client.publishEntry).toHaveBeenCalledWith('e-live');
    const restoreOrder = client.restoreEntry.mock.invocationCallOrder[0] ?? 0;
    const publishOrder = client.publishEntry.mock.invocationCallOrder[0] ?? 0;
    expect(restoreOrder).toBeLessThan(publishOrder);
  });

  it('undoing the trash of a changed entry restores it as a draft without publishing', async () => {
    setup();
    await rowMenu('Pricing page', 'Move to trash');
    await screen.findByText('“Pricing page” unpublished and moved to the trash');

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await screen.findByText('“Pricing page” restored as a draft; publish it to put it back live');
    expect(client.restoreEntry).toHaveBeenCalledWith('e-changed');
    expect(client.publishEntry).not.toHaveBeenCalled();
  });

  it('undoing the trash of a draft only restores it', async () => {
    setup();
    await rowMenu('Spring launch', 'Move to trash');
    await screen.findByText('“Spring launch” moved to the trash');

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await screen.findByText('“Spring launch” restored');
    expect(client.restoreEntry).toHaveBeenCalledWith('e-draft');
    expect(client.publishEntry).not.toHaveBeenCalled();
  });
});

describe('EntriesList unpublish and Undo', () => {
  it('Undo on a single-row unpublish republishes that entry', async () => {
    setup();
    await rowMenu('About us', 'Unpublish');
    await screen.findByText('“About us” unpublished');
    expect(client.unpublishEntry).toHaveBeenCalledWith('e-live');

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await screen.findByText('“About us” is live again');
    expect(client.publishEntry).toHaveBeenCalledExactlyOnceWith('e-live');
  });

  const bulkUnpublish = async (titles: string[]) => {
    for (const t of titles) {
      fireEvent.click(await screen.findByRole('checkbox', { name: `Select “${t}”` }));
    }
    fireEvent.click(screen.getByRole('button', { name: 'Unpublish selected' }));
    const dialog = screen.getByRole('alertdialog', {
      name: `Unpublish ${titles.length} entries?`,
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Unpublish entries' }));
  };

  it('offers Undo on a bulk unpublish of entries that were all live, republishing them', async () => {
    setup();
    await bulkUnpublish(['About us', 'Careers']);
    await screen.findByText('Unpublished 2 entries');
    expect(client.bulkEntryAction).toHaveBeenCalledWith('unpublish', ['e-live', 'e-live2']);

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await screen.findByText('Republished 2 entries');
    expect(client.bulkEntryAction).toHaveBeenLastCalledWith('publish', ['e-live', 'e-live2']);
  });

  it('offers no Undo when the selection included an entry that was not live', async () => {
    setup();
    await bulkUnpublish(['About us', 'Pricing page']);
    await screen.findByText('Unpublished 2 entries');
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
  });
});

describe('EntriesList optimistic status', () => {
  it('rolls the status badge back when the change fails', async () => {
    setup();
    let reject: (e: Error) => void = () => {};
    client.unpublishEntry.mockImplementationOnce(
      () =>
        new Promise((_, rej) => {
          reject = rej;
        }),
    );
    await screen.findByRole('link', { name: 'About us' });
    // Any refetch hangs, so only the rollback can restore the badge.
    client.listEntries.mockImplementation(() => new Promise(() => {}));

    await rowMenu('About us', 'Unpublish');
    await waitFor(() => expect(within(rowOf('About us')).getByText('Draft')).toBeTruthy());

    reject(new Error('Server said no'));
    await waitFor(() => expect(within(rowOf('About us')).getByText('Published')).toBeTruthy());
    expect(within(rowOf('About us')).queryByText('Draft')).toBeNull();
    expect(screen.queryByText('“About us” unpublished')).toBeNull();
  });
});
