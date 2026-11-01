import { createEnvironment } from '@contentworker/application';
import type { ApiConfig } from '@contentworker/platform/config';
import { beforeEach, describe, expect, it } from 'vitest';
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
const env = (name: string) => `/spaces/s1/environments/${name}/webhooks`;
const hook = { url: 'https://hooks.example.com/cw', topics: ['*'], secret: 'shh' };

interface Summary {
  id: string;
  environmentId: string | null;
}

describe('webhooks under an environment', () => {
  let app: ReturnType<typeof createApp>;
  const create = async (name: string, body: object) => {
    const res = await app.request(env(name), {
      method: 'POST',
      headers: cma,
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(201);
    return (await res.json()) as Summary;
  };
  const list = async (name: string) =>
    ((await (await app.request(env(name), { headers: cma })).json()) as { items: Summary[] }).items
      .map((h) => h.id)
      .sort();

  beforeEach(async () => {
    const { ctx, rag, blob, ai } = wire(config);
    app = createApp(ctx, config, rag, blob, ai);
    await createEnvironment(ctx, 's1', 'staging');
  });

  it('scopes a hook to the path environment, or to every one with allEnvironments', async () => {
    const scoped = await create('staging', hook);
    expect(scoped.environmentId).toBe('staging');
    expect(scoped).not.toHaveProperty('secret');
    const wide = await create('staging', { ...hook, allEnvironments: true });
    expect(wide.environmentId).toBeNull();
    const mainHook = await create('main', hook);

    expect(await list('staging')).toEqual([scoped.id, wide.id].sort());
    expect(await list('main')).toEqual([mainHook.id, wide.id].sort());
  });

  it("answers 404 for another environment's hook, and moves one with allEnvironments", async () => {
    const scoped = await create('staging', hook);
    const put = (name: string, body: object) =>
      app.request(`${env(name)}/${scoped.id}`, {
        method: 'PUT',
        headers: cma,
        body: JSON.stringify(body),
      });
    expect((await put('main', { active: false })).status).toBe(404);
    expect(
      (await app.request(`${env('main')}/${scoped.id}`, { method: 'DELETE', headers: cma })).status,
    ).toBe(404);
    expect(
      (await app.request(`${env('main')}/${scoped.id}/deliveries`, { headers: cma })).status,
    ).toBe(404);

    // Omitted, the scope stays; true makes it space-wide; false scopes it to the path's environment.
    expect(
      ((await (await put('staging', { active: false })).json()) as Summary).environmentId,
    ).toBe('staging');
    expect(
      ((await (await put('staging', { allEnvironments: true })).json()) as Summary).environmentId,
    ).toBeNull();
    expect(
      ((await (await put('main', { allEnvironments: false })).json()) as Summary).environmentId,
    ).toBe('main');
    expect(await list('staging')).toEqual([]);
  });

  it('refuses a non-boolean allEnvironments, and a private target', async () => {
    const bad = await app.request(env('main'), {
      method: 'POST',
      headers: cma,
      body: JSON.stringify({ ...hook, allEnvironments: 'yes' }),
    });
    expect(bad.status).toBe(422);
    const internal = await app.request(env('main'), {
      method: 'POST',
      headers: cma,
      body: JSON.stringify({ ...hook, url: 'http://10.0.0.1/hook' }),
    });
    expect(internal.status).toBe(422);
  });
});
