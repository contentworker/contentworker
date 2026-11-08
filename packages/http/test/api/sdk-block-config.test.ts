import {
  createContentType,
  publishContentType,
  pushBlockCatalog,
  SYSTEM_CALLER,
} from '@contentworker/application';
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

/** The management SDK's block config methods against the real routes. */
describe('the block config through the management SDK', () => {
  it('reads, sets against the version read, and answers the rules in force', async () => {
    const wired = wire(config);
    const app = createApp(wired.ctx, config, wired.rag, wired.blob, wired.ai);
    const scope = { spaceId: 's1', environmentId: 'main' };
    await createContentType(wired.ctx, SYSTEM_CALLER, scope, {
      apiId: 'sdkcfg',
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
    await publishContentType(wired.ctx, scope, 'sdkcfg');
    await pushBlockCatalog(wired.ctx, SYSTEM_CALLER, scope, {
      blocks: [
        {
          id: 'hero',
          name: 'Hero',
          fields: [{ apiId: 'heading', name: 'Heading', type: 'Symbol' }],
        },
        { id: 'quote', name: 'Quote', fields: [{ apiId: 'text', name: 'Text', type: 'Symbol' }] },
      ],
      targets: [{ contentTypeApiId: 'sdkcfg', field: 'body' }],
    });
    const fetch = ((url: string | URL | Request, init?: RequestInit) =>
      app.request(String(url), init)) as typeof globalThis.fetch;
    const cma = createManagementClient({
      baseUrl: '',
      space: 's1',
      environment: 'main',
      token: 'admin',
      fetch,
    });

    const current = await cma.blockConfig.get();
    expect(current.version).toBe(0);
    const targets = [{ contentTypeApiId: 'sdkcfg', field: 'body', blocks: ['hero'], max: 2 }];
    const done = await cma.blockConfig.set({
      expectedVersion: current.version,
      targets,
      blocks: [],
    });
    expect(done).toMatchObject({ unchanged: false, config: { version: 1, targets } });
    expect((await cma.blockConfig.get()).version).toBe(1);
    expect(await cma.blockConfig.effective()).toMatchObject({
      configVersion: 1,
      targets: [{ field: 'body', blocks: ['hero'], max: 2, narrowed: true }],
    });
    const stale = await cma.blockConfig
      .set({ expectedVersion: 0, targets: [], blocks: [] })
      .catch((e: unknown) => e);
    expect(stale).toBeInstanceOf(ManagementError);
    expect((stale as ManagementError).status).toBe(409);
  });
});
