// @vitest-environment jsdom
import type { Asset } from '@contentworker/domain';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { DocumentPreview } from '~/cms/components/assets/DocumentPreview';
import { ApiError, type DocumentPreviewPage } from '~/cms/lib/management';

const documentPage = vi.fn<(...args: unknown[]) => Promise<DocumentPreviewPage>>();
const client = { documentPage, getAsset: vi.fn() };
vi.mock('~/cms/lib/client-context', () => ({
  useClient: () => ({ client, conn: { space: 's', environment: 'main' } }),
}));
const asset: Asset = {
  id: 'one',
  version: 1,
  status: 'draft',
  title: {},
  description: {},
  metadata: { tags: [], altText: {} },
  file: { fileName: 'notes.pdf', contentType: 'application/pdf', url: '' },
};
const first: DocumentPreviewPage = {
  page: 1,
  pages: 5,
  version: 1,
  documentStatus: 'partial',
  firstPartialPage: 4,
  status: 'complete',
  warnings: [],
  previewUrl: '/media/preview.png?sig=example',
  text: 'Opening notes',
  media: [],
};
function mount(onLatest?: (a: Asset) => void) {
  const retry = vi.fn(async () => {});
  render(
    <QueryClientProvider client={new QueryClient()}>
      <DocumentPreview asset={asset} onReingest={retry} onLatest={onLatest} />
    </QueryClientProvider>,
  );
  return retry;
}
beforeEach(() => {
  documentPage.mockReset();
});
it('jumps to the affected page and makes the existing reingest action available', async () => {
  documentPage.mockResolvedValueOnce(first).mockResolvedValueOnce({
    ...first,
    page: 4,
    status: 'partial',
    warnings: ['Media exceeds local extraction limit: video.mp4'],
  });
  const retry = mount();
  expect(
    (await screen.findByRole('img', { name: 'Page 1 of notes.pdf' })).getAttribute('src'),
  ).toBe(first.previewUrl);
  fireEvent.click(screen.getByRole('button', { name: 'View page 4' }));
  expect(await screen.findByText(/video\.mp4/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Reingest document' }));
  expect(retry).toHaveBeenCalledTimes(1);
});
it('does not combine embedded file pages from different versions', async () => {
  documentPage
    .mockResolvedValueOnce({
      ...first,
      media: [{ part: 'first.png', url: '/media/first' }],
      nextMediaOffset: 100,
    })
    .mockResolvedValueOnce({
      ...first,
      version: 2,
      media: [{ part: 'replacement.png', url: '/media/replacement' }],
    });
  const onLatest = vi.fn();
  client.getAsset.mockResolvedValue({ ...asset, version: 2 });
  mount(onLatest);
  fireEvent.click(await screen.findByRole('button', { name: 'More embedded files' }));
  expect(await screen.findByText(/file has been replaced/i)).toBeTruthy();
  expect(screen.queryByText('replacement.png')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Load current version' }));
  await vi.waitFor(() => expect(onLatest).toHaveBeenCalledWith({ ...asset, version: 2 }));
});
it('can start ingestion when an idle document has no preview', async () => {
  documentPage.mockRejectedValue(new ApiError(404, 'Page unavailable'));
  const retry = mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Reingest document' }));
  expect(retry).toHaveBeenCalledOnce();
});
