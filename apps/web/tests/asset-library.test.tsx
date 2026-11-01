// @vitest-environment jsdom
import type { Asset, AssetFolder, Tag } from '@contentworker/domain';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

const asset = (
  over: Omit<Partial<Asset>, 'file'> & { file?: Partial<Asset['file']> } = {},
): Asset => ({
  id: over.id ?? 'a1',
  status: over.status ?? 'draft',
  title: {},
  description: {},
  metadata: { altText: {}, tags: [] },
  ...over,
  file: {
    url: 'https://cdn.example/photo.jpg',
    fileName: 'photo.jpg',
    contentType: 'image/jpeg',
    ...over.file,
  },
});

const folder = (id: string, name: string): AssetFolder => ({
  id,
  name,
  path: `/${id}/`,
  createdAt: '',
  updatedAt: '',
});

let assets: Asset[] = [];
let folders: AssetFolder[] = [];
const tags: Tag[] = [{ id: 't1', name: 'Hero' } as Tag];
const client = {
  listAssets: vi.fn(
    async (_q?: unknown) => ({ items: assets }) as { items: Asset[]; nextCursor?: string },
  ),
  listAssetFolders: vi.fn(async () => folders),
  createAssetFolder: vi.fn(async (input: { name: string }) => folder('new', input.name)),
  updateAssetFolder: vi.fn(),
  deleteAssetFolder: vi.fn(),
  listTags: vi.fn(async () => tags),
  listContentTypes: vi.fn(async () => [
    { apiId: 'page', name: 'Page', displayField: 'title', fields: [] },
  ]),
  getEntry: vi.fn(async (id: string) => ({
    id,
    contentType: 'page',
    fields: { title: { 'en-US': 'Home page' } },
  })),
  assetUsage: vi.fn(async () => []),
  publishAsset: vi.fn(async () => ({})),
  unpublishAsset: vi.fn(async () => ({})),
  archiveAsset: vi.fn(async () => ({})),
  restoreAsset: vi.fn(async () => ({})),
  deleteAsset: vi.fn(async () => undefined),
  moveAssets: vi.fn(async (ids: string[]) => ({ moved: ids.length })),
  refreshVideoAsset: vi.fn(),
  uploadAsset: vi.fn(async (..._args: unknown[]) => asset()),
  uploadVideo: vi.fn(),
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
const { AssetLibrary } = await import('~/cms/components/AssetLibrary');
const { ApiError } = await import('~/cms/lib/management');

afterEach(() => {
  vi.clearAllMocks();
  assets = [];
  folders = [];
  try {
    localStorage.clear();
  } catch {}
});

const renderLibrary = () =>
  render(
    <MemoryRouter>
      <QueryClientProvider client={new QueryClient()}>
        <ToastProvider>
          <AssetLibrary locale="en-US" />
        </ToastProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );

const lastQuery = () => client.listAssets.mock.calls.at(-1)?.[0];

describe('asset unpublish', () => {
  it('offers an Undo that republishes the asset', async () => {
    assets = [
      asset({
        status: 'published',
        title: { 'en-US': 'Hero image' },
        file: { fileName: 'hero.png', contentType: 'application/pdf', url: 'http://x/hero.png' },
      }),
    ];
    renderLibrary();
    fireEvent.click(await screen.findByRole('button', { name: 'Unpublish “Hero image”' }));
    await waitFor(() => expect(client.unpublishAsset).toHaveBeenCalledWith('a1'));
    expect(await screen.findByText('Unpublished “Hero image”')).toBeTruthy();
    expect(client.publishAsset).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(client.publishAsset).toHaveBeenCalledWith('a1'));
  });
});

describe('AssetLibrary', () => {
  it('is titled Assets', async () => {
    renderLibrary();
    expect(screen.getByRole('heading', { level: 1, name: 'Assets' })).toBeTruthy();
  });

  it('swaps a broken image for a file-type fallback tile with the file name', async () => {
    assets = [asset()];
    renderLibrary();
    const img = await screen.findByRole('img', { name: 'photo.jpg' });
    expect(screen.queryByTestId('asset-fallback')).toBeNull();
    fireEvent.error(img);
    const tile = screen.getByTestId('asset-fallback');
    expect(within(tile).getByText('photo.jpg')).toBeTruthy();
    expect(screen.queryByRole('img', { name: 'photo.jpg' })).toBeNull();
  });

  it('shows the fallback tile for non-visual files', async () => {
    assets = [
      asset({ file: { fileName: 'report.pdf', contentType: 'application/pdf', url: 'x' } }),
    ];
    renderLibrary();
    expect(
      within(await screen.findByTestId('asset-fallback')).getByText('report.pdf'),
    ).toBeTruthy();
  });

  it('makes each card a real, named button that opens the detail sheet', async () => {
    assets = [asset()];
    renderLibrary();
    const open = await screen.findByRole('button', { name: 'Open “photo.jpg”' });
    // A native <button>: focusable, Enter/Space-activatable, announced as a button.
    expect(open.tagName).toBe('BUTTON');
    expect(open.getAttribute('type')).toBe('button');
    // Publish is a sibling control, not nested inside the open button.
    expect(within(open).queryByRole('button')).toBeNull();
    expect(screen.getByRole('button', { name: 'Publish “photo.jpg”' })).toBeTruthy();
    open.focus();
    expect(document.activeElement).toBe(open);
    fireEvent.click(open);
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });

  it('exposes tag toggles as pressed/unpressed buttons', async () => {
    assets = [asset({ metadata: { altText: {}, tags: ['t1'] } })];
    renderLibrary();
    fireEvent.click(await screen.findByRole('button', { name: 'Open “photo.jpg”' }));
    const tag = await screen.findByRole('button', { name: 'Hero' });
    expect(tag.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(tag);
    expect(tag.getAttribute('aria-pressed')).toBe('false');
  });

  it('shows a hosted video with its poster and processing status', async () => {
    assets = [
      asset({
        file: {
          fileName: 'intro.mp4',
          contentType: 'video/mp4',
          url: '',
          video: {
            provider: 'stream',
            videoId: 'v1',
            status: 'processing',
            thumbnailUrl: 'https://cdn.example/poster.jpg',
          },
        },
      }),
    ];
    renderLibrary();
    expect((await screen.findByRole('img', { name: 'intro.mp4' })).getAttribute('src')).toBe(
      'https://cdn.example/poster.jpg',
    );
    expect(screen.getByText('Processing')).toBeTruthy();
  });

  it('uploads video files to the video host, falling back to a blob upload on 501', async () => {
    client.uploadVideo.mockRejectedValueOnce(new ApiError(501, 'not configured'));
    renderLibrary();
    const input = screen.getByLabelText('Upload asset files') as HTMLInputElement;
    const file = new File(['x'], 'clip.mp4', { type: 'video/mp4' });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(client.uploadAsset).toHaveBeenCalledWith(file, {}));
    expect(client.uploadVideo).toHaveBeenCalledWith(file);
  });
});

describe('finding assets', () => {
  it('asks the API for what the filter bar and the folder tree say', async () => {
    folders = [folder('f1', 'Campaigns')];
    renderLibrary();
    await waitFor(() => expect(lastQuery()).toEqual({ limit: 50 }));

    fireEvent.change(screen.getByRole('combobox', { name: 'Kind' }), {
      target: { value: 'image' },
    });
    await waitFor(() => expect(lastQuery()).toEqual({ limit: 50, kind: 'image' }));

    fireEvent.change(screen.getByRole('combobox', { name: 'Status' }), {
      target: { value: 'archived' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Sort by' }), {
      target: { value: 'size-desc' },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Campaigns' }));
    await waitFor(() =>
      expect(lastQuery()).toEqual({
        limit: 50,
        folder: 'f1',
        kind: 'image',
        status: 'archived',
        sort: 'size',
        order: 'desc',
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Not in a folder' }));
    await waitFor(() => expect(lastQuery()).toMatchObject({ folder: 'root' }));
    expect(
      screen.getByRole('button', { name: 'Not in a folder' }).getAttribute('aria-current'),
    ).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() =>
      expect(lastQuery()).toEqual({ limit: 50, folder: 'root', sort: 'size', order: 'desc' }),
    );
  });

  it('loads the next page with the cursor the last one returned', async () => {
    client.listAssets.mockImplementation(async (q?: unknown) =>
      (q as { cursor?: string } | undefined)?.cursor === 'c2'
        ? { items: [asset({ id: 'a2', file: { fileName: 'second.jpg' } })] }
        : { items: [asset()], nextCursor: 'c2' },
    );
    renderLibrary();
    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    expect(await screen.findByRole('button', { name: 'Open “second.jpg”' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open “photo.jpg”' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
    client.listAssets.mockImplementation(async () => ({ items: assets }));
  });

  it('switches to a list and remembers it', async () => {
    assets = [asset({ file: { size: 2048 } })];
    renderLibrary();
    await screen.findByRole('button', { name: 'Open “photo.jpg”' });
    fireEvent.click(screen.getByRole('radio', { name: 'List' }));
    expect(await screen.findByRole('table')).toBeTruthy();
    expect(screen.getByText('2.0 KB')).toBeTruthy();
    expect(localStorage.getItem('cw.assets.view')).toBe('list');
  });
});

describe('acting on several assets', () => {
  it('moves the selected assets to a folder in one call', async () => {
    folders = [folder('f1', 'Campaigns')];
    assets = [
      asset({ id: 'a1', file: { fileName: 'one.jpg' } }),
      asset({ id: 'a2', file: { fileName: 'two.jpg' } }),
    ];
    renderLibrary();
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Select “one.jpg”' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select “two.jpg”' }));
    const bar = screen.getByRole('toolbar', { name: 'Selected assets' });
    expect(within(bar).getByText('2 assets selected')).toBeTruthy();
    await waitFor(() =>
      expect(within(bar).getByRole('option', { name: 'Campaigns' })).toBeTruthy(),
    );
    fireEvent.change(within(bar).getByRole('combobox', { name: 'Move to folder' }), {
      target: { value: 'f1' },
    });
    fireEvent.click(within(bar).getByRole('button', { name: 'Move' }));
    await waitFor(() => expect(client.moveAssets).toHaveBeenCalledWith(['a1', 'a2'], 'f1'));
    expect(await screen.findByText('Moved 2 assets to “Campaigns”')).toBeTruthy();
    expect(screen.queryByRole('toolbar', { name: 'Selected assets' })).toBeNull();
  });

  it('publishes each selected asset and reports the tally, failures included', async () => {
    assets = [
      asset({ id: 'a1', file: { fileName: 'one.jpg' } }),
      asset({ id: 'a2', file: { fileName: 'two.jpg' } }),
    ];
    client.publishAsset.mockRejectedValueOnce(new Error('nope'));
    renderLibrary();
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Select “one.jpg”' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select “two.jpg”' }));
    fireEvent.click(
      within(screen.getByRole('toolbar', { name: 'Selected assets' })).getByRole('button', {
        name: 'Publish',
      }),
    );
    expect(await screen.findByText('Published 1 of 2 assets; 1 failed')).toBeTruthy();
    expect(client.publishAsset).toHaveBeenCalledTimes(2);
  });
});

describe('archiving and deleting', () => {
  it('archives with an Undo that restores', async () => {
    assets = [asset()];
    renderLibrary();
    fireEvent.click(await screen.findByRole('button', { name: 'Archive “photo.jpg”' }));
    await waitFor(() => expect(client.archiveAsset).toHaveBeenCalledWith('a1'));
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(client.restoreAsset).toHaveBeenCalledWith('a1'));
  });

  it('offers Restore on an archived asset', async () => {
    assets = [asset({ status: 'archived' })];
    renderLibrary();
    fireEvent.click(await screen.findByRole('button', { name: 'Restore “photo.jpg”' }));
    await waitFor(() => expect(client.restoreAsset).toHaveBeenCalledWith('a1'));
  });

  it('asks first, then deletes', async () => {
    assets = [asset()];
    renderLibrary();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete “photo.jpg”' }));
    const confirm = screen.getByRole('alertdialog', { name: /Delete “photo.jpg”\?/ });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(client.deleteAsset).toHaveBeenCalledWith('a1'));
    expect(await screen.findByText('Deleted “photo.jpg”')).toBeTruthy();
  });

  it('shows the entries that use an asset when the delete is refused', async () => {
    assets = [asset()];
    client.deleteAsset.mockRejectedValueOnce(
      new ApiError(409, 'in use', {
        error: {
          code: 'asset_in_use',
          message: 'used',
          usage: [{ fromEntryId: 'e1', fromField: 'hero', toId: 'a1', toType: 'Asset' }],
        },
      }),
    );
    renderLibrary();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete “photo.jpg”' }));
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }),
    );
    const notice = await screen.findByRole('alert');
    expect(within(notice).getByText('“photo.jpg” is used by 1 entry')).toBeTruthy();
    const link = await within(notice).findByRole('link', { name: 'Home page' });
    expect(link.getAttribute('href')).toBe('/content/page/e1');

    fireEvent.click(within(notice).getByRole('button', { name: 'Archive instead' }));
    await waitFor(() => expect(client.archiveAsset).toHaveBeenCalledWith('a1'));
  });
});

describe('uploading many files', () => {
  it('uploads every dropped file into the open folder, listing each one’s progress', async () => {
    folders = [folder('f1', 'Campaigns')];
    let finishSecond: () => void = () => {};
    client.uploadAsset.mockImplementation(async (...args: unknown[]) => {
      const file = args[0] as File;
      if (file.name === 'b.png') await new Promise<void>((r) => (finishSecond = r));
      return asset();
    });
    renderLibrary();
    fireEvent.click(await screen.findByRole('button', { name: 'Campaigns' }));
    const a = new File(['a'], 'a.png', { type: 'image/png' });
    const b = new File(['b'], 'b.png', { type: 'image/png' });
    const region = screen.getByRole('region', { name: 'Asset library' });
    fireEvent.drop(region, { dataTransfer: { files: [a, b], types: ['Files'] } });

    const uploads = await screen.findByRole('region', { name: 'Uploads' });
    await waitFor(() => expect(within(uploads).getByText('Uploading 1 of 2')).toBeTruthy());
    expect(within(uploads).getByText('a.png')).toBeTruthy();
    expect(within(uploads).getByText('Uploaded')).toBeTruthy();
    expect(within(uploads).getByText('Uploading')).toBeTruthy();

    finishSecond();
    await waitFor(() => expect(within(uploads).getByText('Uploaded 2 of 2')).toBeTruthy());
    expect(client.uploadAsset).toHaveBeenCalledWith(a, { folderId: 'f1' });
    expect(client.uploadAsset).toHaveBeenCalledWith(b, { folderId: 'f1' });
    client.uploadAsset.mockImplementation(async () => asset());
  });

  it('marks a failed file and keeps going', async () => {
    client.uploadAsset.mockRejectedValueOnce(new Error('too big'));
    renderLibrary();
    const input = screen.getByLabelText('Upload asset files') as HTMLInputElement;
    fireEvent.change(input, {
      target: {
        files: [new File(['a'], 'a.png', { type: 'image/png' }), new File(['b'], 'b.png')],
      },
    });
    const uploads = await screen.findByRole('region', { name: 'Uploads' });
    await waitFor(() => expect(within(uploads).getByText('Uploaded 2 of 2')).toBeTruthy());
    expect(within(uploads).getByText('Failed')).toBeTruthy();
    expect(within(uploads).getByText('too big')).toBeTruthy();
  });
});

describe('folders', () => {
  it('creates a folder and opens it', async () => {
    renderLibrary();
    fireEvent.click(screen.getByRole('button', { name: 'New folder' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'New folder name' }), {
      target: { value: 'Brand' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create folder' }));
    await waitFor(() => expect(client.createAssetFolder).toHaveBeenCalledWith({ name: 'Brand' }));
    await waitFor(() => expect(lastQuery()).toMatchObject({ folder: 'new' }));
  });

  it('says why a folder with something in it was not deleted', async () => {
    folders = [folder('f1', 'Campaigns')];
    client.deleteAssetFolder.mockRejectedValueOnce(new ApiError(409, 'not empty'));
    renderLibrary();
    fireEvent.click(await screen.findByRole('button', { name: 'Campaigns' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete “Campaigns”' }));
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete folder' }),
    );
    expect(
      await screen.findByText('“Campaigns” isn’t empty: move or delete what is in it first'),
    ).toBeTruthy();
  });
});
