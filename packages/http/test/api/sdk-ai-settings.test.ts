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

/** The management SDK's AI settings methods against the real routes. */
describe('AI settings through the management SDK', () => {
  it('reads, sets against the version read, and answers a stale set with a conflict', async () => {
    const wired = wire(config);
    const app = createApp(wired.ctx, config, wired.rag, wired.blob, wired.ai);
    const fetch = ((url: string | URL | Request, init?: RequestInit) =>
      app.request(String(url), init)) as typeof globalThis.fetch;
    const client = (token: string) =>
      createManagementClient({ baseUrl: '', space: 's1', environment: 'main', token, fetch });
    const cma = client('admin');

    const current = await cma.aiSettings.get();
    expect(current.version).toBe(0);
    expect(current.capabilities.assistant).toEqual({ enabled: true, tier: null, guidance: null });

    const done = await cma.aiSettings.set({
      expectedVersion: current.version,
      capabilities: { assistant: { enabled: false }, layout: { enabled: true, tier: 'balanced' } },
    });
    expect(done).toMatchObject({
      unchanged: false,
      settings: {
        version: 1,
        capabilities: {
          assistant: { enabled: false },
          layout: { enabled: true, tier: 'balanced', guidance: null },
        },
      },
    });
    // Reading takes preview:read.
    expect((await client('cpa').aiSettings.get()).version).toBe(1);

    const stale = await cma.aiSettings
      .set({ expectedVersion: 0, capabilities: { media: { enabled: false } } })
      .catch((e: unknown) => e);
    expect(stale).toBeInstanceOf(ManagementError);
    expect((stale as ManagementError).status).toBe(409);

    const refused = await client('cpa')
      .aiSettings.set({ expectedVersion: 1, capabilities: { media: { enabled: false } } })
      .catch((e: unknown) => e);
    expect((refused as ManagementError).status).toBe(403);
  });
});
