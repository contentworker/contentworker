import type { Principal } from '@contentworker/domain';
import { describe, expect, it } from 'vitest';
import { canonicalUrl, fromCanonical, visibilityProfile } from '../src/profile.js';
import { backoff, drain, PURGE_CALLS, PURGE_TAGS } from '../src/purge.js';

const cda = (over: Partial<Principal> = {}): Principal =>
  ({ spaceId: 's1', kind: 'cda', scopes: ['delivery:read', 'search:read'], ...over }) as Principal;

describe('visibilityProfile', () => {
  it('is equal for keys that see the same content, whatever their order of scopes', async () => {
    const a = await visibilityProfile(cda());
    const b = await visibilityProfile(cda({ scopes: ['search:read', 'delivery:read'] }));
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{24}$/);
  });

  it('differs when anything that shapes a response differs', async () => {
    const base = await visibilityProfile(cda());
    expect(await visibilityProfile(cda({ spaceId: 's2' }))).not.toBe(base);
    expect(await visibilityProfile(cda({ kind: 'cpa' }))).not.toBe(base);
    expect(await visibilityProfile(cda({ scopes: ['delivery:read'] }))).not.toBe(base);
    expect(
      await visibilityProfile(
        cda({
          contentGrants: [
            { contentTypeApiId: 'post', actions: ['read'], deniedFields: ['secret'] },
          ],
        } as Partial<Principal>),
      ),
    ).not.toBe(base);
  });
});

describe('canonical URLs', () => {
  it('sorts query parameters and round-trips the public path', () => {
    const url = new URL('https://cdn.example/delivery/s1/main/entries?limit=5&content_type=post');
    const c = canonicalUrl('a'.repeat(24), url);
    expect(c).toBe(
      `https://delivery.internal/_p/${'a'.repeat(24)}/delivery/s1/main/entries?content_type=post&limit=5`,
    );
    const back = fromCanonical(new URL(c));
    expect(back?.profile).toBe('a'.repeat(24));
    expect(back?.path.pathname).toBe('/delivery/s1/main/entries');
    expect(back?.path.searchParams.get('limit')).toBe('5');
  });

  it('rejects anything that is not a canonical URL', () => {
    expect(fromCanonical(new URL('https://delivery.internal/delivery/s1/main/entries'))).toBeNull();
    expect(fromCanonical(new URL('https://delivery.internal/_p/xyz/delivery'))).toBeNull();
  });
});

type Msg = {
  body: { tags: string[] };
  timestamp: Date;
  attempts: number;
  acked: boolean;
  retried?: number;
  ack(): void;
  retry(o?: { delaySeconds?: number }): void;
};
const msg = (tags: string[], at = 0): Msg => ({
  body: { tags },
  timestamp: new Date(at),
  attempts: 1,
  acked: false,
  ack() {
    this.acked = true;
  },
  retry(o) {
    this.retried = o?.delaySeconds ?? 0;
  },
});
const batch = (messages: Msg[]) => ({ messages }) as unknown as MessageBatch<{ tags: string[] }>;

describe('purge drain', () => {
  it('coalesces duplicate tags across messages into one paced call', async () => {
    const calls: string[][] = [];
    const ms = [msg(['cw:s1:main']), msg(['cw:s1:main', 'cw:s2:main'], 1)];
    await drain(
      batch(ms),
      async (tags) => {
        calls.push(tags);
        return { success: true };
      },
      async () => {},
    );
    expect(calls).toEqual([['cw:s1:main', 'cw:s2:main']]);
    expect(ms.every((m) => m.acked)).toBe(true);
  });

  it('hands everything back with backoff when a purge is refused', async () => {
    const ms = [msg(['a']), msg(['b'], 1)];
    await drain(
      batch(ms),
      async () => ({ success: false }),
      async () => {},
    );
    expect(ms.every((m) => !m.acked && m.retried === backoff(1, 30, 900))).toBe(true);
  });

  it('stops after its call budget and returns the rest to the queue', async () => {
    const ms = Array.from({ length: PURGE_CALLS + 2 }, (_, i) =>
      msg(
        Array.from({ length: PURGE_TAGS }, (_, t) => `t${i}-${t}`),
        i,
      ),
    );
    let calls = 0;
    await drain(
      batch(ms),
      async () => {
        calls++;
        return { success: true };
      },
      async () => {},
    );
    expect(calls).toBe(PURGE_CALLS);
    expect(ms.filter((m) => m.acked)).toHaveLength(PURGE_CALLS);
    expect(ms.filter((m) => m.retried !== undefined)).toHaveLength(2);
  });
});
