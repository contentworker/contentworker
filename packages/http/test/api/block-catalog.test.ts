import {
  createContentType,
  createEntry,
  publishContentType,
  SYSTEM_CALLER,
} from '@contentworker/application';
import type { FieldDefinition } from '@contentworker/domain';
import type { ApiConfig } from '@contentworker/platform/config';
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

const admin = { Authorization: 'Bearer admin', 'Content-Type': 'application/json' };
const cpa = { Authorization: 'Bearer cpa', 'Content-Type': 'application/json' };
const M = '/spaces/s1/environments/main';
const scope = { spaceId: 's1', environmentId: 'main' };

const field = (over: Partial<FieldDefinition> & Pick<FieldDefinition, 'apiId' | 'type'>) =>
  ({
    name: over.apiId,
    localized: false,
    required: false,
    position: 0,
    ...over,
  }) as FieldDefinition;

const BLOCKS = [
  {
    id: 'hero',
    name: 'Hero',
    group: 'Headers',
    thumbnail: { url: 'https://cdn.example/hero.png' },
    fields: [
      { apiId: 'heading', name: 'Heading', type: 'Symbol', required: true },
      { apiId: 'tone', name: 'Tone', type: 'Symbol', validations: { in: ['light', 'dark'] } },
    ],
  },
  {
    id: 'grid',
    name: 'Grid',
    fields: [],
    slots: [{ apiId: 'items', name: 'Items', allowedChildren: ['card'], max: 6 }],
  },
  {
    id: 'card',
    name: 'Card',
    fields: [{ apiId: 'title', name: 'Title', type: 'Symbol' }],
    allowedParents: ['grid'],
  },
];
const TARGETS = [{ contentTypeApiId: 'bpage', field: 'body' }];

async function makeApp() {
  const wired = wire(config);
  const app = createApp(wired.ctx, config, wired.rag, wired.blob, wired.ai);
  const ctx = wired.ctx;
  await createContentType(ctx, SYSTEM_CALLER, scope, {
    apiId: 'bpage',
    name: 'Block page',
    displayField: 'title',
    fields: [
      field({ apiId: 'title', type: 'Symbol' }),
      field({
        apiId: 'body',
        type: 'Array',
        position: 1,
        items: {
          type: 'Component',
          variants: [
            { apiId: 'hero', name: 'Hero', fields: [field({ apiId: 'heading', type: 'Symbol' })] },
          ],
        },
      }),
    ],
  });
  await publishContentType(ctx, scope, 'bpage');
  return { app, ctx };
}

type App = Awaited<ReturnType<typeof makeApp>>['app'];
const send = (app: App, method: string, path: string, body?: unknown, headers = admin) =>
  app.request(`${M}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe('the block catalog over HTTP', () => {
  it('is 404 before the first push, then dry-runs, pushes and reads back', async () => {
    const { app } = await makeApp();
    expect((await send(app, 'GET', '/block-catalog')).status).toBe(404);

    const dry = await send(app, 'POST', '/block-catalog', {
      blocks: BLOCKS,
      targets: TARGETS,
      dryRun: true,
    });
    expect(dry.status).toBe(200);
    const plan = (await dry.json()) as Record<string, unknown>;
    expect(plan).toMatchObject({
      dryRun: true,
      applied: false,
      previousVersion: 0,
      version: 1,
      changes: { added: ['hero', 'grid', 'card'] },
      contentTypes: [
        {
          contentTypeApiId: 'bpage',
          fields: [{ field: 'body', added: ['grid'], changed: ['hero'] }],
        },
      ],
    });
    expect((await send(app, 'GET', '/block-catalog')).status).toBe(404);

    const pushed = await send(app, 'POST', '/block-catalog', {
      blocks: BLOCKS,
      targets: TARGETS,
      expectedVersion: 0,
    });
    expect(pushed.status).toBe(200);
    expect(await pushed.json()).toMatchObject({ applied: true, version: 1 });

    const got = (await (await send(app, 'GET', '/block-catalog')).json()) as {
      version: number;
      blocks: { id: string; thumbnail?: unknown }[];
      pushedBy: string;
    };
    expect(got.version).toBe(1);
    expect(got.blocks.map((b) => b.id)).toEqual(['hero', 'grid', 'card']);
    expect(got.blocks[0]?.thumbnail).toEqual({ url: 'https://cdn.example/hero.png' });
    expect(got.pushedBy).toBe('admin-token');

    const type = (await (await send(app, 'GET', '/content-types/bpage')).json()) as {
      fields: { apiId: string; items?: { variants?: { apiId: string }[] } }[];
    };
    expect(type.fields[1]?.items?.variants?.map((v) => v.apiId)).toEqual(['hero', 'grid']);

    const versions = (await (await send(app, 'GET', '/block-catalog/versions')).json()) as {
      items: { version: number; blockCount: number }[];
    };
    expect(versions.items).toMatchObject([{ version: 1, blockCount: 3 }]);
    expect((await send(app, 'GET', '/block-catalog/versions/1')).status).toBe(200);
    expect((await send(app, 'GET', '/block-catalog/versions/2')).status).toBe(404);
    expect((await send(app, 'GET', '/block-catalog/versions/abc')).status).toBe(422);
  });

  it('answers 422 naming each manifest problem, and 409 for a stale version or a block in use', async () => {
    const { app, ctx } = await makeApp();
    const bad = await send(app, 'POST', '/block-catalog', {
      blocks: [{ id: 'box', name: 'Box', fields: [{ apiId: 'css', name: 'CSS', type: 'Symbol' }] }],
      targets: TARGETS,
    });
    expect(bad.status).toBe(422);
    expect(JSON.stringify(await bad.json())).toContain('blocks[box].css');

    await send(app, 'POST', '/block-catalog', { blocks: BLOCKS, targets: TARGETS });
    const stale = await send(app, 'POST', '/block-catalog', {
      blocks: BLOCKS.slice(0, 1),
      targets: TARGETS,
      expectedVersion: 0,
    });
    expect(stale.status).toBe(409);

    await createEntry(ctx, scope, {
      contentTypeApiId: 'bpage',
      fields: { title: { 'en-US': 'Home' }, body: { 'en-US': [{ _type: 'grid', items: [] }] } },
    });
    const removing = await send(app, 'POST', '/block-catalog', {
      blocks: BLOCKS.slice(0, 1),
      targets: TARGETS,
      allowDestructive: true,
    });
    expect(removing.status).toBe(409);
    const err = (await removing.json()) as { error: { details?: { inUse?: unknown[] } } };
    expect(err.error.details?.inUse).toMatchObject([
      { contentTypeApiId: 'bpage', at: 'body: grid' },
    ]);
  });

  it('needs content:manage to push; preview:read reads the catalog and its usage', async () => {
    const { app, ctx } = await makeApp();
    expect(
      (await send(app, 'POST', '/block-catalog', { blocks: BLOCKS, targets: TARGETS }, cpa)).status,
    ).toBe(403);
    await send(app, 'POST', '/block-catalog', { blocks: BLOCKS, targets: TARGETS });
    await createEntry(ctx, scope, {
      contentTypeApiId: 'bpage',
      fields: { title: { 'en-US': 'Home' }, body: { 'en-US': [{ _type: 'hero', heading: 'Hi' }] } },
    });
    expect((await send(app, 'GET', '/block-catalog', undefined, cpa)).status).toBe(200);
    const usage = await send(app, 'GET', '/block-catalog/usage', undefined, cpa);
    expect(usage.status).toBe(200);
    expect(await usage.json()).toMatchObject({
      version: 1,
      complete: true,
      blocks: [
        { id: 'hero', entries: 1, contentTypes: [{ contentTypeApiId: 'bpage', entries: 1 }] },
        { id: 'grid', entries: 0 },
        { id: 'card', entries: 0 },
      ],
    });
  });

  it('is described in the OpenAPI document under its own tag', async () => {
    const { app } = await makeApp();
    const spec = (await (await app.request('/openapi.json')).json()) as {
      paths: Record<string, Record<string, { tags?: string[] }>>;
    };
    const path = spec.paths['/spaces/{space}/environments/{env}/block-catalog'];
    expect(path?.post?.tags).toEqual(['Block catalog']);
    expect(spec.paths['/spaces/{space}/environments/{env}/block-catalog/usage']?.get).toBeDefined();
  });
});
