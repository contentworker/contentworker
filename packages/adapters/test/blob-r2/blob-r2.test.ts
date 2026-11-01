import { describe, expect, it } from 'vitest';
import {
  createMediaUrlSigner,
  createR2BlobStore,
  handleMediaRequest,
  keyFromMediaPath,
  type R2BucketLike,
  type R2ObjectBodyLike,
} from '../../src/blob-r2/index.js';

/** In-memory R2 bucket: stores bytes + content type, like the binding. */
function fakeBucket() {
  const objects = new Map<string, { bytes: Uint8Array; contentType?: string }>();
  const bucket: R2BucketLike = {
    async get(key) {
      const o = objects.get(key);
      if (!o) return null;
      const obj: R2ObjectBodyLike = {
        body: new Response(o.bytes).body as ReadableStream,
        size: o.bytes.byteLength,
        httpEtag: `"etag-${o.bytes.byteLength}"`,
        httpMetadata: { contentType: o.contentType },
        text: async () => new TextDecoder().decode(o.bytes),
      };
      return obj;
    },
    async put(key, value, options) {
      const bytes =
        typeof value === 'string'
          ? new TextEncoder().encode(value)
          : new Uint8Array(await new Response(value).arrayBuffer());
      objects.set(key, { bytes, contentType: options?.httpMetadata?.contentType });
    },
    async delete(key) {
      objects.delete(key);
    },
  };
  return { bucket, objects };
}

const KEY = 'space-1/main/0190-asset/my photo.png';
const signer = createMediaUrlSigner('test-secret');
const NOW = 1_700_000_000;

describe('createR2BlobStore', () => {
  it('round-trips server-side put/get and deletes', async () => {
    const { bucket } = fakeBucket();
    const blob = createR2BlobStore(bucket, { signer });
    await blob.put('k/a.json', '{"x":1}', 'application/json');
    expect(await blob.get('k/a.json')).toBe('{"x":1}');
    await blob.delete('k/a.json');
    expect(await blob.get('k/a.json')).toBeNull();
  });

  it('issues signed media URLs under the configured origin, encoding key segments', async () => {
    const { bucket } = fakeBucket();
    const blob = createR2BlobStore(bucket, { signer, baseUrl: 'https://api.example/' });
    const url = new URL(await blob.getDownloadUrl(KEY));
    expect(url.origin).toBe('https://api.example');
    expect(url.pathname).toBe('/media/space-1/main/0190-asset/my%20photo.png');
    expect(url.searchParams.get('sig')).toBeTruthy();
    expect(keyFromMediaPath(url.pathname)).toBe(KEY);
  });

  it('defaults to root-relative URLs when no origin is configured', async () => {
    const blob = createR2BlobStore(fakeBucket().bucket, { signer });
    expect(await blob.getDownloadUrl('a/b')).toMatch(/^\/media\/a\/b\?sig=/);
  });
});

describe('handleMediaRequest', () => {
  async function upload(bucket: R2BucketLike, now = NOW) {
    const blob = createR2BlobStore(bucket, {
      signer,
      baseUrl: 'https://api.example',
      now: () => now,
    });
    const { url, headers } = await blob.getUploadUrl(KEY, 'image/png');
    return { blob, url, headers };
  }

  it('accepts a signed PUT, stores bytes with the signed content type, then serves a signed GET', async () => {
    const { bucket, objects } = fakeBucket();
    const { blob, url } = await upload(bucket);
    const put = await handleMediaRequest(
      new Request(url, {
        method: 'PUT',
        // The client lies about the type; the signed `ct` wins.
        headers: { 'content-type': 'text/html', 'content-length': '5' },
        body: 'hello',
      }),
      { bucket, signer, now: () => NOW },
    );
    expect(put.status).toBe(200);
    expect(objects.get(KEY)?.contentType).toBe('image/png');

    const get = await handleMediaRequest(new Request(await blob.getDownloadUrl(KEY)), {
      bucket,
      signer,
    });
    expect(get.status).toBe(200);
    expect(get.headers.get('content-type')).toBe('image/png');
    expect(get.headers.get('x-content-type-options')).toBe('nosniff');
    expect(get.headers.get('content-security-policy')).toContain('sandbox');
    expect(await get.text()).toBe('hello');
  });

  it('refuses an expired upload URL', async () => {
    const { bucket } = fakeBucket();
    const { url } = await upload(bucket, NOW - 10_000);
    const res = await handleMediaRequest(
      new Request(url, { method: 'PUT', headers: { 'content-length': '1' }, body: 'x' }),
      { bucket, signer, now: () => NOW },
    );
    expect(res.status).toBe(403);
  });

  it('refuses a tampered key, a forged signature, and an upload URL replayed as a GET', async () => {
    const { bucket } = fakeBucket();
    const { blob, url } = await upload(bucket);
    const other = url.replace('my%20photo.png', 'other.png');
    expect(
      (
        await handleMediaRequest(
          new Request(other, { method: 'PUT', headers: { 'content-length': '1' }, body: 'x' }),
          { bucket, signer, now: () => NOW },
        )
      ).status,
    ).toBe(403);
    const forged = (await blob.getDownloadUrl(KEY)).replace(/sig=[^&]+/, 'sig=AAAA');
    expect((await handleMediaRequest(new Request(forged), { bucket, signer })).status).toBe(403);
    // Same params signed for PUT do not authorize GET.
    expect((await handleMediaRequest(new Request(url), { bucket, signer })).status).toBe(403);
  });

  it('refuses unsigned requests and oversize uploads', async () => {
    const { bucket } = fakeBucket();
    expect(
      (await handleMediaRequest(new Request('https://api.example/media/a/b'), { bucket, signer }))
        .status,
    ).toBe(403);
    const { url } = await upload(bucket);
    const res = await handleMediaRequest(
      new Request(url, { method: 'PUT', headers: { 'content-length': '10' }, body: '0123456789' }),
      { bucket, signer, now: () => NOW, maxUploadBytes: 5 },
    );
    expect(res.status).toBe(413);
  });

  it('forces download for types a browser could execute', async () => {
    const { bucket } = fakeBucket();
    await bucket.put('a/page.html', '<script>alert(1)</script>', {
      httpMetadata: { contentType: 'text/html' },
    });
    const blob = createR2BlobStore(bucket, { signer, baseUrl: 'https://api.example' });
    const res = await handleMediaRequest(new Request(await blob.getDownloadUrl('a/page.html')), {
      bucket,
      signer,
    });
    expect(res.headers.get('content-disposition')).toBe('attachment');
  });

  it('routes signed GETs with params through the transform hook, and only those', async () => {
    const { bucket } = fakeBucket();
    await bucket.put(KEY, 'png-bytes', { httpMetadata: { contentType: 'image/png' } });
    const seen: string[] = [];
    const transform = async (_o: R2ObjectBodyLike, params: URLSearchParams) => {
      seen.push(params.get('w') ?? '');
      return new Response('transformed');
    };
    const params = new URLSearchParams({ w: '200' });
    params.set('sig', await signer.sign('GET', KEY, params));
    const path = `https://api.example/media/space-1/main/0190-asset/my%20photo.png`;
    const res = await handleMediaRequest(new Request(`${path}?${params}`), {
      bucket,
      signer,
      transform,
    });
    expect(await res.text()).toBe('transformed');
    expect(seen).toEqual(['200']);

    // Changing a signed transform param invalidates the URL.
    const tampered = `${path}?${params.toString().replace('w=200', 'w=9000')}`;
    expect(
      (await handleMediaRequest(new Request(tampered), { bucket, signer, transform })).status,
    ).toBe(403);
  });
});
