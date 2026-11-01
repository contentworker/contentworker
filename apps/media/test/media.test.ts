import { createExecutionContext, createMessageBatch, getQueueResult, SELF } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { createKvAssetGate } from '@contentworker/adapters/asset-gate-kv';
import { createMediaUrlSigner, signedMediaUrl } from '@contentworker/adapters/blob-r2';
import {
  type AppContext,
  createAsset,
  createAssetRendition,
  createSpace,
  publishAsset,
  setAssetMetadata,
  syncAssetGate,
  unpublishAsset,
} from '@contentworker/application';
import { createD1Store } from '@contentworker/db';
import { type Asset, type AssetVariant, assetMediaPath } from '@contentworker/domain';
import type { PurgeMessage } from '@contentworker/platform/messages';
import { FakeBlobStore } from '@contentworker/test-kit';
import { describe, expect, it } from 'vitest';
import worker from '../src/index';

const ORIGIN = 'https://media.example.test';

let seq = 0;
function context(): AppContext {
  return {
    store: createD1Store(env.DB),
    clock: { now: () => new Date() },
    ids: { newId: () => crypto.randomUUID() },
  };
}

const gate = createKvAssetGate(env.KV_CACHE);

/** A body read as bytes (`.text()` on an image type warns), then as text or JSON. */
const textOf = async (res: Response) => new TextDecoder().decode(await res.arrayBuffer());
const jsonOf = async <T>(res: Response) => JSON.parse(await textOf(res)) as T;

/** A space of its own per test (the D1 is shared by the file), with one uploaded image. */
async function uploaded(
  opts: { contentType?: string; fileName?: string; bytes?: string } = {},
): Promise<{ ctx: AppContext; scope: { spaceId: string; environmentId: string }; asset: Asset }> {
  const ctx = context();
  const scope = { spaceId: `media-space-${++seq}`, environmentId: 'main' };
  await createSpace(ctx, { spaceId: scope.spaceId, name: 'Media', defaultLocale: 'en-US' });
  const { asset } = await createAsset(ctx, new FakeBlobStore(), scope, {
    fileName: opts.fileName ?? 'hero shot.jpg',
    contentType: opts.contentType ?? 'image/jpeg',
  });
  await env.MEDIA_BUCKET.put(asset.r2Key as string, opts.bytes ?? 'JPEG-BYTES', {
    httpMetadata: { contentType: opts.contentType ?? 'image/jpeg' },
  });
  return { ctx, scope, asset };
}

/** Publishes it and runs what the engine runs for the event: the gate follows the snapshot. */
async function published(opts: Parameters<typeof uploaded>[0] = {}) {
  const u = await uploaded(opts);
  await publishAsset(u.ctx, u.scope, u.asset.id);
  expect(await syncAssetGate(u.ctx, gate, u.scope, u.asset.id)).toBe('written');
  return u;
}

const urlOf = (
  u: { scope: { spaceId: string; environmentId: string }; asset: Asset },
  variant: AssetVariant,
  version = 1,
) =>
  `${ORIGIN}${assetMediaPath({
    scope: u.scope,
    assetId: u.asset.id,
    version,
    variant,
    fileName: u.asset.file.fileName,
  })}`;

describe('the media Worker', () => {
  it('serves a published original, immutable and tagged for purges', async () => {
    const u = await published();
    const res = await SELF.fetch(urlOf(u, { kind: 'original' }));
    expect(res.status).toBe(200);
    expect(await textOf(res)).toBe('JPEG-BYTES');
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('cache-tag')).toBe(
      `cwa:${u.scope.spaceId}:main:${u.asset.id},cwe:${u.scope.spaceId}:main`,
    );
    // Conditional reads answer 304 against the object's ETag.
    const etag = res.headers.get('etag') as string;
    const again = await SELF.fetch(urlOf(u, { kind: 'original' }), {
      headers: { 'if-none-match': etag },
    });
    expect(again.status).toBe(304);
  });

  it('answers 404 once the asset is unpublished and its media purged', async () => {
    const u = await published();
    expect((await SELF.fetch(urlOf(u, { kind: 'original' }))).status).toBe(200);

    await unpublishAsset(u.ctx, u.scope, u.asset.id);
    expect(await syncAssetGate(u.ctx, gate, u.scope, u.asset.id)).toBe('removed');
    // The media purge the engine enqueues, drained by this Worker's consumer.
    const batch = createMessageBatch<PurgeMessage>('contentworker-media-purge', [
      {
        id: 'purge-1',
        timestamp: new Date(),
        attempts: 1,
        body: { tags: [`cwa:${u.scope.spaceId}:main:${u.asset.id}`] },
      },
    ]);
    // The consumer purges through this Worker's own cached entrypoint (ctx.exports).
    const ctx = Object.assign(createExecutionContext(), { exports });
    await worker.queue(batch, env as never, ctx);
    const result = await getQueueResult(batch, ctx);
    expect(result.explicitAcks).toEqual(['purge-1']);

    const res = await SELF.fetch(urlOf(u, { kind: 'original' }));
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('reads a D1 replica when the gate has no entry yet, and writes nothing', async () => {
    const u = await uploaded();
    await publishAsset(u.ctx, u.scope, u.asset.id);
    // The engine hasn't handled the event: no gate entry.
    expect(await gate.get(u.scope, u.asset.id)).toBeNull();
    const res = await SELF.fetch(urlOf(u, { kind: 'original' }));
    expect(res.status).toBe(200);
    expect(await gate.get(u.scope, u.asset.id)).toBeNull();
  });

  it('answers 410 once the asset’s rights have expired', async () => {
    const u = await uploaded();
    await u.ctx.store.assets.save(u.scope, {
      ...u.asset,
      rights: { license: 'editorial', expiresAt: '2020-01-01T00:00:00.000Z' },
    });
    await publishAsset(u.ctx, u.scope, u.asset.id);
    await syncAssetGate(u.ctx, gate, u.scope, u.asset.id);
    const res = await SELF.fetch(urlOf(u, { kind: 'original' }));
    expect(res.status).toBe(410);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('answers 404 for an unknown variant, version or file name', async () => {
    const u = await published();
    const original = urlOf(u, { kind: 'original' });
    for (const bad of [
      original.replace('/o/', '/w123/'), // off the ladder
      original.replace('/o/', '/w4000/'),
      original.replace('/o/', '/x/'),
      original.replace('/v1/', '/v2/'), // not the published version
      original.replace(/\/[^/]+$/, '/other.jpg'),
      urlOf(u, { kind: 'rendition', name: 'no-such-preset' }),
      `${ORIGIN}/${u.scope.spaceId}/main/${u.asset.id}`,
    ]) {
      const res = await SELF.fetch(bad);
      expect(res.status, bad).toBe(404);
    }
    // Not something the service can resize: only the original exists.
    const pdf = await published({ contentType: 'application/pdf', fileName: 'brief.pdf' });
    expect((await SELF.fetch(urlOf(pdf, { kind: 'width', width: 640 }))).status).toBe(404);
    const doc = await SELF.fetch(urlOf(pdf, { kind: 'original' }));
    expect(doc.status).toBe(200);
  });

  it('negotiates a width step’s format from Accept and says it varies', async () => {
    const u = await published();
    const step = `${urlOf(u, { kind: 'width', width: 640 })}?fm=auto`;
    const formatFor = async (accept?: string) => {
      const res = await SELF.fetch(step, accept ? { headers: { accept } } : {});
      expect(res.status).toBe(200);
      expect(res.headers.get('vary')).toBe('Accept');
      expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
      return (await jsonOf<{ format: string }>(res)).format;
    };
    expect(await formatFor('image/avif,image/webp,*/*')).toBe('image/avif');
    expect(await formatFor('image/webp,*/*')).toBe('image/webp');
    expect(await formatFor('*/*')).toBe('image/jpeg');
    // Without fm=auto the step keeps the source's format, whatever the reader accepts.
    const plain = await SELF.fetch(urlOf(u, { kind: 'width', width: 640 }), {
      headers: { accept: 'image/avif' },
    });
    expect((await jsonOf<{ format: string }>(plain)).format).toBe('image/jpeg');
    expect(plain.headers.get('vary')).toBeNull();
  });

  it('serves a rendition with the focal point as gravity on a crop', async () => {
    const u = await published();
    await setAssetMetadata(u.ctx, u.scope, u.asset.id, { focalPoint: { x: 0.25, y: 0.75 } });
    await publishAsset(u.ctx, u.scope, u.asset.id);
    await syncAssetGate(u.ctx, gate, u.scope, u.asset.id);
    await createAssetRendition(u.ctx, u.scope, {
      name: 'square',
      width: 400,
      height: 400,
      fit: 'crop',
      format: 'webp',
    });
    const res = await SELF.fetch(urlOf(u, { kind: 'rendition', name: 'square' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-tag')).toContain(`cwr:${u.scope.spaceId}:square`);
    const body = await jsonOf<{ format: string; transforms: Record<string, unknown>[] }>(res);
    expect(body.format).toBe('image/webp');
    expect(body.transforms[0]).toMatchObject({
      width: 400,
      height: 400,
      fit: 'cover',
      gravity: { x: 0.25, y: 0.75, mode: 'box-center' },
    });
  });

  it('serves a signed draft read until it expires, and never an upload', async () => {
    const u = await uploaded({ bytes: 'DRAFT' });
    const signer = createMediaUrlSigner(env.MEDIA_SIGNING_SECRET);
    const key = u.asset.r2Key as string;
    const now = Math.floor(Date.now() / 1000);
    const fresh = await signedMediaUrl(
      signer,
      ORIGIN,
      'GET',
      key,
      new URLSearchParams({ exp: String(now + 600) }),
    );
    const ok = await SELF.fetch(fresh);
    expect(ok.status).toBe(200);
    expect(await textOf(ok)).toBe('DRAFT');
    expect(ok.headers.get('cache-control')).toMatch(/^private, max-age=\d+$/);

    const expired = await signedMediaUrl(
      signer,
      ORIGIN,
      'GET',
      key,
      new URLSearchParams({ exp: String(now - 1) }),
    );
    expect((await SELF.fetch(expired)).status).toBe(403);
    // The stored, non-expiring kind is the api's alone.
    expect((await SELF.fetch(await signedMediaUrl(signer, ORIGIN, 'GET', key))).status).toBe(403);
    // Moving the expiry breaks the signature.
    expect((await SELF.fetch(expired.replace(/exp=\d+/, `exp=${now + 600}`))).status).toBe(403);
    const put = await signedMediaUrl(
      signer,
      ORIGIN,
      'PUT',
      key,
      new URLSearchParams({ ct: 'image/jpeg', exp: String(now + 600) }),
    );
    expect((await SELF.fetch(put, { method: 'PUT', body: 'x' })).status).toBe(405);
  });
});
