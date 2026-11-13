// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

type NavType = { apiId: string; name: string; status: string; group?: string; icon?: string };

const modelled: NavType[] = [
  // An inherited key as a stored name: drawn as no icon, never looked up on the prototype.
  { apiId: 'post', name: 'Post', status: 'published', icon: 'constructor' },
  { apiId: 'faq', name: 'FAQ', status: 'published', group: 'A B', icon: 'calendar' },
  { apiId: 'page', name: 'Page', status: 'published', group: 'A-B', icon: 'calendar' },
];
let types = modelled;

vi.mock('~/cms/lib/client-context', () => ({
  useClient: () => ({ conn: { space: 'demo', environment: 'main', locale: 'en-US' } }),
}));

vi.mock('~/cms/lib/queries', () => ({
  useQueryKeys: () => ({ contentTypes: ['types'], spaceConfig: ['config'] }),
  useContentTypesQuery: () => ({ data: types, isPending: false }),
  useSpaceConfigQuery: () => ({ data: null }),
  useInvalidate: () => async () => {},
}));

vi.mock('~/cms/components/ContentTypeDeleteJob', () => ({
  useContentTypeDeleteJob: () => null,
}));

const { ContentLayout } = await import('~/cms/routes/ContentLayout');

afterEach(() => {
  cleanup();
  types = modelled;
});

// A page beside the nav (the overview at /content lists the types itself, with no nav).
const renderNav = (at = '/content/space-import') =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={[at]}>
        <ContentLayout />
      </MemoryRouter>
    </QueryClientProvider>,
  );

describe('the content nav', () => {
  it('names each group’s list by its own heading, for names that differ only in punctuation', () => {
    renderNav();
    const ids = screen.getAllByRole('heading', { level: 3 }).map((h) => h.id);
    expect(new Set(ids).size).toBe(2);
    expect(screen.getByRole('list', { name: 'A B' }).textContent).toBe('FAQ');
    expect(screen.getByRole('list', { name: 'A-B' }).textContent).toBe('Page');
  });

  it('marks the open type’s icon in the brand accent', () => {
    renderNav('/content/faq');
    const icon = (name: string) =>
      screen.getByRole('link', { name }).querySelector('[aria-hidden="true"]');
    expect(icon('FAQ')?.getAttribute('class')).toContain('text-brand');
    expect(icon('Page')?.getAttribute('class')).not.toContain('text-brand');
  });

  it('gives every type an icon: its own, the one its name suggests, else a blank page', () => {
    types = [
      { apiId: 'faq', name: 'FAQ', status: 'published', icon: 'calendar' },
      // `constructor` names no icon the admin knows, and is never looked up on the prototype.
      { apiId: 'post', name: 'Post', status: 'published', icon: 'constructor' },
      { apiId: 'widget', name: 'Widget', status: 'published' },
    ];
    renderNav();
    const icon = (name: string) =>
      screen
        .getByRole('link', { name })
        .querySelector('svg[aria-hidden="true"]')
        ?.getAttribute('class')
        ?.match(/lucide-[a-z-]+/)?.[0];
    expect(icon('FAQ')).toBe('lucide-calendar');
    expect(icon('Post')).toBe('lucide-newspaper');
    // Never an empty slot, which would set the name in like a child of the row above.
    expect(icon('Widget')).toBe('lucide-file');
  });

  it('says an unpublished type’s status in words after its name', () => {
    types = [
      { apiId: 'post', name: 'Post', status: 'published' },
      { apiId: 'event', name: 'Event', status: 'draft' },
    ];
    renderNav();
    expect(screen.getByRole('link', { name: /^Event\W+Draft$/ })).toBeTruthy();
    // Seen too, on touch as at a pointer: the word beside the name, hidden from the name's reading.
    const event = screen.getByRole('link', { name: /^Event\W+Draft$/ });
    // Named by what it shows (no aria-label for its words to drift from), Draft in words.
    expect(event.getAttribute('aria-label')).toBeNull();
    expect(event.lastElementChild?.textContent).toBe('Draft');
    expect(screen.getByRole('link', { name: 'Post' }).getAttribute('aria-label')).toBeNull();
  });

  it('leaves the nav out beside the overview, which lists the types itself', () => {
    renderNav('/content');
    expect(screen.queryByRole('navigation', { name: 'Content types', hidden: true })).toBeNull();
    cleanup();
    renderNav('/content/faq');
    expect(
      screen.getByRole('navigation', { name: 'Content types' }).getAttribute('class'),
    ).toContain('@[40rem]:block');
  });

  it('heads the lists with the groups’ own captions when every type is grouped', () => {
    types = modelled.filter((t) => t.group);
    renderNav();
    // Still the nav's name, without a caption stacked over the first group's.
    expect(screen.getByRole('navigation', { name: 'Content types' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2 }).getAttribute('class')).toBe('sr-only');
    cleanup();
    types = modelled;
    renderNav();
    expect(screen.getByRole('heading', { level: 2 }).getAttribute('class')).toContain('caption');
  });
});
