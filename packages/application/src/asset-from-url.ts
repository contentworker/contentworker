import { createHash } from 'node:crypto';
import {
  type Asset,
  emptyAssetMetadata,
  NotFoundError,
  type Scope,
  ValidationError,
} from '@contentworker/domain';
import type { AssetIngestQueue, BlobStore, RemoteFetcher, RemoteFile } from '@contentworker/ports';
import { ASSET_COPY_MAX_BYTES } from './asset-copy';
import { createUploadDraft, prepareUploadDraft } from './assets';
import type { AppContext } from './context';
import { assertSafeExternalUrl } from './url-safety';

/**
 * Creating an asset from a file at a public URL, for a client that has a link rather than the
 * bytes (an agent bringing in an image it found, a script moving a page's media). The file comes
 * through the outbound fetcher under the rules a space export's file copies follow (the SSRF guard
 * first; GET only, no redirects, size-capped, time-bounded), then takes the path an upload takes:
 * the `asset:beforeCreate` hooks and key rules of {@link prepareUploadDraft}, the bytes written
 * before the record, and ingest started by the same notice a finished upload sends, so hashing,
 * duplicates, dimensions, alt text, tags and search happen the usual way.
 *
 * A file already in the scope is not stored twice: the bytes are hashed here (ingest's SHA-256)
 * and an asset that holds them is returned instead, marked `deduplicated`. That sees only assets
 * ingest has hashed; a copy uploaded moments before is caught by ingest's own duplicate marker.
 */

/**
 * Largest file fetched: the space export's copy limit, for the same reason. The bytes are held in
 * memory while they are hashed and written, and a Worker has 128 MB.
 */
export const ASSET_FROM_URL_MAX_BYTES = ASSET_COPY_MAX_BYTES;

/** How long the download may take; the request waits on it. */
const ASSET_FROM_URL_TIMEOUT_MS = 30_000;

/** Assets with the same hash read when looking for one to reuse. */
const DEDUPE_LOOKUP = 50;

export interface CreateAssetFromUrlInput {
  /** A public http(s) URL answering 200 with the file. */
  readonly url: string;
  /** The stored file name; absent, the URL path's last segment. */
  readonly fileName?: string;
  readonly title?: string;
  /** Alt text, kept as given: ingest suggests one only where it is empty. */
  readonly alt?: string;
  /** The locale `title` and `alt` are in; absent, the space's default. */
  readonly locale?: string;
  readonly folderId?: string;
}

export interface AssetFromUrl {
  /** As stored: a surface signs its read URL on the way out, as for `createAsset`. */
  readonly asset: Asset;
  /** True when `asset` already held these bytes and nothing new was created. */
  readonly deduplicated: boolean;
}

export async function createAssetFromUrl(
  ctx: AppContext,
  deps: {
    readonly blob: BlobStore;
    readonly fetcher: RemoteFetcher;
    readonly ingest?: AssetIngestQueue;
  },
  scope: Scope,
  input: CreateAssetFromUrlInput,
  opts: { readonly createdBy?: string } = {},
): Promise<AssetFromUrl> {
  assertSafeExternalUrl(input.url, 'url');
  const config = await ctx.store.spaces.getConfig(scope);
  if (!config) throw new NotFoundError('Space', scope.spaceId);
  const locale = input.locale ?? config.defaultLocale;
  if (!config.locales.includes(locale)) {
    throw new ValidationError([
      { field: 'locale', message: `"${locale}" is not a locale of this space` },
    ]);
  }

  const file = await download(deps.fetcher, input.url);
  const contentHash = createHash('sha256').update(file.bytes).digest('hex');
  const existing = await reusable(ctx, scope, contentHash);
  if (existing) {
    return { asset: existing, deduplicated: true };
  }

  const prepared = await prepareUploadDraft(
    ctx,
    deps.blob,
    scope,
    {
      fileName: input.fileName ?? fileNameOf(input.url),
      contentType: mimeOf(file.contentType),
      ...(input.title ? { title: { [locale]: input.title } } : {}),
    },
    {
      ...(opts.createdBy ? { createdBy: opts.createdBy } : {}),
      ...(input.folderId ? { folderId: input.folderId } : {}),
    },
  );
  // The bytes first: a record never points at a file that isn't there.
  await deps.blob.put(prepared.key, file.bytes, prepared.contentType);
  const asset: Asset = {
    ...prepared.asset,
    file: { ...prepared.asset.file, size: file.bytes.byteLength },
    metadata: input.alt
      ? { ...emptyAssetMetadata, altText: { [locale]: input.alt } }
      : emptyAssetMetadata,
  };
  try {
    await createUploadDraft(ctx, scope, asset);
  } catch (err) {
    // No record names the object, so nothing ever would: removed now rather than left behind (a
    // caller bringing in a whole site retries many of these). The refusal is what the caller sees.
    await deps.blob.delete(prepared.key).catch((cleanup: unknown) => {
      console.error('asset from URL cleanup failed', {
        key: prepared.key,
        error: String(cleanup),
      });
    });
    throw err;
  }
  // From here the record holds the file, so nothing deletes it: a lost notice only waits for R2's
  // own notification of the write (or a reindex).
  if (deps.ingest) {
    const ingest = deps.ingest;
    try {
      // Named by its etag, as a finished upload's notice is, so R2's own notification of the write
      // starts no second run.
      const etag = (await deps.blob.head?.(prepared.key))?.etag;
      await ingest.objectCreated(prepared.key, etag);
    } catch (err) {
      console.error('asset from URL ingest notice failed', {
        key: prepared.key,
        error: String(err),
      });
    }
  }
  return { asset, deduplicated: false };
}

/** The file at `url`, or a refusal saying why there is none (all the caller's to fix). */
async function download(fetcher: RemoteFetcher, url: string): Promise<RemoteFile> {
  let file: RemoteFile;
  try {
    file = await fetcher.getBytes(url, {
      maxBytes: ASSET_FROM_URL_MAX_BYTES,
      timeoutMs: ASSET_FROM_URL_TIMEOUT_MS,
    });
  } catch (err) {
    // Over the cap (declared or as it arrived), unreachable, or too slow.
    throw new ValidationError([
      {
        field: 'url',
        message: `Could not download the file: ${err instanceof Error ? err.message : String(err)}`,
      },
    ]);
  }
  if (file.status < 200 || file.status >= 300) {
    // A redirect is a status here, not a hop: the fetcher never follows one to an unscreened host.
    throw new ValidationError([
      { field: 'url', message: `Downloading the file answered ${file.status}, not 200` },
    ]);
  }
  if (file.bytes.byteLength === 0) {
    throw new ValidationError([{ field: 'url', message: 'The URL answered with an empty file' }]);
  }
  return file;
}

/**
 * An asset in the scope already holding these bytes: the original ingest's duplicate marker
 * points the others at (the oldest), archived ones left out, since they are on their way out.
 */
async function reusable(ctx: AppContext, scope: Scope, contentHash: string): Promise<Asset | null> {
  const { items } = await ctx.store.assets.list(scope, {
    limit: DEDUPE_LOOKUP,
    filters: { contentHash, status: 'all' },
    sort: { field: 'createdAt', direction: 'asc' },
  });
  const live = items.filter((a) => a.status !== 'archived');
  return live.find((a) => !a.duplicateOf) ?? live[0] ?? null;
}

/** The URL path's last segment, decoded; `file` when it has none. */
function fileNameOf(url: string): string {
  const last = new URL(url).pathname.split('/').filter(Boolean).pop() ?? '';
  let name = last;
  try {
    name = decodeURIComponent(last);
  } catch {
    // A malformed escape: keep the segment as it came.
  }
  return name.trim() === '' ? 'file' : name.slice(0, 1024);
}

/** The media type a response named, without parameters; ingest's probe names an unknown image. */
function mimeOf(contentType: string | undefined): string {
  const mime = (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mime) ? mime : 'application/octet-stream';
}
