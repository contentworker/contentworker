/**
 * @contentworker/sdk-core/webhooks — check that a webhook delivery came from your space.
 *
 * Each delivery is signed: `x-contentworker-signature` is `sha256=` and the hex HMAC-SHA256 of
 * `<x-contentworker-timestamp>.<raw body>` with the webhook's secret. `verifyWebhook` checks it in
 * constant time (Web Crypto, so it runs in browsers, Workers, Node, Deno and Bun) and rejects a
 * delivery whose timestamp is outside the freshness window. Zero dependencies.
 */

/** A webhook event: the type and id on every event, plus the fields its type carries. */
export interface WebhookEvent {
  readonly id: string;
  readonly type: string;
  readonly occurredAt: string;
  readonly [field: string]: unknown;
}

export interface VerifyWebhookOptions {
  /**
   * How far the timestamp may be from now, in milliseconds (default 5 minutes). A retry keeps the
   * event's original timestamp, so widen this to accept late retries, or deduplicate by `id`.
   */
  readonly toleranceMs?: number;
  /** The current time, for tests. */
  readonly now?: number;
}

const encoder = new TextEncoder();

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Whether `signature` is a valid signature of `body` at `timestamp`. Use `verifyWebhook` with a
 * `Request`; this is for frameworks that hand you the raw body and headers separately.
 */
export async function verifyWebhookSignature(input: {
  readonly body: string;
  readonly timestamp: string | null | undefined;
  readonly signature: string | null | undefined;
  readonly secret: string;
  readonly toleranceMs?: number;
  readonly now?: number;
}): Promise<boolean> {
  const { body, timestamp, signature, secret } = input;
  if (!secret || !timestamp || !signature?.startsWith('sha256=')) return false;
  const at = Date.parse(timestamp);
  const tolerance = input.toleranceMs ?? 5 * 60_000;
  if (!Number.isFinite(at) || Math.abs((input.now ?? Date.now()) - at) > tolerance) return false;
  const sig = hexToBytes(signature.slice('sha256='.length));
  if (!sig) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  // `verify` compares in constant time.
  return crypto.subtle.verify('HMAC', key, sig, encoder.encode(`${timestamp}.${body}`));
}

/**
 * Reads a webhook delivery and returns its event if the signature and timestamp check out, or
 * `null` if they don't (answer 401 then). Reads the body itself, so pass the request unread.
 *
 *   const event = await verifyWebhook(request, env.WEBHOOK_SECRET);
 *   if (!event) return new Response('Invalid signature', { status: 401 });
 */
export async function verifyWebhook(
  request: Request,
  secret: string,
  options: VerifyWebhookOptions = {},
): Promise<WebhookEvent | null> {
  const body = await request.text();
  const ok = await verifyWebhookSignature({
    body,
    timestamp: request.headers.get('x-contentworker-timestamp'),
    signature: request.headers.get('x-contentworker-signature'),
    secret,
    ...options,
  });
  if (!ok) return null;
  try {
    const event = JSON.parse(body) as WebhookEvent;
    return typeof event?.type === 'string' ? event : null;
  } catch {
    return null;
  }
}

// --- delivery.refreshed: revalidate your own cache once ContentWorker's edge is fresh ---------

/** Cache tag for one entry's pages: tag your fetches with it, and `delivery.refreshed` clears it. */
export const entryTag = (entryId: string): string => `cw:entry:${entryId}`;
/** Cache tag for pages that list or render a content type's entries. */
export const typeTag = (contentTypeApiId: string): string => `cw:type:${contentTypeApiId}`;
/** Cache tag for everything a site read from one space:environment. */
export const environmentTag = (spaceId: string, environmentId: string): string =>
  `cw:env:${spaceId}:${environmentId}`;

/**
 * `delivery.refreshed`: an environment's Delivery cache has settled after a change, so a fetch now
 * gets the new content. Revalidate on this rather than on `entry.published`, which can reach you
 * before the edge is fresh.
 */
export interface DeliveryRefreshedEvent extends WebhookEvent {
  readonly type: 'delivery.refreshed';
  readonly scope: { readonly spaceId: string; readonly environmentId: string };
  /** `refreshed` after a publish or edit; `purged` after an unpublish or revocation. */
  readonly mode: 'refreshed' | 'purged';
  readonly entryIds: readonly string[];
  readonly contentTypeApiIds: readonly string[];
  /** Revalidate everything from this environment (the lists don't say all that changed). */
  readonly everything: boolean;
  readonly sourceEventIds: readonly string[];
}

export const isDeliveryRefreshed = (event: WebhookEvent): event is DeliveryRefreshedEvent =>
  event.type === 'delivery.refreshed';

/**
 * The cache tags a `delivery.refreshed` event makes stale: the environment's tag when it says
 * `everything`, otherwise each entry's and type's tag.
 */
export function staleTags(event: DeliveryRefreshedEvent): string[] {
  if (event.everything) return [environmentTag(event.scope.spaceId, event.scope.environmentId)];
  return [...event.entryIds.map(entryTag), ...event.contentTypeApiIds.map(typeTag)];
}

export interface DeliveryRefreshedHandlerOptions extends VerifyWebhookOptions {
  /** The webhook's signing secret. */
  readonly secret: string;
  /** Clears one cache tag (Next.js: `revalidateTag` from `next/cache`). */
  readonly revalidateTag: (tag: string) => unknown;
}

/**
 * A webhook route that revalidates your cache on `delivery.refreshed`: verifies the signature
 * (401 when it fails), clears the stale tags, and answers 204. Any other event is acknowledged
 * (204) and ignored, so the same URL can subscribe to more topics.
 *
 *   // app/api/contentworker/route.ts (Next.js)
 *   import { revalidateTag } from 'next/cache';
 *   export const POST = (request: Request) =>
 *     handleDeliveryRefreshed(request, { secret: process.env.CW_WEBHOOK_SECRET!, revalidateTag });
 */
export async function handleDeliveryRefreshed(
  request: Request,
  { secret, revalidateTag, ...options }: DeliveryRefreshedHandlerOptions,
): Promise<Response> {
  const event = await verifyWebhook(request, secret, options);
  if (!event) return new Response('Invalid signature', { status: 401 });
  if (isDeliveryRefreshed(event)) {
    for (const tag of staleTags(event)) await revalidateTag(tag);
  }
  return new Response(null, { status: 204 });
}
