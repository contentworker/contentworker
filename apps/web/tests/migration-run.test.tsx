import type { MigrationRun } from '@contentworker/domain';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, MemoryRouter, Route, RouterProvider, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  type MigrationFetchResult,
  type MigrationPageQuery,
  type MigrationPageView,
  type MigrationRunView,
  type MigrationTemplateView,
} from '~/cms/lib/management';

/*
 * The run's page against a fake of its endpoints: a run of `total` pages that each fetch batch
 * reads `limit` of, and that clustering groups into one template. Each test sets what differs.
 */

const T0 = '2026-11-20T10:00:00.000Z';

const page = (i: number, over: Partial<MigrationPageView> = {}): MigrationPageView => ({
  id: `p${String(i).padStart(4, '0')}`,
  runId: 'run-1',
  url: `https://example.com/blog/post-${i}`,
  path: `/blog/post-${i}`,
  depth: 0,
  stage: 'discovered',
  templateId: null,
  title: `Post ${i}`,
  lastModified: null,
  httpStatus: null,
  html: null,
  output: null,
  outputScript: null,
  score: null,
  entryId: null,
  unresolvedLinks: 0,
  error: null,
  createdAt: T0,
  updatedAt: T0,
  ...over,
});

let state: { run: MigrationRun; pages: MigrationPageView[]; templates: MigrationTemplateView[] };

const viewOf = (): MigrationRunView => {
  const byStage: Record<string, number> = {};
  for (const p of state.pages) byStage[p.stage] = (byStage[p.stage] ?? 0) + 1;
  return {
    run: state.run,
    pages: {
      total: state.pages.length,
      fetched: state.pages.filter((p) => p.html).length,
      failed: state.pages.filter((p) => p.error).length,
      byStage,
    },
    templates: state.templates,
  };
};

function seed(status: MigrationRun['status'], total: number, fetched = 0) {
  state = {
    run: {
      id: 'run-1',
      name: 'example.com',
      source: {
        kind: 'sitemap',
        url: 'https://example.com/sitemap.xml',
        include: [],
        exclude: [],
        maxPages: 500,
      },
      status,
      threshold: 0.8,
      inventory:
        status === 'created'
          ? null
          : {
              discovered: total + 4,
              added: total,
              skipped: { robots: 3, filtered: 1, offOrigin: 0, overLimit: 0, invalid: 0 },
              warnings: [],
            },
      error: null,
      releaseId: null,
      clusteringHeldAt: null,
      version: 1,
      createdAt: T0,
      createdBy: null,
      updatedAt: T0,
    },
    pages: Array.from({ length: total }, (_, i) =>
      i < fetched ? page(i, { html: { sha256: 'ab', bytes: 2048 }, httpStatus: 200 }) : page(i),
    ),
    templates: [],
  };
}

/** One fetch batch: the first `limit` pages not read yet, read. */
const readBatch = (limit: number): MigrationFetchResult => {
  const waiting = state.pages.filter((p) => !p.html && !p.error).slice(0, limit);
  for (const p of waiting) {
    Object.assign(p, { html: { sha256: 'ab', bytes: 2048 }, httpStatus: 200 });
  }
  const more = state.pages.some((p) => !p.html && !p.error);
  return { fetched: waiting.length, failed: 0, added: 0, more };
};

const conflict = () =>
  new ApiError(409, 'POST … → 409', {
    error: { code: 'conflict', message: 'Another step wrote the run first', retryable: true },
  });
const unavailable = () =>
  new ApiError(503, 'POST … → 503', {
    error: {
      code: 'site_unavailable',
      message: 'The site can’t be read now: robots.txt answered 503',
      retryable: true,
    },
  });

const client = {
  getSpaceAccess: vi.fn(),
  getMigrationRun: vi.fn(async () => viewOf()),
  inventoryMigrationRun: vi.fn(async () => {
    state.run = { ...state.run, status: 'inventoried' };
    return state.run;
  }),
  fetchMigrationPages: vi.fn(
    async (_id: string, opts: { limit?: number } = {}, _signal?: AbortSignal) =>
      readBatch(opts.limit ?? 10),
  ),
  clusterMigrationRun: vi.fn(async () => {
    const ids = state.pages.filter((p) => p.html).map((p) => p.id);
    state.templates = [
      {
        id: 't1',
        runId: 'run-1',
        label: 'Blog post',
        status: 'pending',
        pageCount: ids.length,
        samplePageIds: [ids[0], ids[Math.floor(ids.length / 2)]].filter(Boolean) as string[],
        contentTypeId: null,
        script: null,
        proposal: null,
        lastTry: null,
        approvedBy: null,
        reviewDigest: 'd'.repeat(64),
        version: 1,
        createdAt: T0,
        updatedAt: T0,
      },
    ];
    for (const p of state.pages) {
      if (p.html) Object.assign(p, { stage: 'clustered', templateId: 't1' });
    }
    state.run = { ...state.run, status: 'clustered' };
    return viewOf();
  }),
  listMigrationPages: vi.fn(async (_id: string, q: MigrationPageQuery = {}) => {
    const all = state.pages.filter(
      (p) => (!q.stage || p.stage === q.stage) && (!q.template || p.templateId === q.template),
    );
    const from = q.cursor ? all.findIndex((p) => p.id === q.cursor) + 1 : 0;
    const items = all.slice(from, from + (q.limit ?? 50));
    const last = items.at(-1);
    return from + items.length < all.length && last ? { items, nextCursor: last.id } : { items };
  }),
};
vi.mock('~/cms/lib/client-context', () => ({
  useClient: () => ({
    client,
    conn: { space: 's', environment: 'main', locale: 'en-US' },
    ready: true,
  }),
}));

const { ToastProvider } = await import('~/cms/lib/toast');
const { MigrationRunPage } = await import('~/cms/routes/MigrationRun');

beforeEach(() => {
  client.getSpaceAccess.mockResolvedValue({ scopes: ['migration:run'], subject: 'me' });
});
afterEach(() => {
  vi.clearAllMocks();
});

function open(path = '/migrations/run-1') {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ToastProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/migrations/:runId" element={<MigrationRunPage />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

/** The page where a navigation waits, as it does in the app; `settle` lets what is waiting land. */
function openWaiting(path: string) {
  let release = () => {};
  let opened = false;
  const router = createMemoryRouter(
    [
      {
        path: '/migrations/:runId',
        element: <MigrationRunPage />,
        loader: async () => {
          if (opened) await new Promise<void>((resolve) => (release = resolve));
          opened = true;
          return null;
        },
        shouldRevalidate: () => true,
        HydrateFallback: () => null,
      },
    ],
    { initialEntries: [path] },
  );
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { router, settle: () => act(async () => release()) };
}

/** The value a filter shows. */
const picked = (label: string) =>
  (screen.getByLabelText(label) as unknown as { value: string }).value;

const steps = () => within(screen.getByRole('list', { name: 'Steps' }));
const button = (name: string) => steps().getByRole('button', { name });
const pagesTable = () => within(screen.getByRole('table', { name: 'Pages' }));

describe('a migration run', () => {
  it('waits on its inventory, and says why fetching and clustering wait', async () => {
    seed('created', 0);
    open();
    expect(await screen.findByRole('heading', { level: 1, name: 'example.com' })).toBeTruthy();
    expect(screen.getByText('https://example.com/sitemap.xml')).toBeTruthy();
    expect(screen.getByText('Created', { selector: '[data-slot=badge]' })).toBeTruthy();
    await waitFor(() => expect(button('Inventory')).toBeTruthy());
    const fetch = button('Fetch pages') as HTMLButtonElement;
    expect(fetch.disabled).toBe(true);
    const why = document.getElementById(fetch.getAttribute('aria-describedby') ?? '');
    expect(why?.textContent).toBe('Inventory the source first.');
    expect((button('Cluster') as HTMLButtonElement).disabled).toBe(true);
    expect(
      screen.getByText('No pages yet. The inventory lists the site’s pages here.'),
    ).toBeTruthy();
  });

  it('says a site it can’t read calmly, and tries again', async () => {
    seed('created', 0);
    client.inventoryMigrationRun.mockRejectedValueOnce(unavailable());
    open();
    await waitFor(() => expect(button('Inventory')).toBeTruthy());
    fireEvent.click(button('Inventory'));
    const notice = await screen.findByText('The site can’t be read right now');
    const alert = notice.closest('[data-slot=alert]') as HTMLElement;
    // Calm: the plain Alert, not the destructive one.
    expect(alert.className).not.toMatch(/text-destructive/);
    expect(within(alert).getByText(/robots.txt answered 503\. Nothing was written/)).toBeTruthy();
    // The title says the site can't be read; the body never says it again.
    expect(within(alert).queryByText(/can’t be read now/)).toBeNull();
    state.pages = Array.from({ length: 12 }, (_, i) => page(i));
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.queryByText('The site can’t be read right now')).toBeNull());
    expect(client.inventoryMigrationRun).toHaveBeenCalledTimes(2);
    // Focus goes on to the step that is next.
    await waitFor(() => expect(document.activeElement).toBe(button('Fetch until done')));
    expect(screen.getByText('The inventory finished.')).toBeTruthy();
  });

  it('sends a step that lost a race again without a word', async () => {
    seed('created', 0);
    client.inventoryMigrationRun.mockRejectedValueOnce(conflict());
    open();
    await waitFor(() => expect(button('Inventory')).toBeTruthy());
    fireEvent.click(button('Inventory'));
    await waitFor(() => expect(client.inventoryMigrationRun).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(button('Inventory again')).toBeTruthy());
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says a refusal without offering to try it again', async () => {
    seed('inventoried', 3, 3);
    client.clusterMigrationRun.mockRejectedValueOnce(
      new ApiError(400, 'POST … → 400', {
        error: {
          code: 'invalid_state',
          message: 'A template is already being authored or approved',
        },
      }),
    );
    open();
    await waitFor(() => expect(button('Cluster')).toBeTruthy());
    fireEvent.click(button('Cluster'));
    const alert = (await screen.findByText('Clustering didn’t finish')).closest(
      '[data-slot=alert]',
    ) as HTMLElement;
    expect(
      within(alert).getByText('A template is already being authored or approved'),
    ).toBeTruthy();
    expect(within(alert).queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('says a clustering the background run took on first, and keeps focus on the steps', async () => {
    seed('inventoried', 3, 3);
    client.clusterMigrationRun.mockImplementationOnce(async () => {
      state.run = {
        ...state.run,
        status: 'clustered',
        clusteringHeldAt: '2026-11-24T10:00:00.000Z',
      };
      throw new ApiError(400, 'POST … → 400', {
        error: { code: 'invalid_state', message: 'Taken on in the background' },
      });
    });
    open();
    await waitFor(() => expect(button('Cluster')).toBeTruthy());
    fireEvent.click(button('Cluster'));
    const alert = (await screen.findByText('Clustering didn’t finish')).closest(
      '[data-slot=alert]',
    ) as HTMLElement;
    expect(within(alert).getByText('Taken on in the background')).toBeTruthy();
    expect(within(alert).queryByRole('button', { name: 'Try again' })).toBeNull();
    await waitFor(() => expect((button('Cluster again') as HTMLButtonElement).disabled).toBe(true));
    expect(
      steps().getByText('A background run has taken the templates on, so the grouping is kept.'),
    ).toBeTruthy();
    await waitFor(() => expect(document.activeElement?.getAttribute('role')).toBe('status'));
  });

  it('fetches one bounded batch a press', async () => {
    seed('inventoried', 25);
    open();
    await waitFor(() => expect(button('Fetch pages')).toBeTruthy());
    fireEvent.click(button('Fetch pages'));
    await waitFor(() => expect(screen.getByText('Fetched 10 pages.')).toBeTruthy());
    expect(client.fetchMigrationPages).toHaveBeenCalledTimes(1);
    expect(client.fetchMigrationPages).toHaveBeenCalledWith('run-1', { limit: 10 });
    expect(steps().getByText('15 pages to fetch')).toBeTruthy();
  });

  it('tries a failed single fetch again as one batch, never as the whole loop', async () => {
    seed('inventoried', 25);
    client.fetchMigrationPages.mockRejectedValueOnce(new ApiError(502, 'POST … → 502'));
    open();
    await waitFor(() => expect(button('Fetch pages')).toBeTruthy());
    fireEvent.click(button('Fetch pages'));
    const alert = (await screen.findByText('Fetching stopped')).closest(
      '[data-slot=alert]',
    ) as HTMLElement;
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByText('Fetched 10 pages.')).toBeTruthy());
    expect(client.fetchMigrationPages).toHaveBeenCalledTimes(2);
  });

  it('fetches until done while the API says more, with its progress, then hands on to clustering', async () => {
    seed('inventoried', 25);
    let release: () => void = () => {};
    const first = client.fetchMigrationPages.getMockImplementation();
    client.fetchMigrationPages.mockImplementationOnce(
      (id, opts, signal) =>
        new Promise((resolve) => {
          release = () => resolve(first?.(id, opts, signal) as never);
        }),
    );
    open();
    await waitFor(() => expect(button('Fetch until done')).toBeTruthy());
    fireEvent.click(button('Fetch until done'));
    // While it runs: Stop has focus, and the bar says how far it has got.
    await waitFor(() => expect(document.activeElement).toBe(button('Stop')));
    expect(screen.getByRole('progressbar', { name: 'Fetch progress' })).toBeTruthy();
    await act(async () => release());
    await waitFor(() =>
      expect(screen.getByText('Fetched 25 pages. No pages are waiting.')).toBeTruthy(),
    );
    expect(client.fetchMigrationPages).toHaveBeenCalledTimes(3);
    expect(screen.queryByRole('progressbar')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(button('Cluster')));
  });

  it('stops fetching when asked, saying a batch under way may still finish', async () => {
    seed('inventoried', 25);
    client.fetchMigrationPages.mockImplementationOnce(
      (_id, _opts, signal) =>
        new Promise((_, reject) => {
          signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );
    open();
    await waitFor(() => expect(button('Fetch until done')).toBeTruthy());
    fireEvent.click(button('Fetch until done'));
    fireEvent.click(await waitFor(() => button('Stop')));
    expect(
      await screen.findByText(/^Stopped\. Fetched 0 pages\. A batch under way may still finish/),
    ).toBeTruthy();
    expect(client.fetchMigrationPages).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(button('Fetch until done')).toBeTruthy());
  });

  it('stops fetching calmly when the site can’t be read, having written nothing', async () => {
    seed('inventoried', 25);
    client.fetchMigrationPages.mockResolvedValueOnce({
      fetched: 0,
      failed: 0,
      added: 0,
      more: true,
      unavailable: 'robots.txt answered 500',
    });
    open();
    await waitFor(() => expect(button('Fetch until done')).toBeTruthy());
    fireEvent.click(button('Fetch until done'));
    expect(await screen.findByText('The site can’t be read right now')).toBeTruthy();
    expect(screen.getByText(/robots.txt answered 500\. Nothing was written/)).toBeTruthy();
    expect(client.fetchMigrationPages).toHaveBeenCalledTimes(1);
  });

  it('clusters into templates and narrows the pages to one, each page by its URL', async () => {
    seed('inventoried', 6, 6);
    open();
    await waitFor(() => expect(button('Cluster')).toBeTruthy());
    fireEvent.click(button('Cluster'));
    const heading = await screen.findByText('Templates', { selector: 'h2 span' });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    const templates = within(screen.getByRole('list', { name: 'Templates' }));
    expect(templates.getByText('Blog post')).toBeTruthy();
    expect(templates.getByText('Not authored')).toBeTruthy();
    expect(screen.getByText('Grouped 6 pages into 1 template.')).toBeTruthy();

    fireEvent.click(templates.getByRole('button', { name: 'Show pages of Blog post' }));
    await waitFor(() =>
      expect(client.listMigrationPages).toHaveBeenCalledWith('run-1', {
        template: 't1',
        limit: 50,
      }),
    );
    expect(screen.getByLabelText('Template')).toHaveProperty('value', 't1');
    // Each page is its live URL, never its HTML.
    const link = await within(screen.getByRole('table', { name: 'Pages' })).findByRole('link', {
      name: '/blog/post-0 (opens in a new tab)',
    });
    expect(link.getAttribute('href')).toBe('https://example.com/blog/post-0');
    expect(link.getAttribute('target')).toBe('_blank');
  });

  it('pages through its pages by stage, Load more handing focus to the first it brought', async () => {
    seed('inventoried', 60, 3);
    state.pages[1] = {
      ...(state.pages[1] as MigrationPageView),
      html: null,
      error: 'answered 404',
      httpStatus: 404,
    };
    open();
    expect(
      await waitFor(() =>
        pagesTable().getByRole('link', { name: '/blog/post-0 (opens in a new tab)' }),
      ),
    ).toBeTruthy();
    const failed = within(pagesTable().getByText('/blog/post-1').closest('tr') as HTMLElement);
    expect(failed.getByText('Failed')).toBeTruthy();
    expect(failed.getByText('answered 404')).toBeTruthy();
    expect(failed.getByText('404')).toBeTruthy();
    // A page is its facts: nothing of its HTML reaches the screen.
    expect(document.body.innerHTML).not.toContain('sha256');

    fireEvent.click(pagesTable().getByRole('button', { name: 'Load more' }));
    await waitFor(() =>
      expect(document.activeElement?.textContent).toBe('/blog/post-50 (opens in a new tab)'),
    );
    expect(client.listMigrationPages).toHaveBeenLastCalledWith('run-1', {
      limit: 50,
      cursor: 'p0049',
    });

    fireEvent.change(screen.getByLabelText('Stage'), { target: { value: 'clustered' } });
    expect(await screen.findByText('No pages match these filters.')).toBeTruthy();
    expect(client.listMigrationPages).toHaveBeenLastCalledWith('run-1', {
      stage: 'clustered',
      limit: 50,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(screen.queryByText('No pages match these filters.')).toBeNull());
    expect(document.activeElement).toBe(screen.getByLabelText('Stage'));
  });

  it('keeps a cleared template cleared when the stage is picked before the address catches up', async () => {
    seed('inventoried', 4, 4);
    await client.clusterMigrationRun();
    client.listMigrationPages.mockClear();
    const { router, settle } = openWaiting('/migrations/run-1?template=t1');
    const template = await screen.findByLabelText('Template');
    expect(picked('Template')).toBe('t1');

    fireEvent.change(template, { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Stage'), { target: { value: 'discovered' } });
    // Both show as picked at once, and neither undoes the other once the address has them.
    expect(picked('Template')).toBe('');
    expect(picked('Stage')).toBe('discovered');
    await settle();
    await waitFor(() => expect(router.state.location.search).toBe('?stage=discovered'));
    expect(client.listMigrationPages).toHaveBeenLastCalledWith('run-1', {
      stage: 'discovered',
      limit: 50,
    });

    // The address still has the last word: going elsewhere isn't held to what was picked.
    await act(async () => {
      void router.navigate('/migrations/run-1?template=t1');
    });
    await settle();
    await waitFor(() => expect(picked('Template')).toBe('t1'));
    expect(picked('Stage')).toBe('');
  });

  it('shows the steps without offering them to a role without migration:run', async () => {
    client.getSpaceAccess.mockResolvedValue({ scopes: ['content:manage'], subject: 'me' });
    seed('inventoried', 4);
    open();
    expect(
      await screen.findByText('Running a step takes migration:run. You can follow the run here.'),
    ).toBeTruthy();
    expect(steps().queryAllByRole('button')).toHaveLength(0);
  });

  it('keeps the run, and keeps fetching, when reading it again fails mid-loop', async () => {
    seed('inventoried', 25);
    open();
    await waitFor(() => expect(button('Fetch until done')).toBeTruthy());
    // Every read after the first fails: the counts can't be refreshed between batches.
    client.getMigrationRun.mockRejectedValue(new ApiError(500, 'GET … → 500', {}));
    fireEvent.click(button('Fetch until done'));
    await waitFor(() =>
      expect(screen.getByText('Fetched 25 pages. No pages are waiting.')).toBeTruthy(),
    );
    expect(client.fetchMigrationPages).toHaveBeenCalledTimes(3);
    expect(screen.getByRole('heading', { level: 1, name: 'example.com' })).toBeTruthy();
    expect(screen.queryByText('The run didn’t load')).toBeNull();
    expect(screen.getByText(/The counts couldn’t be read again/)).toBeTruthy();
    client.getMigrationRun.mockImplementation(async () => viewOf());
  });

  it('reads a template the run no longer has as no template filter', async () => {
    seed('inventoried', 6, 6);
    open('/migrations/run-1?template=gone');
    await waitFor(() => expect(pagesTable().getAllByRole('link')).toHaveLength(6));
    expect(client.listMigrationPages).not.toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({ template: 'gone' }),
    );
  });

  it('says a run that isn’t here, with the way back', async () => {
    seed('created', 0);
    client.getMigrationRun.mockRejectedValueOnce(new ApiError(404, 'GET … → 404'));
    open();
    expect(await screen.findByRole('heading', { level: 1, name: 'Run not found' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'All migrations' }).getAttribute('href')).toBe(
      '/migrations',
    );
  });
});
