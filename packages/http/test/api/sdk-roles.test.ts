import type { ApiConfig } from '@contentworker/platform/config';
import { createManagementClient, isConflict } from '@contentworker/sdk-management';
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

/** The management SDK's role methods against the real routes. */
describe('roles through the management SDK', () => {
  it('creates, reads and replaces against the version read; a stale save is a conflict', async () => {
    const wired = wire(config);
    const app = createApp(wired.ctx, config, wired.rag, wired.blob, wired.ai);
    const fetch = ((url: string | URL | Request, init?: RequestInit) =>
      app.request(String(url), init)) as typeof globalThis.fetch;
    const cma = createManagementClient({
      baseUrl: '',
      space: 's1',
      environment: 'main',
      token: 'admin',
      fetch,
    });

    const made = await cma.roles.create({
      name: 'Writers',
      scopes: ['preview:read'],
      contentGrants: [{ contentTypeApiId: '*', actions: ['read'] }],
    });
    expect(made.version).toBe(1);
    expect((await cma.roles.list()).find((r) => r.id === made.id)?.version).toBe(1);

    const read = await cma.roles.get(made.id);
    const saved = await cma.roles.update(made.id, {
      name: 'Authors',
      scopes: read.scopes,
      contentGrants: read.contentGrants,
      expectedVersion: read.version,
    });
    expect(saved).toMatchObject({ name: 'Authors', version: 2 });

    const stale = await cma.roles
      .update(made.id, { name: 'Mine', scopes: [], expectedVersion: read.version })
      .catch((e: unknown) => e);
    expect(isConflict(stale)).toBe(true);
    if (!isConflict(stale)) throw stale;
    expect(stale.status).toBe(409);
    expect(stale.error.details).toEqual({ version: 2 });
    expect((await cma.roles.get(made.id)).name).toBe('Authors');

    await cma.roles.delete(made.id);
    expect((await cma.roles.list()).some((r) => r.id === made.id)).toBe(false);
  });
});
