/**
 * What clients may do with a delivery response. Workers Caching keeps its own (public) policy for
 * the cached entrypoint; to clients a successful response is private, because it was authorized
 * for this key and no shared cache downstream may reuse it for another caller. Anything else (a
 * 404 for an entry about to be published, a 401, an error) must not be kept at all.
 */
export const CLIENT_CACHE = 'private, max-age=60, must-revalidate';

export function clientCacheControl(status: number): string {
  return status === 200 || status === 304 ? CLIENT_CACHE : 'no-store';
}
