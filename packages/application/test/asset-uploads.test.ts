import { NotFoundError, ValidationError } from '@contentworker/domain';
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
  completeMultipartAssetUpload,
  createSpace,
  DEFAULT_PART_BYTES,
  multipartPlan,
  partLength,
  signAssetUploadParts,
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
