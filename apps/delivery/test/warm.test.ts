import type { Principal } from '@contentworker/domain';
import type { EdgeEnv } from '@contentworker/platform/env';
import type { HotUrl } from '@contentworker/platform/hot-urls';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  recordRead,
  resetRecorded,
  scopeOfTag,
  warm,
  warmingEnabled,
  warmTargets,
} from '../src/warm';

/** A HOT_SET namespace whose objects answer from a map, and record what they were told. */
function hotSets(sets: Record<string, HotUrl[]>) {
  const recorded: { name: string; reads: unknown[] }[] = [];
  const ns = {
    idFromName: (name: string) => name,
    get: (name: string) => ({
      top: async (limit: number) => (sets[name] ?? []).slice(0, limit),
      recordMany: async (reads: unknown[]) => {
        recorded.push({ name, reads });
      },
    }),
  };
  return { ns, recorded };
}

const reader = { spaceId: 's1', kind: 'cda', scopes: ['delivery:read'] } as const;
const hot = (url: string): HotUrl => ({ url, principal: reader });
const metrics = () => {
  const counted: Record<string, number> = {};
  return {
    counted,
    count(metric: string, value = 1, labels: Record<string, string> = {}) {
      const k = [metric, ...Object.values(labels)].join('|');
      counted[k] = (counted[k] ?? 0) + value;
    },
  };
};
const envWith = (ns: unknown, vars: Record<string, string> = {}) =>
  ({ HOT_SET: ns, ...vars }) as unknown as EdgeEnv;

describe('cache warming', () => {
  it('requests the hottest URLs of every environment a purge settled, once each', async () => {
    const { ns } = hotSets({
      's1:main': [hot('https://d/_p/a/1'), hot('https://d/_p/a/2')],
      's2:main': [hot('https://d/_p/b/1'), hot('https://d/_p/a/1')],
    });
    const fetched: string[] = [];
    const m = metrics();
    const out = await warm(
      envWith(ns),
      ['cw:s1:main', 'cw:s2:main', 'cwa:s1:main:asset', 'cw:s1:main'],
      async (url, principal) => {
        expect(principal).toEqual(reader);
        fetched.push(url);
        return new Response('{}', { headers: { 'cf-cache-status': 'MISS' } });
      },
      m,
    );
    expect(fetched.sort()).toEqual(['https://d/_p/a/1', 'https://d/_p/a/2', 'https://d/_p/b/1']);
    expect(out).toEqual({ requested: 3, failed: 0, skipped: 0 });
    expect(m.counted['contentworker_cache_warm_requests_total|miss']).toBe(3);
  });

  it('warms at most CACHE_WARM_URLS per environment', async () => {
    const { ns } = hotSets({ 's1:main': [1, 2, 3, 4].map((i) => hot(`https://d/_p/a/${i}`)) });
    const fetched: string[] = [];
    await warm(
      envWith(ns, { CACHE_WARM_URLS: '2' }),
      ['cw:s1:main'],
      async (url) => {
        fetched.push(url);
        return new Response('{}');
      },
      metrics(),
    );
    expect(fetched).toEqual(['https://d/_p/a/1', 'https://d/_p/a/2']);
  });

  it('counts failures and stops when its budget runs out', async () => {
    const { ns } = hotSets({ 's1:main': [1, 2, 3].map((i) => hot(`https://d/_p/a/${i}`)) });
    const failing = await warm(
      envWith(ns),
      ['cw:s1:main'],
      async () => {
        throw new Error('boom');
      },
      metrics(),
    );
    expect(failing).toEqual({ requested: 3, failed: 3, skipped: 0 });
    const out = await warm(
      envWith(ns),
      ['cw:s1:main'],
      async () => new Response('{}'),
      metrics(),
      0,
    );
    expect(out).toEqual({ requested: 0, failed: 0, skipped: 3 });
  });

  it('does nothing when turned off or unbound', async () => {
    const { ns } = hotSets({ 's1:main': [hot('https://d/_p/a/1')] });
    const never = async () => {
      throw new Error('should not fetch');
    };
    expect(warmingEnabled(envWith(ns, { CACHE_WARMING: 'false' }))).toBe(false);
    expect(warmingEnabled(envWith(undefined))).toBe(false);
    expect(
      await warm(envWith(ns, { CACHE_WARMING: 'false' }), ['cw:s1:main'], never, metrics()),
    ).toEqual({ requested: 0, failed: 0, skipped: 0 });
  });

  it('never warms what a drain purged: only what it invalidated', () => {
    expect(warmTargets({ purged: ['cw:s1:main'], invalidated: [] } as never)).toEqual([]);
    expect(warmTargets({ purged: ['cw:s1:main'], invalidated: ['cw:s2:main'] } as never)).toEqual([
      'cw:s2:main',
    ]);
  });

  it('reads the environment a scope tag names, and nothing else', () => {
    expect(scopeOfTag('cw:s1:main')).toEqual({ spaceId: 's1', environmentId: 'main' });
    expect(scopeOfTag('cwa:s1:main:a')).toBeNull();
    expect(scopeOfTag('cw:s1')).toBeNull();
  });
});

describe('recording reads', () => {
  beforeEach(() => resetRecorded());
  const principal = { ...reader, keyId: 'k1', subject: 'x' } as unknown as Principal;
  const scope = { spaceId: 's1', environmentId: 'main' };

  it('flushes the reads it held, weighted, at most once a minute per environment', async () => {
    const { ns, recorded } = hotSets({});
    const env = envWith(ns);
    // The first read of an environment goes out at once.
    await recordRead(env, scope, 'https://d/_p/a/1', 'pa', principal, 0);
    expect(recordRead(env, scope, 'https://d/_p/a/1', 'pa', principal, 1000)).toBeUndefined();
    expect(recordRead(env, scope, 'https://d/_p/a/2', 'pa', principal, 2000)).toBeUndefined();
    expect(recordRead(env, scope, 'https://d/_p/a/1', 'pa', principal, 3000)).toBeUndefined();
    await recordRead(env, scope, 'https://d/_p/a/2', 'pa', principal, 61_000);
    expect(recorded).toEqual([
      {
        name: 's1:main',
        reads: [{ url: 'https://d/_p/a/1', profile: 'pa', principal: reader, weight: 1 }],
      },
      {
        name: 's1:main',
        reads: [
          { url: 'https://d/_p/a/1', profile: 'pa', principal: reader, weight: 2 },
          { url: 'https://d/_p/a/2', profile: 'pa', principal: reader, weight: 2 },
        ],
      },
    ]);
  });

  it('never records search: its URLs carry what readers typed', () => {
    const { ns } = hotSets({});
    expect(
      recordRead(envWith(ns), scope, 'https://d/_p/a/delivery/s1/main/search?q=x', 'p', principal),
    ).toBeUndefined();
  });

  it('records nothing when warming is off', () => {
    const { ns } = hotSets({});
    expect(
      recordRead(envWith(ns, { CACHE_WARMING: 'false' }), scope, 'u', 'p', principal),
    ).toBeUndefined();
  });
});
