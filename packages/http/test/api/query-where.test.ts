import type { ApiConfig } from '@contentworker/platform/config';
import { createDeliveryClient } from '@contentworker/sdk-core';
import { createManagementClient } from '@contentworker/sdk-management';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app';
import { testConfig } from './config';
import { wire } from './wire';

// Richer queries on every read surface: startsWith, between, component paths and `where` groups
// on Delivery, Preview and GraphQL, and a field's distinct values on Management.

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

const admin = { Authorization: 'Bearer admin', 'Content-Type': 'application/json' };
const M = '/spaces/s1/environments/main';
const D = '/delivery/s1/main';
const P = '/preview/s1/main';
const def = (apiId: string, type: string, position: number, extra = {}) => ({
  apiId,
  name: apiId,
  type,
  localized: false,
  required: false,
  position,
  ...extra,
});

type App = ReturnType<typeof createApp>;

async function seed(): Promise<App> {
  const { ctx, rag, blob, ai } = wire(config);
  const app = createApp(ctx, config, rag, blob, ai);
  const post = (path: string, body: unknown) =>
    app.request(path, { method: 'POST', headers: admin, body: JSON.stringify(body) });
  await post(`${M}/content-types`, {
    apiId: 'page',
    name: 'Page',
    displayField: 'title',
    fields: [
      def('title', 'Symbol', 0),
      def('views', 'Integer', 1),
      def('seo', 'Component', 2, {
        fields: [def('title', 'Symbol', 0), def('rank', 'Integer', 1)],
      }),
      def('tags', 'Array', 3, { items: { type: 'Symbol' } }),
      def('secret', 'Symbol', 4),
      def('body', 'RichText', 5),
    ],
  });
  await post(`${M}/content-types/page/published`, {});
  for (const [title, views, seo, tags] of [
    ['Apple', 10, 'Buy apples', ['fruit', 'red']],
    ['Apricot', 30, 'Apricots', ['fruit']],
    ['Banana', 50, 'Bananas', ['fruit', 'yellow']],
    ['Carrot', 70, 'Carrots', ['vegetable']],
  ] as const) {
    const res = await post(`${M}/entries`, {
      contentTypeApiId: 'page',
      fields: {
        title: { 'en-US': title },
        views: { 'en-US': views },
        seo: { 'en-US': { title: seo, rank: views / 10 } },
        tags: { 'en-US': tags },
      },
    });
    const { entry } = (await res.json()) as { entry: { id: string } };
    await post(`${M}/entries/${entry.id}/published`, {});
  }
  return app;
}

const get = (app: App, path: string, token: string) =>
  app.request(path, { headers: { Authorization: `Bearer ${token}` } });

const titles = async (app: App, path: string, token: string) => {
  const res = await get(app, path, token);
  expect(res.status, await res.clone().text()).toBe(200);
  const body = (await res.json()) as { items: { fields: { title: Record<string, string> } }[] };
  return body.items.map((i) => i.fields.title['en-US']).sort();
};

describe('richer queries over HTTP', () => {
  let app: App;
  beforeEach(async () => {
    app = await seed();
  });

  it('Delivery and Preview: startsWith, between and a component path', async () => {
    for (const [base, token] of [
      [`${D}/entries?content_type=page`, 'cda'],
      [`${P}/entries?content_type=page`, 'cpa'],
    ] as const) {
      expect(await titles(app, `${base}&fields.title[startsWith]=ap`, token)).toEqual([
        'Apple',
        'Apricot',
      ]);
      expect(await titles(app, `${base}&fields.views[between]=30,50`, token)).toEqual([
        'Apricot',
        'Banana',
      ]);
      expect(await titles(app, `${base}&fields.seo.title[match]=carrot`, token)).toEqual([
        'Carrot',
      ]);
    }
  });

  it('Delivery and Preview: a where parameter with OR and AND groups', async () => {
    const where = encodeURIComponent(
      JSON.stringify({
        or: [
          { field: 'fields.tags', value: 'vegetable' },
          {
            and: [
              { field: 'fields.seo.rank', op: 'lte', value: 3 },
              { field: 'fields.title', op: 'startsWith', value: 'Apr' },
            ],
          },
        ],
      }),
    );
    expect(await titles(app, `${D}/entries?content_type=page&where=${where}`, 'cda')).toEqual([
      'Apricot',
      'Carrot',
    ]);
    expect(await titles(app, `${P}/entries?content_type=page&where=${where}`, 'cpa')).toEqual([
      'Apricot',
      'Carrot',
    ]);
  });

  it('refuses a malformed where with 422 and the problem named', async () => {
    const where = encodeURIComponent(JSON.stringify({ or: [{ field: 'title', op: 'nope' }] }));
    const res = await get(app, `${D}/entries?where=${where}`, 'cda');
    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).toContain('where.or[0]');
    const notJson = await get(app, `${P}/entries?where=%7Bor`, 'cpa');
    expect(notJson.status).toBe(422);
  });

  it('GraphQL: and/or keys in where are groups', async () => {
    const res = await app.request(`${D}/graphql`, {
      method: 'POST',
      headers: { Authorization: 'Bearer cda', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: 'query ($where: JSON) { pageCollection(where: $where) { title } }',
        variables: {
          where: {
            'fields.views[gte]': 30,
            or: [
              { field: 'title', op: 'startsWith', value: 'B' },
              { field: 'seo.title', op: 'eq', value: 'Carrots' },
            ],
          },
        },
      }),
    });
    const body = (await res.json()) as { data: { pageCollection: { title: string }[] } };
    expect(body.data.pageCollection.map((p) => p.title).sort()).toEqual(['Banana', 'Carrot']);
  });
});

describe('richer queries through the SDKs', () => {
  it('the query builder and contentTypes.fieldValues reach the same answers', async () => {
    const app = await seed();
    const fetch = ((url: string | URL | Request, init?: RequestInit) =>
      app.request(String(url), init)) as typeof globalThis.fetch;
    const cda = createDeliveryClient({
      baseUrl: '',
      space: 's1',
      environment: 'main',
      token: 'cda',
      fetch,
    });
    const res = await cda
      .query()
      .contentType('page')
      .where('views', 'between', [20, 80])
      .or(
        { field: 'title', op: 'startsWith', value: 'Ap' },
        { field: 'seo.title', value: 'Carrots' },
      )
      .fetch();
    expect(
      res.items.map((i) => (i.fields.title as Record<string, string>)['en-US']).sort(),
    ).toEqual(['Apricot', 'Carrot']);
    const cma = createManagementClient({
      baseUrl: '',
      space: 's1',
      environment: 'main',
      token: 'cma',
      fetch,
    });
    const page = await cma.contentTypes.fieldValues('page', 'tags', { limit: 1 });
    expect(page.items).toEqual([{ value: 'fruit', count: 3 }]);
    expect(page.nextCursor).toBeTruthy();
  });
});

describe('distinct field values over HTTP', () => {
  let app: App;
  beforeEach(async () => {
    app = await seed();
  });
  const values = `${M}/content-types/page/fields`;

  it('lists each value with its count and pages with the cursor', async () => {
    const first = await get(app, `${values}/tags/values?limit=2`, 'cma');
    expect(first.status).toBe(200);
    const page = (await first.json()) as {
      items: { value: string; count: number }[];
      nextCursor?: string;
    };
    expect(page.items).toEqual([
      { value: 'fruit', count: 3 },
      { value: 'red', count: 1 },
    ]);
    const rest = await get(
      app,
      `${values}/tags/values?limit=2&cursor=${page.nextCursor as string}`,
      'cma',
    );
    expect(((await rest.json()) as { items: unknown[] }).items).toEqual([
      { value: 'vegetable', count: 1 },
      { value: 'yellow', count: 1 },
    ]);
    const numbers = await get(app, `${values}/views/values`, 'cma');
    expect(
      ((await numbers.json()) as { items: { value: unknown }[] }).items.map((i) => i.value),
    ).toEqual([10, 30, 50, 70]);
  });

  it('refuses a structured field (422), an unknown type (404) and a forged cursor (422)', async () => {
    expect((await get(app, `${values}/body/values`, 'cma')).status).toBe(422);
    expect((await get(app, `${values}/nope/values`, 'cma')).status).toBe(422);
    expect((await get(app, `${M}/content-types/nope/fields/title/values`, 'cma')).status).toBe(404);
    expect((await get(app, `${values}/title/values?cursor=xyz`, 'cma')).status).toBe(422);
  });

  it('refuses a field the key may not read (403)', async () => {
    const roleRes = await app.request('/spaces/s1/roles', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({
        name: 'Reader',
        scopes: ['preview:read'],
        contentGrants: [{ contentTypeApiId: 'page', actions: ['read'], deniedFields: ['secret'] }],
      }),
    });
    const role = (await roleRes.json()) as { id: string };
    const keyRes = await app.request('/spaces/s1/api-keys', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ kind: 'cma', roleId: role.id }),
    });
    const { token } = (await keyRes.json()) as { token: string };
    expect((await get(app, `${values}/secret/values`, token)).status).toBe(403);
    expect((await get(app, `${values}/title/values`, token)).status).toBe(200);
  });
});
