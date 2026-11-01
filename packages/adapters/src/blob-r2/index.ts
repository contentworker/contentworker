import type { BlobStore, DownloadUrlOptions } from '@contentworker/ports';

/**
 * The subset of an R2 object (with body) this adapter reads. Structural, so the
 * package imports no Cloudflare types — the Worker passes its real binding.
 */
export interface R2ObjectBodyLike {
  readonly body: ReadableStream;
  readonly size: number;
  readonly httpEtag: string;
  readonly httpMetadata?: { readonly contentType?: string };
  text(): Promise<string>;
}

/** The subset of an R2 bucket binding this adapter uses. */
export interface R2BucketLike {
  get(key: string): Promise<R2ObjectBodyLike | null>;
  put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
  delete(keys: string | string[]): Promise<void>;
  list(options: { prefix: string; cursor?: string; limit?: number }): Promise<{
    objects: { key: string }[];
    truncated: boolean;
    cursor?: string;
  }>;
}

/** Path prefix the Worker serves blobs under (see {@link handleMediaRequest}). */
export const MEDIA_PATH_PREFIX = '/media/';

/**
 * Signs and verifies media URLs.
 *
 * The R2 binding has no presigned URLs, so the Worker issues its own: an
 * HMAC over the method, object key and every query parameter. A URL is a
 * capability for exactly that operation on exactly that object — a signed
 * download cannot be turned into a different key, an upload, or (for image
 * transforms) a different set of transform parameters.
 */
export interface MediaUrlSigner {
  sign(method: 'GET' | 'PUT', key: string, params: URLSearchParams): Promise<string>;
  verify(
    method: 'GET' | 'PUT',
    key: string,
    params: URLSearchParams,
    sig: string,
  ): Promise<boolean>;
}

const encoder = new TextEncoder();

function canonical(method: string, key: string, params: URLSearchParams): string {
  const pairs = [...params.entries()]
    .filter(([k]) => k !== 'sig')
    .sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : 1) : a < b ? -1 : 1))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  return `${method}\n${key}\n${pairs.join('&')}`;
}

function toBase64Url(bytes: ArrayBuffer): string {
  let bin = '';
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): Uint8Array | null {
  try {
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** HMAC-SHA256 media URL signer (WebCrypto — runs on Workers and Node). */
export function createMediaUrlSigner(secret: string): MediaUrlSigner {
  if (!secret) throw new Error('media URL signing secret must not be empty');
  const keyPromise = crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
  return {
    async sign(method, key, params) {
      const mac = await crypto.subtle.sign(
        'HMAC',
        await keyPromise,
        encoder.encode(canonical(method, key, params)),
      );
      return toBase64Url(mac);
    },
    async verify(method, key, params, sig) {
      const mac = fromBase64Url(sig);
      if (!mac) return false;
      // crypto.subtle.verify is constant-time.
      return crypto.subtle.verify(
        'HMAC',
        await keyPromise,
        mac,
        encoder.encode(canonical(method, key, params)),
      );
    },
  };
}

/** `/media/<segment>/<segment>…` — each key segment percent-encoded. */
export function mediaPath(key: string): string {
  return `${MEDIA_PATH_PREFIX}${key.split('/').map(encodeURIComponent).join('/')}`;
}

/** Reverses {@link mediaPath}; `null` when the path is not a media path. */
export function keyFromMediaPath(pathname: string): string | null {
  const at = pathname.indexOf(MEDIA_PATH_PREFIX);
  if (at < 0) return null;
  const rest = pathname.slice(at + MEDIA_PATH_PREFIX.length);
  if (!rest) return null;
  try {
    const segments = rest.split('/').map(decodeURIComponent);
    // Keys are minted server-side and never contain traversal; refuse anything
    // that does rather than normalizing it.
    if (segments.some((s) => s === '' || s === '.' || s === '..')) return null;
    return segments.join('/');
  } catch {
    return null;
  }
}

/** Builds a signed media URL for `key` with the given (unsigned) params. */
export async function signedMediaUrl(
  signer: MediaUrlSigner,
  baseUrl: string,
  method: 'GET' | 'PUT',
  key: string,
  params: URLSearchParams = new URLSearchParams(),
): Promise<string> {
  const signed = new URLSearchParams(params);
  signed.delete('sig');
  signed.set('sig', await signer.sign(method, key, signed));
  return `${baseUrl.replace(/\/$/, '')}${mediaPath(key)}?${signed.toString()}`;
}

export interface R2BlobOptions {
  readonly signer: MediaUrlSigner;
  /**
   * Public origin of the Worker serving `/media/*` (e.g. `https://api.example.com`).
   * Empty → root-relative URLs, which work for the same-origin admin SPA but not
   * for delivery clients on other origins.
   */
  readonly baseUrl?: string;
  /** Lifetime of a signed upload URL, seconds (default 900). */
  readonly uploadTtlSeconds?: number;
  /** Injected for tests; seconds since the epoch. */
  readonly now?: () => number;
}

/**
 * The expiry of a short-lived read URL: at least `ttl` seconds away, rounded up to a multiple of
 * `ttl`, so every URL minted for a key within one window is the same URL and a browser's cache
 * keeps working across reads (a URL then lives between `ttl` and twice that).
 */
export function readUrlExpiry(nowSeconds: number, ttl: number): number {
  return Math.ceil((nowSeconds + ttl) / ttl) * ttl;
}

/**
 * BlobStore over the native R2 binding. Server-side `put`/`get` talk to the
 * bucket directly; client transfers use Worker-signed URLs served by
 * {@link handleMediaRequest}: an upload URL is a short-lived signed PUT bound
 * to one key and content type. A download URL is a signed GET bound to one
 * key: without options a non-expiring one (what an asset stores at creation),
 * with `expiresInSeconds` one that carries an `exp` the signature covers
 * (what Management and Preview hand out at read time).
 */
export function createR2BlobStore(bucket: R2BucketLike, opts: R2BlobOptions): BlobStore {
  const base = opts.baseUrl ?? '';
  const ttl = opts.uploadTtlSeconds ?? 900;
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  return {
    async getUploadUrl(key, contentType) {
      const params = new URLSearchParams({ ct: contentType, exp: String(now() + ttl) });
      const url = await signedMediaUrl(opts.signer, base, 'PUT', key, params);
      return { url, headers: { 'content-type': contentType } };
    },
    getDownloadUrl(key, read?: DownloadUrlOptions) {
      if (!read?.expiresInSeconds)
        return signedMediaUrl(opts.signer, read?.origin ?? base, 'GET', key);
      const exp = readUrlExpiry(now(), read.expiresInSeconds);
      const params = new URLSearchParams({ exp: String(exp) });
      return signedMediaUrl(opts.signer, read.origin ?? base, 'GET', key, params);
    },
    async delete(key) {
      await bucket.delete(key);
    },
    async put(key, body, contentType) {
      await bucket.put(key, body, { httpMetadata: { contentType } });
    },
    async get(key) {
      const obj = await bucket.get(key);
      return obj ? obj.text() : null;
    },
    async deletePrefix(prefix, keep) {
      // List everything first, then delete: deleting between pages could shift what a cursor
      // points at and skip objects.
      const keys: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await bucket.list({ prefix, cursor, limit: 1000 });
        for (const { key } of page.objects) if (!keep(key)) keys.push(key);
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
      // R2 deletes up to 1,000 keys per call.
      for (let at = 0; at < keys.length; at += 1000) await bucket.delete(keys.slice(at, at + 1000));
      return keys.length;
    },
  };
}

/** Transform hook: serves a signed GET whose params ask for an image transform. */
export type MediaTransform = (
  object: R2ObjectBodyLike,
  params: URLSearchParams,
  request: Request,
) => Promise<Response | null>;

export interface MediaRequestOptions {
  readonly bucket: R2BucketLike;
  readonly signer: MediaUrlSigner;
  /** Largest accepted upload, bytes (default 100 MiB — the Workers request-body cap). */
  readonly maxUploadBytes?: number;
  /**
   * Called for GETs carrying params beyond `sig`; returning `null` serves the
   * original bytes. Absent → transforms are ignored and the original is served.
   */
  readonly transform?: MediaTransform;
  /** Injected for tests; seconds since the epoch. */
  readonly now?: () => number;
  /**
   * Refuse a signed GET without an `exp` (the media origin serves only short-lived reads; the
   * api still honours the non-expiring URLs assets stored at creation).
   */
  readonly requireExpiry?: boolean;
  /** Only GET and HEAD: a host that must never accept an upload (the media origin). */
  readonly readOnly?: boolean;
}

const DEFAULT_MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/** Types a browser may render inline from the media origin. Everything else downloads. */
const INLINE_TYPES = /^(image\/(?!svg)|video\/|audio\/|application\/pdf$|text\/plain$)/;

/**
 * Response headers for user-supplied bytes served from the API's own origin.
 * `sandbox` stops an uploaded HTML/SVG from running script against the admin
 * SPA (same origin on the single-worker deployment); nosniff stops the browser
 * from second-guessing the stored type. The media origin serves bytes with the
 * same headers.
 */
export function safeHeaders(contentType: string): Headers {
  const h = new Headers({
    'content-type': contentType,
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; sandbox",
    'cross-origin-resource-policy': 'cross-origin',
  });
  if (!INLINE_TYPES.test(contentType)) h.set('content-disposition', 'attachment');
  return h;
}

function text(status: number, body: string): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

/**
 * Serves `/media/*`: signed PUT uploads stream straight into R2 (no buffering);
 * signed GETs stream the object back, or through `transform` when the URL
 * carries transform params. Every request must carry a valid signature —
 * there is no unsigned read path.
 */
export async function handleMediaRequest(
  request: Request,
  opts: MediaRequestOptions,
): Promise<Response> {
  const url = new URL(request.url);
  const key = keyFromMediaPath(url.pathname);
  if (!key) return text(404, 'not found');
  const sig = url.searchParams.get('sig');
  if (!sig) return text(403, 'missing signature');
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));

  if (request.method === 'PUT' && !opts.readOnly) {
    if (!(await opts.signer.verify('PUT', key, url.searchParams, sig))) {
      return text(403, 'invalid signature');
    }
    const exp = Number(url.searchParams.get('exp'));
    if (!Number.isFinite(exp) || exp < now()) return text(403, 'upload URL expired');
    const contentType = url.searchParams.get('ct') ?? 'application/octet-stream';
    const length = Number(request.headers.get('content-length'));
    const max = opts.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
    // R2 needs a known length to stream; it also lets us refuse before reading.
    if (!Number.isFinite(length) || length <= 0) return text(411, 'content-length required');
    if (length > max) return text(413, `upload exceeds ${max} bytes`);
    if (!request.body) return text(400, 'empty body');
    // The stored type is the one the URL was signed for, not whatever the
    // client sends — the signer decided what this key may hold.
    await opts.bucket.put(key, request.body, { httpMetadata: { contentType } });
    return new Response(null, { status: 200 });
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('method not allowed', {
      status: 405,
      headers: { allow: opts.readOnly ? 'GET, HEAD' : 'GET, HEAD, PUT' },
    });
  }
  if (!(await opts.signer.verify('GET', key, url.searchParams, sig))) {
    return text(403, 'invalid signature');
  }
  // The signature covers `exp`, so it can't be stripped or moved; a URL without one is a stored,
  // non-expiring download URL, which only a host that still honours them accepts.
  const expParam = url.searchParams.get('exp');
  if (expParam === null ? opts.requireExpiry : !(Number(expParam) >= now())) {
    return text(403, 'URL expired');
  }
  const object = await opts.bucket.get(key);
  if (!object) return text(404, 'not found');

  const hasTransform = [...url.searchParams.keys()].some((k) => k !== 'sig' && k !== 'exp');
  if (hasTransform && opts.transform && request.method === 'GET') {
    const transformed = await opts.transform(object, url.searchParams, request);
    if (transformed) {
      if (expParam !== null) {
        const ttl = Math.max(0, Math.min(3600, Number(expParam) - now()));
        transformed.headers.set('cache-control', `private, max-age=${ttl}`);
      }
      return transformed;
    }
  }

  const contentType = object.httpMetadata?.contentType ?? 'application/octet-stream';
  const headers = safeHeaders(contentType);
  headers.set('etag', object.httpEtag);
  headers.set('content-length', String(object.size));
  // Keys are unique per asset and the URL is signed, so the bytes behind a
  // given URL change only on an (unusual) re-upload within the upload window.
  // A short-lived URL is a draft's: kept by the reader only, and not past its expiry.
  headers.set(
    'cache-control',
    expParam === null
      ? 'public, max-age=3600'
      : `private, max-age=${Math.max(0, Math.min(3600, Number(expParam) - now()))}`,
  );
  if (request.headers.get('if-none-match') === object.httpEtag) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(request.method === 'HEAD' ? null : object.body, { status: 200, headers });
}
