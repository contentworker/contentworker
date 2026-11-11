import type { ApiConfig } from '@contentworker/platform/config';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app';
import { testConfig } from './config';
import { wire } from './wire';

/**
 * `PUT /roles/:id` held to the version the role was read at: every read answers `version`, a
 * stale `expectedVersion` is a 409 naming the version in force with nothing written, and a body
 * without one saves as it always has.
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

const admin = { Authorization: 'Bearer admin', 'Content-Type': 'application/json' };
type Role = { id: string; name: string; scopes: string[]; version: number };

function makeApp() {
  const wired = wire(config);
  return createApp(wired.ctx, config, wired.rag, wired.blob, wired.ai);
}
type App = ReturnType<typeof makeApp>;
const send = (app: App, method: string, path: string, body?: unknown) =>
  app.request(`/spaces/s1${path}`, {
    method,
    headers: admin,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const body = (over: Record<string, unknown> = {}) => ({
  name: 'Writers',
  scopes: ['preview:read', 'content:write'],
  contentGrants: [{ contentTypeApiId: '*', actions: ['read', 'write'] }],
  ...over,
});

describe('a role’s version over HTTP', () => {
  it('answers the version on create, get, list and replace', async () => {
    const app = makeApp();
    const made = (await (await send(app, 'POST', '/roles', body())).json()) as Role;
    expect(made.version).toBe(1);
    const saved = await send(app, 'PUT', `/roles/${made.id}`, body({ name: 'Authors' }));
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ name: 'Authors', version: 2 });
    expect(await (await send(app, 'GET', `/roles/${made.id}`)).json()).toMatchObject({
      version: 2,
    });
    const { items } = (await (await send(app, 'GET', '/roles')).json()) as { items: Role[] };
    expect(items.find((r) => r.id === made.id)?.version).toBe(2);
  });

  it('refuses a stale expectedVersion with 409 and the version in force, writing nothing', async () => {
    const app = makeApp();
    const made = (await (await send(app, 'POST', '/roles', body())).json()) as Role;
    await send(app, 'PUT', `/roles/${made.id}`, body({ name: 'Theirs', expectedVersion: 1 }));

    const stale = await send(
      app,
      'PUT',
      `/roles/${made.id}`,
      body({ name: 'Mine', scopes: ['preview:read'], expectedVersion: 1 }),
    );
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      error: { code: 'conflict', details: { version: 2 } },
    });
    expect(await (await send(app, 'GET', `/roles/${made.id}`)).json()).toMatchObject({
      name: 'Theirs',
      scopes: ['preview:read', 'content:write'],
      version: 2,
    });

    // Matching saves; absent saves over whatever is there, as before.
    const matched = await send(app, 'PUT', `/roles/${made.id}`, body({ expectedVersion: 2 }));
    expect(await matched.json()).toMatchObject({ version: 3 });
    const unversioned = await send(app, 'PUT', `/roles/${made.id}`, body({ name: 'Any' }));
    expect(await unversioned.json()).toMatchObject({ name: 'Any', version: 4 });
  });

  it('refuses an expectedVersion that isn’t a version, as 422', async () => {
    const app = makeApp();
    const made = (await (await send(app, 'POST', '/roles', body())).json()) as Role;
    for (const expectedVersion of [0, 1.5, '1']) {
      const res = await send(app, 'PUT', `/roles/${made.id}`, body({ expectedVersion }));
      expect(res.status).toBe(422);
    }
  });

  it('documents version on the role and expectedVersion on the replace', async () => {
    const app = makeApp();
    const spec = JSON.stringify(await (await app.request('/openapi.json')).json());
    expect(spec).toContain('send it back as `expectedVersion`');
    expect(spec).toContain('The version the role was edited from; another is a 409');
  });
});
