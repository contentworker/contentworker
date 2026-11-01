import { ConflictError, NotFoundError, ValidationError } from '@contentworker/domain';
import {
  FakeAssetIngestQueue,
  FakeBlobStore,
  FixedClock,
  InMemoryContentStore,
  SequenceIdGenerator,
} from '@contentworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ABANDONED_MULTIPART_TTL_MS,
  type AppContext,
  abortMultipartAssetUpload,
  assetFileKey,
  commitAssetFile,
  completeMultipartAssetUpload,
  createAsset,
  createSpace,
  DEFAULT_PART_BYTES,
  multipartPlan,
  partLength,
  replaceAssetFile,
  restoreAssetVersion,
  signAssetUploadParts,
  startMultipartAssetFileReplacement,
  startMultipartAssetUpload,
  sweepAbandonedMultipartUploads,
} from '../src/index';

const scope = { spaceId: 'shop', environmentId: 'main' };
const MiB = 1024 * 1024;

describe('multipart uploads', () => {
  let ctx: AppContext;
  let store: InMemoryContentStore;
  let blob: FakeBlobStore;
  let clock: FixedClock;

  beforeEach(async () => {
    store = new InMemoryContentStore();
    blob = new FakeBlobStore();
    clock = new FixedClock();
    ctx = { store, clock, ids: new SequenceIdGenerator('u') };
    await createSpace(ctx, { spaceId: 'shop', name: 'Shop', defaultLocale: 'en-US' });
  });

  it('plans equal parts but the last, growing the part size past 10,000 parts', () => {
    expect(multipartPlan(250 * MiB)).toEqual({ partSize: DEFAULT_PART_BYTES, partCount: 32 });
    const huge = multipartPlan(200 * 1024 * MiB);
    expect(huge.partCount).toBeLessThanOrEqual(10_000);
    expect(huge.partSize % MiB).toBe(0);
    const upload = { size: 20 * MiB + 3, partSize: 8 * MiB };
    expect([1, 2, 3].map((n) => partLength(upload, n))).toEqual([8 * MiB, 8 * MiB, 4 * MiB + 3]);
  });

  it('starts, signs exact-length parts, completes and hands the file to ingest', async () => {
    const ingest = new FakeAssetIngestQueue();
    const size = 2 * DEFAULT_PART_BYTES + 5;
    const started = await startMultipartAssetUpload(
      ctx,
      blob,
      scope,
      { fileName: '../../other/film.mov', contentType: 'video/quicktime', size },
      { createdBy: 'ann' },
    );
    const { asset, upload } = started;
    // The key follows the single PUT's rules: this scope, this asset, a safe file name.
    expect(asset.r2Key).toBe(`shop/main/${asset.id}/film.mov`);
    expect(upload.partCount).toBe(3);
    const { parts } = await signAssetUploadParts(
      ctx,
      blob,
      scope,
      asset.id,
      upload.uploadId,
      [3, 1, 2],
    );
    expect(parts.map((p) => [p.partNumber, p.length])).toEqual([
      [3, 5],
      [1, DEFAULT_PART_BYTES],
      [2, DEFAULT_PART_BYTES],
    ]);
    const uploaded = [];
    for (const p of parts) {
      uploaded.push(
        await blob.multipart.uploadPart(
          asset.r2Key ?? '',
          upload.uploadId,
          p.partNumber,
          new Uint8Array(p.length),
        ),
      );
    }
    const done = await completeMultipartAssetUpload(
      ctx,
      { blob, ingest },
      scope,
      asset.id,
      upload.uploadId,
      uploaded,
    );
    expect(done.id).toBe(asset.id);
    expect((await blob.head(asset.r2Key ?? ''))?.size).toBe(size);
    expect(ingest.created).toEqual([{ key: asset.r2Key, etag: expect.stringMatching(/-3$/) }]);
    // Completing again (a retry whose answer was lost) answers with the same asset, and starts no
    // second ingest; one for an asset without bytes is a 404.
    const again = await completeMultipartAssetUpload(
      ctx,
      { blob, ingest },
      scope,
      asset.id,
      upload.uploadId,
      uploaded,
    );
    expect(again.id).toBe(asset.id);
    expect(ingest.created).toHaveLength(1);
    const empty = await startMultipartAssetUpload(ctx, blob, scope, {
      fileName: 'b.bin',
      contentType: 'application/octet-stream',
      size: 3,
    });
    await expect(
      completeMultipartAssetUpload(ctx, { blob, ingest }, scope, empty.asset.id, 'never', uploaded),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('refuses a size past the cap, bad part numbers, and an incomplete part list', async () => {
    const tight = { ...ctx, maxUploadBytes: 10 * MiB };
    await expect(
      startMultipartAssetUpload(tight, blob, scope, {
        fileName: 'a.bin',
        contentType: 'application/octet-stream',
        size: 10 * MiB + 1,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    const { asset, upload } = await startMultipartAssetUpload(ctx, blob, scope, {
      fileName: 'a.bin',
      contentType: 'application/octet-stream',
      size: DEFAULT_PART_BYTES + 1,
    });
    for (const numbers of [
      [0],
      [3],
      [],
      Array.from({ length: 101 }, () => 1).map((_, i) => i + 1),
    ]) {
      await expect(
        signAssetUploadParts(ctx, blob, scope, asset.id, upload.uploadId, numbers),
      ).rejects.toBeInstanceOf(ValidationError);
    }
    await expect(
      completeMultipartAssetUpload(ctx, { blob }, scope, asset.id, upload.uploadId, [
        { partNumber: 1, etag: 'e' },
      ]),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      completeMultipartAssetUpload(ctx, { blob }, scope, asset.id, upload.uploadId, [
        { partNumber: 1, etag: 'e' },
        { partNumber: 1, etag: 'e' },
      ]),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('does not let one scope sign or complete another scope’s upload', async () => {
    const { asset, upload } = await startMultipartAssetUpload(ctx, blob, scope, {
      fileName: 'a.bin',
      contentType: 'application/octet-stream',
      size: 10,
    });
    const other = { spaceId: 'shop', environmentId: 'staging' };
    await expect(
      signAssetUploadParts(ctx, blob, other, asset.id, upload.uploadId, [1]),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      abortMultipartAssetUpload(ctx, blob, other, asset.id, upload.uploadId),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('aborts: the parts go, and the empty draft with them', async () => {
    const { asset, upload } = await startMultipartAssetUpload(ctx, blob, scope, {
      fileName: 'a.bin',
      contentType: 'application/octet-stream',
      size: 10,
    });
    await abortMultipartAssetUpload(ctx, blob, scope, asset.id, upload.uploadId);
    expect(blob.aborted).toEqual([upload.uploadId]);
    expect(await store.assets.get(scope, asset.id)).toBeNull();
  });

  it('sweeps uploads left unfinished a day on, once each', async () => {
    const { upload } = await startMultipartAssetUpload(ctx, blob, scope, {
      fileName: 'a.bin',
      contentType: 'application/octet-stream',
      size: 10,
    });
    expect(await sweepAbandonedMultipartUploads(ctx, blob)).toEqual({ aborted: 0, failed: 0 });
    clock.advance(ABANDONED_MULTIPART_TTL_MS + 1);
    expect(await sweepAbandonedMultipartUploads(ctx, blob)).toEqual({ aborted: 1, failed: 0 });
    expect(blob.aborted).toEqual([upload.uploadId]);
    expect(await sweepAbandonedMultipartUploads(ctx, blob)).toEqual({ aborted: 0, failed: 0 });
  });
});

describe('replacing a file in parts', () => {
  let ctx: AppContext;
  let store: InMemoryContentStore;
  let blob: FakeBlobStore;
  let clock: FixedClock;

  beforeEach(async () => {
    store = new InMemoryContentStore();
    blob = new FakeBlobStore();
    clock = new FixedClock();
    ctx = { store, clock, ids: new SequenceIdGenerator('r') };
    await createSpace(ctx, { spaceId: 'shop', name: 'Shop', defaultLocale: 'en-US' });
  });

  /** A published-able asset with its first file stored. */
  async function asset() {
    const created = await createAsset(ctx, blob, scope, {
      fileName: 'film.mov',
      contentType: 'video/quicktime',
    });
    await blob.put(assetFileKey(scope, created.asset), 'v1', 'video/quicktime');
    return created.asset;
  }

  /** Uploads every part the way a client does, and returns their etags. */
  async function sendParts(key: string, uploadId: string, size: number, partSize: number) {
    const out = [];
    for (let n = 1, at = 0; at < size; n++, at += partSize) {
      out.push(
        await blob.multipart.uploadPart(
          key,
          uploadId,
          n,
          new Uint8Array(Math.min(partSize, size - at)),
        ),
      );
    }
    return out;
  }

  const big = 2 * DEFAULT_PART_BYTES + 7;
  const nextKey = (id: string, version: number, name = 'cut.mov') =>
    `shop/main/${id}/v${version}/file/${name}`;

  it('uploads the next version in parts and commits it on completion, in the version-bump unit', async () => {
    const a = await asset();
    const started = await startMultipartAssetFileReplacement(ctx, blob, scope, a.id, {
      fileName: '../cut.mov',
      contentType: 'video/quicktime',
      size: big,
    });
    expect(started.version).toBe(2);
    expect(started.upload.partCount).toBe(3);
    // Nothing changes until it completes.
    expect((await store.assets.get(scope, a.id))?.version ?? 1).toBe(1);
    const { parts } = await signAssetUploadParts(
      ctx,
      blob,
      scope,
      a.id,
      started.upload.uploadId,
      [1, 2, 3],
    );
    expect(parts.map((p) => p.length)).toEqual([DEFAULT_PART_BYTES, DEFAULT_PART_BYTES, 7]);
    const ingest = new FakeAssetIngestQueue();
    const uploaded = await sendParts(
      nextKey(a.id, 2),
      started.upload.uploadId,
      big,
      started.upload.partSize,
    );
    const done = await completeMultipartAssetUpload(
      ctx,
      { blob, ingest },
      scope,
      a.id,
      started.upload.uploadId,
      uploaded,
      { by: 'ann' },
    );
    expect(done.version).toBe(2);
    expect(done.r2Key).toBe(nextKey(a.id, 2));
    expect(done.file).toMatchObject({ fileName: 'cut.mov', size: big });
    // Ingest starts from the commit's event, not a second notice.
    expect(ingest.created).toEqual([]);
    const replaced = store.allEvents().filter((e) => e.type === 'asset.file_replaced');
    expect(replaced).toEqual([
      expect.objectContaining({ assetId: a.id, version: 2, previousVersion: 1 }),
    ]);
    // The upload went in the same unit.
    expect(await store.assetUploads.listForAsset(scope, a.id)).toEqual([]);
    // A retry whose answer was lost gets the committed asset back, and commits nothing twice.
    const again = await completeMultipartAssetUpload(
      ctx,
      { blob, ingest },
      scope,
      a.id,
      started.upload.uploadId,
      uploaded,
    );
    expect(again.version).toBe(2);
    expect(store.allEvents().filter((e) => e.type === 'asset.file_replaced')).toHaveLength(1);
  });

  it('refuses a hosted video, a size past the cap, and a type the space refuses, as a single replace does', async () => {
    const a = await asset();
    await expect(
      startMultipartAssetFileReplacement({ ...ctx, maxUploadBytes: 10 * MiB }, blob, scope, a.id, {
        fileName: 'cut.mov',
        contentType: 'video/quicktime',
        size: 10 * MiB + 1,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      startMultipartAssetFileReplacement(ctx, blob, scope, 'missing', {
        fileName: 'cut.mov',
        contentType: 'video/quicktime',
        size: big,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(blob.uploadsInProgress.size).toBe(0);
  });

  it('lets the latest replace win: a newer start aborts the one in progress', async () => {
    const a = await asset();
    const first = await startMultipartAssetFileReplacement(ctx, blob, scope, a.id, {
      fileName: 'cut.mov',
      contentType: 'video/quicktime',
      size: big,
    });
    const firstParts = await sendParts(
      nextKey(a.id, 2),
      first.upload.uploadId,
      big,
      first.upload.partSize,
    );
    // A single-PUT replace starts meanwhile: the multipart upload is superseded.
    const single = await replaceAssetFile(ctx, blob, scope, a.id, {
      fileName: 'other.mov',
      contentType: 'video/quicktime',
    });
    expect(blob.aborted).toEqual([first.upload.uploadId]);
    await blob.put(nextKey(a.id, 2, 'other.mov'), 'small', 'video/quicktime');
    await commitAssetFile(ctx, blob, scope, a.id, single.commit);
    // The superseded upload's completion is told so (409), and changes nothing.
    await expect(
      completeMultipartAssetUpload(ctx, { blob }, scope, a.id, first.upload.uploadId, firstParts),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(await store.assetUploads.listForAsset(scope, a.id)).toEqual([]);
    expect((await store.assets.get(scope, a.id))?.r2Key).toBe(nextKey(a.id, 2, 'other.mov'));
    expect(blob.bytes(nextKey(a.id, 2))).toBeNull();
  });

  it('tells a superseded upload so, even before the newer replace commits', async () => {
    const a = await asset();
    const first = await startMultipartAssetFileReplacement(ctx, blob, scope, a.id, {
      fileName: 'cut.mov',
      contentType: 'video/quicktime',
      size: big,
    });
    const parts = await sendParts(
      nextKey(a.id, 2),
      first.upload.uploadId,
      big,
      first.upload.partSize,
    );
    await startMultipartAssetFileReplacement(ctx, blob, scope, a.id, {
      fileName: 'cut.mov',
      contentType: 'video/quicktime',
      size: big,
    });
    await expect(
      completeMultipartAssetUpload(ctx, { blob }, scope, a.id, first.upload.uploadId, parts),
    ).rejects.toThrow(/newer replace/);
    expect((await store.assets.get(scope, a.id))?.version ?? 1).toBe(1);
    expect(await store.assetUploads.listForAsset(scope, a.id)).toHaveLength(1);
  });

  it('never completes over a version committed meanwhile (a restore took it): 409, upload dropped', async () => {
    const a = await asset();
    // v2 by a single replace, so there is a version to restore.
    const r = await replaceAssetFile(ctx, blob, scope, a.id, {
      fileName: 'b.mov',
      contentType: 'video/quicktime',
    });
    await blob.put(nextKey(a.id, 2, 'b.mov'), 'v2', 'video/quicktime');
    await commitAssetFile(ctx, blob, scope, a.id, r.commit);
    const started = await startMultipartAssetFileReplacement(ctx, blob, scope, a.id, {
      fileName: 'cut.mov',
      contentType: 'video/quicktime',
      size: big,
    });
    const parts = await sendParts(
      nextKey(a.id, 3),
      started.upload.uploadId,
      big,
      started.upload.partSize,
    );
    await restoreAssetVersion(ctx, blob, scope, a.id, 1);
    await expect(
      completeMultipartAssetUpload(ctx, { blob }, scope, a.id, started.upload.uploadId, parts),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(blob.aborted).toContain(started.upload.uploadId);
    expect(blob.bytes(nextKey(a.id, 3))).toBeNull();
    expect(await store.assetUploads.listForAsset(scope, a.id)).toEqual([]);
    expect((await store.assets.get(scope, a.id))?.version).toBe(3);
  });

  it('aborting a replacement keeps the asset and its file, even a draft without bytes yet', async () => {
    const created = await createAsset(ctx, blob, scope, {
      fileName: 'film.mov',
      contentType: 'video/quicktime',
    });
    const started = await startMultipartAssetFileReplacement(ctx, blob, scope, created.asset.id, {
      fileName: 'cut.mov',
      contentType: 'video/quicktime',
      size: big,
    });
    await abortMultipartAssetUpload(ctx, blob, scope, created.asset.id, started.upload.uploadId);
    expect(blob.aborted).toEqual([started.upload.uploadId]);
    expect(await store.assets.get(scope, created.asset.id)).not.toBeNull();
  });

  it('a single replace started again clears the bytes an uncommitted one left, so its PUT can land', async () => {
    const a = await asset();
    const first = await replaceAssetFile(ctx, blob, scope, a.id, {
      fileName: 'cut.mov',
      contentType: 'video/quicktime',
    });
    await blob.put(nextKey(a.id, 2), 'never committed', 'video/quicktime');
    const second = await replaceAssetFile(ctx, blob, scope, a.id, {
      fileName: 'cut.mov',
      contentType: 'video/quicktime',
    });
    expect(second.commit).toEqual(first.commit);
    expect(blob.bytes(nextKey(a.id, 2))).toBeNull();
    // The asset's own file is never touched.
    expect(blob.bytes(assetFileKey(scope, a))).not.toBeNull();
  });

  it('keeps another scope out of a replacement upload', async () => {
    const a = await asset();
    const started = await startMultipartAssetFileReplacement(ctx, blob, scope, a.id, {
      fileName: 'cut.mov',
      contentType: 'video/quicktime',
      size: big,
    });
    const other = { spaceId: 'shop', environmentId: 'staging' };
    await expect(
      completeMultipartAssetUpload(ctx, { blob }, other, a.id, started.upload.uploadId, []),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(await store.assetUploads.listForAsset(other, a.id)).toEqual([]);
    clock.advance(ABANDONED_MULTIPART_TTL_MS + 1);
    // The abandoned-upload sweep aborts a replacement's upload as it does a new asset's.
    expect(await sweepAbandonedMultipartUploads(ctx, blob)).toEqual({ aborted: 1, failed: 0 });
    expect((await store.assets.get(scope, a.id))?.version ?? 1).toBe(1);
  });
});
