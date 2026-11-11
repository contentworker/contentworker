// @vitest-environment jsdom
import type { DeliveryClient, EntryPage, EntryQuery } from '@contentworker/sdk-core';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type AsyncState, ContentworkerProvider, useEntries } from '../src/index';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
});

const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

function Probe(props: { query: EntryQuery; out: (value: AsyncState<EntryPage>) => void }) {
  props.out(useEntries(props.query));
  return null;
}

describe('useEntries', () => {
  it('reads the next page when the cursor changes, and hands back nextCursor', async () => {
    const listEntries = vi.fn(async (q: EntryQuery) =>
      q.cursor
        ? { items: [{ id: 'e2', contentType: 'post', fields: {} }], total: 1 }
        : { items: [{ id: 'e1', contentType: 'post', fields: {} }], total: 1, nextCursor: 'c2' },
    );
    const client = { listEntries } as unknown as DeliveryClient;
    let state: AsyncState<EntryPage> = { loading: true };
    const out = (v: AsyncState<EntryPage>) => {
      state = v;
    };
    root = createRoot(document.createElement('div'));
    const show = (query: EntryQuery) =>
      act(() =>
        root?.render(
          createElement(ContentworkerProvider, { client }, createElement(Probe, { query, out })),
        ),
      );

    show({ contentType: 'post', limit: 1 });
    await flush();
    expect(state.data?.items.map((e) => e.id)).toEqual(['e1']);
    expect(state.data?.nextCursor).toBe('c2');

    // An equal query made fresh is not a new read.
    show({ contentType: 'post', limit: 1 });
    await flush();
    expect(listEntries).toHaveBeenCalledTimes(1);

    show({ contentType: 'post', limit: 1, cursor: state.data?.nextCursor });
    await flush();
    expect(state.data?.items.map((e) => e.id)).toEqual(['e2']);
    expect(listEntries).toHaveBeenLastCalledWith({ contentType: 'post', limit: 1, cursor: 'c2' });
  });

  it('reads again when a filter value changes, and not for an equal query', async () => {
    const listEntries = vi.fn(async () => ({ items: [], total: 0 }));
    const client = { listEntries } as unknown as DeliveryClient;
    root = createRoot(document.createElement('div'));
    const show = (query: EntryQuery) =>
      act(() =>
        root?.render(
          createElement(
            ContentworkerProvider,
            { client },
            createElement(Probe, { query, out: () => {} }),
          ),
        ),
      );
    const byAuthor = (id: string): EntryQuery => ({
      contentType: 'post',
      filters: [{ field: 'author', op: 'ref', value: id }],
    });

    show(byAuthor('a1'));
    await flush();
    show(byAuthor('a1'));
    await flush();
    expect(listEntries).toHaveBeenCalledTimes(1);

    show(byAuthor('a2'));
    await flush();
    expect(listEntries).toHaveBeenCalledTimes(2);
    expect(listEntries).toHaveBeenLastCalledWith(byAuthor('a2'));
  });
});
