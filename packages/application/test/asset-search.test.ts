import {
  FakeBlobStore,
  FixedClock,
  InMemoryContentStore,
  InMemorySearchIndex,
  InMemoryVectorStore,
  LocalEmbeddingsProvider,
  SequenceIdGenerator,
} from '@contentworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  type AssetSearchDeps,
  archiveAsset,
  createAsset,
  createAssetFolder,
  createEnvironment,
  createSpace,
  createTag,
  indexAssetForSearch,
  publishAsset,
  searchAssets,
  searchDeliveredAssets,
  setAssetMetadata,
} from '../src/index';

const scope = { spaceId: 'shop', environmentId: 'main' };

describe('asset search', () => {
  let ctx: AppContext;
  let blob: FakeBlobStore;
  let deps: AssetSearchDeps;
  let index: InMemorySearchIndex;

  beforeEach(async () => {
    ctx = {
      store: new InMemoryContentStore(),
      clock: new FixedClock(),
      ids: new SequenceIdGenerator('a'),
    };
    blob = new FakeBlobStore();
    index = new InMemorySearchIndex();
    deps = {
      embeddings: new LocalEmbeddingsProvider(4096),
      vectors: new InMemoryVectorStore(),
      index,
    };
    await createSpace(ctx, { spaceId: 'shop', name: 'Shop', defaultLocale: 'en-US' });
  });

  async function add(
    fileName: string,
    contentType: string,
    alt: string,
    opts: { tags?: string[]; folderId?: string; at?: typeof scope } = {},
  ) {
    const at = opts.at ?? scope;
    const { asset } = await createAsset(
      ctx,
      blob,
      at,
      { fileName, contentType },
      {
        ...(opts.folderId ? { folderId: opts.folderId } : {}),
      },
    );
    await setAssetMetadata(ctx, at, asset.id, {
      altText: { 'en-US': alt },
      ...(opts.tags ? { tags: opts.tags } : {}),
    });
    await indexAssetForSearch(ctx, deps, blob, at, asset.id);
    return asset;
  }

  it('finds assets by text, best first, with facets that ignore their own filter', async () => {
    const red = await createTag(ctx, scope, { name: 'red' });
    const folder = await createAssetFolder(ctx, scope, { name: 'Campaign' });
    const mugImage = await add('mug.jpg', 'image/jpeg', 'Red mug', {
      tags: [red.id],
      folderId: folder.id,
    });
    const mugPdf = await add('mug-spec.pdf', 'application/pdf', 'Mug specification');
    await add('plate.jpg', 'image/jpeg', 'Blue plate');

    const all = await searchAssets(ctx, deps, scope, { q: 'mug' });
    expect(all.items.map((a) => a.id).sort()).toEqual([mugImage.id, mugPdf.id].sort());
    expect(all.total).toBe(2);
    expect(all.facets.kind).toEqual({ image: 1, document: 1 });
    expect(all.facets.tag).toEqual({ [red.id]: 1 });
    expect(all.facets.folder).toEqual({ [folder.id]: 1, root: 1 });

    const images = await searchAssets(ctx, deps, scope, { q: 'mug', filters: { kind: 'image' } });
    expect(images.items.map((a) => a.id)).toEqual([mugImage.id]);
    // The kind facet still counts the other kind.
    expect(images.facets.kind).toEqual({ image: 1, document: 1 });
    expect(images.facets.folder).toEqual({ [folder.id]: 1 });

    const rooted = await searchAssets(ctx, deps, scope, { q: 'mug', filters: { folderId: null } });
    expect(rooted.items.map((a) => a.id)).toEqual([mugPdf.id]);
    const tagged = await searchAssets(ctx, deps, scope, { q: 'mug', filters: { tag: red.id } });
    expect(tagged.items.map((a) => a.id)).toEqual([mugImage.id]);
  });

  it('leaves archived assets out unless asked, and honours limit', async () => {
    const a = await add('mug.jpg', 'image/jpeg', 'Mug one');
    await add('mug2.jpg', 'image/jpeg', 'Mug two');
    await archiveAsset(ctx, scope, a.id);
    expect((await searchAssets(ctx, deps, scope, { q: 'mug' })).total).toBe(1);
    const all = await searchAssets(ctx, deps, scope, { q: 'mug', filters: { status: 'all' } });
    expect(all.total).toBe(2);
    const one = await searchAssets(ctx, deps, scope, {
      q: 'mug',
      limit: 1,
      filters: { status: 'all' },
    });
    expect(one.items).toHaveLength(1);
    expect(one.total).toBe(2);
  });

  it('never returns another environment’s assets', async () => {
    await createEnvironment(ctx, 'shop', 'staging', 'Staging');
    const staging = { spaceId: 'shop', environmentId: 'staging' };
    await add('mug.jpg', 'image/jpeg', 'Mug', { at: staging });
    expect((await searchAssets(ctx, deps, scope, { q: 'mug' })).items).toEqual([]);
    expect((await searchAssets(ctx, deps, staging, { q: 'mug' })).total).toBe(1);
  });

  it('Delivery search returns published assets only, projected, never ranked on draft text', async () => {
    const published = await add('mug.jpg', 'image/jpeg', 'Mug');
    await add('draft-mug.jpg', 'image/jpeg', 'Draft mug');
    await publishAsset(ctx, scope, published.id);
    await indexAssetForSearch(ctx, deps, blob, scope, published.id);
    // A draft edit after publishing: Delivery's index still holds the published text.
    await setAssetMetadata(ctx, scope, published.id, { altText: { 'en-US': 'Secret codename' } });
    await indexAssetForSearch(ctx, deps, blob, scope, published.id);

    const page = await searchDeliveredAssets(ctx, deps, scope, { q: 'mug' });
    expect(page.items.map((a) => a.id)).toEqual([published.id]);
    expect(page.items[0]).toMatchObject({ kind: 'image', altText: { 'en-US': 'Mug' } });
    expect((await searchDeliveredAssets(ctx, { index }, scope, { q: 'codename' })).items).toEqual(
      [],
    );
  });

  it('falls back to scanning recent assets when no index is bound', async () => {
    const a = await add('mug.jpg', 'image/jpeg', 'Mug');
    const page = await searchAssets(ctx, {}, scope, { q: 'MUG' });
    expect(page.items.map((x) => x.id)).toEqual([a.id]);
  });

  it('refuses an empty or oversized query', async () => {
    await expect(searchAssets(ctx, deps, scope, { q: '  ' })).rejects.toMatchObject({
      issues: [{ field: 'q' }],
    });
    await expect(searchAssets(ctx, deps, scope, { q: 'x'.repeat(257) })).rejects.toThrow();
  });
});
