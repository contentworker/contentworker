/**
 * Entry list paging through the SDK clients, against the real api in process: Preview pages by
 * cursor and refuses `skip`, Delivery pages by `skip`, so each client must send what its list
 * takes.
 */
import type { ApiConfig } from '@contentworker/platform/config';
import { createDeliveryClient } from '@contentworker/sdk-core';
import { createManagementClient } from '@contentworker/sdk-management';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app';
import { testConfig } from './config';
import { wire } from './wire';

const config: ApiConfig = testConfig({
  role: 'all',
  cmaKey: 'cma',
  cdaKey: 'cda',
  cpaKey: 'cpa',
  adminToken: 'admin',
  seed: {
    spaceId: 's1',
    environmentId: 'main',
    defaultLocale: 'en-US',
    locales: ['en-US'],
    scale: 1,
  },
});

const M = '/spaces/s1/environments/main';
const post = (token: string, body?: unknown) => ({
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  ...(body ? { body: JSON.stringify(body) } : {}),
});

let app: ReturnType<typeof createApp>;
const ids: string[] = [];
const appFetch = ((url: string | URL | Request, init?: RequestInit) =>
  app.request(String(url), init)) as typeof fetch;

/** Five published notes: two pages of two and a last of one. */
beforeAll(async () => {
  const wired = wire(config);
  app = createApp(wired.ctx, config, wired.rag, wired.blob, wired.ai);
  await app.request(
    `${M}/content-types`,
    post('cma', {
      apiId: 'note',
      name: 'Note',
      displayField: 'title',
      fields: [{ apiId: 'title', name: 'Title', type: 'Symbol', localized: false, required: true }],
    }),
  );
  await app.request(`${M}/content-types/note/published`, post('cma'));
  for (let i = 0; i < 5; i++) {
    const res = await app.request(
      `${M}/entries`,
      post('cma', { contentTypeApiId: 'note', fields: { title: { 'en-US': `Note ${i}` } } }),
    );
    const { entry } = (await res.json()) as { entry: { id: string } };
    await app.request(`${M}/entries/${entry.id}/published`, post('cma'));
    ids.push(entry.id);
  }
});

const preview = () =>
  createDeliveryClient({
    baseUrl: '',
    space: 's1',
    environment: 'main',
    token: 'cpa',
    preview: true,
    fetch: appFetch,
  });

const delivery = () =>
  createDeliveryClient({
    baseUrl: '',
    space: 's1',
    environment: 'main',
    token: 'cda',
    fetch: appFetch,
  });

const management = () =>
  createManagementClient({
    baseUrl: '',
    space: 's1',
    environment: 'main',
    token: 'cma',
    fetch: appFetch,
  });

const sorted = (xs: readonly string[]) => [...xs].sort();

describe('entry paging through the SDK', () => {
  it('a preview client given skip reads the page after it, not a 422', async () => {
    const all = await preview().listEntries({ contentType: 'note' });
    const page = await preview().listEntries({ contentType: 'note', limit: 2, skip: 2 });
    expect(page.items.map((e) => e.id)).toEqual(all.items.slice(2, 4).map((e) => e.id));
    // Past the end is an empty page, as an offset past the end would be.
    expect((await preview().listEntries({ contentType: 'note', skip: 5 })).items).toEqual([]);
  });

  it('management entries.list given skip reads the page after it, not a 422', async () => {
    const all = await management().entries.list({ contentType: 'note' });
    const page = await management().entries.list({ contentType: 'note', limit: 2, skip: 2 });
    expect(page.items.map((e) => e.id)).toEqual(all.items.slice(2, 4).map((e) => e.id));
  });

  it('a preview client pages by nextCursor, every entry once', async () => {
    const client = preview();
    const first = await client.listEntries({ contentType: 'note', limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBeTypeOf('string');
    const second = await client.listEntries({
      contentType: 'note',
      limit: 2,
      cursor: first.nextCursor,
    });
    expect(second.items).toHaveLength(2);
    const seen: string[] = [];
    for await (const e of client.iterateEntries({ contentType: 'note', limit: 2 })) seen.push(e.id);
    expect(seen.slice(0, 4)).toEqual([...first.items, ...second.items].map((e) => e.id));
    expect(sorted(seen)).toEqual(sorted(ids));
    // The builder pages the same way.
    const built = await client
      .query()
      .contentType('note')
      .limit(2)
      .cursor(first.nextCursor ?? '')
      .fetch();
    expect(built.items.map((e) => e.id)).toEqual(second.items.map((e) => e.id));
  });

  it('management entries.list pages by nextCursor, and iterate reads every entry once', async () => {
    const cma = management();
    const first = await cma.entries.list({ contentType: 'note', limit: 2 });
    expect(first.nextCursor).toBeTypeOf('string');
    const second = await cma.entries.list({
      contentType: 'note',
      limit: 2,
      cursor: first.nextCursor,
    });
    expect(second.items).toHaveLength(2);
    expect(second.items.map((e) => e.id)).not.toContain(first.items[0]?.id);
    const seen: string[] = [];
    for await (const e of cma.entries.iterate({ contentType: 'note', limit: 2 })) seen.push(e.id);
    expect(sorted(seen)).toEqual(sorted(ids));
  });

  it('a Delivery client still pages by skip, and iterates every entry once', async () => {
    const client = delivery();
    const all = await client.listEntries({ contentType: 'note' });
    const second = await client.listEntries({ contentType: 'note', limit: 2, skip: 2 });
    expect(second.items.map((e) => e.id)).toEqual(all.items.slice(2, 4).map((e) => e.id));
    const seen: string[] = [];
    for await (const e of client.iterateEntries({ contentType: 'note', limit: 2 })) seen.push(e.id);
    expect(sorted(seen)).toEqual(sorted(ids));
  });
});
