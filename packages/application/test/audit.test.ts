import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@contentworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import { type AppContext, listAuditLog, recordAudit } from '../src/index';

function makeContext(): { ctx: AppContext; clock: FixedClock } {
  const store = new InMemoryContentStore();
  store.seedSpace({ spaceId: 'shop', defaultLocale: 'en-US', locales: ['en-US'] });
  const clock = new FixedClock();
  return { ctx: { store, clock, ids: new SequenceIdGenerator('a') }, clock };
}

describe('audit log', () => {
  let ctx: AppContext;
  let clock: FixedClock;

  beforeEach(() => {
    ({ ctx, clock } = makeContext());
  });

  it('stamps id + timestamp from the injected generators', async () => {
    const entry = await recordAudit(ctx, {
      spaceId: 'shop',
      environmentId: 'main',
      actor: 'cma',
      action: 'POST /spaces/:space/environments/:env/entries',
      targetId: 'entry-1',
      status: 201,
    });
    expect(entry.id).toBe('a-1');
    expect(entry.at).toBe('2026-01-01T00:00:00.000Z');
    expect(entry.actor).toBe('cma');
  });

  it('returns entries newest first', async () => {
    await recordAudit(ctx, { spaceId: 'shop', actor: 'cma', action: 'a', status: 200 });
    clock.advance(1000);
    await recordAudit(ctx, { spaceId: 'shop', actor: 'cma', action: 'b', status: 200 });
    const items = await listAuditLog(ctx, 'shop');
    expect(items.map((e) => e.action)).toEqual(['b', 'a']);
  });

  it('isolates entries by space', async () => {
    await recordAudit(ctx, { spaceId: 'shop', actor: 'cma', action: 'a', status: 200 });
    await recordAudit(ctx, { spaceId: 'other', actor: 'cma', action: 'b', status: 200 });
    expect(await listAuditLog(ctx, 'shop')).toHaveLength(1);
    expect(await listAuditLog(ctx, 'other')).toHaveLength(1);
  });

  it('filters by environment and honors limit', async () => {
    await recordAudit(ctx, {
      spaceId: 'shop',
      environmentId: 'main',
      actor: 'cma',
      action: 'a',
      status: 200,
    });
    await recordAudit(ctx, {
      spaceId: 'shop',
      environmentId: 'staging',
      actor: 'cma',
      action: 'b',
      status: 200,
    });
    await recordAudit(ctx, {
      spaceId: 'shop',
      environmentId: 'main',
      actor: 'cma',
      action: 'c',
      status: 200,
    });

    const main = await listAuditLog(ctx, 'shop', { environmentId: 'main' });
    expect(main.map((e) => e.action)).toEqual(['c', 'a']);

    const limited = await listAuditLog(ctx, 'shop', { limit: 1 });
    expect(limited).toHaveLength(1);
    expect(limited[0]?.action).toBe('c');
  });
});
