// @vitest-environment jsdom
import type { ContentType, SavedView } from '@contentworker/domain';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes, useLocation } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EntryListQuery, EntryPage } from '~/cms/lib/management';

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;
Element.prototype.scrollIntoView ??= () => {};

const views: SavedView[] = [];
const access = { scopes: ['preview:read', 'content:manage'] as string[] };
const client = {
  listEntryPage: vi.fn(
    async (_t?: string, _q?: EntryListQuery): Promise<EntryPage> => ({
      items: [
        {
          id: 'e1',
          contentType: 'article',
          status: 'draft',
          version: 1,
          fields: { title: { 'en-US': 'Pricing' }, section: { 'en-US': 'news' } },
        },
      ],
    }),
  ),
  contentTypeEntryCounts: vi.fn(async () => []),
  getSpaceAccess: vi.fn(async () => ({ spaceId: 's1', kind: 'user', ...access, bulkJobs: [] })),
  listSavedViews: vi.fn(async () => [...views]),
  createSavedView: vi.fn(async (input: Partial<SavedView>) => {
    const made = view({ ...input, id: 'v-new' });
    views.push(made);
    return made;
  }),
  updateSavedView: vi.fn(async (id: string, changes: Partial<SavedView>) => {
    const i = views.findIndex((v) => v.id === id);
    const { revision: _r, ...rest } = changes;
    const next = { ...(views[i] as SavedView), ...rest, revision: (views[i]?.revision ?? 0) + 1 };
    views[i] = next as SavedView;
    return next;
  }),
  deleteSavedView: vi.fn(async (id: string) => {
    views.splice(
      views.findIndex((v) => v.id === id),
      1,
    );
  }),
};
const runner = async (fn: () => Promise<void>) => {
  try {
    await fn();
  } catch {}
};
vi.mock('~/cms/lib/client-context', () => ({
  useClient: () => ({
    client,
    conn: { space: 's1', environment: 'main', locale: 'en-US' },
    busy: false,
    run: runner,
  }),
  useLocalRun: () => ({ busy: false, run: runner }),
}));
vi.mock('~/cms/lib/assistant', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/cms/lib/assistant')>()),
  useAssistantEdit: () => () => Promise.resolve(null),
}));

const { ToastProvider } = await import('~/cms/lib/toast');
const { EntriesList } = await import('~/cms/routes/EntriesList');

function view(over: Partial<SavedView> = {}): SavedView {
  return {
    id: 'v1',
    name: 'News',
    contentTypeApiId: 'article',
    visibility: 'personal',
    createdBy: 'ada',
    query: {},
    revision: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  views.length = 0;
  access.scopes = ['preview:read', 'content:manage'];
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
    {
      apiId: 'section',
      name: 'Section',
      type: 'Symbol',
      localized: false,
      required: false,
      position: 1,
    },
  ],
} as ContentType;

function Where() {
  return <output data-testid="search">{useLocation().search}</output>;
}

function setup(url = '/content/article') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const outlet = { types: [article], locales: ['en-US'], defaultLocale: 'en-US', reload() {} };
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter initialEntries={[url]}>
          <Routes>
            <Route path="/content" element={<Outlet context={outlet} />}>
              <Route
                path=":typeId"
                element={
                  <>
                    <EntriesList />
                    <Where />
                  </>
                }
              />
            </Route>
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const search = () => decodeURIComponent(screen.getByTestId('search').textContent ?? '');
const open = async (name: RegExp | string) => {
  const trigger = await screen.findByRole('button', { name }, { timeout: 5000 });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
};

describe('the entries list URL', () => {
  it('lists what a link says: its filters, sort, search and columns', async () => {
    setup('/content/article?fields.section[match]=ne&order=-fields.title&columns=section');
    await screen.findByRole('link', { name: 'Pricing' }, { timeout: 5000 });
    expect(client.listEntryPage).toHaveBeenLastCalledWith(
      'article',
      expect.objectContaining({
        filters: [{ field: 'section', op: 'match', value: 'ne' }],
        order: [{ field: 'title', direction: 'desc' }],
      }),
      undefined,
    );
    expect(screen.getByRole('columnheader', { name: 'Section' })).toBeTruthy();
    expect(screen.queryByRole('columnheader', { name: 'Status' })).toBeNull();
    expect(screen.getByRole('cell', { name: 'news' })).toBeTruthy();
  });

  it('writes a search and a column choice into the URL', async () => {
    setup();
    fireEvent.change(await screen.findByRole('searchbox', { name: 'Search entries' }), {
      target: { value: 'launch' },
    });
    await waitFor(() => expect(search()).toContain('query=launch'));
    await open('Columns');
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Section' }));
    await waitFor(() => expect(search()).toContain('columns=sys.status,sys.updatedAt,section'));
  });
});

describe('the views menu', () => {
  it('opens a view as its URL, and says when the list has moved off it', async () => {
    views.push(
      view({
        query: { filters: [{ field: 'section', op: 'eq', value: 'news' }] },
        columns: ['section'],
      }),
      view({ id: 'v2', name: 'Team picks', visibility: 'shared', createdBy: 'lead' }),
    );
    setup();
    await waitFor(() => expect(client.listSavedViews).toHaveBeenCalledWith('article'));
    await open('Views');
    expect(await screen.findByText('Your views')).toBeTruthy();
    expect(screen.getByText('Shared with the space')).toBeTruthy();
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'News' }));
    await waitFor(() => expect(search()).toBe('?view=v1&fields.section=news&columns=section'));
    await waitFor(() =>
      expect(client.listEntryPage).toHaveBeenLastCalledWith(
        'article',
        expect.objectContaining({ filters: [{ field: 'section', op: 'eq', value: 'news' }] }),
        undefined,
      ),
    );
    const trigger = screen.getByRole('button', { name: /^News/ });
    expect(trigger.textContent).not.toContain('edited');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search entries' }), {
      target: { value: 'x' },
    });
    await waitFor(() => expect(screen.getByRole('button', { name: /News.*edited/ })).toBeTruthy());

    // Save changes writes the list back over the view, at the revision read.
    await open(/News.*edited/);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Save changes to “News”' }));
    await waitFor(() =>
      expect(client.updateSavedView).toHaveBeenCalledWith('v1', {
        query: { filters: [{ field: 'section', op: 'eq', value: 'news' }], search: 'x' },
        columns: ['section'],
        revision: 1,
      }),
    );
  });

  it('saves the list as a new view, shared when asked, in the structured form', async () => {
    setup('/content/article?sys.status[in]=draft,changed&order=fields.title&columns=section');
    await open('Views');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Save as new view…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Save view' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Name' }), {
      target: { value: 'In progress' },
    });
    fireEvent.click(within(dialog).getByRole('switch', { name: 'Share with the space' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save view' }));
    await waitFor(() =>
      expect(client.createSavedView).toHaveBeenCalledWith({
        name: 'In progress',
        contentTypeApiId: 'article',
        visibility: 'shared',
        query: {
          filters: [{ field: 'sys.status', op: 'in', value: ['draft', 'changed'] }],
          order: [{ field: 'title', direction: 'asc' }],
        },
        columns: ['section'],
      }),
    );
    await waitFor(() => expect(search()).toContain('view=v-new'));
  });

  it('offers no sharing, and no changes to a shared view, without content:manage', async () => {
    access.scopes = ['preview:read'];
    views.push(view(), view({ id: 'v2', name: 'Team picks', visibility: 'shared' }));
    setup('/content/article?view=v2');
    await waitFor(() => expect(client.getSpaceAccess).toHaveBeenCalled());
    await open(/Team picks/);
    expect(screen.queryByRole('menuitem', { name: 'Rename…' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Stop sharing' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Delete view…' })).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Save as new view…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Save view' });
    expect(within(dialog).queryByRole('switch')).toBeNull();
  });

  it('renames, shares and deletes the open view', async () => {
    views.push(view());
    setup('/content/article?view=v1');
    await open(/^News/);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Share with the space' }));
    await waitFor(() =>
      expect(client.updateSavedView).toHaveBeenCalledWith('v1', {
        visibility: 'shared',
        revision: 1,
      }),
    );
    await screen.findByText('“News” is shared with everyone in the space');

    await open(/^News/);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Rename view' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Name' }), {
      target: { value: 'Newsroom' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Rename' }));
    await screen.findByText('Renamed to “Newsroom”');

    await open(/^Newsroom/);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete view…' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Delete “Newsroom”?' });
    expect(confirm.textContent).toContain('Everyone in the space loses this view');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Delete view' }));
    await waitFor(() => expect(client.deleteSavedView).toHaveBeenCalledWith('v1'));
    await waitFor(() => expect(search()).not.toContain('view='));
  });
});
