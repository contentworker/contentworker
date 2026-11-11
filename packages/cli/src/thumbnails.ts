import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import type { BlockManifest, ManagementClient } from '@contentworker/sdk-management';
import { CliError, EXIT } from './output.js';

/**
 * Block thumbnails as assets. The admin draws only `{ assetId }` thumbnails: its `img-src` takes
 * its own origin and nothing else, and an asset is read through it. So `blocks push` turns each
 * `{ url }` thumbnail (an https image) and each `{ file }` one (a path beside the blocks file) into
 * an asset of the space and pushes `{ assetId }`: the catalog then holds only what the admin can
 * draw, and its thumbnails are versioned with it. The CLI does the fetching, never the server.
 *
 * Each image is hashed (SHA-256) and looked up by that hash first (`GET …/assets?contentHash=`),
 * so a push uploads an image only when no asset in the environment has those bytes yet: pushing
 * the same file again reuses the asset the first push made, or one a person uploaded. Ingest writes
 * an asset's hash a few seconds after its upload, so a second push inside that window uploads a
 * copy, which ingest then marks as a duplicate of the first.
 */

/** The largest thumbnail imported: a picture in a list of blocks, not a hero image. */
export const MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024;

/** How long one thumbnail fetch may take. */
const FETCH_TIMEOUT_MS = 30_000;

/** The image types the admin draws, by extension (the same ones `assets upload` names). */
const IMAGE_TYPES: Readonly<Record<string, string>> = {
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

const EXTENSION_OF: Readonly<Record<string, string>> = {
  'image/avif': '.avif',
  'image/gif': '.gif',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/svg+xml': '.svg',
  'image/webp': '.webp',
};

/** A thumbnail as a blocks file may give it: what the server takes, or a local image file. */
export type LocalThumbnail = NonNullable<BlockManifest['thumbnail']> | { readonly file: string };

/** A manifest as a blocks file holds it; `blocks push` sends it as a {@link BlockManifest}. */
export type LocalBlockManifest = Omit<BlockManifest, 'thumbnail'> & {
  readonly thumbnail?: LocalThumbnail;
};

/** What became of one block's thumbnail. */
export interface ThumbnailImport {
  readonly block: string;
  /** The URL or file it came from. */
  readonly source: string;
  readonly contentHash: string;
  /**
   * `reused`: an asset already held these bytes; `imported`: this push uploaded it; `pending`: a
   * dry run, which uploads nothing (the push would import it).
   */
  readonly action: 'reused' | 'imported' | 'pending';
  /** Absent while `pending`. */
  readonly assetId?: string;
}

interface Image {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly contentHash: string;
}

/** One block's image, read and hashed, waiting for an asset. */
interface Resolved {
  readonly block: string;
  readonly source: string;
  readonly image: Image;
  assetId?: string;
  action?: 'reused' | 'imported';
}

/**
 * The blocks' URL and file thumbnails, read and looked up: reads only, so a dry run, a refused
 * plan or a declined confirmation writes nothing. `upload` then imports what wasn't found.
 */
export interface ThumbnailPlan {
  readonly imports: readonly ThumbnailImport[];
  /** The manifests to send now: found thumbnails as `{ assetId }`, the rest as the server takes them. */
  readonly blocks: () => BlockManifest[];
  /** Uploads each image no asset holds yet (each distinct one once) and returns the final plan. */
  readonly upload: () => Promise<ThumbnailPlan>;
}

const refused = (block: string, message: string, exitCode: number = EXIT.failure) =>
  new CliError(`blocks[${block}].thumbnail: ${message}`, exitCode, 'thumbnail_refused');

/** The media type without parameters, lower case. */
const mimeOf = (header: string | null): string =>
  (header ?? '').split(';')[0]?.trim().toLowerCase() ?? '';

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Reads a body up to the cap, stopping (and cancelling the download) as soon as it is past it. */
async function boundedBody(res: Response, block: string): Promise<Uint8Array> {
  const tooBig = () =>
    refused(block, `the image is larger than ${MAX_THUMBNAIL_BYTES} bytes; use a smaller one`);
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_THUMBNAIL_BYTES) {
    await res.body?.cancel();
    throw tooBig();
  }
  if (!res.body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_THUMBNAIL_BYTES) {
      await reader.cancel();
      throw tooBig();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

async function fetchImage(doFetch: typeof fetch, block: string, raw: string): Promise<Image> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw refused(
      block,
      `"${raw}" is not an absolute URL; a local image is { "file": "…" }`,
      EXIT.usage,
    );
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw refused(
      block,
      `${url.protocol}// is not imported: the URL must be https without credentials`,
      EXIT.usage,
    );
  }
  let res: Response;
  try {
    res = await doFetch(url.href, {
      headers: { accept: Object.keys(EXTENSION_OF).join(', ') },
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    throw refused(block, `fetching ${url.href} failed: ${(err as Error).message}`);
  }
  // A redirect must not step down to plain http.
  if (res.url && !res.url.startsWith('https:')) {
    await res.body?.cancel();
    throw refused(block, `${url.href} redirected to ${res.url}, which is not https`);
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw refused(block, `fetching ${url.href} answered ${res.status}`);
  }
  const contentType = mimeOf(res.headers.get('content-type'));
  if (!EXTENSION_OF[contentType]) {
    await res.body?.cancel();
    throw refused(
      block,
      `${url.href} is ${contentType || 'of no stated type'}, not an image the admin draws ` +
        `(${Object.keys(EXTENSION_OF).join(', ')})`,
    );
  }
  const bytes = await boundedBody(res, block);
  if (bytes.byteLength === 0) throw refused(block, `${url.href} is empty`);
  return { bytes, contentType, contentHash: sha256(bytes) };
}

async function readImage(dir: string, block: string, path: string): Promise<Image> {
  const contentType = IMAGE_TYPES[extname(path).toLowerCase()];
  if (!contentType) {
    throw refused(
      block,
      `${path} is not an image the admin draws (${Object.keys(IMAGE_TYPES).join(', ')})`,
      EXIT.usage,
    );
  }
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(resolve(dir, path)));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw refused(
        block,
        `${path}: no such file (paths are from the blocks file's folder)`,
        EXIT.usage,
      );
    }
    throw err;
  }
  if (bytes.byteLength > MAX_THUMBNAIL_BYTES) {
    throw refused(block, `${path} is larger than ${MAX_THUMBNAIL_BYTES} bytes; use a smaller one`);
  }
  if (bytes.byteLength === 0) throw refused(block, `${path} is empty`);
  return { bytes, contentType, contentHash: sha256(bytes) };
}

/** The oldest drawable asset in the environment with these bytes: archived ones are left out. */
async function findAsset(cma: ManagementClient, contentHash: string): Promise<string | undefined> {
  const page = await cma.assets.list({
    contentHash,
    kind: 'image',
    sort: 'createdAt',
    order: 'asc',
    limit: 1,
  });
  return page.items[0]?.id;
}

/**
 * Reads every `{ url }` and `{ file }` thumbnail (`dir` is the blocks file's folder), each source
 * once, and looks each image up by its hash. Nothing is written until `upload`.
 */
export async function planThumbnails(
  blocks: readonly LocalBlockManifest[],
  opts: { readonly cma: ManagementClient; readonly fetch: typeof fetch; readonly dir: string },
): Promise<ThumbnailPlan> {
  const images = new Map<string, Promise<Image>>();
  const found = new Map<string, Promise<string | undefined>>();
  const resolved: Resolved[] = [];
  for (const b of blocks) {
    const t = b.thumbnail as Record<string, unknown> | undefined;
    if (!t || typeof t !== 'object') continue;
    const source =
      typeof t.url === 'string' && t.assetId === undefined && t.file === undefined
        ? { kind: 'url' as const, value: t.url }
        : typeof t.file === 'string' && t.assetId === undefined && t.url === undefined
          ? { kind: 'file' as const, value: t.file }
          : undefined;
    // `{ assetId }` goes as it is; any other shape is the server's to refuse, by its place.
    if (!source) continue;
    const key = `${source.kind}:${source.value}`;
    let image = images.get(key);
    if (!image) {
      image =
        source.kind === 'url'
          ? fetchImage(opts.fetch, b.id, source.value)
          : readImage(opts.dir, b.id, source.value);
      images.set(key, image);
    }
    const read = await image;
    if (!found.has(read.contentHash))
      found.set(read.contentHash, findAsset(opts.cma, read.contentHash));
    const assetId = await found.get(read.contentHash);
    resolved.push({
      block: b.id,
      source: source.value,
      image: read,
      ...(assetId ? { assetId, action: 'reused' as const } : {}),
    });
  }
  return planOf(blocks, resolved, opts.cma);
}

function planOf(
  blocks: readonly LocalBlockManifest[],
  resolved: readonly Resolved[],
  cma: ManagementClient,
): ThumbnailPlan {
  const byBlock = new Map(resolved.map((r) => [r.block, r]));
  return {
    imports: resolved.map((r) => ({
      block: r.block,
      source: r.source,
      contentHash: r.image.contentHash,
      action: r.action ?? 'pending',
      ...(r.assetId ? { assetId: r.assetId } : {}),
    })),
    blocks: () =>
      blocks.map((b) => {
        const r = byBlock.get(b.id);
        if (!r) return b as BlockManifest;
        const { thumbnail, ...rest } = b;
        if (r.assetId) return { ...rest, thumbnail: { assetId: r.assetId } };
        // Not imported yet: a URL goes as the server takes it, and a file has nothing to send.
        return 'url' in (thumbnail ?? {}) ? (b as BlockManifest) : rest;
      }),
    upload: async () => {
      const uploaded = new Map<string, Promise<string>>();
      const next: Resolved[] = [];
      for (const r of resolved) {
        if (r.assetId) {
          next.push(r);
          continue;
        }
        const { contentHash, contentType, bytes } = r.image;
        let id = uploaded.get(contentHash);
        if (!id) {
          id = cma.assets
            .upload({
              fileName: `${r.block}-thumbnail${EXTENSION_OF[contentType] ?? ''}`,
              contentType,
              body: bytes,
            })
            .then((a) => a.id);
          uploaded.set(contentHash, id);
        }
        next.push({ ...r, assetId: await id, action: 'imported' });
      }
      return planOf(blocks, next, cma);
    },
  };
}

/** One line per thumbnail, for the person running the push. */
export function renderThumbnails(imports: readonly ThumbnailImport[]): string[] {
  return imports.map((i) =>
    i.action === 'pending'
      ? `  thumbnail ${i.block}: would import ${i.source}`
      : i.action === 'reused'
        ? `  thumbnail ${i.block}: ${i.source} is asset ${i.assetId}`
        : `  thumbnail ${i.block}: imported ${i.source} as asset ${i.assetId}`,
  );
}
