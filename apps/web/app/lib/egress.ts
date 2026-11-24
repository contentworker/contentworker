/**
 * The egress policy for server-side fetches of URLs someone else chose or can influence: an
 * identity provider's endpoints, a webhook subscriber, a live carrier, an A2A or UCP receiver, an
 * image an order points at. Workers reach the internet from Cloudflare's edge, and the Workers set
 * `global_fetch_strictly_public`, but a URL can still be aimed at an internal name, carry
 * credentials in itself, redirect a request (and its `Authorization`) somewhere it wasn't sent,
 * or answer with more than anyone reads. So: https only; no credentials in the URL; no IP
 * literals, `localhost`, `.internal`, `.local` or single-label hosts; no redirects unless the
 * caller allows a few for a credential-free GET, each checked again; bounded time and size.
 *
 * Hostnames aren't resolved here (Workers can't), so a public name that points at a private
 * address isn't caught: `global_fetch_strictly_public` is the backstop for that.
 */

import { isInternalHostname, isSpecialPurposeAddress } from '@contentworker/domain';

/** A fetch the policy refused, before or during the request. */
export class EgressRefused extends Error {}

/** Whether `host` resolves only inside a network (or is a single label), or to whatever its labels say. */
export const isInternalName = (host: string) =>
  isInternalHostname(host) || !host.replace(/\.+$/, '').includes('.');

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

export type EgressOptions = {
  /**
   * Plain http (or https) to this machine is allowed: webhook subscriptions and A2A push URLs,
   * which may point at a receiver in local development (`isWebhookUrl`).
   */
  loopback?: boolean;
};

/** Why the policy refuses `url`, or null when it may be fetched. */
export function egressProblem(url: string | URL, { loopback = false }: EgressOptions = {}) {
  let u: URL;
  try {
    u = new URL(String(url));
  } catch {
    return 'not a valid URL';
  }
  const host = u.hostname.toLowerCase();
  if (loopback && LOOPBACK.has(host) && (u.protocol === 'http:' || u.protocol === 'https:'))
    return u.username || u.password ? 'credentials in the URL' : null;
  if (u.protocol !== 'https:') return `${u.protocol} isn't allowed (https only)`;
  if (u.username || u.password) return 'credentials in the URL';
  if (!host) return 'no host';
  // A trailing root dot (`localhost.`, also written `%2e` or `。`) names the same host; no
  // receiver needs one, and refusing it keeps the name checks below honest.
  if (host.endsWith('.')) return `a host ending in a dot (${host})`;
  // Any IP literal: public services are reached by name, and a literal is how the private ranges
  // (and the ones that wrap them) are written.
  if (host.startsWith('[') || /^\d{1,3}(\.\d{1,3}){3}$/.test(host))
    return isSpecialPurposeAddress(host)
      ? `a private address (${host})`
      : `an IP address (${host})`;
  if (isInternalName(host)) return `an internal name (${host})`;
  return null;
}

export type SafeFetchInit = RequestInit &
  EgressOptions & {
    /** Milliseconds before the request is abandoned. Default 10 seconds. */
    timeoutMs?: number;
    /**
     * Redirects followed, each checked against the policy (default 0: a 3xx is refused). Only for
     * a GET without credential headers: a redirect never carries a credential elsewhere.
     */
    redirects?: number;
  };

const TIMEOUT_MS = 10_000;

/** Headers that carry a credential, so a request with any of them never follows a redirect. */
const CREDENTIAL_HEADERS = ['authorization', 'proxy-authorization', 'cookie', 'x-api-key'];

/**
 * `fetch` behind the policy: the URL checked, redirects refused (or followed and checked, see
 * `redirects`), time bounded. Throws `EgressRefused` for a refused URL or redirect; the response
 * is the caller's to read, with `readCappedText` or `readCappedJson` for a bounded body.
 */
export async function safeFetch(url: string | URL, init: SafeFetchInit = {}): Promise<Response> {
  const { loopback, timeoutMs = TIMEOUT_MS, redirects = 0, ...rest } = init;
  const method = (rest.method ?? 'GET').toUpperCase();
  const headers = new Headers(rest.headers);
  const credentialed = CREDENTIAL_HEADERS.some((h) => headers.has(h));
  if (redirects > 0 && (method !== 'GET' || credentialed))
    throw new EgressRefused('redirects are followed only for a GET without credentials');
  const signal = AbortSignal.timeout(timeoutMs);
  let at = String(url);
  for (let hop = 0; ; hop++) {
    const problem = egressProblem(at, { loopback });
    if (problem) throw new EgressRefused(`refused ${hostOf(at)}: ${problem}`);
    const res = await fetch(at, { ...rest, redirect: 'manual', signal });
    if (res.status < 300 || res.status >= 400) return res;
    await res.body?.cancel();
    const next = res.headers.get('location');
    if (hop >= redirects || !next)
      throw new EgressRefused(`refused a redirect from ${hostOf(at)} (HTTP ${res.status})`);
    at = new URL(next, at).href;
  }
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return 'an invalid URL';
  }
};

/** A response body as bytes, or null once it passes `maxBytes` (declared or as it streams). */
export async function readCappedBytes(res: Response, maxBytes: number): Promise<Uint8Array | null> {
  if (Number(res.headers.get('content-length') ?? 0) > maxBytes) {
    await res.body?.cancel();
    return null;
  }
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/** A response body as text, capped at `maxBytes`; throws `EgressRefused` past it. */
export async function readCappedText(res: Response, maxBytes: number): Promise<string> {
  const bytes = await readCappedBytes(res, maxBytes);
  if (!bytes) throw new EgressRefused(`a response over ${maxBytes} bytes`);
  return new TextDecoder().decode(bytes);
}

/** A response body as JSON, capped at `maxBytes`; throws on a body too large or not JSON. */
export async function readCappedJson<T = unknown>(res: Response, maxBytes: number): Promise<T> {
  return JSON.parse(await readCappedText(res, maxBytes)) as T;
}
