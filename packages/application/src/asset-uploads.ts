import {
  type Asset,
  AssetInUseError,
  NotFoundError,
  type Scope,
  ValidationError,
} from '@contentworker/domain';
import type {
  AssetIngestQueue,
  AssetUpload,
  BlobStore,
  MultipartBlobStore,
  UploadedPart,
} from '@contentworker/ports';
import {
  type CreateAssetInput,
  createUploadDraft,
  deleteAsset,
  prepareUploadDraft,
  withReadUrl,
} from './assets';
import type { AppContext } from './context';

/**
 * Multipart uploads, for files past what one signed PUT takes (100 MiB, the Workers request-body
 * cap). The api starts an R2 multipart upload for a new draft, signs a URL per part (each bound to
 * its upload, number and exact length), and completes it with the parts' etags; completing starts
 * ingest exactly as a finished single PUT does. The key is minted the same way as a single PUT's
 * ({@link prepareUploadDraft}), so it obeys the same rules.
 *
 * An upload left unfinished is aborted by the hourly sweep a day on ({@link
 * sweepAbandonedMultipartUploads}), and by the bucket's lifecycle rule after that; its draft goes
 * with the abandoned-upload sweep.
 */

/** What one signed PUT takes; above it a client must upload in parts. */
export const SINGLE_UPLOAD_MAX_BYTES = 100 * 1024 * 1024;
/** Default cap on one file (ASSET_UPLOAD_MAX_BYTES overrides it). */
export const DEFAULT_MAX_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024;
/** R2's smallest part (every part but the last), and the size this server asks for at least. */
export const MIN_PART_BYTES = 5 * 1024 * 1024;
export const DEFAULT_PART_BYTES = 8 * 1024 * 1024;
/** R2 takes at most this many parts. */
export const MAX_PARTS = 10_000;
/** Most part URLs one call signs. */
export const MAX_PART_URLS = 100;
/** How long an unfinished multipart upload is kept before the sweep aborts it. */
export const ABANDONED_MULTIPART_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The part size and count for a file of `size` bytes: {@link DEFAULT_PART_BYTES}, or larger (a
 * whole MiB) when that would need more than {@link MAX_PARTS} parts. Every part but the last has
 * exactly `partSize` bytes.
 */
export function multipartPlan(size: number): { partSize: number; partCount: number } {
  const mib = 1024 * 1024;
  const partSize = Math.max(DEFAULT_PART_BYTES, Math.ceil(size / MAX_PARTS / mib) * mib);
  return { partSize, partCount: Math.max(1, Math.ceil(size / partSize)) };
}

const partCountOf = (upload: Pick<AssetUpload, 'size' | 'partSize'>) =>
  Math.max(1, Math.ceil(upload.size / upload.partSize));

/** The exact length of part `n` (1-based) of an upload: `partSize`, but the last part's rest. */
export function partLength(upload: Pick<AssetUpload, 'size' | 'partSize'>, n: number): number {
  const count = partCountOf(upload);
  return n < count ? upload.partSize : upload.size - upload.partSize * (count - 1);
}

function multipartOf(blob: BlobStore): MultipartBlobStore {
  if (!blob.multipart) {
    throw new ValidationError([
      { field: 'size', message: 'Multipart uploads are not available on this deployment' },
    ]);
  }
  return blob.multipart;
}

export interface MultipartUploadStarted {
  readonly asset: Asset;
  readonly upload: {
    readonly uploadId: string;
    readonly partSize: number;
    readonly partCount: number;
  };
}

/**
 * Creates a draft asset and starts a multipart upload of its file: `size` bytes, at most the
 * deployment's cap ({@link DEFAULT_MAX_UPLOAD_BYTES} unless ASSET_UPLOAD_MAX_BYTES says). Then sign
 * part URLs ({@link signAssetUploadParts}), PUT each part, and complete it.
 */
export async function startMultipartAssetUpload(
  ctx: AppContext,
  blob: BlobStore,
  scope: Scope,
  input: CreateAssetInput & { readonly size: number },
  opts: { readonly createdBy?: string; readonly folderId?: string } = {},
): Promise<MultipartUploadStarted> {
  const max = ctx.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
  if (!Number.isSafeInteger(input.size) || input.size < 1 || input.size > max) {
    throw new ValidationError([
      {
        field: 'size',
        message: `A file is 1 byte to ${max} bytes (${Math.floor(max / 2 ** 20)} MiB)`,
      },
    ]);
  }
  const multipart = multipartOf(blob);
  const { size, ...rest } = input;
  const { asset, key, contentType } = await prepareUploadDraft(ctx, blob, scope, rest, opts);
  const { partSize, partCount } = multipartPlan(size);
  await createUploadDraft(ctx, scope, asset);
  const { uploadId } = await multipart.create(key, contentType);
  await ctx.store.assetUploads.create(scope, {
    assetId: asset.id,
    uploadId,
    r2Key: key,
    size,
    partSize,
    contentType,
    createdAt: ctx.clock.now().toISOString(),
  });
  return { asset, upload: { uploadId, partSize, partCount } };
}

async function uploadOrThrow(
  ctx: AppContext,
  scope: Scope,
  assetId: string,
  uploadId: string,
): Promise<AssetUpload> {
  const upload = await ctx.store.assetUploads.get(scope, assetId, uploadId);
  if (!upload) throw new NotFoundError('AssetUpload', uploadId);
  return upload;
}

export interface SignedPart {
  readonly partNumber: number;
  readonly url: string;
  /** The exact length the PUT must carry. */
  readonly length: number;
  readonly expiresAt: string;
}

/**
 * Signs upload URLs for parts of an upload in progress (at most {@link MAX_PART_URLS} per call;
 * a part may be signed again to retry it). Each URL takes exactly that part's length.
 */
export async function signAssetUploadParts(
  ctx: AppContext,
  blob: BlobStore,
  scope: Scope,
  assetId: string,
  uploadId: string,
  partNumbers: readonly number[],
): Promise<{ readonly parts: readonly SignedPart[] }> {
  const upload = await uploadOrThrow(ctx, scope, assetId, uploadId);
  const count = partCountOf(upload);
  const numbers = [...new Set(partNumbers)];
  if (
    numbers.length === 0 ||
    numbers.length > MAX_PART_URLS ||
    numbers.some((n) => !Number.isInteger(n) || n < 1 || n > count)
  ) {
    throw new ValidationError([
      {
        field: 'partNumbers',
        message: `Name 1 to ${MAX_PART_URLS} parts, each from 1 to ${count}`,
      },
    ]);
  }
  const multipart = multipartOf(blob);
  const parts = await Promise.all(
    numbers.map(async (n) => {
      const length = partLength(upload, n);
      const signed = await multipart.partUrl(upload.r2Key, uploadId, n, length);
      return { partNumber: n, url: signed.url, length, expiresAt: signed.expiresAt };
    }),
  );
  return { parts };
}

/**
 * Completes an upload with every part's etag (parts 1..n, each once). The object then exists at
 * the asset's key, and ingest starts as it does for a finished single PUT. Returns the asset, with
 * a short-lived read URL.
 */
export async function completeMultipartAssetUpload(
  ctx: AppContext,
  deps: { readonly blob: BlobStore; readonly ingest?: AssetIngestQueue },
  scope: Scope,
  assetId: string,
  uploadId: string,
  parts: readonly UploadedPart[],
): Promise<Asset> {
  const upload = await uploadOrThrow(ctx, scope, assetId, uploadId);
  const count = partCountOf(upload);
  const numbers = parts.map((p) => p.partNumber).sort((a, b) => a - b);
  if (
    numbers.length !== count ||
    numbers.some((n, i) => n !== i + 1) ||
    parts.some((p) => typeof p.etag !== 'string' || p.etag === '')
  ) {
    throw new ValidationError([
      { field: 'parts', message: `Name each of parts 1 to ${count} once, with its etag` },
    ]);
  }
  const asset = await ctx.store.assets.get(scope, assetId);
  if (!asset) throw new NotFoundError('Asset', assetId);
  let stored: Awaited<ReturnType<MultipartBlobStore['complete']>>;
  try {
    stored = await multipartOf(deps.blob).complete(upload.r2Key, uploadId, parts);
  } catch (err) {
    // A part never uploaded, an etag that isn't its part's, or uneven parts: R2 keeps the upload,
    // so the client can upload the part again and retry.
    throw new ValidationError([
      {
        field: 'parts',
        message: `The upload could not be completed: ${String(err).slice(0, 200)}`,
      },
    ]);
  }
  await ctx.store.assetUploads.delete(scope, assetId, uploadId);
  // The same notice a finished signed PUT sends: ingest names the bytes by their etag, so R2's
  // own notification of the completion starts no second run.
  if (deps.ingest) {
    await deps.ingest.objectCreated(upload.r2Key, stored.etag).catch((err: unknown) => {
      console.error('upload ingest notice failed', { key: upload.r2Key, error: String(err) });
    });
  }
  return withReadUrl(deps.blob, scope, asset);
}

/**
 * Abandons an upload: its parts are discarded and, while it still has no bytes and nothing links
 * to it, its draft is deleted too. Aborting an upload already gone changes nothing.
 */
export async function abortMultipartAssetUpload(
  ctx: AppContext,
  blob: BlobStore,
  scope: Scope,
  assetId: string,
  uploadId: string,
): Promise<void> {
  const upload = await uploadOrThrow(ctx, scope, assetId, uploadId);
  await multipartOf(blob).abort(upload.r2Key, uploadId);
  await ctx.store.assetUploads.delete(scope, assetId, uploadId);
  const asset = await ctx.store.assets.get(scope, assetId);
  if (!asset || asset.status !== 'draft' || asset.file.size !== undefined) return;
  if (blob.head && (await blob.head(upload.r2Key))) return;
  try {
    await deleteAsset(ctx, scope, assetId);
  } catch (err) {
    // Linked meanwhile: the draft stays (the abandoned-upload sweep marks it), the upload is gone.
    if (!(err instanceof AssetInUseError || err instanceof NotFoundError)) throw err;
  }
}

/** Most unfinished uploads one sweep aborts. */
export const ABANDONED_MULTIPART_SWEEP_LIMIT = 100;

/**
 * Aborts multipart uploads started more than {@link ABANDONED_MULTIPART_TTL_MS} ago that were
 * never completed or aborted, across every space (R2 keeps, and bills, their parts until then;
 * the bucket's lifecycle rule is the backstop). Each is forgotten once aborted, so a rerun finds
 * the rest. Their drafts go with the abandoned-upload sweep.
 */
export async function sweepAbandonedMultipartUploads(
  ctx: AppContext,
  blob: BlobStore,
  opts: { readonly ttlMs?: number; readonly limit?: number } = {},
): Promise<{ readonly aborted: number; readonly failed: number }> {
  if (!blob.multipart) return { aborted: 0, failed: 0 };
  const before = new Date(ctx.clock.now().getTime() - (opts.ttlMs ?? ABANDONED_MULTIPART_TTL_MS));
  const stale = await ctx.store.assetUploads.listStartedBefore(
    before,
    opts.limit ?? ABANDONED_MULTIPART_SWEEP_LIMIT,
  );
  let aborted = 0;
  let failed = 0;
  for (const { scope, upload } of stale) {
    try {
      await blob.multipart.abort(upload.r2Key, upload.uploadId);
      await ctx.store.assetUploads.delete(scope, upload.assetId, upload.uploadId);
      aborted += 1;
    } catch {
      failed += 1;
    }
  }
  return { aborted, failed };
}
