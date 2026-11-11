// @vitest-environment jsdom
import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The scope's client, swapped between renders as the scope settles after hydration.
let client: { getEntriesByIds: ReturnType<typeof vi.fn>; listAssets: ReturnType<typeof vi.fn> };
const conn = { space: 's', environment: 'main', locale: 'en-US' };
vi.mock('~/cms/lib/client-context', () => ({ useClient: () => ({ client, conn }) }));

// Stable data, as the query cache hands back while nothing changed.
const TYPES = [{ apiId: 'page', displayField: 'title' }];
const ENTRIES = [{ id: 'e1', contentType: 'page', fields: { title: { 'en-US': 'Home' } } }];
const ASSETS: unknown[] = [];
vi.mock('~/cms/lib/queries', () => ({
  useContentTypesQuery: () => ({ data: TYPES }),
  useAllEntriesQuery: () => ({ data: ENTRIES }),
  useAssetsQuery: () => ({ data: ASSETS }),
}));

const { useEntryPickers } = await import('~/cms/lib/pickers');

afterEach(cleanup);

const newClient = (title: string) => ({
  getEntriesByIds: vi.fn(async (ids: readonly string[]) =>
    ids.map((id) => ({ id, contentType: 'page', fields: { title: { 'en-US': title } } })),
  ),
  listAssets: vi.fn(async () => ({ items: [] })),
});

describe('the entry pickers', () => {
  it('stay the same object when only the client changes, so the editor isn’t re-rendered', () => {
    client = newClient('first');
    const { result, rerender } = renderHook(() => useEntryPickers());
    const before = result.current.pickers;
    expect(before.entries).toEqual([
      { id: 'e1', contentType: 'page', title: 'Home', label: 'Home (page)' },
    ]);

    client = newClient('second');
    rerender();
    expect(result.current.pickers).toBe(before);
  });

  it('look links up through the client in force when the lookup runs', async () => {
    client = newClient('first');
    const { result, rerender } = renderHook(() => useEntryPickers());
    const stale = client;
    client = newClient('Far away');
    rerender();

    const found = await result.current.pickers.resolve?.('Entry', ['far']);
    expect(found).toEqual([
      { id: 'far', contentType: 'page', title: 'Far away', label: 'Far away (page)' },
    ]);
    expect(stale.getEntriesByIds).not.toHaveBeenCalled();
  });
});
