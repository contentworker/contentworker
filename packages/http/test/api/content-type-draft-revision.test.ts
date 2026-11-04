import type { ApiConfig } from '@contentworker/platform/config';
import type { InMemoryContentStore } from '@contentworker/test-kit';
import { describe, expect, it } from 'vitest';
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

const cma = { Authorization: 'Bearer cma', 'Content-Type': 'application/json' };
const cda = { Authorization: 'Bearer cda', 'Content-Type': 'application/json' };
const M = '/spaces/s1/environments/main';
const D = '/delivery/s1/main';

const field = (apiId: string, type: string, position: number) => ({
  apiId,
  name: apiId,
  type,
  localized: false,
  required: false,
  position,
});
const fields = [field('title', 'Symbol', 0), field('slug', 'Slug', 1)];
const definition = {
  apiId: 'page',
  name: 'Page',
  displayField: 'title',
  urlPattern: '/{slug}',
  fields,
};

/** An app with a published `page` type holding one published entry. */
async function setup() {
  const wired = wire(config);
  const app = createApp(wired.ctx, config, wired.rag, wired.blob, wired.ai);
  const save = (body: unknown) =>
    app.request(`${M}/content-types`, {
      method: 'POST',
      headers: cma,
      body: JSON.stringify(body),
    });
  const publish = (apiId: string) =>
    app.request(`${M}/content-types/${apiId}/published`, { method: 'POST', headers: cma });
  const entry = async (contentTypeApiId: string, slug: string) => {
    const res = await app.request(`${M}/entries`, {
      method: 'POST',
      headers: cma,
      body: JSON.stringify({
        contentTypeApiId,
        fields: { title: { 'en-US': slug }, slug: { 'en-US': slug } },
      }),
    });
    expect(res.status).toBe(201);
    const { entry: made } = (await res.json()) as { entry: { id: string } };
    const done = await app.request(`${M}/entries/${made.id}/published`, {
      method: 'POST',
      headers: cma,
    });
    expect(done.status).toBe(200);
    return made.id;
  };
  const graphql = async (query: string) => {
    const res = await app.request(`${D}/graphql`, {
      method: 'POST',
      headers: cda,
      body: JSON.stringify({ query }),
    });
    return {
      status: res.status,
      body: (await res.json()) as { data?: Record<string, unknown>; errors?: unknown[] },
    };
  };
  const routes = async () => {
    const res = await app.request(`${D}/routes`, { headers: cda });
    return ((await res.json()) as { items: unknown[] }).items;
  };
  expect((await save(definition)).status).toBe(201);
  expect((await publish('page')).status).toBe(200);
  await entry('page', 'about');
  return { app, wired, save, publish, entry, graphql, routes };
}

/**
 * `it.fails` because Delivery doesn't hold to this yet: `content_types` keeps one definition per
 * type, so a draft save overwrites the published one. Each turns red when Delivery gets a published
 * definition to read; drop the `.fails` then.
 */
describe('Delivery while a live type has an unpublished revision', () => {
  it.fails('keeps a draft field out of GraphQL until the type is published', async () => {
    const { save, publish, graphql } = await setup();
    const query = '{ pageCollection { subtitle } }';
    expect((await graphql(query)).status).toBe(400);

    await save({ ...definition, fields: [...fields, field('subtitle', 'Symbol', 2)] });
    expect((await graphql(query)).status).toBe(400);

    await publish('page');
    expect((await graphql(query)).status).toBe(200);
  });

  it.fails('keeps a field’s published type in GraphQL through a draft that changes it', async () => {
    const { save, graphql } = await setup();
    const query = '{ pageCollection { title } }';
    expect((await graphql(query)).body.errors).toBeUndefined();
    await save({
      ...definition,
      fields: [field('title', 'Integer', 0), field('slug', 'Slug', 1)],
    });
    expect((await graphql(query)).body).toEqual({
      data: { pageCollection: [{ title: 'about' }] },
    });
  });

  it.fails('keeps a live type in the routes through a draft revision', async () => {
    const { save, routes } = await setup();
    await save({ ...definition, name: 'Pages' });
    expect(await routes()).toEqual([{ contentType: 'page', urlPattern: '/{slug}' }]);
  });

  it.fails('keeps a live type in the routes through a save that changes nothing', async () => {
    const { save, routes } = await setup();
    await save(definition);
    expect(await routes()).toEqual([{ contentType: 'page', urlPattern: '/{slug}' }]);
  });

  it.fails('holds a draft URL pattern back until the type is published', async () => {
    const { save, routes } = await setup();
    await save({ ...definition, urlPattern: '/pages/{slug}' });
    expect(await routes()).toEqual([{ contentType: 'page', urlPattern: '/{slug}' }]);
  });
});

describe('what Delivery does today', () => {
  it('serves an entry of a never-published type over REST and GraphQL today', async () => {
    const { app, save, entry, graphql, routes } = await setup();
    await save({ ...definition, apiId: 'event' });
    const id = await entry('event', 'launch');
    expect((await app.request(`${D}/entries/${id}`, { headers: cda })).status).toBe(200);
    expect((await graphql('{ eventCollection { title } }')).body.data).toEqual({
      eventCollection: [{ title: 'launch' }],
    });
    expect(await routes()).toEqual([{ contentType: 'page', urlPattern: '/{slug}' }]);
  });

  it('announces nothing for a draft save, so no purge follows', async () => {
    const { wired, save } = await setup();
    const store = wired.ctx.store as unknown as InMemoryContentStore;
    const count = () => store.allEvents().filter((e) => e.type.startsWith('content_type.')).length;
    const was = count();
    await save({ ...definition, name: 'Pages' });
    expect(count()).toBe(was);
  });
});
