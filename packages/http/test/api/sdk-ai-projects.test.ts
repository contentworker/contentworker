import { assetTextKey, createAsset } from '@contentworker/application';
import type { ApiConfig } from '@contentworker/platform/config';
import { createManagementClient, ManagementError } from '@contentworker/sdk-management';
import type { FakeBlobStore } from '@contentworker/test-kit';
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
const scope = { spaceId: 's1', environmentId: 'main' };

/** The management SDK's AI project methods against the real routes. */
describe('AI projects through the management SDK', () => {
  it('lists, creates, reads, updates, sets the default, reads a reference and deletes', async () => {
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
    const blob = wired.blob as FakeBlobStore;
    const { asset } = await createAsset(wired.ctx, blob, scope, {
      fileName: 'spec.pdf',
      contentType: 'application/pdf',
    });
    await blob.put(
      assetTextKey(scope, asset.id, 1) as string,
      'Facts. '.repeat(2_000),
      'text/markdown',
    );

    expect(await cma.aiProjects.list()).toEqual([]);
    const created = await cma.aiProjects.create({
      name: 'Northwind',
      reader: { name: 'Procurement lead', description: 'Busy, wants numbers.' },
      references: [{ assetId: asset.id }],
    });
    expect(created.references).toEqual([
      { assetId: asset.id, version: 1, text: 'ready', updateAvailable: false },
    ]);
    expect((await cma.aiProjects.get(created.id)).reader?.name).toBe('Procurement lead');

    const stale = await cma.aiProjects
      .update(created.id, { name: 'X', expectedVersion: 9 })
      .catch((e: unknown) => e);
    expect(stale).toBeInstanceOf(ManagementError);
    expect((stale as ManagementError).status).toBe(409);
    const updated = await cma.aiProjects.update(created.id, {
      name: 'Northwind launch',
      references: [{ assetId: asset.id }],
      expectedVersion: 1,
    });
    expect(updated.project.version).toBe(2);

    expect(await cma.aiProjects.setDefault(created.id)).toEqual({
      projectId: created.id,
      unchanged: false,
    });
    expect((await cma.aiProjects.list())[0]?.isDefault).toBe(true);

    const page = await cma.aiProjects.readReference(created.id, asset.id, { limit: 10_000 });
    expect(page).toMatchObject({ offset: 0, nextOffset: 10_000, total: 14_000 });
    const rest = await cma.aiProjects.readReference(created.id, asset.id, {
      offset: page.nextOffset as number,
    });
    expect(rest.nextOffset).toBeNull();

    await cma.aiProjects.setDefault(null);
    await cma.aiProjects.delete(created.id);
    expect(await cma.aiProjects.list()).toEqual([]);
  });
});
