import type { ApiConfig } from '@contentworker/platform/config';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app';
import { testConfig } from './config';
import { wire } from './wire';

/**
 * A role's content grants name each content type once, `*` included: a create, a replace or a clone
 * that would store a repeated one is a 422 naming the type. A role stored with one before the rule
 * still reads as it did.
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

function makeApp() {
  const wired = wire(config);
  return { wired, app: createApp(wired.ctx, config, wired.rag, wired.blob, wired.ai) };
}
type App = ReturnType<typeof makeApp>['app'];
const send = (app: App, method: string, path: string, body?: unknown) =>
  app.request(`/spaces/s1${path}`, {
    method,
    headers: admin,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const TWO_WILDCARDS = [
  { contentTypeApiId: '*', actions: ['read', 'write'] },
  { contentTypeApiId: '*', actions: ['read'] },
];
const wildcardIssue = {
  field: 'contentGrants',
  message: 'More than one grant covers every type ("*"); merge them into one',
};

describe('repeated content grants over HTTP', () => {
  it('refuses a create or a replace naming a type twice, as 422, and writes nothing', async () => {
    const { app } = makeApp();
    const created = await send(app, 'POST', '/roles', {
      name: 'Two posts',
      scopes: ['content:write'],
      contentGrants: [
        { contentTypeApiId: 'post', actions: ['read'] },
        { contentTypeApiId: 'post', actions: ['write'] },
      ],
    });
    expect(created.status).toBe(422);
    expect(await created.json()).toMatchObject({
      error: {
        code: 'validation_failed',
        issues: [
          {
            field: 'contentGrants',
            message: 'More than one grant names "post"; merge them into one',
          },
        ],
      },
    });

    const made = (await (
      await send(app, 'POST', '/roles', {
        name: 'Readers',
        scopes: ['preview:read'],
        contentGrants: [{ contentTypeApiId: '*', actions: ['read'] }],
      })
    ).json()) as { id: string; version: number };
    const replaced = await send(app, 'PUT', `/roles/${made.id}`, {
      name: 'Readers',
      scopes: ['preview:read'],
      contentGrants: TWO_WILDCARDS,
    });
    expect(replaced.status).toBe(422);
    expect(await replaced.json()).toMatchObject({ error: { issues: [wildcardIssue] } });
    expect(await (await send(app, 'GET', `/roles/${made.id}`)).json()).toMatchObject({
      version: 1,
      contentGrants: [{ contentTypeApiId: '*', actions: ['read'] }],
    });
  });

  it('reads a role stored with repeated grants, and refuses saving or cloning it unmerged', async () => {
    const { app, wired } = makeApp();
    await wired.ctx.store.roles.save({
      id: 'legacy',
      spaceId: 's1',
      name: 'Legacy',
      scopes: ['content:write'],
      contentGrants: TWO_WILDCARDS as never,
      version: 1,
    });
    const read = await send(app, 'GET', '/roles/legacy');
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ contentGrants: TWO_WILDCARDS });

    const unchanged = { name: 'Legacy', scopes: ['content:write'], contentGrants: TWO_WILDCARDS };
    const saved = await send(app, 'PUT', '/roles/legacy', unchanged);
    expect(saved.status).toBe(422);
    expect(await saved.json()).toMatchObject({ error: { issues: [wildcardIssue] } });
    const cloned = await send(app, 'POST', '/roles/legacy/clone', {});
    expect(cloned.status).toBe(422);
    expect(await cloned.json()).toMatchObject({ error: { issues: [wildcardIssue] } });

    const merged = await send(app, 'PUT', '/roles/legacy', {
      ...unchanged,
      contentGrants: [TWO_WILDCARDS[0]],
    });
    expect(merged.status).toBe(200);
    expect(await merged.json()).toMatchObject({ version: 2 });
  });
});
