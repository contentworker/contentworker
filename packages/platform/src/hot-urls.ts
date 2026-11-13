/**
 * The shapes and arithmetic of a hot set (the Delivery URLs readers ask for, kept by HotSetDO),
 * free of the Workers runtime so the delivery Worker's tests can use them.
 */
import type { Principal } from '@contentworker/domain';

/**
 * The reader shape a cached Delivery response depends on: what decides its visibility profile, and
 * nothing that identifies a key or a person. Replaying a URL with it renders the same bytes any
 * reader with that profile would get.
 */
export type ProfilePrincipal = Pick<Principal, 'spaceId' | 'kind' | 'scopes' | 'contentGrants'>;

/** One URL worth keeping warm, with the reader to request it as. */
export interface HotUrl {
  readonly url: string;
  readonly principal: ProfilePrincipal;
}

/** Most URLs one space:environment keeps; the coldest beyond it are dropped. */
export const HOT_SET_MAX_URLS = 500;
/** A request counts half as much after this long: recent reads outrank old ones. */
export const HOT_SET_HALF_LIFE_MS = 6 * 60 * 60 * 1000;
/** A URL nobody has read for this long is forgotten. */
export const HOT_SET_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Reduces a principal to its profile shape (see {@link ProfilePrincipal}). */
export function profilePrincipal(p: Principal): ProfilePrincipal {
  return {
    spaceId: p.spaceId,
    kind: p.kind,
    scopes: p.scopes,
    ...(p.contentGrants ? { contentGrants: p.contentGrants } : {}),
  };
}

/**
 * A decayed hit count kept as one sortable number: `rank = seen / halfLife + log2(score at seen)`.
 * Comparing ranks compares scores decayed to any common instant, so the hottest URLs are an index
 * scan, with no rewrite of every row as time passes.
 */
export function nextRank(previous: number | undefined, now: number): number {
  const at = now / HOT_SET_HALF_LIFE_MS;
  const decayed = previous === undefined ? 0 : 2 ** (previous - at);
  return at + Math.log2(decayed + 1);
}

/** The object holding one space:environment's hot set. */
export const hotSetName = (spaceId: string, environmentId: string) => `${spaceId}:${environmentId}`;
