// @vitest-environment jsdom
import type { ContentType } from '@contentworker/domain';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type ContentTypeEntryCounts, RequestTimeoutError } from '~/cms/lib/management';

const client = {
  contentTypeEntryCounts: vi.fn<() => Promise<ContentTypeEntryCounts[]>>(),
  saveContentType: vi.fn(),
  publishContentType: vi.fn(),
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

const { ToastProvider } = await import('~/cms/lib/toast');
const { ContentTypesOverview } = await import('~/cms/routes/ContentTypesOverview');

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const type = (apiId: string, name: string, status: 'draft' | 'published'): ContentType =>
  ({ apiId, name, displayField: 'title', version: 1, status, fields: [] }) as ContentType;

function setup(types: ContentType[], typesPending = false) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const deleteJob = { state: null, start() {}, dismiss() {}, cancel() {}, cancelling: false };
  const outlet = {
    types,
    typesPending,
    locales: ['en-US'],
    defaultLocale: 'en-US',
    reload() {},
    deleteJob,
  };
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/content']}>
          <Routes>
            <Route path="/content" element={<Outlet context={outlet} />}>
              <Route index element={<ContentTypesOverview />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const rowOf = (name: string) => {
  const row = screen.getByRole('link', { name }).closest('tr');
  if (!row) throw new Error(`no row for ${name}`);
  return within(row);
};

describe('content types overview', () => {
  describe('a save that fails', () => {
    const article = {
      ...type('article', 'Article', 'published'),
      fields: [{ apiId: 'title', name: 'Title', type: 'Symbol' }],
    } as unknown as ContentType;
    const trySave = async () => {
      client.contentTypeEntryCounts.mockResolvedValue([]);
      setup([article]);
      fireEvent.click(await screen.findByRole('button', { name: 'Edit “Article”' }));
      await screen.findByRole('dialog');
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Story' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
      return screen.findByRole('alert');
    };
    const ask = async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      return screen.findByRole('alertdialog', { name: /Discard/ });
    };

    it('keeps the form and asks honestly when the save timed out', async () => {
      client.saveContentType.mockRejectedValueOnce(new RequestTimeoutError(true));
      expect((await trySave()).textContent).toContain('didn’t confirm');
      expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Story');
      expect((await ask()).textContent).toContain('may have gone through');
    });

    it('says nothing was saved when the save itself was refused', async () => {
      client.saveContentType.mockRejectedValueOnce(new ApiError(422, 'PUT → 422'));
      await trySave();
      expect((await ask()).textContent).toContain('Nothing has been saved.');
      expect(client.publishContentType).not.toHaveBeenCalled();
    });

    it('never says so when the draft saved and only its publish was refused', async () => {
      client.saveContentType.mockResolvedValueOnce(undefined);
      client.publishContentType.mockRejectedValueOnce(
        new ApiError(422, 'POST → 422', { error: { message: 'Entries would break' } }),
      );
      const alert = await trySave();
      expect(alert.textContent).toContain(
        'The draft saved but wasn’t published: Entries would break',
      );
      await waitFor(() => expect(client.publishContentType).toHaveBeenCalledOnce());
      const question = await ask();
      expect(question.textContent).not.toContain('Nothing has been saved');
    });
  });

  it('shows each type’s entry counts, and a badge only on a draft schema', async () => {
    client.contentTypeEntryCounts.mockResolvedValue([
      { contentType: 'article', total: 1240, draft: 3, changed: 2, published: 1235, archived: 4 },
      { contentType: 'author', total: 0, draft: 0, changed: 0, published: 0, archived: 0 },
    ]);
    setup([type('article', 'Article', 'published'), type('author', 'Author', 'draft')]);

    const article = rowOf('Article');
    expect(await article.findByText('1,240')).toBeTruthy();
    expect(article.getByText('3')).toBeTruthy();
    expect(article.getByText('2')).toBeTruthy();
    // A published schema is the normal case: no badge to say so.
    expect(article.queryByText('Published')).toBeNull();
    expect(screen.getByRole('link', { name: 'Article' }).getAttribute('href')).toBe(
      '/content/article',
    );

    const author = rowOf('Author');
    expect(author.getByText('Draft')).toBeTruthy();
    expect(author.getByRole('button', { name: 'Publish' })).toBeTruthy();
  });

  it('still lists the types when the counts can’t be read', async () => {
    client.contentTypeEntryCounts.mockRejectedValue(new Error('down'));
    setup([type('article', 'Article', 'published')]);
    const article = rowOf('Article');
    expect((await article.findAllByText('—')).length).toBe(3);
    expect(article.getByRole('button', { name: 'Edit “Article”' })).toBeTruthy();
  });
});

describe('ContentTypesOverview while the types load', () => {
  it('draws a loading list, never "No content types yet", before the types arrive', () => {
    setup([], true);
    expect(screen.queryByText('No content types yet')).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('Loading content types…');
  });
});
