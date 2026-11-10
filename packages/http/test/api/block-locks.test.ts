import { createContentType, publishContentType, SYSTEM_CALLER } from '@contentworker/application';
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
const cda = { Authorization: 'Bearer cda' };
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

const hero = (key: string) => ({ _type: 'hero', _key: key, heading: 'Hi' });

async function makeApp() {
  const wired = wire(config);
  const app = createApp(wired.ctx, config, wired.rag, wired.blob, wired.ai);
  await createContentType(wired.ctx, SYSTEM_CALLER, scope, {
    apiId: 'lpage',
    name: 'Locked page',
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
  await publishContentType(wired.ctx, scope, 'lpage');
  return { app, ctx: wired.ctx };
}

type App = Awaited<ReturnType<typeof makeApp>>['app'];
const send = (app: App, method: string, path: string, body?: unknown, headers = admin) =>
  app.request(path.startsWith('/') && !path.startsWith('/entries') ? path : `${M}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

async function page(app: App, keys: string[]) {
  const res = await send(app, 'POST', '/entries', {
    contentTypeApiId: 'lpage',
    fields: { title: { 'en-US': 'Home' }, body: { 'en-US': keys.map(hero) } },
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { entry: { id: string } }).entry.id;
}

/** A key bound to a role with these content grants and content:write. */
async function keyFor(app: App, actions: string[]) {
  const role = (await (
    await send(app, 'POST', '/spaces/s1/roles', {
      name: `r-${actions.join('-')}`,
      scopes: ['content:write', 'preview:read'],
      contentGrants: [{ contentTypeApiId: '*', actions }],
    })
  ).json()) as { id: string };
  const key = (await (
    await send(app, 'POST', '/spaces/s1/api-keys', { kind: 'cma', roleId: role.id })
  ).json()) as { token: string };
  return { Authorization: `Bearer ${key.token}`, 'Content-Type': 'application/json' };
}

describe('locked regions over HTTP', () => {
  it('sets, reads back, shows on the management read, and refuses a save that breaks one', async () => {
    const { app } = await makeApp();
    const id = await page(app, ['a', 'b', 'c']);
    expect(await (await send(app, 'GET', `/entries/${id}/block-locks`)).json()).toMatchObject({
      entryId: id,
      version: 1,
      locks: [],
      stale: [],
    });
    const set = await send(app, 'PUT', `/entries/${id}/block-locks`, {
      expectedVersion: 1,
      locks: [{ field: 'body', keys: ['a', 'b'] }],
    });
    expect(set.status).toBe(200);
    expect(await set.json()).toMatchObject({
      unchanged: false,
      version: 1,
      locks: [{ field: 'body', keys: ['a', 'b'], depth: 'subtree', freeze: 'structure' }],
    });
    const read = (await (await send(app, 'GET', `/entries/${id}`)).json()) as {
      entry: { blockLocks?: unknown[]; currentVersion: number };
    };
    expect(read.entry.currentVersion).toBe(1);
    expect(read.entry.blockLocks).toHaveLength(1);

    const broken = await send(app, 'PUT', `/entries/${id}`, {
      fields: { title: { 'en-US': 'Home' }, body: { 'en-US': [hero('b'), hero('a')] } },
    });
    expect(broken.status).toBe(422);
    expect(JSON.stringify(await broken.json())).toContain('region_locked');
  });

  it('refuses a stale expectedVersion (409), an overlap (422) and a malformed lock (400/422)', async () => {
    const { app } = await makeApp();
    const id = await page(app, ['a', 'b']);
    expect(
      (await send(app, 'PUT', `/entries/${id}/block-locks`, { expectedVersion: 2, locks: [] }))
        .status,
    ).toBe(409);
    const overlap = await send(app, 'PUT', `/entries/${id}/block-locks`, {
      locks: [
        { field: 'body', keys: ['a', 'b'] },
        { field: 'body', keys: ['b'] },
      ],
    });
    expect(overlap.status).toBe(422);
    expect(JSON.stringify(await overlap.json())).toContain('lock_overlaps');
    const malformed = await send(app, 'PUT', `/entries/${id}/block-locks`, {
      locks: [{ field: 'body', keys: [], depth: 'deep' }],
    });
    expect([400, 422]).toContain(malformed.status);
  });

  it('holds a version restore to the locks held now, unless the caller holds lock', async () => {
    const { app } = await makeApp();
    const id = await page(app, ['a']);
    // v2 adds b, which is then locked: restoring v1 would remove it.
    expect(
      (
        await send(app, 'PUT', `/entries/${id}`, {
          fields: { title: { 'en-US': 'Home' }, body: { 'en-US': [hero('a'), hero('b')] } },
        })
      ).status,
    ).toBe(200);
    await send(app, 'PUT', `/entries/${id}/block-locks`, {
      locks: [{ field: 'body', keys: ['b'] }],
    });
    const writer = await keyFor(app, ['read', 'write']);
    const refused = await send(app, 'POST', `/entries/${id}/versions/1/restore`, undefined, writer);
    expect(refused.status).toBe(422);
    expect(JSON.stringify(await refused.json())).toContain('region_locked');
    const locker = await keyFor(app, ['read', 'write', 'lock']);
    const restored = await send(
      app,
      'POST',
      `/entries/${id}/versions/1/restore`,
      undefined,
      locker,
    );
    expect(restored.status).toBe(200);
    expect(
      ((await restored.json()) as { entry: { currentVersion: number } }).entry.currentVersion,
    ).toBe(3);
  });

  it('takes content:write and the lock action to set; preview keys may read', async () => {
    const { app } = await makeApp();
    const id = await page(app, ['a']);
    const body = { locks: [{ field: 'body', keys: ['a'] }] };
    expect((await send(app, 'PUT', `/entries/${id}/block-locks`, body, cpa)).status).toBe(403);
    expect((await send(app, 'GET', `/entries/${id}/block-locks`, undefined, cpa)).status).toBe(200);
    const writer = await keyFor(app, ['read', 'write', 'publish']);
    const refused = await send(app, 'PUT', `/entries/${id}/block-locks`, body, writer);
    expect(refused.status).toBe(403);
    expect(JSON.stringify(await refused.json())).toContain('content:lock:lpage');
    // The editor's save is held to the lock even though it can't lift it.
    const locker = await keyFor(app, ['read', 'write', 'lock']);
    expect((await send(app, 'PUT', `/entries/${id}/block-locks`, body, locker)).status).toBe(200);
    expect(
      (
        await send(
          app,
          'PUT',
          `/entries/${id}`,
          { fields: { title: { 'en-US': 'Home' }, body: { 'en-US': [] } } },
          writer,
        )
      ).status,
    ).toBe(422);
    // A preview key reads the locks, but not who locked them (as it isn't told who wrote what).
    const seen = (await (
      await send(app, 'GET', `/entries/${id}/block-locks`, undefined, cpa)
    ).json()) as { locks: { field: string; lockedBy?: string }[] };
    expect(seen.locks).toHaveLength(1);
    expect(seen.locks[0]).not.toHaveProperty('lockedBy');
    const entry = (await (await send(app, 'GET', `/entries/${id}`, undefined, cpa)).json()) as {
      entry: { blockLocks?: { lockedBy?: string }[] };
    };
    expect(entry.entry.blockLocks?.[0]).toBeDefined();
    expect(entry.entry.blockLocks?.[0]).not.toHaveProperty('lockedBy');
    expect(
      (
        (await (
          await send(app, 'GET', `/entries/${id}/block-locks`, undefined, locker)
        ).json()) as {
          locks: { lockedBy?: string }[];
        }
      ).locks[0]?.lockedBy,
    ).toBeTruthy();
    // Anyone with lock may unlock, whoever locked.
    expect(
      (await send(app, 'PUT', `/entries/${id}/block-locks`, { locks: [] }, admin)).status,
    ).toBe(200);
  });

  it('never returns locks on Preview or Delivery', async () => {
    const { app } = await makeApp();
    const id = await page(app, ['a']);
    await send(app, 'PUT', `/entries/${id}/block-locks`, {
      locks: [{ field: 'body', keys: ['a'] }],
    });
    expect((await send(app, 'POST', `/entries/${id}/published`)).status).toBe(200);
    const preview = await app.request(`/preview/s1/main/entries/${id}`, { headers: cpa });
    expect(preview.status).toBe(200);
    expect(await preview.text()).not.toContain('lockedBy');
    const delivery = await app.request(`/delivery/s1/main/entries/${id}`, { headers: cda });
    expect(delivery.status).toBe(200);
    expect(await delivery.text()).not.toContain('lockedBy');
  });

  it('records each lock and unlock in the audit trail, against the entry', async () => {
    const { app, ctx } = await makeApp();
    const id = await page(app, ['a']);
    await send(app, 'PUT', `/entries/${id}/block-locks`, {
      locks: [{ field: 'body', keys: ['a'], freeze: 'all' }],
    });
    await send(app, 'PUT', `/entries/${id}/block-locks`, { locks: [] });
    const rows = (await ctx.store.audit.list('s1', { limit: 10 })).filter((r) =>
      r.action.endsWith('/block-locks'),
    );
    // Two rows can share a millisecond, so neither their order nor their ids say which came first.
    const region = { field: 'body', keys: ['a'], depth: 'subtree', freeze: 'all' };
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => [r.targetType, r.targetId, r.detail?.blockLocks])).toEqual(
      expect.arrayContaining([
        ['entry', id, { entryId: id, locked: [region], unlocked: [] }],
        ['entry', id, { entryId: id, locked: [], unlocked: [region] }],
      ]),
    );
  });
});
