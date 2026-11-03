import type { ApiConfig } from '@contentworker/platform/config';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app';
import { testConfig } from './config';
import { wire } from './wire';

/**
 * Authorship over HTTP: Management and Preview serve who created an entry and changed it last,
 * `sys.createdBy=me` names the caller, and Delivery serves the first publish and nobody's id.
 */
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

const json = { 'Content-Type': 'application/json' };
const cma = { Authorization: 'Bearer cma', ...json };
const admin = { Authorization: 'Bearer admin', ...json };
const M = '/spaces/s1/environments/main';
const P = '/preview/s1/main';
const D = '/delivery/s1/main';

interface Authored {
  id: string;
  createdAt: string | null;
  createdBy: string | null;
  updatedBy: string | null;
  firstPublishedAt: string | null;
}

let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  const { ctx, rag, blob, ai } = wire(config);
  app = createApp(ctx, config, rag, blob, ai);
  await app.request(`${M}/content-types`, {
    method: 'POST',
    headers: cma,
    body: JSON.stringify({
      apiId: 'memo',
      name: 'Memo',
      displayField: 'title',
      fields: [
        {
          apiId: 'title',
          name: 'Title',
          type: 'Symbol',
          localized: false,
          required: true,
          position: 0,
        },
      ],
    }),
  });
  await app.request(`${M}/content-types/memo/published`, { method: 'POST', headers: cma });
});

const create = async (headers: Record<string, string>, title: string) => {
  const res = await app.request(`${M}/entries`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ contentTypeApiId: 'memo', fields: { title: { 'en-US': title } } }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { entry: Authored }).entry;
};

const previewList = async (headers: Record<string, string>, qs: string) => {
  const res = await app.request(`${P}/entries?content_type=memo&${qs}`, { headers });
  expect(res.status).toBe(200);
  return ((await res.json()) as { items: Authored[] }).items;
};

describe('entry authorship over HTTP', () => {
  it('serves who created and last changed an entry in Management and Preview', async () => {
    const created = await create(cma, 'Hello');
    expect(created).toMatchObject({ createdBy: 'cma', updatedBy: 'cma', firstPublishedAt: null });
    expect(created.createdAt).toEqual(expect.any(String));

    const saved = await app.request(`${M}/entries/${created.id}`, {
      method: 'PUT',
      headers: admin,
      body: JSON.stringify({ fields: { title: { 'en-US': 'Hello again' } } }),
    });
    expect(saved.status).toBe(200);
    const published = await app.request(`${M}/entries/${created.id}/published`, {
      method: 'POST',
      headers: admin,
    });
    expect(published.status).toBe(200);

    const got = (await (
      await app.request(`${M}/entries/${created.id}`, { headers: cma })
    ).json()) as { entry: Authored };
    expect(got.entry).toMatchObject({ createdBy: 'cma', updatedBy: 'admin-token' });
    expect(got.entry.firstPublishedAt).toEqual(expect.any(String));

    const [row] = await previewList(cma, '');
    expect(row).toMatchObject({
      id: created.id,
      createdBy: 'cma',
      updatedBy: 'admin-token',
      firstPublishedAt: got.entry.firstPublishedAt,
    });
  });

  it('lists the caller’s own entries with sys.createdBy=me', async () => {
    const mine = await create(cma, 'Mine');
    const theirs = await create(admin, 'Theirs');
    expect((await previewList(cma, 'sys.createdBy=me')).map((e) => e.id)).toEqual([mine.id]);
    expect((await previewList(admin, 'sys.createdBy=me')).map((e) => e.id)).toEqual([theirs.id]);
    expect((await previewList(cma, 'sys.createdBy[ne]=me')).map((e) => e.id)).toEqual([theirs.id]);
    expect((await previewList(cma, 'order=-sys.createdBy')).map((e) => e.createdBy)).toEqual([
      'cma',
      'admin-token',
    ]);
  });

  it('delivers the first publish, sorted by it, and no person or key ids', async () => {
    const ids: string[] = [];
    for (const title of ['One', 'Two']) {
      const e = await create(cma, title);
      await app.request(`${M}/entries/${e.id}/published`, { method: 'POST', headers: cma });
      ids.push(e.id);
    }
    const res = await app.request(`${D}/entries?content_type=memo&order=-sys.firstPublishedAt`, {
      headers: { Authorization: 'Bearer cda' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Record<string, unknown>[] };
    expect(body.items.map((e) => e.id)).toEqual([...ids].reverse());
    for (const item of body.items) {
      expect(item.firstPublishedAt).toEqual(expect.any(String));
      expect(item).not.toHaveProperty('createdBy');
      expect(item).not.toHaveProperty('updatedBy');
    }
    // And filtering on an author through Delivery finds nothing: it has none to compare.
    const byAuthor = await app.request(`${D}/entries?content_type=memo&sys.createdBy=cma`, {
      headers: { Authorization: 'Bearer cda' },
    });
    expect(((await byAuthor.json()) as { items: unknown[] }).items).toEqual([]);
  });
});
