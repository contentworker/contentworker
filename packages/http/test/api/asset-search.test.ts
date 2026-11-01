import type { ApiConfig } from '@contentworker/platform/config';
import { FakeAssetIngestQueue } from '@contentworker/test-kit';
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

const cma = { Authorization: 'Bearer cma', 'Content-Type': 'application/json' };
const cpa = { Authorization: 'Bearer cpa' };
const cda = { Authorization: 'Bearer cda' };
const M = '/spaces/s1/environments/main';
const D = '/delivery/s1/main';

function makeApp(opts: { ingest?: FakeAssetIngestQueue } = {}) {
  const wired = wire(config);
  const app = createApp(
    wired.ctx,
    config,
    wired.rag,
    wired.blob,
    wired.ai,
    wired.bus,
    undefined,
    undefined,
    undefined,
    opts.ingest ? { assetIngest: opts.ingest } : {},
  );
  return { app, ctx: wired.ctx };
}

async function json<T>(res: Response | Promise<Response>): Promise<T> {
  return (await (await res).json()) as T;
}

async function upload(app: ReturnType<typeof makeApp>['app'], fileName: string, alt: string) {
  const { asset } = await json<{ asset: { id: string } }>(
    app.request(`${M}/assets`, {
      method: 'POST',
      headers: cma,
      body: JSON.stringify({
        fileName,
        contentType: fileName.endsWith('.pdf') ? 'application/pdf' : 'image/png',
      }),
    }),
  );
  await app.request(`${M}/assets/${asset.id}/metadata`, {
    method: 'PATCH',
    headers: cma,
    body: JSON.stringify({ altText: { 'en-US': alt } }),
  });
  return asset;
}

type SearchBody = {
  items: { id: string; file?: { url: string } }[];
  total: number;
  facets: { kind: Record<string, number> };
};

describe('asset search over HTTP', () => {
  it('Management searches the library with facets; Delivery only what is published', async () => {
    const { app } = makeApp();
    const draft = await upload(app, 'draft-mug.png', 'Draft mug');
    const live = await upload(app, 'mug.pdf', 'Mug brochure');
    await app.request(`${M}/assets/${live.id}/published`, { method: 'POST', headers: cma });

    const lib = await json<SearchBody>(app.request(`${M}/assets/search?q=mug`, { headers: cpa }));
    expect(lib.items.map((a) => a.id).sort()).toEqual([draft.id, live.id].sort());
    expect(lib.facets.kind).toEqual({ image: 1, document: 1 });
    // Reads hand out short-lived URLs, as the listing does.
    expect(lib.items[0]?.file?.url).toMatch(/ttl=/);
    const images = await json<SearchBody>(
      app.request(`${M}/assets/search?q=mug&kind=image`, { headers: cpa }),
    );
    expect(images.items.map((a) => a.id)).toEqual([draft.id]);

    const delivered = await json<SearchBody>(app.request(`${D}/assets?q=mug`, { headers: cda }));
    expect(delivered.items.map((a) => a.id)).toEqual([live.id]);
    expect(delivered.total).toBe(1);
    expect(delivered.facets.kind).toEqual({ document: 1 });
  });

  it('checks the query and the scopes', async () => {
    const { app } = makeApp();
    expect((await app.request(`${M}/assets/search`, { headers: cpa })).status).toBe(422);
    expect((await app.request(`${M}/assets/search?q=x&kind=nope`, { headers: cpa })).status).toBe(
      422,
    );
    // A delivery key can't search the library (drafts).
    expect((await app.request(`${M}/assets/search?q=x`, { headers: cda })).status).toBe(403);
  });

  it('re-ingest queues a run (501 without the queue); reindex starts a job', async () => {
    const ingest = new FakeAssetIngestQueue();
    const { app } = makeApp({ ingest });
    const a = await upload(app, 'mug.png', 'Mug');
    const res = await app.request(`${M}/assets/${a.id}/reingest`, { method: 'POST', headers: cma });
    expect(res.status).toBe(202);
    expect((await json<{ ingestStatus: string }>(res)).ingestStatus).toBe('pending');
    expect(ingest.requested).toEqual([
      expect.objectContaining({ assetId: a.id, version: 1, rerun: expect.any(String) }),
    ]);
    // A preview key can read but not re-run.
    expect(
      (await app.request(`${M}/assets/${a.id}/reingest`, { method: 'POST', headers: cpa })).status,
    ).toBe(403);

    const job = await app.request(`${M}/assets/reindex`, {
      method: 'POST',
      headers: cma,
      body: JSON.stringify({}),
    });
    expect(job.status).toBe(202);
    expect(await json<{ assets: number; job: { action: string } }>(job)).toMatchObject({
      assets: 1,
      job: { action: 'asset_reindex' },
    });

    const bare = makeApp().app;
    const b = await upload(bare, 'x.png', 'X');
    expect(
      (await bare.request(`${M}/assets/${b.id}/reingest`, { method: 'POST', headers: cma })).status,
    ).toBe(501);
  });
});
