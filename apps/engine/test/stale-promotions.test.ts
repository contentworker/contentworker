import { env } from 'cloudflare:workers';
import {
  type AppContext,
  createSpace,
  failStalePromotions,
  getSchedulerStatus,
  PROMOTION_APPLY_TIMEOUT_MS,
} from '@contentworker/application';
import { createD1Store } from '@contentworker/db';
import { type Principal, type Promotion, SCOPES } from '@contentworker/domain';
import { FixedClock } from '@contentworker/test-kit';
import { describe, expect, it } from 'vitest';
import { CRON_EVERY, CRON_JOBS, finishTick, startTick, sweep } from '../src/heartbeat';

/**
 * The cron's stale promotion sweep on D1, as `scheduled` runs it on the top-of-hour tick: under its
 * own heartbeat job, failing a promotion left `applying` past the bound, through the store's real
 * compare-and-set, and leaving one that is younger or already finished alone.
 */
const admin: Principal = { spaceId: '*', kind: 'admin', scopes: Object.values(SCOPES) };
const uid = () => crypto.randomUUID();

describe('stale promotion sweep', () => {
  it('runs hourly under its own heartbeat job', () => {
    expect(CRON_JOBS.stalePromotions).toBe('stale-promotions');
    expect(CRON_EVERY.stalePromotions).toBe(60 * 60 * 1000);
  });

  it('fails what has been applying past the bound, once, and nothing else', async () => {
    const clock = new FixedClock(new Date());
    const ctx: AppContext = { store: createD1Store(env.DB), clock, ids: { newId: uid } };
    const spaceId = `promo-${uid()}`;
    await createSpace(ctx, { spaceId, name: spaceId, defaultLocale: 'en-US' });
    const ago = (ms: number) => new Date(clock.now().getTime() - ms).toISOString();
    const promotion = (id: string, patch: Partial<Promotion>): Promotion => ({
      id,
      spaceId,
      source: 'staging',
      target: 'main',
      contentTypes: [],
      entries: [],
      status: 'applying',
      risk: { protectedTarget: true, requiresApproval: false, reasons: [] },
      requestedBy: 'ci',
      createdAt: ago(0),
      ...patch,
    });
    // Approved long after it was requested: the hour runs from the approval.
    const stuck = promotion('stuck', {
      createdAt: ago(3 * PROMOTION_APPLY_TIMEOUT_MS),
      decidedAt: ago(PROMOTION_APPLY_TIMEOUT_MS + 1),
      decidedBy: 'grace',
    });
    const young = promotion('young', {
      createdAt: ago(3 * PROMOTION_APPLY_TIMEOUT_MS),
      decidedAt: ago(PROMOTION_APPLY_TIMEOUT_MS - 60_000),
    });
    const done = promotion('done', {
      status: 'completed',
      createdAt: ago(3 * PROMOTION_APPLY_TIMEOUT_MS),
    });
    for (const p of [stuck, young, done]) await ctx.store.promotions.create(p);

    const runTick = async () => {
      const tick = startTick(ctx);
      const results: unknown[] = [];
      await sweep(
        tick,
        CRON_JOBS.stalePromotions,
        async () => results.push(await failStalePromotions(ctx)),
        (err) => {
          throw err;
        },
      );
      expect(await finishTick(ctx, tick)).toBe(true);
      return results[0];
    };

    expect(await runTick()).toEqual({ failed: 1 });
    expect(await ctx.store.promotions.get(spaceId, 'stuck')).toMatchObject({
      status: 'failed',
      decidedBy: 'grace',
      completedAt: clock.now().toISOString(),
      error: expect.stringContaining('request a new promotion'),
    });
    expect((await ctx.store.promotions.get(spaceId, 'young'))?.status).toBe('applying');
    expect((await ctx.store.promotions.get(spaceId, 'done'))?.status).toBe('completed');
    const audit = await ctx.store.audit.list(spaceId, { targetType: 'promotion' });
    expect(audit).toMatchObject([
      { action: 'promotion.failed', targetId: 'stuck', actor: 'system', status: 500 },
    ]);

    // A second tick (or a redelivered one) finds nothing more to fail.
    expect(await runTick()).toEqual({ failed: 0 });
    const status = await getSchedulerStatus(ctx, admin);
    expect(status.jobs.find((j) => j.job === CRON_JOBS.stalePromotions)?.lastSuccessAt).toBe(
      clock.now().toISOString(),
    );
  });
});
