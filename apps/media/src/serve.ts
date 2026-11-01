/**
 * What the media Worker does with a request, over ports and structural bindings so the tests can
 * run it against Miniflare's KV, R2 and D1 with a fake Images binding.
 */
import { type R2BucketLike, safeHeaders } from '@contentworker/adapters/blob-r2';
import {
  type ImagesBindingLike,
  transformImage,
  transformParams,
} from '@contentworker/adapters/images-cf';
import { assetGateEntry } from '@contentworker/application';
import {
  type AssetMediaAddress,
  type AssetRendition,
  isTransformableImage,
  parseAssetMediaPath,
} from '@contentworker/domain';
import {
  mediaAssetTag,
  mediaEnvironmentTag,
  mediaRenditionTag,
} from '@contentworker/platform/messages';
import type {
  AssetGate,
  AssetGateEntry,
  ContentStore,
  ImageTransformSpec,
} from '@contentworker/ports';

/** Internal origin for gateway → cached entrypoint requests (never resolvable publicly). */
export const INTERNAL_ORIGIN = 'https://media.internal';

/** A published file's URL never changes meaning (the version is in it), so it keeps a year. */
export const IMMUTABLE = 'public, max-age=31536000, immutable';
const NO_STORE = 'no-store';

/** The output encoding a variant is negotiated to: AVIF, WebP, or the source's own format. */
export type FormatClass = 'avif' | 'webp' | 'src';

/** The format class `Accept` allows, best first. */
export function formatClass(accept: string | null): FormatClass {
  const a = accept ?? '';
  if (a.includes('image/avif')) return 'avif';
  if (a.includes('image/webp')) return 'webp';
  return 'src';
}

/**
 * The cache key a public request maps to: the parsed path, and for a variant the one format class
 * it negotiates to (`?f=`). Every other query parameter and header is dropped, so nothing a
 * client adds can mint another cache entry or another transform. `null`: not a media URL.
 */
export function canonicalMediaUrl(
  url: URL,
  accept: string | null,
): { readonly url: string; readonly negotiated: boolean } | null {
  const address = parseAssetMediaPath(url.pathname);
  if (!address) return null;
  const path = `${INTERNAL_ORIGIN}${url.pathname}`;
  switch (address.variant.kind) {
    case 'original':
      return { url: path, negotiated: false };
    case 'width': {
      // A width step negotiates only when asked to (`fm=auto`, which delivered URLs carry).
      if (url.searchParams.get('fm') !== 'auto') return { url: `${path}?f=src`, negotiated: false };
      return { url: `${path}?f=${formatClass(accept)}`, negotiated: true };
    }
    default:
      // A rendition's own format may be `auto`; which it is is only known on a miss.
      return { url: `${path}?f=${formatClass(accept)}`, negotiated: true };
  }
}

export interface MediaDeps {
  readonly bucket: R2BucketLike;
  readonly images?: ImagesBindingLike;
  /** The engine's gate (KV). */
  readonly gate?: AssetGate;
  /** Read-only, through a replica: the gate's fallback and the rendition presets. */
  readonly store?: Pick<ContentStore, 'assets' | 'assetRenditions'>;
  /** Milliseconds since the epoch; injected for tests. */
  readonly now?: () => number;
}

const plain = (status: number, body: string) =>
  new Response(body, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': NO_STORE },
  });

/**
 * The gate entry for an asset: KV first, then a D1 replica when KV has none yet (an entry the
 * engine hasn't written, or one KV hasn't spread to this colo). Read only: a miss writes nothing.
 */
async function gateFor(deps: MediaDeps, a: AssetMediaAddress): Promise<AssetGateEntry | null> {
  const entry = await deps.gate?.get(a.scope, a.assetId);
  if (entry) return entry;
  const snapshot = await deps.store?.assets.getPublished(a.scope, a.assetId);
  return snapshot ? assetGateEntry(a.scope, snapshot) : null;
}

/** The transform a variant asks of the image service, or `null` for one that isn't served. */
function variantSpec(
  a: AssetMediaAddress,
  f: FormatClass,
  rendition: AssetRendition | null,
): ImageTransformSpec | null {
  const negotiated = f === 'src' ? undefined : 'auto';
  if (a.variant.kind === 'width') {
    // Never upscaled (`max`), so a step past the image's width is the image itself.
    return { width: a.variant.width, fit: 'max', ...(negotiated ? { format: negotiated } : {}) };
  }
  if (!rendition) return null;
  const format = rendition.format === 'auto' ? negotiated : rendition.format;
  return {
    ...(rendition.width !== undefined ? { width: rendition.width } : {}),
    ...(rendition.height !== undefined ? { height: rendition.height } : {}),
    ...(rendition.fit !== undefined ? { fit: rendition.fit } : {}),
    ...(format ? { format } : {}),
    ...(rendition.quality !== undefined ? { quality: rendition.quality } : {}),
  };
}

/**
 * Serves one canonical media request (the cached entrypoint's miss path). 200s are immutable and
 * tagged so the engine's purges reach them: by asset, by environment, and by rendition. Anything
 * else is `no-store`, so a 404 never outlives a publish and a 410 never outlives a restored right.
 */
export async function serveMedia(request: Request, deps: MediaDeps): Promise<Response> {
  const url = new URL(request.url);
  const a = parseAssetMediaPath(url.pathname);
  if (!a) return plain(404, 'not found');
  const gate = await gateFor(deps, a);
  // Not published (or an older version, whose URLs end with the publish that replaced it).
  if (!gate || gate.v !== a.version || gate.fileName !== a.fileName) {
    return plain(404, 'not found');
  }
  const now = deps.now?.() ?? Date.now();
  if (gate.expiresAt && Date.parse(gate.expiresAt) <= now) return plain(410, 'gone');

  const f = (url.searchParams.get('f') ?? 'src') as FormatClass;
  const tags = [
    mediaAssetTag(a.scope.spaceId, a.scope.environmentId, a.assetId),
    mediaEnvironmentTag(a.scope.spaceId, a.scope.environmentId),
  ];
  let spec: ImageTransformSpec | null = null;
  if (a.variant.kind !== 'original') {
    // Variants exist only for images the service can resize, and only when it is bound.
    if (!deps.images || !isTransformableImage(gate.contentType)) return plain(404, 'not found');
    let rendition: AssetRendition | null = null;
    if (a.variant.kind === 'rendition') {
      rendition = (await deps.store?.assetRenditions.get(a.scope, a.variant.name)) ?? null;
      if (!rendition) return plain(404, 'not found');
      tags.push(mediaRenditionTag(a.scope.spaceId, a.variant.name));
    }
    spec = variantSpec(a, f, rendition);
    if (!spec) return plain(404, 'not found');
  }

  const object = await deps.bucket.get(gate.r2Key);
  if (!object) return plain(404, 'not found');

  let response: Response;
  if (spec && deps.images) {
    // The negotiated class stands in for the reader's Accept, which never reaches this entrypoint.
    const accept = f === 'avif' ? 'image/avif' : f === 'webp' ? 'image/webp' : null;
    const transformed = await transformImage(
      deps.images,
      object.body,
      gate.contentType,
      transformParams(spec, gate.focal),
      accept,
    );
    if (!transformed) {
      await object.body.cancel();
      return plain(404, 'not found');
    }
    const headers = safeHeaders(transformed.headers.get('content-type') ?? gate.contentType);
    response = new Response(transformed.body, { status: 200, headers });
  } else {
    const headers = safeHeaders(gate.contentType);
    headers.set('content-length', String(object.size));
    headers.set('etag', object.httpEtag);
    response = new Response(object.body, { status: 200, headers });
  }
  response.headers.set('cache-control', IMMUTABLE);
  response.headers.set('cache-tag', tags.join(','));
  return response;
}
