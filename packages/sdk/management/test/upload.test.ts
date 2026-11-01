import { describe, expect, it, vi } from 'vitest';
import { createManagementClient, SINGLE_UPLOAD_MAX_BYTES } from '../src/index.js';

const base = { baseUrl: 'https://cms.test', space: 's1', environment: 'main', token: 'cma-tok' };
const M = 'https://cms.test/spaces/s1/environments/main';

/** A fake api: multipart for big files, a part that fails `failures` times first. */
function api(opts: { failures?: Record<number, number>; partSize?: number } = {}) {
  const calls: { method: string; url: string; body?: unknown }[] = [];
  const failures = { ...(opts.failures ?? {}) };
  const partSize = opts.partSize ?? 8;
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, url, body });
    const json = (v: unknown, status = 200) =>
      new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
    if (method === 'POST' && url === `${M}/assets/uploads`) {
      return json(
        {
          asset: { id: 'a1' },
          upload: { uploadId: 'u1', partSize, partCount: Math.ceil(body.size / partSize) },
        },
        201,
      );
    }
    if (method === 'POST' && url === `${M}/assets`) {
      return json(
        {
          asset: { id: 'a0' },
          upload: { url: '/media/k?sig=x', headers: { 'content-type': 'image/png' } },
        },
        201,
      );
    }
    if (url.endsWith('/parts')) {
      const [n] = body.partNumbers as number[];
      const total = (calls.find((c) => c.url === `${M}/assets/uploads`)?.body as { size: number })
        .size;
      const count = Math.ceil(total / partSize);
      const length = n === count ? total - partSize * (count - 1) : partSize;
      return json({
        parts: [{ partNumber: n, url: `/media/k?part=${n}`, length, expiresAt: 'x' }],
      });
    }
    if (method === 'PUT') {
      const n = Number(new URL(url).searchParams.get('part') ?? '1');
      if ((failures[n] ?? 0) > 0) {
        failures[n] = (failures[n] ?? 0) - 1;
        return new Response('boom', { status: 503 });
      }
      const size =
        init?.body instanceof Blob
          ? init.body.size
          : init?.body instanceof Uint8Array
            ? init.body.byteLength
            : 0;
      return new Response(null, { status: 200, headers: { etag: `"p${n}-${size}"` } });
    }
    if (url.endsWith('/complete')) return json({ id: 'a1', status: 'draft' });
    if (method === 'DELETE') return new Response(null, { status: 204 });
    return json({}, 404);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe('assets.upload', () => {
  it('uses one signed PUT for a small file, against the api’s origin', async () => {
    const { fetchImpl, calls } = api();
    const client = createManagementClient({ ...base, fetch: fetchImpl });
    const progress: number[] = [];
    const asset = await client.assets.upload(
      { fileName: 'a.png', contentType: 'image/png', body: new Uint8Array(10) },
      { onProgress: (p) => progress.push(p.loaded) },
    );
    expect(asset.id).toBe('a0');
    expect(calls.find((c) => c.method === 'PUT')?.url).toBe('https://cms.test/media/k?sig=x');
    expect(progress).toEqual([0, 10]);
  });

  it('uploads past the single-PUT cap in parts, retries a failed part, reports bytes, completes', async () => {
    const partSize = 40 * 1024 * 1024;
    const { fetchImpl, calls } = api({ failures: { 2: 2 }, partSize });
    const client = createManagementClient({ ...base, fetch: fetchImpl });
    const total = SINGLE_UPLOAD_MAX_BYTES + 5;
    const body = new Blob([new Uint8Array(total)]);
    const progress: { loaded: number; partsDone: number }[] = [];
    await client.assets.upload(
      { fileName: 'film.mov', contentType: 'video/quicktime', body },
      { onProgress: (p) => progress.push(p), sleep: async () => {}, concurrency: 2 },
    );
    const puts = calls.filter((c) => c.method === 'PUT');
    // Three parts, part 2 tried three times (each re-signed).
    expect(puts).toHaveLength(5);
    expect(calls.filter((c) => c.url.endsWith('/parts'))).toHaveLength(5);
    const complete = calls.find((c) => c.url.endsWith('/complete'))?.body as {
      parts: { partNumber: number; etag: string }[];
    };
    expect(complete.parts.map((p) => p.partNumber)).toEqual([1, 2, 3]);
    expect(complete.parts[2]?.etag).toBe(`"p3-${total - 2 * partSize}"`);
    expect(progress.at(-1)).toMatchObject({ loaded: total, partsDone: 3 });
    expect(progress.map((p) => p.loaded)).toEqual(
      [...progress.map((p) => p.loaded)].sort((a, b) => a - b),
    );
  });

  it('aborts the upload on the server when a part keeps failing', async () => {
    const { fetchImpl, calls } = api({ failures: { 1: 99 } });
    const client = createManagementClient({ ...base, fetch: fetchImpl });
    await expect(
      client.assets.upload(
        {
          fileName: 'film.mov',
          contentType: 'video/quicktime',
          body: new Uint8Array(SINGLE_UPLOAD_MAX_BYTES + 1),
        },
        { sleep: async () => {}, attempts: 2 },
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect(calls.some((c) => c.method === 'DELETE' && c.url === `${M}/assets/a1/uploads/u1`)).toBe(
      true,
    );
    expect(calls.some((c) => c.url.endsWith('/complete'))).toBe(false);
  });
});

describe('collections, share links and zips', () => {
  it('call the routes the api serves', async () => {
    const { fetchImpl, calls } = api();
    const client = createManagementClient({ ...base, fetch: fetchImpl });
    await client.assets.collections.add('c1', ['a', 'b']).catch(() => undefined);
    await client.assets.collections.reorder('c1', ['b']).catch(() => undefined);
    await client.assets.shareLinks.list({ includeInactive: true }).catch(() => undefined);
    await client.assets.shareLinks.revoke('l1').catch(() => undefined);
    await client.assets.zips.create({ collectionId: 'c1' }).catch(() => undefined);
    expect(calls.map((c) => `${c.method} ${c.url.replace(M, '')}`)).toEqual([
      'POST /asset-collections/c1/assets',
      'PUT /asset-collections/c1/order',
      'GET /share-links?includeInactive=true',
      'DELETE /share-links/l1',
      'POST /asset-zips',
    ]);
  });
});
