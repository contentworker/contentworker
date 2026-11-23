import { createHash } from 'node:crypto';
import type { AppContext } from '@contentworker/application';
import type { RemoteFetcher } from '@contentworker/ports';
import { FakeAssetIngestQueue } from '@contentworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app';
import { testConfig } from './config';
import { wire } from './wire';

const config = testConfig();
const M = '/spaces/s1/environments/main';
const cma = { Authorization: 'Bearer cma', 'Content-Type': 'application/json' };
const cpa = { Authorization: 'Bearer cpa', 'Content-Type': 'application/json' };
const BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 9, 9]);

/** One file host: a PNG at /logo.png, 404 everywhere else. */
const files: RemoteFetcher & { calls: string[] } = {
  calls: [],
  async get() {
    throw new Error('not used');
  },
  async getBytes(url) {
    files.calls.push(url);
    return url === 'https://files.example.com/logo.png'
      ? { status: 200, contentType: 'image/png', bytes: BYTES }
      : { status: 404, bytes: new Uint8Array() };
  },
};

let ctx: AppContext;
let ingest: FakeAssetIngestQueue;
let app: ReturnType<typeof createApp>;

const post = (body: unknown, headers = cma) =>
  app.request(`${M}/assets/from-url`, { method: 'POST', headers, body: JSON.stringify(body) });

beforeEach(() => {
  const wired = wire(config);
  ctx = wired.ctx;
  ingest = new FakeAssetIngestQueue();
  files.calls.length = 0;
  app = createApp(
    wired.ctx,
    config,
    wired.rag,
    wired.blob,
    wired.ai,
    undefined,
    undefined,
    undefined,
    undefined,
    { remoteFetcher: files, assetIngest: ingest },
  );
});

describe('POST …/assets/from-url', () => {
  it('creates a draft from the file (201), signed like every asset read, and starts ingest', async () => {
    const res = await post({
      url: 'https://files.example.com/logo.png',
      title: 'Logo',
      alt: 'Mark',
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      deduplicated: boolean;
      asset: Record<string, unknown> & { id: string; file: { url: string; size: number } };
    };
    expect(body.deduplicated).toBe(false);
    expect(body.asset).toMatchObject({
      status: 'draft',
      title: { 'en-US': 'Logo' },
      metadata: { altText: { 'en-US': 'Mark' } },
      file: { fileName: 'logo.png', contentType: 'image/png', size: BYTES.byteLength },
    });
    expect(body.asset.file.url).toMatch(/\?ttl=900$/);
    expect(body.asset).not.toHaveProperty('r2Key');
    expect(ingest.created.map((c) => c.key)).toEqual([`s1/main/${body.asset.id}/logo.png`]);

    // The same asset as GET answers.
    const got = await app.request(`${M}/assets/${body.asset.id}`, { headers: cma });
    expect(await got.json()).toEqual(body.asset);
  });

  it('answers 200 with the existing asset when it already holds the bytes', async () => {
    const first = (await (await post({ url: 'https://files.example.com/logo.png' })).json()) as {
      asset: { id: string };
    };
    const contentHash = createHash('sha256').update(BYTES).digest('hex');
    await ctx.store.assets.recordIngest(
      { spaceId: 's1', environmentId: 'main' },
      first.asset.id,
      1,
      { contentHash },
    );
    const again = await post({ url: 'https://files.example.com/logo.png' });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ deduplicated: true, asset: { id: first.asset.id } });
  });

  it('refuses a private address and a failed download with 422, fetching nothing private', async () => {
    const internal = await post({ url: 'http://169.254.169.254/latest/meta-data' });
    expect(internal.status).toBe(422);
    const missing = await post({ url: 'https://files.example.com/gone.png' });
    expect(missing.status).toBe(422);
    expect(JSON.stringify(await missing.json())).toContain('answered 404');
    expect(files.calls).toEqual(['https://files.example.com/gone.png']);
    expect((await post({})).status).toBe(422);
  });

  it('needs assets:write', async () => {
    expect((await post({ url: 'https://files.example.com/logo.png' }, cpa)).status).toBe(403);
    expect(files.calls).toEqual([]);
  });
});
