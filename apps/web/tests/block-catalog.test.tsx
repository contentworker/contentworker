// @vitest-environment jsdom
import { type BlockCatalog, EMPTY_BLOCK_CONFIG, effectiveBlockRules } from '@contentworker/domain';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BlockCatalogUsage } from '~/cms/lib/management';

const field = (apiId: string, over: Record<string, unknown> = {}) => ({
  apiId,
  name: apiId[0]?.toUpperCase() + apiId.slice(1),
  type: 'Symbol',
  localized: false,
  required: false,
  position: 0,
  ...over,
});

const CATALOG: BlockCatalog = {
  version: 4,
  hash: 'abc',
  pushedAt: '2026-11-07T10:00:00.000Z',
  pushedBy: 'dev@example.com',
  targets: [{ contentTypeApiId: 'page', field: 'body' }],
  breakpoints: [],
  changes: { added: [], changed: [], removed: [], renamed: [] },
  blocks: [
    {
      id: 'banner',
      name: 'Banner',
      group: 'Headers',
      aliases: ['hero'],
      fields: [field('heading'), field('tone', { validations: { in: ['light', 'dark'] } })],
    },
    {
      id: 'grid',
      name: 'Grid',
      group: 'Layout',
      fields: [],
      slots: [{ apiId: 'items', name: 'Items', allowedChildren: ['card'], min: 1, max: 6 }],
    },
    {
      id: 'card',
      name: 'Card',
      group: 'Layout',
      fields: [field('title')],
      allowedParents: ['grid'],
    },
  ] as BlockCatalog['blocks'],
};

const USAGE: BlockCatalogUsage = {
  version: 4,
  scanned: 3,
  complete: true,
  blocks: [
    { id: 'banner', entries: 2, contentTypes: [{ contentTypeApiId: 'page', entries: 2 }] },
    { id: 'grid', entries: 0, contentTypes: [] },
    { id: 'card', entries: 0, contentTypes: [] },
  ],
};

const client = {
  getBlockCatalog: vi.fn<() => Promise<BlockCatalog | null>>(),
  getBlockUsage: vi.fn<() => Promise<BlockCatalogUsage>>(),
  listContentTypes: vi.fn(async () => [
    {
      apiId: 'page',
      name: 'Page',
      fields: [{ apiId: 'body', name: 'Page body', type: 'RichText' }],
    },
  ]),
  getTeam: vi.fn(async () => ({
    people: [{ id: 'dev@example.com', name: 'Dev Person', email: 'dev@example.com' }],
  })),
  // The rules section beside the catalog: unset, and read by someone who can't change them.
  getBlockConfig: vi.fn(async () => EMPTY_BLOCK_CONFIG),
  getEffectiveBlockRules: vi.fn(async () => effectiveBlockRules(CATALOG, EMPTY_BLOCK_CONFIG)),
  getSpaceAccess: vi.fn(async () => ({ subject: 'me', scopes: ['preview:read'] })),
  listAssets: vi.fn(async () => ({ items: [] as unknown[] })),
};
vi.mock('~/cms/lib/client-context', () => ({
  useClient: () => ({
    client,
    conn: { space: 's', environment: 'main', locale: 'en-US' },
    busy: false,
    run: (fn: () => Promise<void>) => fn(),
  }),
}));

const { Blocks, propSummary } = await import('~/cms/routes/Blocks');
const { ToastProvider } = await import('~/cms/lib/toast');

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function setup(catalog: BlockCatalog | null | Error, usage: BlockCatalogUsage | Error = USAGE) {
  if (catalog instanceof Error) client.getBlockCatalog.mockRejectedValue(catalog);
  else client.getBlockCatalog.mockResolvedValue(catalog);
  if (usage instanceof Error) client.getBlockUsage.mockRejectedValue(usage);
  else client.getBlockUsage.mockResolvedValue(usage);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <RouterProvider router={createMemoryRouter([{ path: '/', element: <Blocks /> }])} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const rowOf = async (name: string) => {
  const row = (await screen.findByText(name, { selector: 'span' })).closest('li');
  if (!row) throw new Error(`no row for ${name}`);
  return within(row);
};

describe('the block catalog screen', () => {
  it('explains how to push blocks when none are there yet', async () => {
    setup(null);
    expect(await screen.findByText('No blocks pushed yet')).toBeTruthy();
    expect(screen.getByText(/contentworker\.blocks\.json/, { selector: 'code' })).toBeTruthy();
    expect(screen.getByLabelText('Example contentworker.blocks.json').textContent).toContain(
      '"targets"',
    );
    expect(screen.getByLabelText('Push command').textContent).toContain('blocks push --dry-run');
    expect(screen.getAllByRole('button', { name: 'Copy' })).toHaveLength(2);
    // Nothing to count before there is a catalog.
    expect(client.getBlockUsage).not.toHaveBeenCalled();
  });

  it('points the example at a placeholder, and says what a target must be, without a blocks field', async () => {
    setup(null);
    const example = await screen.findByLabelText('Example contentworker.blocks.json');
    expect(example.textContent).toContain(
      '{ "contentTypeApiId": "YOUR_CONTENT_TYPE", "field": "YOUR_BLOCKS_FIELD" }',
    );
    expect(await screen.findByText(/Replace the target with a Blocks field/)).toBeTruthy();
    expect(screen.getByRole('link', { name: /Blocks from code guide/ }).getAttribute('href')).toBe(
      'https://docs.contentworker.app/guides/blocks-from-code/',
    );
  });

  it('prefills the example with the first blocks field in the space', async () => {
    client.listContentTypes.mockResolvedValueOnce([
      {
        apiId: 'article',
        name: 'Article',
        fields: [{ apiId: 'body', name: 'Body', type: 'RichText' }],
      },
      {
        apiId: 'landing',
        name: 'Landing page',
        fields: [
          { apiId: 'title', name: 'Title', type: 'Symbol' },
          {
            apiId: 'sections',
            name: 'Sections',
            type: 'Array',
            items: { type: 'Component', variants: [{ apiId: 'x', name: 'X', fields: [] }] },
          },
        ],
      },
    ] as never);
    setup(null);
    expect(await screen.findByText(/The example fills Landing page › Sections/)).toBeTruthy();
    expect(screen.getByLabelText('Example contentworker.blocks.json').textContent).toContain(
      '{ "contentTypeApiId": "landing", "field": "sections" }',
    );
    expect(screen.queryByText(/Replace the target/)).toBeNull();
  });

  it('offers to try again when the catalog can’t be loaded', async () => {
    setup(new Error('boom'));
    expect(await screen.findByText('The block catalog couldn’t be loaded')).toBeTruthy();
    client.getBlockCatalog.mockResolvedValue(CATALOG);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Banner', { selector: 'span' })).toBeTruthy();
  });

  it('says a count is unknown when usage can’t be read', async () => {
    setup(CATALOG, new Error('boom'));
    const banner = await rowOf('Banner');
    expect(await banner.findByText('Unknown')).toBeTruthy();
  });

  it('leads a block’s row with its asset thumbnail, and the others with the block tile', async () => {
    client.listAssets.mockResolvedValueOnce({
      items: [
        {
          id: 'a-banner',
          status: 'published',
          file: {
            url: '/media/banner.png?sig=1',
            fileName: 'banner.png',
            contentType: 'image/png',
          },
          title: {},
          description: {},
          metadata: { altText: {}, tags: [] },
        },
      ],
    });
    const withThumbnails = {
      ...CATALOG,
      blocks: CATALOG.blocks.map((b) =>
        b.id === 'banner'
          ? { ...b, thumbnail: { assetId: 'a-banner' } }
          : b.id === 'grid'
            ? { ...b, thumbnail: { url: 'https://cdn.example/grid.png' } }
            : b,
      ),
    } as BlockCatalog;
    setup(withThumbnails);
    const banner = (await screen.findByText('Banner', { selector: 'span' })).closest('li');
    const pic = await waitFor(() => {
      const img = banner?.querySelector('img');
      if (!img) throw new Error('no thumbnail yet');
      return img;
    });
    expect(pic.getAttribute('src')).toBe('/media/banner.png?sig=1');
    expect(pic.getAttribute('alt')).toBe('');
    // A url thumbnail isn't drawn: the row keeps the block tile.
    const grid = (await screen.findByText('Grid', { selector: 'span' })).closest('li');
    expect(grid?.querySelector('img')).toBeNull();
    expect(grid?.querySelector('[data-slot="catalog-tile"]')).toBeTruthy();
    expect(client.listAssets).toHaveBeenCalledTimes(1);
    expect(client.listAssets).toHaveBeenCalledWith({ ids: ['a-banner'], limit: 1 });
    // A failed load is the tile again, never a broken image.
    fireEvent.error(pic);
    expect(banner?.querySelector('img')).toBeNull();
    expect(banner?.querySelector('[data-slot="catalog-tile"]')).toBeTruthy();
  });

  it('draws one list named Blocks, without a heading, when nothing is grouped', async () => {
    const ungrouped = {
      ...CATALOG,
      blocks: CATALOG.blocks.map(({ group: _g, ...b }) => b),
    } as BlockCatalog;
    setup(ungrouped);
    await rowOf('Banner');
    expect(screen.getByRole('list', { name: 'Blocks' })).toBeTruthy();
    expect(screen.queryByRole('heading', { level: 3 })).toBeNull();
  });

  it('lists each block with its id, props, slots, placement, former ids and usage', async () => {
    setup(CATALOG);
    const banner = await rowOf('Banner');
    expect(banner.getByText('banner')).toBeTruthy();
    expect(banner.getByText('Props: Heading (Symbol), Tone (light | dark)')).toBeTruthy();
    expect(banner.getByText('Formerly hero')).toBeTruthy();
    expect(await banner.findByText('Used on Page (2 entries)')).toBeTruthy();
    expect(banner.getByText('2')).toBeTruthy();

    const grid = await rowOf('Grid');
    expect(grid.getByText('Slot Items takes Card (1–6)')).toBeTruthy();
    expect(grid.getByText('No props')).toBeTruthy();
    expect((await rowOf('Card')).getByText('Only inside Grid')).toBeTruthy();

    // The catalog's version, who pushed it and where its blocks go.
    expect(screen.getByText('v4')).toBeTruthy();
    expect(await screen.findByText(/by Dev Person/)).toBeTruthy();
    expect(screen.getByText('Page › Page body', { selector: 'dd' })).toBeTruthy();
    // Grouped as the dock will group them.
    expect(screen.getByRole('list', { name: 'Headers' })).toBeTruthy();
    expect(
      within(screen.getByRole('list', { name: 'Layout' })).getAllByRole('listitem'),
    ).toHaveLength(2);
  });

  it('says a usage count is a lower bound when the count did not read every entry', async () => {
    setup(CATALOG, { ...USAGE, complete: false });
    const banner = await rowOf('Banner');
    expect(await banner.findByText('at least 2')).toBeTruthy();
  });

  it('filters by name, id or group, with the way out when nothing matches', async () => {
    setup(CATALOG);
    await rowOf('Banner');
    const search = screen.getByRole('searchbox', { name: 'Filter blocks' });
    fireEvent.change(search, { target: { value: 'layout' } });
    expect(screen.queryByText('Banner', { selector: 'span' })).toBeNull();
    expect(screen.getByText('Grid', { selector: 'span' })).toBeTruthy();
    fireEvent.change(search, { target: { value: 'nothing' } });
    expect(screen.getByText(/No block matches/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(screen.getByText('Banner', { selector: 'span' })).toBeTruthy();
  });

  it('summarizes a list prop by its element type', () => {
    expect(
      propSummary({ ...field('tags'), type: 'Array', items: { type: 'Symbol' } } as never),
    ).toBe('Tags (list of Symbol)');
  });
});
