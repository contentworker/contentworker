// @vitest-environment jsdom
// The entry editor's action row: one primary verb for the entry's state, the save state in words,
// Publish confirming what goes live and offering Undo only where unpublishing is its exact inverse.
import type { ContentType } from '@contentworker/domain';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PreviewEntry } from '~/cms/lib/management';

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
  publishEntry: vi.fn(async (id: string) => ({
    id,
    contentTypeApiId: 'article',
    status: 'published',
    currentVersion: 2,
    publishedVersion: 2,
  })),
  unpublishEntry: vi.fn(async (id: string) => ({
    id,
    contentTypeApiId: 'article',
    status: 'draft',
    currentVersion: 2,
    publishedVersion: null,
  })),
  updateEntry: vi.fn(),
  getPublished: vi.fn(async (id: string) => ({
    id,
    contentType: 'article',
    fields: { title: 'Pricing' },
    publishedAt: '2026-10-01T00:00:00.000Z',
  })),
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

// The side pane's panels fetch their own data; this file is about the action row.
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

function setup(path: string, entry?: PreviewEntry) {
  if (entry) client.getEntry.mockResolvedValue(entry);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const outlet = { types: [article], locales: ['en-US'], defaultLocale: 'en-US', reload() {} };
  // A data router: the editor's unsaved-edits guard (`useBlocker`) needs one.
  const router = createMemoryRouter(
    [
      {
        path: '/content',
        element: <Outlet context={outlet} />,
        children: [
          { path: ':typeId/new', element: <EntryEditor /> },
          { path: ':typeId/:entryId', element: <EntryEditor /> },
        ],
      },
    ],
    { initialEntries: [path] },
  );
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const saved = (status: string): PreviewEntry => ({
  id: 'e1',
  contentType: 'article',
  status,
  version: 2,
  fields: { title: { 'en-US': 'Pricing page' } },
});

const button = (name: string) => screen.getByRole('button', { name, hidden: false });
const variant = (name: string) => button(name).getAttribute('data-variant');

describe('EntryEditor action row', () => {
  it('a saved draft: Publish is the primary verb, Save draft rests until there are edits', async () => {
    setup('/content/article/e1', saved('draft'));
    await screen.findByRole('heading', { level: 1, name: 'Pricing page' });
    expect(screen.getByText('All changes saved')).toBeTruthy();
    expect((button('Save draft') as HTMLButtonElement).disabled).toBe(true);
    expect(variant('Save draft')).toBe('outline');
    expect((button('Publish') as HTMLButtonElement).disabled).toBe(false);
    expect(variant('Publish')).toBe('default');

    fireEvent.change(screen.getByRole('textbox', { name: /Title/ }), {
      target: { value: 'Pricing page v2' },
    });
    await screen.findByText('Unsaved changes');
    expect(screen.queryByText('All changes saved')).toBeNull();
    expect((button('Save draft') as HTMLButtonElement).disabled).toBe(false);
    expect(variant('Publish')).toBe('default');
  });

  it('a live entry with no edits reads Published, and both verbs rest', async () => {
    setup('/content/article/e1', saved('published'));
    await screen.findByRole('heading', { level: 1, name: 'Pricing page' });
    expect((button('Published') as HTMLButtonElement).disabled).toBe(true);
    expect((button('Save draft') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Publish' })).toBeNull();

    // An edit makes it publishable again (saving first).
    fireEvent.change(screen.getByRole('textbox', { name: /Title/ }), {
      target: { value: 'Pricing' },
    });
    await waitFor(() => expect((button('Publish') as HTMLButtonElement).disabled).toBe(false));
  });

  it('a new entry has one verb, Save draft, as the primary', async () => {
    setup('/content/article/new');
    await screen.findByRole('heading', { level: 1, name: 'New Article' });
    expect((button('Save draft') as HTMLButtonElement).disabled).toBe(false);
    expect(variant('Save draft')).toBe('default');
    expect(screen.queryByRole('button', { name: 'Publish' })).toBeNull();
  });

  it('holds the title’s line while the entry loads, and can’t publish what hasn’t loaded', async () => {
    client.getEntry.mockImplementation(() => new Promise(() => {}));
    setup('/content/article/e1');
    const h1 = await screen.findByRole('heading', { level: 1 });
    // Read out as the page it will be, drawn as a skeleton rather than "Edit Article" text.
    expect(h1.querySelector('[data-slot="skeleton"], .animate-pulse')).toBeTruthy();
    expect((button('Publish') as HTMLButtonElement).disabled).toBe(true);
  });

  it('the AI actions are quieter than the verbs: ghost, never outline or ink', async () => {
    setup('/content/article/e1', saved('draft'));
    await screen.findByRole('heading', { level: 1, name: 'Pricing page' });
    for (const name of ['Draft from prose', 'Generate with AI']) {
      expect(screen.getByRole('button', { name, hidden: true }).getAttribute('data-variant')).toBe(
        'ghost',
      );
    }
  });
});

describe('EntryEditor Publish', () => {
  it('confirms a first publish, then offers Undo, which unpublishes it', async () => {
    setup('/content/article/e1', saved('draft'));
    await screen.findByRole('heading', { level: 1, name: 'Pricing page' });
    fireEvent.click(button('Publish'));
    const dialog = await screen.findByRole('alertdialog', { name: 'Publish “Pricing page”?' });
    expect(within(dialog).getByText(/whole entry goes live/)).toBeTruthy();
    expect(client.publishEntry).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Publish entry' }));
    await screen.findByText('Published v2');
    expect(client.publishEntry).toHaveBeenCalledExactlyOnceWith('e1');

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await screen.findByText('“Pricing page” is back to draft');
    expect(client.unpublishEntry).toHaveBeenCalledExactlyOnceWith('e1');
  });

  it('confirms a changed entry with its draft against what is live, and offers no Undo', async () => {
    setup('/content/article/e1', saved('changed'));
    await screen.findByRole('heading', { level: 1, name: 'Pricing page' });
    fireEvent.click(button('Publish'));
    const dialog = await screen.findByRole('alertdialog', { name: 'Publish “Pricing page”?' });
    await within(dialog).findByText('1 field changed');
    expect(client.getPublished).toHaveBeenCalledWith('e1');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Publish entry' }));
    await screen.findByText('Published v2');
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
  });

  it('declining keeps the entry a draft', async () => {
    setup('/content/article/e1', saved('draft'));
    await screen.findByRole('heading', { level: 1, name: 'Pricing page' });
    fireEvent.click(button('Publish'));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep as draft' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(client.publishEntry).not.toHaveBeenCalled();
  });
});
