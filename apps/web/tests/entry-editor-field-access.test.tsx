// @vitest-environment jsdom
// The entry editor under a role's field rules: it waits for the person's access before drawing the
// form, then leaves the fields their role hides off the whole page (form and preview alike), shows
// the read-only ones read-only, and creates the entry without either.
import type { ContentType } from '@contentworker/domain';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';
import type { PrincipalInfo } from '~/cms/lib/management';

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;
Element.prototype.scrollIntoView ??= () => {};

let resolveAccess: (access: PrincipalInfo) => void = () => {};
const client = {
  listEntries: vi.fn(async () => []),
  listAssets: vi.fn(async () => []),
  listAppExtensions: vi.fn(async () => []),
  getSpaceAccess: vi.fn(
    () =>
      new Promise<PrincipalInfo>((resolve) => {
        resolveAccess = resolve;
      }),
  ),
  createEntry: vi.fn(async () => ({
    entry: {
      id: 'e1',
      contentTypeApiId: 'listing',
      status: 'draft',
      currentVersion: 1,
      publishedVersion: null,
    },
    fields: {},
  })),
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
const { EntryEditor } = await import('~/cms/routes/EntryEditor');

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const listing = {
  apiId: 'listing',
  name: 'Listing',
  displayField: 'title',
  version: 1,
  status: 'published',
  fields: [
    {
      apiId: 'title',
      name: 'Title',
      type: 'Symbol',
      localized: false,
      required: true,
      position: 0,
    },
    {
      apiId: 'price',
      name: 'Price',
      type: 'Number',
      localized: false,
      required: false,
      position: 1,
    },
    {
      apiId: 'notes',
      name: 'Internal notes',
      type: 'Text',
      localized: false,
      required: true,
      position: 2,
    },
  ],
} as ContentType;

const ACCESS: PrincipalInfo = {
  spaceId: 's',
  kind: 'user',
  scopes: ['content:write', 'preview:read'],
  restricted: true,
  fieldRules: {
    types: { listing: { deniedFields: ['notes'], readOnlyFields: ['price'] } },
    others: { deniedFields: [], readOnlyFields: [] },
  },
};

function setup() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const outlet = { types: [listing], locales: ['en-US'], defaultLocale: 'en-US', reload() {} };
  const router = createMemoryRouter(
    [
      {
        path: '/content',
        element: <Outlet context={outlet} />,
        children: [
          { path: ':typeId/new', element: <EntryEditor /> },
          { path: ':typeId/:entryId', element: <div>Saved</div> },
        ],
      },
    ],
    { initialEntries: ['/content/listing/new'] },
  );
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

it('draws a new entry’s form once access is read, without the hidden field anywhere', async () => {
  setup();
  // Until the person's access is read, no form: a field it would hide could be typed into.
  await waitFor(() => expect(client.getSpaceAccess).toHaveBeenCalled());
  expect(screen.queryByLabelText(/^Title/)).toBeNull();

  await act(async () => resolveAccess(ACCESS));
  const title = await screen.findByLabelText(/^Title/);
  const price = screen.getByLabelText(/^Price/) as HTMLInputElement;
  expect(price.readOnly).toBe(true);
  expect(screen.getByText('Your role can’t change this field')).toBeTruthy();
  // Neither the form nor the preview beside it names the hidden field.
  expect(screen.queryByText(/Internal notes/)).toBeNull();

  fireEvent.change(title, { target: { value: 'Loft' } });
  fireEvent.submit(title.closest('form') as HTMLFormElement);
  // The required hidden field doesn't stop the create, and isn't sent.
  await waitFor(() => expect(client.createEntry).toHaveBeenCalled());
  expect(client.createEntry.mock.calls[0]).toEqual(['listing', { title: { 'en-US': 'Loft' } }]);
});
