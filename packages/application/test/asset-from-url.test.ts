import { createHash } from 'node:crypto';
import { ValidationError } from '@contentworker/domain';
import type { RemoteFetcher, RemoteFile } from '@contentworker/ports';
import {
  FakeAssetIngestQueue,
  FakeBlobStore,
  FixedClock,
  InMemoryContentStore,
  SequenceIdGenerator,
} from '@contentworker/test-kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type AppContext,
  ASSET_FROM_URL_MAX_BYTES,
  archiveAsset,
  createAssetFromUrl,
  createSpace,
} from '../src/index';

const scope = { spaceId: 'shop', environmentId: 'main' };
const other = { spaceId: 'blog', environmentId: 'main' };
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

/** A fetcher answering each URL from `files`, recording what it was asked for. */
function fetcher(
  files: Record<string, RemoteFile | Error>,
): RemoteFetcher & { calls: { url: string; maxBytes: number }[] } {
  const calls: { url: string; maxBytes: number }[] = [];
  return {
    calls,
    async get() {
      throw new Error('not used');
    },
    async getBytes(url, options) {
      calls.push({ url, maxBytes: options.maxBytes });
      const file = files[url];
      if (!file) return { status: 404, bytes: new Uint8Array() };
      if (file instanceof Error) throw file;
      return file;
    },
  };
}

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

describe('create an asset from a URL', () => {
  let ctx: AppContext;
  let store: InMemoryContentStore;
  let blob: FakeBlobStore;
  let ingest: FakeAssetIngestQueue;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(async () => {
    store = new InMemoryContentStore();
    blob = new FakeBlobStore();
    ingest = new FakeAssetIngestQueue();
    ctx = { store, clock: new FixedClock(), ids: new SequenceIdGenerator('a') };
    await createSpace(ctx, { spaceId: 'shop', name: 'Shop', defaultLocale: 'en-US' });
    await createSpace(ctx, { spaceId: 'blog', name: 'Blog', defaultLocale: 'en-US' });
  });

  const files = fetcher({
    'https://cdn.example.com/media/hero%20shot.png': {
      status: 200,
      contentType: 'image/png; charset=binary',
      bytes: PNG,
    },
  });

  it('stores the file under its own key, writes the draft and hands it to ingest', async () => {
    const { asset, deduplicated } = await createAssetFromUrl(
      ctx,
      { blob, fetcher: files, ingest },
      scope,
      { url: 'https://cdn.example.com/media/hero%20shot.png', title: 'Hero', alt: 'A red bike' },
      { createdBy: 'user:ada' },
    );
    expect(deduplicated).toBe(false);
    expect(asset.status).toBe('draft');
    expect(asset.file).toMatchObject({ fileName: 'hero shot.png', contentType: 'image/png' });
    expect(asset.file.size).toBe(PNG.byteLength);
    expect(asset.title).toEqual({ 'en-US': 'Hero' });
    expect(asset.metadata.altText).toEqual({ 'en-US': 'A red bike' });

    const stored = await store.assets.get(scope, asset.id);
    expect(stored?.createdBy).toBe('user:ada');
    const key = stored?.r2Key as string;
    expect(key).toBe(`shop/main/${asset.id}/hero shot.png`);
    expect(await blob.head(key)).toMatchObject({ size: PNG.byteLength, contentType: 'image/png' });
    // Named by the write's etag, so R2's notification of the same write is the same run.
    expect(ingest.created).toEqual([{ key, etag: (await blob.head(key))?.etag }]);
    expect(files.calls.at(-1)?.maxBytes).toBe(ASSET_FROM_URL_MAX_BYTES);
  });

  it('puts title and alt text under the locale asked for, which must be the space’s', async () => {
    await store.spaces.create({
      ...(await store.spaces.getConfig(scope))!,
      locales: ['en-US', 'de-DE'],
    });
    const { asset } = await createAssetFromUrl(ctx, { blob, fetcher: files, ingest }, scope, {
      url: 'https://cdn.example.com/media/hero%20shot.png',
      fileName: 'held.png',
      title: 'Held',
      locale: 'de-DE',
    });
    expect(asset.file.fileName).toBe('held.png');
    expect(asset.title).toEqual({ 'de-DE': 'Held' });
    await expect(
      createAssetFromUrl(ctx, { blob, fetcher: files }, scope, {
        url: 'https://cdn.example.com/media/hero%20shot.png',
        locale: 'fr-FR',
      }),
    ).rejects.toThrow(ValidationError);
  });

  it('returns the asset already holding the bytes instead of storing them again', async () => {
    const first = await createAssetFromUrl(ctx, { blob, fetcher: files, ingest }, scope, {
      url: 'https://cdn.example.com/media/hero%20shot.png',
    });
    // What ingest's hash step records once it has read the file.
    await store.assets.recordIngest(scope, first.asset.id, 1, { contentHash: sha(PNG) });

    const again = await createAssetFromUrl(ctx, { blob, fetcher: files, ingest }, scope, {
      url: 'https://cdn.example.com/media/hero%20shot.png',
    });
    expect(again.deduplicated).toBe(true);
    expect(again.asset.id).toBe(first.asset.id);
    expect((await store.assets.list(scope, { filters: { status: 'all' } })).items).toHaveLength(1);
    expect(ingest.created).toHaveLength(1);
  });

  it('does not reuse an archived asset, nor one in another space', async () => {
    const first = await createAssetFromUrl(ctx, { blob, fetcher: files }, scope, {
      url: 'https://cdn.example.com/media/hero%20shot.png',
    });
    await store.assets.recordIngest(scope, first.asset.id, 1, { contentHash: sha(PNG) });

    const elsewhere = await createAssetFromUrl(ctx, { blob, fetcher: files }, other, {
      url: 'https://cdn.example.com/media/hero%20shot.png',
    });
    expect(elsewhere.deduplicated).toBe(false);
    expect(elsewhere.asset.id).not.toBe(first.asset.id);

    await archiveAsset(ctx, scope, first.asset.id);
    const fresh = await createAssetFromUrl(ctx, { blob, fetcher: files }, scope, {
      url: 'https://cdn.example.com/media/hero%20shot.png',
    });
    expect(fresh.deduplicated).toBe(false);
    expect(fresh.asset.id).not.toBe(first.asset.id);
  });

  it.each([
    'http://127.0.0.1/a.png',
    'http://localhost:8787/a.png',
    'http://10.0.0.5/a.png',
    'http://169.254.169.254/latest/meta-data',
    'http://[::1]/a.png',
    'ftp://files.example.com/a.png',
    'not a url',
  ])('refuses %s before fetching anything', async (url) => {
    const guarded = fetcher({});
    await expect(
      createAssetFromUrl(ctx, { blob, fetcher: guarded }, scope, { url }),
    ).rejects.toThrow(ValidationError);
    expect(guarded.calls).toEqual([]);
  });

  it('refuses a file over the cap, an error status, a redirect and an empty body', async () => {
    const bad = fetcher({
      'https://cdn.example.com/big.bin': new Error(
        `Response exceeds the ${ASSET_FROM_URL_MAX_BYTES} byte limit`,
      ),
      'https://cdn.example.com/moved.png': { status: 302, bytes: new Uint8Array() },
      'https://cdn.example.com/broken.png': { status: 500, bytes: new Uint8Array() },
      'https://cdn.example.com/empty.png': { status: 200, bytes: new Uint8Array() },
    });
    for (const [path, message] of [
      ['big.bin', /byte limit/],
      ['missing.png', /answered 404/],
      ['moved.png', /answered 302/],
      ['broken.png', /answered 500/],
      ['empty.png', /empty file/],
    ] as const) {
      const err = await createAssetFromUrl(ctx, { blob, fetcher: bad, ingest }, scope, {
        url: `https://cdn.example.com/${path}`,
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ValidationError);
      expect(JSON.stringify((err as ValidationError).issues)).toMatch(message);
    }
    // Nothing was written for any of them.
    expect((await store.assets.list(scope, { filters: { status: 'all' } })).items).toEqual([]);
    expect(await blob.listKeys('shop/', 100)).toEqual({ keys: [], cursor: undefined });
    expect(ingest.created).toEqual([]);
  });

  it('deletes the stored file when the record cannot be written, and rethrows why', async () => {
    const failure = new Error('D1 unavailable');
    vi.spyOn(store.assets, 'create').mockRejectedValueOnce(failure);
    const err = await createAssetFromUrl(ctx, { blob, fetcher: files, ingest }, scope, {
      url: 'https://cdn.example.com/media/hero%20shot.png',
    }).catch((e: unknown) => e);
    expect(err).toBe(failure);
    expect(blob.deletes).toHaveLength(1);
    expect(blob.deletes[0]).toMatch(/^shop\/main\/.+\/hero shot\.png$/);
    expect(await blob.listKeys('shop/', 100)).toEqual({ keys: [], cursor: undefined });
    expect(ingest.created).toEqual([]);
  });

  it('still rethrows the record’s failure when the cleanup fails too', async () => {
    const failure = new Error('D1 unavailable');
    vi.spyOn(store.assets, 'create').mockRejectedValueOnce(failure);
    vi.spyOn(blob, 'delete').mockRejectedValueOnce(new Error('R2 unavailable'));
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      createAssetFromUrl(ctx, { blob, fetcher: files }, scope, {
        url: 'https://cdn.example.com/media/hero%20shot.png',
      }),
    ).rejects.toBe(failure);
    expect(blob.delete).toHaveBeenCalledTimes(1);
    quiet.mockRestore();
  });

  it('keeps the file once the record holds it, even when the ingest notice fails', async () => {
    vi.spyOn(ingest, 'objectCreated').mockRejectedValueOnce(new Error('queue down'));
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { asset } = await createAssetFromUrl(ctx, { blob, fetcher: files, ingest }, scope, {
      url: 'https://cdn.example.com/media/hero%20shot.png',
    });
    expect(blob.deletes).toEqual([]);
    expect(await store.assets.get(scope, asset.id)).toBeTruthy();
    quiet.mockRestore();
  });

  it('falls back to a generic type and name when the response names neither', async () => {
    const bare = fetcher({
      'https://cdn.example.com/': { status: 200, contentType: 'nonsense', bytes: PNG },
    });
    const { asset } = await createAssetFromUrl(ctx, { blob, fetcher: bare }, scope, {
      url: 'https://cdn.example.com/',
    });
    expect(asset.file).toMatchObject({ fileName: 'file', contentType: 'application/octet-stream' });
  });
});
