// @vitest-environment jsdom
import type { DeliveryClient, LiveEvent, LiveOptions } from '@contentworker/sdk-core';
import { describe, expect, it, vi } from 'vitest';
import { type App, createApp, defineComponent, h, nextTick, ref } from 'vue';
import { createContentworker, useLiveEntries, useLiveEntry } from '../src/index.js';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const base = { scope: { spaceId: 's1', environmentId: 'main' }, occurredAt: '' };
const published = (entryId: string): LiveEvent => ({
  ...base,
  id: `p-${entryId}`,
  type: 'entry.published',
  entryId,
  contentTypeApiId: 'post',
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
  const emit = (e: LiveEvent) => {
    for (const l of listeners) l.onEvent(e);
  };
  return { client, listeners, close, emit };
}

function withSetup<T>(client: DeliveryClient, setup: () => T): { result: T; app: App } {
  let result!: T;
  const app = createApp(
    defineComponent({
      setup() {
        result = setup();
        return () => h('div');
      },
    }),
  );
  app.use(createContentworker(client));
  app.mount(document.createElement('div'));
  return { result, app };
}

describe('useLiveEntry (Vue)', () => {
  it('reads on mount, reads again on its publish (not another’s), and clears on unpublish', async () => {
    const s = stubClient();
    const { result, app } = withSetup(s.client, () => useLiveEntry('e1', { delayMs: 0 }));
    await flush();
    expect(result.loading.value).toBe(false);
    expect((result.data.value as unknown as { fields: { n: number } }).fields.n).toBe(1);
    s.emit(published('e2'));
    await flush();
    expect(s.client.getEntry).toHaveBeenCalledTimes(1);
    s.emit(published('e1'));
    await flush();
    expect(s.client.getEntry).toHaveBeenCalledTimes(2);
    s.listeners[0]?.onStatus?.('open');
    expect(result.live.value).toBe(true);
    s.emit({
      ...base,
      id: 'u',
      type: 'entry.unpublished',
      entryId: 'e1',
      contentTypeApiId: 'post',
    });
    expect(result.removed.value).toBe(true);
    expect(result.data.value).toBeUndefined();
    app.unmount();
    expect(s.close).toHaveBeenCalledOnce();
  });

  it('re-subscribes when the id changes, closing the old stream', async () => {
    const s = stubClient();
    const id = ref('a');
    const { app } = withSetup(s.client, () => useLiveEntry(id, { delayMs: 0 }));
    await flush();
    id.value = 'b';
    await nextTick();
    await flush();
    expect(s.listeners.map((l) => l.entryIds)).toEqual([['a'], ['b']]);
    expect(s.close).toHaveBeenCalledOnce();
    app.unmount();
  });
});

describe('useLiveEntries (Vue)', () => {
  it('follows the query’s type and lists again on a change', async () => {
    const s = stubClient();
    const { result, app } = withSetup(s.client, () =>
      useLiveEntries({ contentType: 'post' }, { delayMs: 0 }),
    );
    await flush();
    expect(s.listeners[0]?.contentTypes).toEqual(['post']);
    s.emit(published('e9'));
    await flush();
    expect(result.data.value?.total).toBe(2);
    app.unmount();
  });
});
