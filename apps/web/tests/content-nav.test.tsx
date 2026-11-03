// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

const types = [
  { apiId: 'post', name: 'Post', status: 'published' },
  { apiId: 'faq', name: 'FAQ', status: 'published', group: 'A B' },
  { apiId: 'page', name: 'Page', status: 'published', group: 'A-B' },
];

vi.mock('~/cms/lib/client-context', () => ({
  useClient: () => ({ conn: { space: 'demo', environment: 'main', locale: 'en-US' } }),
}));

vi.mock('~/cms/lib/queries', () => ({
  useQueryKeys: () => ({ contentTypes: ['types'], spaceConfig: ['config'] }),
  useContentTypesQuery: () => ({ data: types, isPending: false }),
  useSpaceConfigQuery: () => ({ data: null }),
}));

const { ContentLayout } = await import('~/cms/routes/ContentLayout');

afterEach(cleanup);

describe('the content nav', () => {
  it('names each group’s list by its own heading, for names that differ only in punctuation', () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <ContentLayout />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const ids = screen.getAllByRole('heading', { level: 3 }).map((h) => h.id);
    expect(new Set(ids).size).toBe(2);
    expect(screen.getByRole('list', { name: 'A B' }).textContent).toBe('FAQ');
    expect(screen.getByRole('list', { name: 'A-B' }).textContent).toBe('Page');
  });
});
