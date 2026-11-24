import type { MigrationRun } from '@contentworker/domain';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type MigrationRunView } from '~/cms/lib/management';

const run = (id: string, name: string, over: Partial<MigrationRun> = {}): MigrationRun => ({
  id,
  name,
  source: {
    kind: 'sitemap',
    url: `https://${name}/sitemap.xml`,
    include: [],
    exclude: [],
    maxPages: 500,
  },
  status: 'inventoried',
  threshold: 0.8,
  inventory: null,
  error: null,
  releaseId: null,
  clusteringHeldAt: null,
  version: 1,
  createdAt: new Date(Date.now() - 3 * 60_000).toISOString(),
  createdBy: null,
  updatedAt: new Date().toISOString(),
  ...over,
});

const client = {
  getSpaceAccess: vi.fn(),
  listMigrationRuns: vi.fn<() => Promise<MigrationRun[]>>(),
  getMigrationRun: vi.fn<(id: string) => Promise<MigrationRunView>>(),
  createMigrationRun: vi.fn(),
};
vi.mock('~/cms/lib/client-context', () => ({
  useClient: () => ({
    client,
    conn: { space: 's', environment: 'main', locale: 'en-US' },
    ready: true,
  }),
}));

const { ToastProvider } = await import('~/cms/lib/toast');
const { Migrations } = await import('~/cms/routes/Migrations');

afterEach(() => {
  vi.clearAllMocks();
});

function setup({ scopes, runs = [] }: { scopes: string[]; runs?: MigrationRun[] }) {
  client.getSpaceAccess.mockResolvedValue({ scopes, subject: 'me' });
  client.listMigrationRuns.mockResolvedValue(runs);
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ToastProvider>
        <MemoryRouter initialEntries={['/migrations']}>
          <Routes>
            <Route path="/migrations" element={<Migrations />} />
            <Route path="/migrations/:runId" element={<p>Run page</p>} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('migrations list', () => {
  it('explains a migration where there are none, and offers to start one', async () => {
    setup({ scopes: ['space:admin'] });
    expect(await screen.findByText('No migrations yet')).toBeTruthy();
    expect(screen.getByText(/brings a published website in as structured content/)).toBeTruthy();
    // space:admin implies migration:run, as the API resolves it.
    fireEvent.click(screen.getByRole('button', { name: 'Migrate a website' }));
    expect(await screen.findByRole('dialog', { name: 'Migrate a website' })).toBeTruthy();
  });

  it('shows content:manage the runs, with nothing to start', async () => {
    setup({ scopes: ['content:manage'], runs: [run('r1', 'example.com')] });
    expect(await screen.findByRole('link', { name: 'example.com' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'New migration' })).toBeNull();
    expect(screen.getByText(/Starting one, or a step of one, takes migration:run/)).toBeTruthy();
  });

  it('shows nothing of the runs to a role that can open neither', async () => {
    setup({ scopes: ['content:write'], runs: [run('r1', 'example.com')] });
    expect(
      await screen.findByText(/reading them takes migration:run or content:manage/),
    ).toBeTruthy();
    // The runs aren't shown, whatever the read before the role was known brought.
    expect(screen.queryByRole('link', { name: 'example.com' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'New migration' })).toBeNull();
  });

  it('lists each run with its source, kind and status, from the list alone', async () => {
    setup({
      scopes: ['migration:run'],
      runs: [
        run('r1', 'example.com'),
        run('r2', 'docs.example.org', {
          status: 'failed',
          source: {
            kind: 'crawl',
            url: 'https://docs.example.org/',
            include: [],
            exclude: [],
            maxPages: 50,
          },
        }),
      ],
    });
    const row = within(
      (await screen.findByRole('link', { name: 'example.com' })).closest('li') as HTMLElement,
    );
    expect(row.getByText('https://example.com/sitemap.xml')).toBeTruthy();
    expect(row.getByText('Sitemap')).toBeTruthy();
    expect(row.getByText('Inventoried')).toBeTruthy();
    expect(row.getByText(/Created/).textContent).toMatch(/3m ago/);
    // A row is the run's own record: the list never reads each run again to count its pages.
    expect(client.getMigrationRun).not.toHaveBeenCalled();
    const failed = within(
      screen.getByRole('link', { name: 'docs.example.org' }).closest('li') as HTMLElement,
    );
    expect(failed.getByText('Link crawl')).toBeTruthy();
    expect(failed.getByText('Failed', { selector: '[data-slot=badge]' })).toBeTruthy();
  });
});

describe('a new run', () => {
  async function openForm() {
    setup({ scopes: ['migration:run'], runs: [run('r1', 'example.com')] });
    fireEvent.click(await screen.findByRole('button', { name: 'New migration' }));
    return within(await screen.findByRole('dialog', { name: 'Migrate a website' }));
  }

  it('says the API’s refusal of the source URL beside the field, and takes focus there', async () => {
    client.createMigrationRun.mockRejectedValueOnce(
      new ApiError(422, 'POST … → 422', {
        error: {
          code: 'validation_failed',
          message: 'Invalid',
          issues: [
            {
              field: 'source.url',
              message: 'must not target a loopback, link-local, or private address',
            },
          ],
        },
      }),
    );
    const sheet = await openForm();
    const url = sheet.getByLabelText('Sitemap or site URL');
    fireEvent.change(url, { target: { value: 'http://localhost:8000/sitemap.xml' } });
    fireEvent.click(sheet.getByRole('button', { name: 'Create run' }));
    const said = await sheet.findByText(
      'must not target a loopback, link-local, or private address',
    );
    expect(url.getAttribute('aria-invalid')).toBe('true');
    expect(url.getAttribute('aria-describedby')).toBe(said.id);
    expect(document.activeElement).toBe(url);
    // A refusal: nothing was made, so the button doesn't ask to create again.
    expect(sheet.getByRole('button', { name: 'Create run' })).toBeTruthy();
  });

  it('asks for a URL before sending anything', async () => {
    const sheet = await openForm();
    fireEvent.click(sheet.getByRole('button', { name: 'Create run' }));
    expect(await sheet.findByText('Enter the sitemap’s or the site’s URL.')).toBeTruthy();
    expect(client.createMigrationRun).not.toHaveBeenCalled();
  });

  it('sends the source as typed, a crawl’s globs a line each, and opens the run', async () => {
    client.createMigrationRun.mockResolvedValueOnce(run('r9', 'example.com'));
    const sheet = await openForm();
    fireEvent.click(sheet.getByRole('radio', { name: 'Link crawl' }));
    fireEvent.change(sheet.getByLabelText('Start page'), {
      target: { value: ' https://example.com/ ' },
    });
    fireEvent.change(sheet.getByLabelText(/^Include paths/), {
      target: { value: '/blog/**\n\n/news/*' },
    });
    fireEvent.change(sheet.getByLabelText(/^Exclude paths/), { target: { value: '/tag/**' } });
    fireEvent.change(sheet.getByLabelText('Most pages'), { target: { value: '40' } });
    fireEvent.click(sheet.getByRole('button', { name: 'Create run' }));
    expect(await screen.findByText('Run page')).toBeTruthy();
    expect(client.createMigrationRun).toHaveBeenCalledWith({
      source: {
        kind: 'crawl',
        url: 'https://example.com/',
        include: ['/blog/**', '/news/*'],
        exclude: ['/tag/**'],
        maxPages: 40,
      },
    });
  });

  it('offers to create again when a create may have landed', async () => {
    client.createMigrationRun.mockRejectedValueOnce(new ApiError(502, 'POST … → 502'));
    const sheet = await openForm();
    fireEvent.change(sheet.getByLabelText('Sitemap or site URL'), {
      target: { value: 'https://example.com/' },
    });
    fireEvent.click(sheet.getByRole('button', { name: 'Create run' }));
    expect(await sheet.findByRole('button', { name: 'Create again' })).toBeTruthy();
    // The list behind the sheet is read again: the run may be in it.
    await waitFor(() => expect(client.listMigrationRuns).toHaveBeenCalledTimes(2));
  });
});
