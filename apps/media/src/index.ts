/**
 * The media Worker: published asset files at `media.<domain>`, cached at the edge.
 *
 * This default entrypoint is the gateway, with no cache in front of it. It trusts no request
 * header: it reads `Accept` only to pick an output format and `If-None-Match` only to answer 304.
 * Per request it either
 * 1. checks a public URL's token (`/<space>/<env>/<asset>/v<n>/<token>/<variant>/<file>`), maps
 *    it to its canonical form (the path, and for a variant the negotiated format) and asks the
 *    cached `Media` entrypoint, which checks the engine's gate on a miss; or
 * 2. serves a short-lived signed read (`/media/<key>?exp=…&sig=…`, Preview's drafts), uncached,
 *    when the signature and expiry hold. Never an upload, never a URL without an expiry.
 *
 * Its queue consumer drains `contentworker-media-purge`, rationed like delivery's.
 */
import { handleMediaRequest } from '@contentworker/adapters/blob-r2';
import { type ImagesBindingLike, transformImage } from '@contentworker/adapters/images-cf';
import { type EdgeEnv, queueName } from '@contentworker/platform/env';
import type { PurgeMessage } from '@contentworker/platform/messages';
import { drain } from '@contentworker/platform/purge';
import { wireMedia } from '@contentworker/platform/wire';
import type { Media } from './media';
import { canonicalMediaUrl } from './serve';

export { Media } from './media';

type Exports = { Media: Service<Media> };

const PUBLIC = {
  'access-control-allow-origin': '*',
  'access-control-expose-headers': 'etag, cf-cache-status',
  'timing-allow-origin': '*',
  'x-content-type-options': 'nosniff',
  'strict-transport-security': 'max-age=31536000',
};

function withPublic(res: Response, extra: Record<string, string> = {}): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries({ ...PUBLIC, ...extra })) out.headers.set(k, v);
  return out;
}

/** Whether an If-None-Match header names `etag` (weak or strong, or `*`). */
function matches(ifNoneMatch: string | null, etag: string | null): boolean {
  if (!ifNoneMatch || !etag) return false;
  return ifNoneMatch
    .split(',')
    .map((t) => t.trim().replace(/^W\//, ''))
    .some((t) => t === '*' || t === etag);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/health')
      return Response.json({ ok: true, service: 'contentworker-media' });
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return withPublic(new Response('read only', { status: 405 }), { allow: 'GET, HEAD' });
    }

    const wired = wireMedia(env);
    if (url.pathname.startsWith('/media/')) {
      if (!env.MEDIA_BUCKET) return withPublic(new Response('not found', { status: 404 }));
      const images = env.IMAGES;
      const res = await handleMediaRequest(request, {
        bucket: env.MEDIA_BUCKET,
        signer: wired.mediaSigner,
        requireExpiry: true,
        readOnly: true,
        ...(images
          ? {
              transform: (object, params, req) =>
                transformImage(
                  images as ImagesBindingLike,
                  object.body,
                  object.httpMetadata?.contentType ?? '',
                  params,
                  req.headers.get('accept'),
                ),
            }
          : {}),
      });
      return withPublic(res);
    }

    const canonical = canonicalMediaUrl(url, request.headers.get('accept'), wired.mediaPaths);
    if (!canonical) {
      return withPublic(new Response('not found', { status: 404 }), {
        'cache-control': 'no-store',
      });
    }
    const exports = (ctx as unknown as { exports: Exports }).exports;
    // A fresh request: nothing the client sent reaches the cache or its key.
    const upstream = await exports.Media.fetch(new Request(canonical.url));
    const etag = upstream.headers.get('etag');
    const extra: Record<string, string> = canonical.negotiated ? { vary: 'Accept' } : {};
    if (upstream.status === 200 && matches(request.headers.get('if-none-match'), etag)) {
      await upstream.body?.cancel();
      return withPublic(new Response(null, { status: 304, headers: upstream.headers }), extra);
    }
    if (request.method === 'HEAD') {
      await upstream.body?.cancel();
      return withPublic(new Response(null, upstream), extra);
    }
    return withPublic(upstream, extra);
  },

  async queue(batch, env, ctx) {
    if (batch.queue === queueName(env, 'contentworker-media-purge-dlq')) {
      // Purges that failed every retry: the media they name stays cached (it is immutable), so
      // say so loudly; an operator can purge the tags by hand.
      for (const msg of batch.messages) {
        console.error(
          JSON.stringify({
            msg: 'media purge dead-lettered',
            tags: (msg.body as PurgeMessage).tags,
          }),
        );
        env.METRICS?.writeDataPoint({
          blobs: ['contentworker_media_purge_dead_letters_total'],
          doubles: [1],
        });
        msg.ack();
      }
      return;
    }
    const exports = (ctx as unknown as { exports: Exports }).exports;
    await drain(batch as MessageBatch<PurgeMessage>, (tags) => exports.Media.purge(tags));
  },
} satisfies ExportedHandler<EdgeEnv>;
