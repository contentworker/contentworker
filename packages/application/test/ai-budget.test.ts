import { RateLimitedError } from '@contentworker/domain';
import type { AIProvider } from '@contentworker/ports';
import {
  FixedClock,
  InMemoryContentStore,
  InMemoryCostGuard,
  SequenceIdGenerator,
} from '@contentworker/test-kit';
import { describe, expect, it } from 'vitest';
import { type AppContext, aiBudgetLimits, generateWithBudget } from '../src/index';

const scope = { spaceId: 's1', environmentId: 'main' };
const scopeB = { spaceId: 's2', environmentId: 'main' };

function fakeAI(tokens = 100): AIProvider {
  return {
    async generate() {
      return { text: 'ok', usage: { inputTokens: tokens, outputTokens: tokens } };
    },
  };
}

function ctxWith(guard?: InMemoryCostGuard): AppContext {
  return {
    store: new InMemoryContentStore(),
    clock: new FixedClock(),
    ids: new SequenceIdGenerator('a'),
    costGuard: guard,
  };
}

const req = { prompt: 'hi', maxTokens: 128 };

describe('generateWithBudget', () => {
  it('passes through unmetered when no cost guard is wired', async () => {
    const ctx = ctxWith(undefined);
    const r = await generateWithBudget(ctx, fakeAI(), scope, req);
    expect(r.text).toBe('ok');
  });

  it('enforces the per-space request ceiling', async () => {
    const guard = new InMemoryCostGuard({
      maxRequests: 3,
      maxTokens: 1_000_000,
      windowSeconds: 60,
    });
    const ctx = ctxWith(guard);
    for (let i = 0; i < 3; i++) await generateWithBudget(ctx, fakeAI(0), scope, req);
    await expect(generateWithBudget(ctx, fakeAI(0), scope, req)).rejects.toBeInstanceOf(
      RateLimitedError,
    );
  });

  it('enforces the per-space token ceiling on the next call after usage accrues', async () => {
    const guard = new InMemoryCostGuard({ maxRequests: 100, maxTokens: 150, windowSeconds: 60 });
    const ctx = ctxWith(guard);
    // First call settles 100+100=200 tokens, over the 150 ceiling.
    await generateWithBudget(ctx, fakeAI(100), scope, req);
    await expect(generateWithBudget(ctx, fakeAI(100), scope, req)).rejects.toBeInstanceOf(
      RateLimitedError,
    );
  });

  it('isolates budgets per space', async () => {
    const guard = new InMemoryCostGuard({
      maxRequests: 1,
      maxTokens: 1_000_000,
      windowSeconds: 60,
    });
    const ctx = ctxWith(guard);
    await generateWithBudget(ctx, fakeAI(0), scope, req);
    await expect(generateWithBudget(ctx, fakeAI(0), scope, req)).rejects.toBeInstanceOf(
      RateLimitedError,
    );
    // A different space still has its full budget.
    await expect(generateWithBudget(ctx, fakeAI(0), scopeB, req)).resolves.toBeTruthy();
  });

  it('resets after the window elapses', async () => {
    let t = 1_000_000;
    const guard = new InMemoryCostGuard(
      { maxRequests: 1, maxTokens: 1_000_000, windowSeconds: 60 },
      () => t,
    );
    const ctx = ctxWith(guard);
    await generateWithBudget(ctx, fakeAI(0), scope, req);
    await expect(generateWithBudget(ctx, fakeAI(0), scope, req)).rejects.toBeInstanceOf(
      RateLimitedError,
    );
    t += 61_000; // advance past the window
    await expect(generateWithBudget(ctx, fakeAI(0), scope, req)).resolves.toBeTruthy();
  });
});

describe('aiBudgetLimits', () => {
  it('returns defaults for an empty env', () => {
    expect(aiBudgetLimits({})).toEqual({ maxRequests: 60, maxTokens: 200_000, windowSeconds: 60 });
  });

  it('disables metering when a ceiling is 0', () => {
    expect(aiBudgetLimits({ AI_MAX_REQUESTS_PER_WINDOW: '0' })).toBeUndefined();
    expect(aiBudgetLimits({ AI_MAX_TOKENS_PER_WINDOW: '0' })).toBeUndefined();
  });

  it('reads overrides from env', () => {
    expect(
      aiBudgetLimits({
        AI_MAX_REQUESTS_PER_WINDOW: '10',
        AI_MAX_TOKENS_PER_WINDOW: '5000',
        AI_BUDGET_WINDOW_SECONDS: '30',
      }),
    ).toEqual({ maxRequests: 10, maxTokens: 5000, windowSeconds: 30 });
  });
});
