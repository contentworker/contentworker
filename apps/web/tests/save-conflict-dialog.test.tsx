// @vitest-environment jsdom
// The question a stale save asks (the form's and the canvas's alike): who saved the newer version
// and when, what changed between theirs and the one the edits started from, and Keep editing as
// the safe, focused answer.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const client = {
  getVersion: vi.fn(),
  diffVersions: vi.fn(),
};
vi.mock('~/cms/lib/client-context', () => ({
  useClient: () => ({ client, conn: { space: 's', environment: 'main', locale: 'en-US' } }),
}));

const { SaveConflictDialog } = await import('~/cms/components/entries/SaveConflictDialog');

const MINUTE_AGO = () => new Date(Date.now() - 60_000).toISOString();

beforeEach(() => {
  client.getVersion.mockResolvedValue({
    entryId: 'e1',
    version: 5,
    fields: {},
    createdBy: 'cma',
    createdAt: MINUTE_AGO(),
  });
  client.diffVersions.mockResolvedValue({
    from: 2,
    to: 5,
    hiddenChanges: 0,
    changes: [
      {
        field: 'title',
        name: 'Title',
        fieldType: 'Symbol',
        kind: 'changed',
        locales: [
          {
            locale: 'en-US',
            kind: 'changed',
            before: 'Pricing',
            after: 'Plans',
            detail: {
              type: 'text',
              segments: [
                { kind: 'removed', text: 'Pricing' },
                { kind: 'added', text: 'Plans' },
              ],
            },
          },
        ],
      },
    ],
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** What the editor already read: the person's access, and the team for an administrator. */
interface Known {
  readonly people?: readonly { id: string; email: string; name?: string }[];
}

function ask(props: Partial<Parameters<typeof SaveConflictDialog>[0]> = {}, known: Known = {}) {
  const handlers = { onOpenChange: vi.fn(), onLoadTheirs: vi.fn(), onSaveOver: vi.fn() };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(['s', 'main', 'space-access'], {
    spaceId: 's',
    kind: 'user',
    scopes: [],
    subject: 'u1',
  });
  if (known.people) queryClient.setQueryData(['s', 'main', 'team'], { people: known.people });
  const router = createMemoryRouter(
    [
      {
        path: '/content/:typeId/:entryId',
        element: (
          <SaveConflictDialog open theirs={5} mine={2} where="the form" {...handlers} {...props} />
        ),
      },
    ],
    { initialEntries: ['/content/article/e1'] },
  );
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return handlers;
}

describe('a save someone else got in before', () => {
  it('focuses Keep editing, the primary answer, with the other two beside it', async () => {
    ask();
    const dialog = await screen.findByRole('alertdialog');
    const keep = within(dialog).getByRole('button', { name: 'Keep editing' });
    await waitFor(() => expect(document.activeElement).toBe(keep));
    expect(keep.className).toContain('bg-primary');
    expect(
      within(dialog).getByRole('button', { name: 'Save mine over it' }).className,
    ).not.toContain('bg-primary');
    expect(within(dialog).getByText(/It’s at v5 now, and the form started from v2/)).toBeTruthy();
  });

  it('names who saved their version, and when', async () => {
    ask();
    const dialog = await screen.findByRole('alertdialog');
    expect(await within(dialog).findByText(/An API key saved v5/)).toBeTruthy();
    expect(within(dialog).getByText('1m ago')).toBeTruthy();
    expect(client.getVersion).toHaveBeenCalledWith('e1', 5);
  });

  it('names a teammate as the editor knows them, and the person themselves as You', async () => {
    client.getVersion.mockResolvedValue({ entryId: 'e1', version: 5, fields: {}, createdBy: 'u2' });
    ask({}, { people: [{ id: 'u2', email: 'd@x.test', name: 'Dana' }] });
    expect(await screen.findByText('Dana saved v5')).toBeTruthy();
    cleanup();
    // Without the team (only administrators read it), a teammate reads as one.
    ask();
    expect(await screen.findByText('A teammate saved v5')).toBeTruthy();
    cleanup();
    client.getVersion.mockResolvedValue({ entryId: 'e1', version: 5, fields: {}, createdBy: 'u1' });
    ask();
    expect(await screen.findByText('You saved v5')).toBeTruthy();
  });

  it('says nothing of who when the version doesn’t record it, and asks all the same', async () => {
    client.getVersion.mockRejectedValue(new Error('down'));
    ask();
    const dialog = await screen.findByRole('alertdialog');
    await waitFor(() => expect(client.getVersion).toHaveBeenCalled());
    expect(within(dialog).queryByText(/saved v5/)).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Keep editing' })).toBeTruthy();
  });

  it('shows what changed from the version the edits started from, before anything is chosen', async () => {
    const handlers = ask();
    const dialog = await screen.findByRole('alertdialog');
    expect(client.diffVersions).not.toHaveBeenCalled();
    const see = within(dialog).getByRole('button', { name: 'See what changed' });
    fireEvent.click(see);
    expect(see.getAttribute('aria-expanded')).toBe('true');
    const changes = await within(dialog).findByRole('region', {
      name: 'What changed from v2 to v5',
    });
    expect(await within(changes).findByText('Title')).toBeTruthy();
    expect(client.diffVersions).toHaveBeenCalledWith('e1', 2, 5);
    expect(handlers.onSaveOver).not.toHaveBeenCalled();
    expect(handlers.onLoadTheirs).not.toHaveBeenCalled();
  });

  it('offers Try again when what changed can’t be read', async () => {
    client.diffVersions.mockRejectedValueOnce(new Error('down'));
    ask();
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'See what changed' }));
    const retry = await within(dialog).findByRole('button', { name: 'Try again' });
    act(() => retry.click());
    expect(await within(dialog).findByText('Title')).toBeTruthy();
  });

  it('answers each way it says', async () => {
    const handlers = ask();
    const dialog = await screen.findByRole('alertdialog');
    act(() => within(dialog).getByRole('button', { name: 'Save mine over it' }).click());
    expect(handlers.onSaveOver).toHaveBeenCalledOnce();
    cleanup();
    const loading = ask();
    act(() =>
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Load theirs' }).click(),
    );
    expect(loading.onLoadTheirs).toHaveBeenCalledOnce();
    cleanup();
    const keeping = ask();
    act(() =>
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Keep editing' }).click(),
    );
    expect(keeping.onOpenChange).toHaveBeenCalledWith(false);
    expect(keeping.onSaveOver).not.toHaveBeenCalled();
    expect(keeping.onLoadTheirs).not.toHaveBeenCalled();
  });
});
