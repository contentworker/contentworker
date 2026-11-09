import { createContentType, publishContentType, SYSTEM_CALLER } from '@contentworker/application';
import type { ApiConfig } from '@contentworker/platform/config';
import { createManagementClient, ManagementError } from '@contentworker/sdk-management';
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

const field = (apiId: string, type: string, position: number) => ({
  apiId,
  name: apiId,
  type,
  position,
  localized: false,
  required: false,
});
const hero = (key: string) => ({ _type: 'hero', _key: key, heading: 'Hi' });

/** The management SDK's locked-region methods against the real routes. */
describe('locked regions through the management SDK', () => {
  it('reads, sets against the version read, and a save that breaks a region is refused', async () => {
    const wired = wire(config);
    const app = createApp(wired.ctx, config, wired.rag, wired.blob, wired.ai);
    const scope = { spaceId: 's1', environmentId: 'main' };
    await createContentType(wired.ctx, SYSTEM_CALLER, scope, {
      apiId: 'sdklock',
      name: 'Page',
      displayField: 'title',
      fields: [
        field('title', 'Symbol', 0),
        {
          ...field('body', 'Array', 1),
          items: {
            type: 'Component',
            variants: [{ apiId: 'hero', name: 'Hero', fields: [field('heading', 'Symbol', 0)] }],
          },
        },
      ] as never,
    });
    await publishContentType(wired.ctx, scope, 'sdklock');
    const fetch = ((url: string | URL | Request, init?: RequestInit) =>
      app.request(String(url), init)) as typeof globalThis.fetch;
    const cma = createManagementClient({
      baseUrl: '',
      space: 's1',
      environment: 'main',
      token: 'admin',
      fetch,
    });
    const { entry } = await cma.entries.create({
      contentTypeApiId: 'sdklock',
      fields: { body: { 'en-US': [hero('a'), hero('b')] } },
    });

    const current = await cma.entries.blockLocks.get(entry.id);
    expect(current).toMatchObject({ version: 1, locks: [], stale: [] });
    const done = await cma.entries.blockLocks.set(entry.id, [{ field: 'body', keys: ['a'] }], {
      expectedVersion: current.version,
    });
    expect(done).toMatchObject({ unchanged: false, locks: [{ keys: ['a'], depth: 'subtree' }] });
    expect((await cma.entries.get(entry.id)).entry.blockLocks).toEqual(done.locks);

    const refused = await cma.entries
      .update(entry.id, { body: { 'en-US': [hero('b')] } })
      .catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ManagementError);
    expect((refused as ManagementError).status).toBe(422);

    const stale = await cma.entries.blockLocks
      .set(entry.id, [], { expectedVersion: 2 })
      .catch((e: unknown) => e);
    expect((stale as ManagementError).status).toBe(409);
  });
});
