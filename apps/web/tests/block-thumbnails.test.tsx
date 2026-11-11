// @vitest-environment jsdom
// Block thumbnails where the admin lists catalog blocks to pick: an `{ assetId }` thumbnail is
// drawn from the asset's same-origin URL, read with every other one in one lookup; a `{ url }`
// one, a missing asset and a failed load leave the block its name. The picture is decorative.
import type { Asset, BlockCatalog } from '@contentworker/domain';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssetListQuery, AssetPage } from '~/cms/lib/management';
import { catalog as baseCatalog, tree } from './canvas-fixture';

const image = (id: string, url: string, contentType = 'image/png'): Asset =>
  ({
    id,
    status: 'published',
    file: { url, fileName: `${id}.png`, contentType },
    title: {},
    description: {},
    metadata: { altText: {}, tags: [] },
  }) as Asset;

const client = {
  listAssets: vi.fn<(q: AssetListQuery) => Promise<AssetPage>>(),
};
vi.mock('~/cms/lib/client-context', () => ({
  useClient: () => ({ client, conn: { space: 's', environment: 'main', locale: 'en-US' } }),
}));

const { Dock } = await import('~/cms/components/canvas/Dock');
const { thumbnailAssetIds } = await import('~/cms/lib/block-thumbnails');

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** The fixture's catalog: hero names an asset, cta a URL, section an asset that's gone. */
const CATALOG = {
  ...baseCatalog,
  blocks: baseCatalog.blocks.map((b) =>
    b.id === 'hero'
      ? { ...b, thumbnail: { assetId: 'a-hero' } }
      : b.id === 'cta'
        ? { ...b, thumbnail: { url: 'https://cdn.example/cta.png' } }
        : b.id === 'section'
          ? { ...b, thumbnail: { assetId: 'a-gone' } }
          : b,
  ),
} as BlockCatalog;

function renderDock(catalog: BlockCatalog) {
  const slot = tree()[0];
  if (!slot) throw new Error('no slot');
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <Dock place={{ slot, index: 0 }} catalog={catalog} onInsert={() => {}} onClose={() => {}} />
    </QueryClientProvider>,
  );
  return screen.getByRole('region', { name: /^Add to/ });
}

const card = (dock: HTMLElement, id: string) =>
  dock.querySelector<HTMLElement>(`[data-dock-item="${id}"]`) as HTMLElement;

describe('block thumbnails in the dock', () => {
  it('draws an asset thumbnail, decorative, and leaves a url one and a missing asset their name', async () => {
    client.listAssets.mockResolvedValue({ items: [image('a-hero', '/media/hero.png?sig=1')] });
    const dock = renderDock(CATALOG);

    const pic = await waitFor(() => {
      const img = card(dock, 'hero').querySelector('img');
      if (!img) throw new Error('no thumbnail yet');
      return img;
    });
    expect(pic.getAttribute('src')).toBe('/media/hero.png?sig=1');
    expect(pic.getAttribute('alt')).toBe('');
    // The card is still named by the block, and the dock's one tab stop is unchanged.
    expect(within(dock).getByRole('button', { name: /^Hero banner/ })).toBe(card(dock, 'hero'));
    const stops = [...dock.querySelectorAll<HTMLElement>('[data-dock-item]')].filter(
      (b) => b.tabIndex === 0,
    );
    expect(stops).toHaveLength(1);
    // Not drawn: a URL on the developer's host (CSP), and an asset the lookup didn't find.
    expect(card(dock, 'cta').querySelector('img')).toBeNull();
    expect(card(dock, 'section').querySelector('img')).toBeNull();
    expect(card(dock, 'cta').textContent).toBe('Call to action');

    // One lookup for every asset the catalog names, never one per block.
    expect(client.listAssets).toHaveBeenCalledTimes(1);
    expect(client.listAssets).toHaveBeenCalledWith({ ids: ['a-gone', 'a-hero'], limit: 2 });
  });

  it('falls back to the name when the picture fails to load', async () => {
    client.listAssets.mockResolvedValue({ items: [image('a-hero', '/media/expired.png')] });
    const dock = renderDock(CATALOG);
    const pic = await waitFor(() => {
      const img = card(dock, 'hero').querySelector('img');
      if (!img) throw new Error('no thumbnail yet');
      return img;
    });
    act(() => fireEvent.error(pic));
    expect(card(dock, 'hero').querySelector('img')).toBeNull();
    expect(card(dock, 'hero').textContent).toBe('Hero bannerA big opening');
  });

  it('draws a deployment’s absolute /media/ URL from this origin, and never a video poster', async () => {
    client.listAssets.mockResolvedValue({
      items: [
        image('a-hero', 'https://api.example.com/media/sp/main/a-hero/f?exp=1&sig=x'),
        {
          ...image(
            'a-gone',
            'https://videodelivery.example/x/thumbnails/thumbnail.jpg',
            'video/mp4',
          ),
          file: {
            url: '',
            fileName: 'v.mp4',
            contentType: 'video/mp4',
            video: { thumbnailUrl: 'https://videodelivery.example/x/thumbnails/thumbnail.jpg' },
          },
        } as unknown as Asset,
      ],
    });
    const dock = renderDock(CATALOG);
    const pic = await waitFor(() => {
      const img = card(dock, 'hero').querySelector('img');
      if (!img) throw new Error('no thumbnail yet');
      return img;
    });
    // The signature covers the path and query, so the gateway's same-origin path is the same read.
    expect(pic.getAttribute('src')).toBe('/media/sp/main/a-hero/f?exp=1&sig=x');
    // The video's poster is on another origin: the card holds the picture's place, and no <img>.
    expect(card(dock, 'section').querySelector('img')).toBeNull();
    expect(card(dock, 'section').querySelector('span[aria-hidden="true"]')).toBeTruthy();
  });

  it('leaves names alone when the lookup fails, or the asset is not an image', async () => {
    client.listAssets.mockRejectedValueOnce(new Error('boom'));
    let dock = renderDock(CATALOG);
    await waitFor(() => expect(client.listAssets).toHaveBeenCalledTimes(1));
    expect(dock.querySelector('img')).toBeNull();
    cleanup();

    client.listAssets.mockResolvedValue({
      items: [image('a-hero', '/media/brief.pdf', 'application/pdf')],
    });
    dock = renderDock(CATALOG);
    await waitFor(() => expect(client.listAssets).toHaveBeenCalledTimes(2));
    expect(dock.querySelector('img')).toBeNull();
  });

  it('makes no lookup for a catalog without asset thumbnails', () => {
    renderDock(baseCatalog);
    expect(client.listAssets).not.toHaveBeenCalled();
  });

  it('reads a large catalog’s assets 100 ids a call', async () => {
    client.listAssets.mockResolvedValue({ items: [] });
    const many = {
      ...CATALOG,
      blocks: [
        ...CATALOG.blocks,
        ...Array.from({ length: 150 }, (_, i) => ({
          id: `extra-${i}`,
          name: `Extra ${i}`,
          fields: [],
          thumbnail: { assetId: `a-${String(i).padStart(3, '0')}` },
        })),
      ],
    } as BlockCatalog;
    expect(thumbnailAssetIds(many)).toHaveLength(152);
    renderDock(many);
    await waitFor(() => expect(client.listAssets).toHaveBeenCalledTimes(2));
    const sizes = client.listAssets.mock.calls.map(([q]) => q.ids?.length);
    expect(sizes).toEqual([100, 52]);
  });
});
