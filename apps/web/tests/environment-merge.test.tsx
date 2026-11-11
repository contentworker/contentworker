// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;
Element.prototype.scrollIntoView ??= () => {};

const toastError = vi.fn();
// `run` as the provider's: the screen's own error handling first, then a toast for what's left.
vi.mock('~/cms/lib/client-context', () => ({
  useClient: () => ({
    busy: false,
    run: async (fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (e) {
        toastError(e instanceof Error ? e.message : String(e));
      }
    },
  }),
}));

const { BranchMerge } = await import('~/cms/components/BranchMerge');
const { ToastProvider } = await import('~/cms/lib/toast');
const { ApiError } = await import('~/cms/lib/management');
type ManagementClient = import('~/cms/lib/management').ManagementClient;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const STRANDS =
  'The content type "page" can\'t go to main: it removes a block variant 2 entries there still ' +
  'use: body: quote (e1, e2). Change or clear those values there first, or leave "page" out of ' +
  'the merge';

const refusal = (issues: { field: string; message: string }[]) =>
  new ApiError(422, `422 ${JSON.stringify({ error: { issues } })}`, {
    error: { code: 'validation_failed', message: 'Validation failed', issues },
  });

function renderMerge(merge: ManagementClient['mergeEnvironments']) {
  const client = {
    compareEnvironments: vi.fn(async () => ({
      contentTypes: [
        { apiId: 'page', kind: 'changed' },
        { apiId: 'post', kind: 'added' },
      ],
      entries: [],
    })),
    mergeEnvironments: vi.fn(merge),
  };
  render(
    <ToastProvider>
      <BranchMerge
        client={client as unknown as ManagementClient}
        environments={[
          { id: 'staging', name: 'Staging' },
          { id: 'main', name: 'Main' },
        ]}
      />
    </ToastProvider>,
  );
  return client;
}

const compare = async () => {
  fireEvent.click(screen.getByRole('button', { name: 'Compare' }));
  return screen.findByRole('button', { name: /^Merge 2 selected/ });
};

describe('the entries to merge', () => {
  it('are told apart by the end of their ids, where UUIDv7s made together differ', async () => {
    const client = {
      compareEnvironments: vi.fn(async () => ({
        contentTypes: [],
        entries: [
          {
            entryId: '01a1c888-d23b-75da-b7cd-ff8e1e749238',
            contentTypeApiId: 'page',
            kind: 'added',
          },
          {
            entryId: '01a1c888-d243-7a36-ab2f-ebaa8557d62e',
            contentTypeApiId: 'page',
            kind: 'added',
          },
        ],
      })),
      mergeEnvironments: vi.fn(),
    };
    render(
      <ToastProvider>
        <BranchMerge
          client={client as unknown as ManagementClient}
          environments={[
            { id: 'staging', name: 'Staging' },
            { id: 'main', name: 'Main' },
          ]}
        />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Compare' }));
    expect(await screen.findByText('page · 1e749238')).toBeTruthy();
    expect(screen.getByText('page · 8557d62e')).toBeTruthy();
    expect(screen.queryByText('page · 01a1c888')).toBeNull();
  });
});

describe('a merge the target refuses', () => {
  it('lists the issues by the list they name, in the API’s words, beside Merge', async () => {
    renderMerge(async () => {
      throw refusal([
        { field: 'contentTypes', message: STRANDS },
        { field: 'entries[e9]', message: 'The entry e9 is in the trash in main' },
      ]);
    });
    fireEvent.click(await compare());

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('Nothing was merged into main')).toBeTruthy();
    expect(within(alert).getByText('Content types')).toBeTruthy();
    // The message names the content type and says what to change; the screen adds no rule.
    expect(within(alert).getByText(STRANDS)).toBeTruthy();
    expect(within(alert).getByText('Entries')).toBeTruthy();
    expect(within(alert).getByText('The entry e9 is in the trash in main')).toBeTruthy();
    // Not a generic toast as well.
    expect(toastError).not.toHaveBeenCalled();
  });

  it('keeps the selection so the type can be left out and the merge sent again', async () => {
    let refuse = true;
    const client = renderMerge(async (input) => {
      if (refuse) throw refusal([{ field: 'contentTypes', message: STRANDS }]);
      return { mergedContentTypes: input.contentTypes ?? [], mergedEntries: [] };
    });
    fireEvent.click(await compare());
    await screen.findByRole('alert');

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select page' }));
    refuse = false;
    fireEvent.click(screen.getByRole('button', { name: /^Merge 1 selected/ }));

    await waitFor(() => expect(client.mergeEnvironments).toHaveBeenCalledTimes(2));
    expect(client.mergeEnvironments.mock.calls[1]?.[0].contentTypes).toEqual(['post']);
    // The refusal is for the last merge only: one that goes through clears it.
    await waitFor(() => expect(screen.queryByText('Nothing was merged into main')).toBeNull());
  });

  it('toasts a failure that names no issues, rather than an empty list', async () => {
    renderMerge(async () => {
      throw new ApiError(500, 'Internal error');
    });
    fireEvent.click(await compare());
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Internal error'));
    expect(screen.queryByText(/Nothing was merged/)).toBeNull();
  });
});
