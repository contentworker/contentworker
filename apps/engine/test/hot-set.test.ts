import { env } from 'cloudflare:workers';
import {
  HOT_SET_HALF_LIFE_MS,
  HOT_SET_MAX_URLS,
  hotSetName,
  nextRank,
  profilePrincipal,
} from '@contentworker/platform/hot-urls';
import { describe, expect, it } from 'vitest';

/**
 * The hot set keeps the Delivery URLs readers ask for, hottest first, and the reader shape to
 * request each as: what a cache warm-up replays after a publish.
 */
const reader = profilePrincipal({
  spaceId: 's1',
  kind: 'cda',
  scopes: ['delivery:read'],
  keyId: 'key-1',
  subject: 'someone@example.com',
} as never);

const stub = (name = crypto.randomUUID()) => env.HOT_SET.get(env.HOT_SET.idFromName(name));

describe('hot set', () => {
  it('ranks URLs by how often they are read, hottest first', async () => {
    const hot = stub(hotSetName('s1', `env-${crypto.randomUUID()}`));
    for (let i = 0; i < 3; i++) await hot.record('https://d/_p/a/x', 'p1', reader);
    await hot.record('https://d/_p/a/y', 'p1', reader);
    for (let i = 0; i < 2; i++) await hot.record('https://d/_p/a/z', 'p1', reader);
    const top = await hot.top(10);
    expect(top.map((h) => h.url)).toEqual([
      'https://d/_p/a/x',
      'https://d/_p/a/z',
      'https://d/_p/a/y',
    ]);
    expect((await hot.top(1)).map((h) => h.url)).toEqual(['https://d/_p/a/x']);
  });

  it('keeps the reader shape only: no key id, no person', async () => {
    const hot = stub();
    await hot.record('https://d/_p/a/x', 'p1', reader);
    const [only] = await hot.top(1);
    expect(only?.principal).toEqual({ spaceId: 's1', kind: 'cda', scopes: ['delivery:read'] });
  });

  it('forgets the coldest URLs beyond its cap', async () => {
    const hot = stub();
    for (let i = 0; i < HOT_SET_MAX_URLS + 5; i++) {
      await hot.record(`https://d/_p/a/${i}`, 'p1', reader);
    }
    // The first URLs, read most often, stay.
    for (let i = 0; i < 5; i++) await hot.record(`https://d/_p/a/${i}`, 'p1', reader);
    await hot.prune();
    const top = await hot.top(HOT_SET_MAX_URLS + 10);
    expect(top).toHaveLength(HOT_SET_MAX_URLS);
    expect(top.slice(0, 5).map((h) => h.url)).toEqual(
      expect.arrayContaining([0, 1, 2, 3, 4].map((i) => `https://d/_p/a/${i}`)),
    );
  });
});

describe('decayed rank', () => {
  it('lets a URL read now outrank one read as often a day ago', () => {
    const now = 10 * 24 * 60 * 60 * 1000;
    let old: number | undefined;
    for (let i = 0; i < 4; i++) old = nextRank(old, now - 24 * 60 * 60 * 1000);
    let fresh: number | undefined;
    for (let i = 0; i < 4; i++) fresh = nextRank(fresh, now);
    expect(fresh as number).toBeGreaterThan(old as number);
  });

  it('halves a count over one half-life', () => {
    const r1 = nextRank(undefined, 0);
    const r2 = nextRank(nextRank(undefined, 0), 0);
    // Two reads at 0, compared one half-life later, weigh what one read then weighs.
    expect(r2).toBeCloseTo(nextRank(undefined, HOT_SET_HALF_LIFE_MS) - 1 + Math.log2(2), 6);
    expect(r2).toBeGreaterThan(r1);
  });
});
