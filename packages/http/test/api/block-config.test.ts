import {
  createContentType,
  publishContentType,
  pushBlockCatalog,
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

const NARROWING = {
  targets: [{ contentTypeApiId: 'cpage', field: 'body', blocks: ['grid'] }],
  blocks: [{ block: 'grid', slots: { items: { allowedChildren: ['card'], locked: true } } }],
};

async function makeApp() {
  const wired = wire(config);
  const app = createApp(wired.ctx, config, wired.rag, wired.blob, wired.ai);
  const ctx = wired.ctx;
  await createContentType(ctx, SYSTEM_CALLER, scope, {
    apiId: 'cpage',
    name: 'Config page',
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
  await publishContentType(ctx, scope, 'cpage');
  await pushBlockCatalog(ctx, SYSTEM_CALLER, scope, {
    blocks: [
      { id: 'hero', name: 'Hero', fields: [{ apiId: 'heading', name: 'Heading', type: 'Symbol' }] },
      {
        id: 'grid',
        name: 'Grid',
        fields: [],
        slots: [{ apiId: 'items', name: 'Items', allowedChildren: ['card', 'quote'], max: 6 }],
      },
      {
        id: 'card',
        name: 'Card',
        fields: [{ apiId: 'title', name: 'Title', type: 'Symbol' }],
        allowedParents: ['grid'],
      },
      {
        id: 'quote',
        name: 'Quote',
        fields: [{ apiId: 'text', name: 'Text', type: 'Symbol' }],
        allowedParents: ['grid'],
      },
    ],
    targets: [{ contentTypeApiId: 'cpage', field: 'body' }],
    allowDestructive: true,
  });
  return { app, ctx };
}

type App = Awaited<ReturnType<typeof makeApp>>['app'];
const send = (app: App, method: string, path: string, body?: unknown, headers = admin) =>
  app.request(`${M}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe('the block config over HTTP', () => {
  it('reads version 0, sets, reads back, and answers the rules in force', async () => {
    const { app } = await makeApp();
    expect(await (await send(app, 'GET', '/block-config')).json()).toEqual({
      version: 0,
      targets: [],
      blocks: [],
      updatedAt: null,
      updatedBy: null,
    });
    const set = await send(app, 'PUT', '/block-config', { expectedVersion: 0, ...NARROWING });
    expect(set.status).toBe(200);
    expect(await set.json()).toMatchObject({
      unchanged: false,
      config: { version: 1, ...NARROWING, updatedBy: 'admin-token' },
    });
    expect(await (await send(app, 'GET', '/block-config')).json()).toMatchObject({ version: 1 });
    const rules = await send(app, 'GET', '/block-config/effective');
    expect(rules.status).toBe(200);
    expect(await rules.json()).toMatchObject({
      catalogVersion: 1,
      configVersion: 1,
      targets: [{ contentTypeApiId: 'cpage', field: 'body', blocks: ['grid'] }],
      blocks: [{ block: 'grid', slots: { items: { allowedChildren: ['card'], locked: true } } }],
      stale: [],
    });
  });

  it('answers 422 naming a widening, 422 for a malformed body, and 409 for a stale version', async () => {
    const { app } = await makeApp();
    const wide = await send(app, 'PUT', '/block-config', {
      expectedVersion: 0,
      targets: [],
      blocks: [{ block: 'grid', slots: { items: { max: 9 } } }],
    });
    expect(wide.status).toBe(422);
    expect(JSON.stringify(await wide.json())).toContain('blocks[grid].slots.items.max');
    const malformed = await send(app, 'PUT', '/block-config', { targets: [], blocks: [] });
    expect(malformed.status).toBe(422);

    await send(app, 'PUT', '/block-config', { expectedVersion: 0, ...NARROWING });
    const stale = await send(app, 'PUT', '/block-config', {
      expectedVersion: 0,
      targets: [],
      blocks: [],
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { details: { version: 1 } } });
  });

  it('holds entry saves and block patches to it, with the issue codes', async () => {
    const { app } = await makeApp();
    await send(app, 'PUT', '/block-config', { expectedVersion: 0, ...NARROWING });
    const refused = await send(app, 'POST', '/entries', {
      contentTypeApiId: 'cpage',
      fields: { body: { 'en-US': [{ _type: 'hero', heading: 'Hi' }] } },
    });
    expect(refused.status).toBe(422);
    expect(JSON.stringify(await refused.json())).toContain('block_not_allowed_here');

    const made = await send(app, 'POST', '/entries', {
      contentTypeApiId: 'cpage',
      fields: { body: { 'en-US': [{ _type: 'grid', _key: 'g1', items: [] }] } },
    });
    expect(made.status).toBe(201);
    const { entry } = (await made.json()) as { entry: { id: string; currentVersion: number } };
    // The grid's slot is locked: nothing can be put in it.
    const patch = await send(app, 'PATCH', `/entries/${entry.id}/blocks`, {
      expectedVersion: entry.currentVersion,
      ops: [
        {
          op: 'insert',
          field: 'body',
          parent: { key: 'g1', slot: 'items' },
          block: { _type: 'card', title: 'One' },
        },
      ],
    });
    expect(patch.status).toBe(422);
    expect(JSON.stringify(await patch.json())).toContain('slot_locked');
  });

  it('needs content:manage to set; preview:read reads', async () => {
    const { app } = await makeApp();
    const body = { expectedVersion: 0, ...NARROWING };
    expect((await send(app, 'PUT', '/block-config', body, cpa)).status).toBe(403);
    expect((await send(app, 'GET', '/block-config', undefined, cpa)).status).toBe(200);
    expect((await send(app, 'GET', '/block-config/effective', undefined, cpa)).status).toBe(200);
  });

  it('refuses a Delivery key, and another space’s key, on every route', async () => {
    const { app } = await makeApp();
    const cda = { Authorization: 'Bearer cda', 'Content-Type': 'application/json' };
    expect((await send(app, 'GET', '/block-config', undefined, cda)).status).toBe(403);
    expect((await send(app, 'GET', '/block-config/effective', undefined, cda)).status).toBe(403);
    await app.request('/spaces', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ spaceId: 's2', name: 'Second', defaultLocale: 'en-US' }),
    });
    const mint = await app.request('/spaces/s2/api-keys', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ kind: 'cma', name: 's2 writer' }),
    });
    const { token } = (await mint.json()) as { token: string };
    const other = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const body = { expectedVersion: 0, ...NARROWING };
    expect((await send(app, 'PUT', '/block-config', body, other)).status).toBe(403);
    expect((await send(app, 'GET', '/block-config', undefined, other)).status).toBe(403);
    expect((await send(app, 'GET', '/block-config/effective', undefined, other)).status).toBe(403);
    // The same key works on its own space's config.
    const own = await app.request('/spaces/s2/environments/main/block-config', { headers: other });
    expect(own.status).toBe(200);
  });

  it('answers an oversized list with a bounded 422', async () => {
    const { app } = await makeApp();
    const huge = Array.from({ length: 5000 }, (_, i) => `block${i}`);
    const res = await send(app, 'PUT', '/block-config', {
      expectedVersion: 0,
      targets: [{ contentTypeApiId: 'cpage', field: 'body', blocks: huge }],
      blocks: [
        {
          block: 'grid',
          slots: Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`s${i}`, {}])),
        },
      ],
    });
    expect(res.status).toBe(422);
    expect((await res.text()).length).toBeLessThan(4000);
    // Within the request's bounds, the domain still names one problem per list, not per id.
    const wide = await send(app, 'PUT', '/block-config', {
      expectedVersion: 0,
      targets: [
        { contentTypeApiId: 'cpage', field: 'body', blocks: ['hero', 'card', 'quote', 'nope'] },
      ],
      blocks: [],
    });
    expect(wide.status).toBe(422);
    const issues = ((await wide.json()) as { error: { issues: unknown[] } }).error.issues;
    expect(issues).toHaveLength(1);
  });

  it('records the set in the audit trail, naming what it changed', async () => {
    const { app, ctx } = await makeApp();
    await send(app, 'PUT', '/block-config', { expectedVersion: 0, ...NARROWING });
    await send(app, 'PUT', '/block-config', {
      expectedVersion: 1,
      targets: NARROWING.targets,
      blocks: [],
    });
    // A set that changes nothing writes no change, and its row says so by having no detail.
    await send(app, 'PUT', '/block-config', {
      expectedVersion: 2,
      targets: NARROWING.targets,
      blocks: [],
    });
    const rows = await ctx.store.audit.list('s1', {
      action: 'PUT /spaces/:space/environments/:env/block-config',
    });
    const byVersion = rows.toSorted((a, b) =>
      String(b.targetId ?? '9').localeCompare(String(a.targetId ?? '9')),
    );
    expect(byVersion.map((r) => [r.targetType, r.targetId, r.detail?.blockConfig])).toEqual([
      [undefined, undefined, undefined],
      [
        'block_config',
        '2',
        {
          from: 1,
          to: 2,
          added: [],
          removed: ['blocks[grid].slots.items'],
          loosened: [],
          unlocked: ['blocks[grid].slots.items'],
        },
      ],
      [
        'block_config',
        '1',
        {
          from: 0,
          to: 1,
          added: ['targets[cpage.body]', 'blocks[grid].slots.items'],
          removed: [],
          loosened: [],
          unlocked: [],
        },
      ],
    ]);
  });

  it('is described in the OpenAPI document under its own tag', async () => {
    const { app } = await makeApp();
    const spec = (await (await app.request('/openapi.json')).json()) as {
      paths: Record<string, Record<string, { tags?: string[] }>>;
    };
    const path = spec.paths['/spaces/{space}/environments/{env}/block-config'];
    expect(path?.put?.tags).toEqual(['Block config']);
    expect(
      spec.paths['/spaces/{space}/environments/{env}/block-config/effective']?.get,
    ).toBeDefined();
  });
});
