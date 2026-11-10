// @vitest-environment jsdom
import type { DeliveryClient, LiveEvent, LiveOptions } from '@contentworker/sdk-core';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ContentworkerProvider,
  type LiveAsyncState,
  useLiveEntries,
  useLiveEntry,
} from '../src/index';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const base = { scope: { spaceId: 's1', environmentId: 'main' }, occurredAt: '' };
const published = (entryId: string, contentTypeApiId = 'post'): LiveEvent => ({
  ...base,
  id: `p-${entryId}`,
  type: 'entry.published',
  entryId,
  contentTypeApiId,
  version: 2,
  fields: {},
});

function stubClient() {
  let n = 0;
  const listeners: LiveOptions[] = [];
  const close = vi.fn();
  const client = {
    getEntry: vi.fn(async (id: string) => ({ id, fields: { n: ++n }, publishedAt: `t${n}` })),
    listEntries: vi.fn(async () => ({ items: [], total: ++n })),
    live: vi.fn((o: LiveOptions) => {
      listeners.push(o);
      return { close, status: 'connecting' };
    }),
  } as unknown as DeliveryClient;
  return {
    client,
    close,
    listeners,
    emit: (e: LiveEvent) => {
      for (const l of listeners) l.onEvent(e);
    },
  };
}

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
});

const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

/** Runs `hook` as a component would, handing each render's value out. */
function Probe(props: { hook: () => unknown; out: (value: unknown) => void }) {
  props.out(props.hook());
  return null;
}

function render<T>(client: DeliveryClient, hook: () => T): { current: () => T } {
  let value!: T;
  const out = (v: unknown) => {
    value = v as T;
  };
  const el = document.createElement('div');
  root = createRoot(el);
  act(() =>
    root?.render(
      createElement(ContentworkerProvider, { client }, createElement(Probe, { hook, out })),
    ),
  );
  return { current: () => value };
}

describe('useLiveEntry', () => {
  it('reads the entry, then reads it again on its publish, but not on another entry’s', async () => {
    const s = stubClient();
    const r = render(s.client, () => useLiveEntry('e1', { delayMs: 0 }));
    await flush();
    const state = r.current() as LiveAsyncState<{ fields: { n: number } }>;
    expect(state).toMatchObject({ loading: false, data: { fields: { n: 1 } }, removed: false });
    expect(s.listeners[0]?.entryIds).toEqual(['e1']);

    act(() => s.emit(published('e2')));
    await flush();
    expect(s.client.getEntry).toHaveBeenCalledTimes(1);

    act(() => s.emit(published('e1')));
    await flush();
    expect(s.client.getEntry).toHaveBeenCalledTimes(2);
    expect((r.current() as LiveAsyncState<{ fields: { n: number } }>).data?.fields.n).toBe(2);
  });

  it('says it is live while the stream is open, and clears the entry when it is unpublished', async () => {
    const s = stubClient();
    const r = render(s.client, () => useLiveEntry('e1', { delayMs: 0 }));
    await flush();
    act(() => s.listeners[0]?.onStatus?.('open'));
    expect(r.current().live).toBe(true);
    act(() =>
      s.emit({
        ...base,
        id: 'u',
        type: 'entry.unpublished',
        entryId: 'e1',
        contentTypeApiId: 'post',
      }),
    );
    expect(r.current()).toMatchObject({ removed: true, data: undefined });
  });

  it('closes the stream on unmount', async () => {
    const s = stubClient();
    render(s.client, () => useLiveEntry('e1'));
    await flush();
    act(() => root?.unmount());
    root = undefined;
    expect(s.close).toHaveBeenCalledOnce();
  });
});

describe('useLiveEntries', () => {
  it('follows the query’s type and does not resubscribe for an equal query each render', async () => {
    const s = stubClient();
    const r = render(s.client, () => useLiveEntries({ contentType: 'post' }, { delayMs: 0 }));
    await flush();
    expect(s.listeners).toHaveLength(1);
    expect(s.listeners[0]?.contentTypes).toEqual(['post']);
    act(() => s.emit(published('e7')));
    await flush();
    expect(s.client.listEntries).toHaveBeenCalledTimes(2);
    expect(r.current().data?.total).toBe(2);
    expect(s.listeners).toHaveLength(1);
  });
});
