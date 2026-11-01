// @vitest-environment jsdom
import type { Asset, Tag } from '@contentworker/domain';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const asset = (over: Partial<Asset> & { file?: Partial<Asset['file']> } = {}): Asset => ({
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

let assets: Asset[] = [];
const tags: Tag[] = [{ id: 't1', name: 'Hero' } as Tag];
const client = {
  listAssets: vi.fn(async () => assets),
  listTags: vi.fn(async () => tags),
  assetUsage: vi.fn(async () => []),
  publishAsset: vi.fn(async () => ({})),
  unpublishAsset: vi.fn(async () => ({})),
  refreshVideoAsset: vi.fn(),
  uploadAsset: vi.fn(),
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
const { MediaLibrary } = await import('~/cms/components/MediaLibrary');
const { ApiError } = await import('~/cms/lib/management');

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  assets = [];
});

const renderLibrary = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ToastProvider>
        <MediaLibrary locale="en-US" />
      </ToastProvider>
    </QueryClientProvider>,
  );

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

describe('MediaLibrary', () => {
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
    client.uploadAsset.mockResolvedValueOnce(asset());
    renderLibrary();
    const input = screen.getByLabelText('Upload asset file') as HTMLInputElement;
    const file = new File(['x'], 'clip.mp4', { type: 'video/mp4' });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(client.uploadAsset).toHaveBeenCalledWith(file));
    expect(client.uploadVideo).toHaveBeenCalledWith(file);
  });
});
