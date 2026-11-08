import type { ApiConfig } from '@contentworker/platform/config';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app';
import { testConfig } from './config';
import { wire } from './wire';

const config: ApiConfig = testConfig({
  role: 'all',
  cmaKey: 'cma',
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
const M = '/spaces/s1/environments/main';

async function setUp() {
  const { ctx, rag, blob, ai } = wire(config);
  const app = createApp(ctx, config, rag, blob, ai);
  await app.request(`${M}/content-types`, {
    method: 'POST',
    headers: cma,
    body: JSON.stringify({
      apiId: 'held',
      name: 'Held',
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
  await app.request(`${M}/content-types/held/published`, { method: 'POST', headers: cma });
  const created = await app.request(`${M}/entries`, {
    method: 'POST',
    headers: cma,
    body: JSON.stringify({ contentTypeApiId: 'held', fields: { title: { 'en-US': 'Seen' } } }),
  });
  const { entry } = (await created.json()) as { entry: { id: string } };
  const save = (title: string) =>
    app.request(`${M}/entries/${entry.id}`, {
      method: 'PUT',
      headers: cma,
      body: JSON.stringify({ fields: { title: { 'en-US': title } } }),
    });
  return { app, id: entry.id, save };
}

describe('REST writes held to ?expectedVersion', () => {
  it('publishes at the version read, and answers 409 once a newer draft was saved', async () => {
    const { app, id, save } = await setUp();
    expect((await save('Unseen')).status).toBe(200);
    const stale = await app.request(`${M}/entries/${id}/published?expectedVersion=1`, {
      method: 'POST',
      headers: cma,
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      error: { code: 'conflict', message: expect.stringMatching(/version 2, not 1/) },
    });
    const fresh = await app.request(`${M}/entries/${id}/published?expectedVersion=2`, {
      method: 'POST',
      headers: cma,
    });
    expect(fresh.status).toBe(200);
  });

  it('holds unpublish and restore the same way', async () => {
    const { app, id, save } = await setUp();
    await app.request(`${M}/entries/${id}/published`, { method: 'POST', headers: cma });
    await save('Unseen');
    const unpublish = await app.request(`${M}/entries/${id}/published?expectedVersion=1`, {
      method: 'DELETE',
      headers: cma,
    });
    expect(unpublish.status).toBe(409);
    const restore = await app.request(`${M}/entries/${id}/versions/1/restore?expectedVersion=1`, {
      method: 'POST',
      headers: cma,
    });
    expect(restore.status).toBe(409);
  });

  it('holds a draft save to the version it was edited from', async () => {
    const { app, id, save } = await setUp();
    expect((await save('Theirs')).status).toBe(200);
    const put = (expectedVersion: number) =>
      app.request(`${M}/entries/${id}`, {
        method: 'PUT',
        headers: cma,
        body: JSON.stringify({ fields: { title: { 'en-US': 'Mine' } }, expectedVersion }),
      });
    const stale = await put(1);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      error: { code: 'conflict', message: expect.stringMatching(/version 2, not 1/) },
    });
    // Nothing was saved: the entry still holds the other save.
    const read = await app.request(`${M}/entries/${id}`, { headers: cma });
    expect(await read.json()).toMatchObject({
      entry: { currentVersion: 2 },
      fields: { title: { 'en-US': 'Theirs' } },
    });
    const fresh = await put(2);
    expect(fresh.status).toBe(200);
    expect(await fresh.json()).toMatchObject({ entry: { currentVersion: 3 } });
    expect((await put(0)).status).toBe(422);
  });

  it('refuses a writer who may not write the type before it says anything of the version', async () => {
    const { app, id, save } = await setUp();
    expect((await save('Theirs')).status).toBe(200);
    const admin = { Authorization: 'Bearer admin', 'Content-Type': 'application/json' };
    const role = await app.request('/spaces/s1/roles', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({
        name: 'Reader of held',
        scopes: ['content:write', 'preview:read'],
        contentGrants: [{ contentTypeApiId: 'held', actions: ['read'] }],
      }),
    });
    expect(role.status).toBe(201);
    const { id: roleId } = (await role.json()) as { id: string };
    const key = await app.request('/spaces/s1/api-keys', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ kind: 'cma', roleId }),
    });
    const { token } = (await key.json()) as { token: string };
    const res = await app.request(`${M}/entries/${id}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { title: { 'en-US': 'Mine' } }, expectedVersion: 1 }),
    });
    // A 403, never the 409 that would say the entry moved on.
    expect(res.status).toBe(403);
  });

  it('refuses an expectedVersion that is not a positive integer', async () => {
    const { app, id } = await setUp();
    for (const bad of ['0', '-1', '1.5', 'latest']) {
      const res = await app.request(`${M}/entries/${id}/published?expectedVersion=${bad}`, {
        method: 'POST',
        headers: cma,
      });
      expect(res.status).toBe(422);
    }
  });
});
