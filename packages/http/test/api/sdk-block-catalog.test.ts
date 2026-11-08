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

/** The management SDK's block catalog methods against the real routes. */
describe('the block catalog through the management SDK', () => {
  it('dry-runs, pushes against the reviewed version, and reads it back', async () => {
    const wired = wire(config);
    const app = createApp(wired.ctx, config, wired.rag, wired.blob, wired.ai);
    const scope = { spaceId: 's1', environmentId: 'main' };
    await createContentType(wired.ctx, SYSTEM_CALLER, scope, {
      apiId: 'sdkpage',
      name: 'Page',
      displayField: 'title',
      fields: [
        field('title', 'Symbol', 0),
        {
          ...field('body', 'Array', 1),
          items: {
            type: 'Component',
            variants: [{ apiId: 'old', name: 'Old', fields: [field('x', 'Symbol', 0)] }],
          },
        },
      ] as never,
    });
    await publishContentType(wired.ctx, scope, 'sdkpage');
    const fetch = ((url: string | URL | Request, init?: RequestInit) =>
      app.request(String(url), init)) as typeof globalThis.fetch;
    const cma = createManagementClient({
      baseUrl: '',
      space: 's1',
      environment: 'main',
      token: 'admin',
      fetch,
    });

    const input = {
      blocks: [
        {
          id: 'hero',
          name: 'Hero',
          fields: [{ apiId: 'heading', name: 'Heading', type: 'Symbol' }],
        },
      ],
      targets: [{ contentTypeApiId: 'sdkpage', field: 'body' }],
    };
    const plan = await cma.blockCatalog.push({ ...input, dryRun: true });
    expect(plan).toMatchObject({ previousVersion: 0, destructive: true });
    const done = await cma.blockCatalog.push({
      ...input,
      expectedVersion: plan.previousVersion,
      allowDestructive: true,
    });
    expect(done).toMatchObject({ applied: true, version: 1 });
    expect((await cma.blockCatalog.get()).blocks.map((b) => b.id)).toEqual(['hero']);
    expect((await cma.blockCatalog.version(1)).version).toBe(1);
    expect(await cma.blockCatalog.versions({ limit: 5 })).toMatchObject([
      { version: 1, blockCount: 1 },
    ]);
    expect(await cma.blockCatalog.usage()).toMatchObject({
      version: 1,
      blocks: [{ id: 'hero', entries: 0 }],
    });
    const stale = await cma.blockCatalog
      .push({
        ...input,
        blocks: input.blocks.map((b) => ({ ...b, name: 'Hero banner' })),
        expectedVersion: 0,
      })
      .catch((e: unknown) => e);
    expect(stale).toBeInstanceOf(ManagementError);
    expect((stale as ManagementError).status).toBe(409);
  });
});
