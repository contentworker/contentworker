// @vitest-environment jsdom
// The entry editor's Site segment: there only when the entry's type has a preview URL, framing the
// Site frame for the entry, and a click in the framed page focusing that field (or block) in the
// form, its locale tab opened for it.
import type { ContentType } from '@contentworker/domain';
import { formatContentRef } from '@contentworker/sdk-core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FRAME_CHANNEL } from '~/cms/lib/live-preview/frame-channel';
import type { PreviewEntry } from '~/cms/lib/management';

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;
Element.prototype.scrollIntoView ??= () => {};

const client = {
  getEntry: vi.fn<(id: string) => Promise<PreviewEntry>>(),
  listEntries: vi.fn(async () => []),
  listAssets: vi.fn(async () => []),
  listAppExtensions: vi.fn(async () => []),
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
vi.mock('~/cms/components/CollaborationPanel', () => ({ CollaborationPanel: () => null }));
vi.mock('~/cms/components/EntryMetadataPanel', () => ({ EntryMetadataPanel: () => null }));
vi.mock('~/cms/components/VersionHistory', () => ({ VersionHistory: () => null }));
vi.mock('~/cms/components/ReferencedBy', () => ({ ReferencedBy: () => null }));
vi.mock('~/cms/components/SemanticPanel', () => ({ SemanticPanel: () => null }));
vi.mock('~/cms/components/AiAssistPanel', () => ({ AiAssistPanel: () => null }));

const { ToastProvider } = await import('~/cms/lib/toast');
const { EntryEditor } = await import('~/cms/routes/EntryEditor');

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
});

const page = (preview?: string): ContentType =>
  ({
    apiId: 'page',
    name: 'Page',
    displayField: 'title',
    version: 1,
    status: 'published',
    fields: [
      {
        apiId: 'title',
        name: 'Title',
        type: 'Symbol',
        localized: true,
        required: false,
        position: 0,
      },
      {
        apiId: 'body',
        name: 'Body',
        type: 'Array',
        localized: false,
        required: false,
        position: 1,
        items: {
          type: 'Component',
          variants: [
            {
              apiId: 'cta',
              name: 'Call to action',
              fields: [
                {
                  apiId: 'label',
                  name: 'Label',
                  type: 'Symbol',
                  localized: false,
                  required: false,
                  position: 0,
                },
              ],
            },
          ],
        },
      },
    ],
    ...(preview ? { preview: { urlTemplate: preview } } : {}),
  }) as ContentType;

function setup(type: ContentType) {
  client.getEntry.mockResolvedValue({
    id: 'e1',
    contentType: 'page',
    status: 'draft',
    version: 2,
    fields: {
      title: { 'en-US': 'Home', de: 'Start' },
      body: { 'en-US': [{ _type: 'cta', _key: 'k1', label: 'Go' }] },
    },
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const outlet = { types: [type], locales: ['en-US', 'de'], defaultLocale: 'en-US', reload() {} };
  const router = createMemoryRouter(
    [
      {
        path: '/content',
        element: <Outlet context={outlet} />,
        children: [{ path: ':typeId/:entryId', element: <EntryEditor /> }],
      },
    ],
    { initialEntries: ['/content/page/e1'] },
  );
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const TEMPLATE = 'https://site.example/p?entry={id}#token={token}';

/** The frame says the page renders `entries`, then that `ref` was clicked in it. */
function pick(ref: string, entries: string[] = ['e1']) {
  const frame = screen.getByTitle('Site preview') as HTMLIFrameElement;
  const say = (data: Record<string, unknown>) =>
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { channel: FRAME_CHANNEL, ...data },
          origin: window.location.origin,
          source: frame.contentWindow,
        }),
      );
    });
  say({ type: 'session', entries, capabilities: ['select'] });
  say({ type: 'pick', ref });
}

const refTo = (field: string, locale = 'en-US') =>
  formatContentRef({
    space: 's',
    environment: 'main',
    entryId: 'e1',
    contentType: 'page',
    field,
    locale,
  });

describe('the entry editor’s Site segment', () => {
  it('is absent when the type has no preview URL', async () => {
    setup(page());
    await screen.findByRole('heading', { level: 1, name: 'Home' });
    expect(screen.getByRole('radio', { name: 'Preview' })).toBeTruthy();
    expect(screen.queryByRole('radio', { name: 'Site' })).toBeNull();
  });

  it('a remembered Site opens on Details for a type without one', async () => {
    localStorage.setItem('cw.entry-pane.view', 'site');
    setup(page());
    await screen.findByRole('heading', { level: 1, name: 'Home' });
    expect(screen.getByRole('radio', { name: 'Details' }).getAttribute('aria-checked')).toBe(
      'true',
    );
    expect(screen.queryByTitle('Site preview')).toBeNull();
  });

  it('frames the Site frame for the entry when the type has one, and never remembers it', async () => {
    setup(page(TEMPLATE));
    await screen.findByRole('heading', { level: 1, name: 'Home' });
    act(() => screen.getByRole('radio', { name: 'Preview' }).click());
    act(() => screen.getByRole('radio', { name: 'Site' }).click());
    expect(screen.getByTitle('Site preview').getAttribute('src')).toBe('/preview-frame/s/main/e1');
    // The next entry opens on the view kept before: Site frames only when picked.
    expect(localStorage.getItem('cw.entry-pane.view')).toBe('preview');
  });

  it('focuses the field a click in the page names, in its locale', async () => {
    setup(page(TEMPLATE));
    await screen.findByRole('heading', { level: 1, name: 'Home' });
    act(() => screen.getByRole('radio', { name: 'Site' }).click());
    const ref = formatContentRef({
      space: 's',
      environment: 'main',
      entryId: 'e1',
      contentType: 'page',
      field: 'title',
      locale: 'de',
    });
    pick(ref);
    await waitFor(() => expect(document.activeElement?.id).toBe('field-title'));
    expect((document.activeElement as HTMLInputElement).value).toBe('Start');
  });

  it('focuses the block a click in the page names, in its blocks field', async () => {
    setup(page(TEMPLATE));
    await screen.findByRole('heading', { level: 1, name: 'Home' });
    act(() => screen.getByRole('radio', { name: 'Site' }).click());
    pick(refTo('body[k1].label'));
    const block = screen.getByRole('group', { name: 'Call to action block 1' });
    await waitFor(() => expect(document.activeElement).toBe(block));
    // Ringed for the pick, until focus moves on.
    expect(block.hasAttribute('data-picked')).toBe(true);
    act(() => screen.getByRole('textbox', { name: /^Label/ }).focus());
    expect(block.hasAttribute('data-picked')).toBe(false);
  });

  it('ignores a click on an entry the page didn’t report', async () => {
    setup(page(TEMPLATE));
    await screen.findByRole('heading', { level: 1, name: 'Home' });
    act(() => screen.getByRole('radio', { name: 'Site' }).click());
    const before = document.activeElement;
    pick(refTo('title'), ['someone-else']);
    // Nothing to wait for: the pick is dropped as it arrives.
    await act(async () => {});
    expect(document.activeElement).toBe(before);
  });

  it('names the focused field to the frame, so the page outlines it', async () => {
    setup(page(TEMPLATE));
    await screen.findByRole('heading', { level: 1, name: 'Home' });
    act(() => screen.getByRole('radio', { name: 'Site' }).click());
    const frame = screen.getByTitle('Site preview') as HTMLIFrameElement;
    const spy = vi.spyOn(frame.contentWindow as Window, 'postMessage').mockImplementation(() => {});
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { channel: FRAME_CHANNEL, type: 'ready', origin: 'https://site.example' },
          origin: window.location.origin,
          source: frame.contentWindow,
        }),
      );
    });
    act(() => (document.getElementById('field-title') as HTMLElement).focus());
    await waitFor(() =>
      expect(
        spy.mock.calls
          .map(([m]) => m)
          .filter((m) => (m as { type: string }).type === 'select')
          .at(-1),
      ).toMatchObject({
        ref: refTo('title'),
      }),
    );
  });
});
