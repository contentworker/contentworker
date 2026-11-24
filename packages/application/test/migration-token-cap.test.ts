import {
  MIGRATION_DEFAULT_TOKEN_CAP,
  MIGRATION_MAX_TOKEN_CAP,
  MIGRATION_MIN_TOKEN_CAP,
  ValidationError,
} from '@contentworker/domain';
import type { AIProvider, GenerateRequest, GenerateResult } from '@contentworker/ports';
import {
  FakeBlobStore,
  FakeSiteSource,
  InMemoryContentStore,
  InMemoryCostGuard,
} from '@contentworker/test-kit';
import { InProcessImportScriptSandbox } from '@contentworker/test-kit/import-script';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type AppContext,
  clusterPages,
  createMigrationRun,
  getMigrationRun,
  inventorySite,
  MIGRATION_AGENTS_PER_RUN,
  newTemplateAgentState,
  releaseAgentTokens,
  TEMPLATE_AGENT_LIMITS,
  type TemplateAgentState,
  templateAgentTurn,
} from '../src/index';
import { callReservation } from '../src/site-migration-tokens';

/** A run's token cap over its template agents: reserved before each call, settled after it. */

const scope = { spaceId: 'site', environmentId: 'main' };
const AT = new Date('2026-11-24T00:00:00.000Z');
const CAP = MIGRATION_MIN_TOKEN_CAP;
/** Reserved for an agent's first call: its prompt by size and its answer allowance. */
const FIRST = (state: TemplateAgentState) => state.call?.tokens ?? 0;

afterEach(() => {
  vi.useRealTimers();
});

/** The templates the agents author. */
async function templates(store: InMemoryContentStore, runId: string, n: number) {
  const at = AT.toISOString();
  await store.migrations.replaceTemplates(
    scope,
    runId,
    Array.from({ length: n }, (_, i) => `t${i}`).map((id) => ({
      template: {
        id,
        runId,
        label: id,
        status: 'pending' as const,
        pageCount: 1,
        samplePageIds: [],
        fingerprint: [],
        contentTypeId: null,
        script: null,
        proposal: null,
        lastTry: null,
        approvedBy: null,
        version: 1,
        createdAt: at,
        updatedAt: at,
      },
      pageIds: [],
    })),
    at,
  );
}

async function harness(agentTokenCap: number | null = CAP) {
  let n = 0;
  const clock = { at: AT.getTime(), now: () => new Date(clock.at) };
  const store = new InMemoryContentStore();
  const ctx: AppContext = { store, clock, ids: { newId: () => `id-${++n}` } };
  const deps = { blob: new FakeBlobStore(), sandbox: new InProcessImportScriptSandbox() };
  const run = await createMigrationRun(ctx, scope, {
    source: { kind: 'sitemap', url: 'https://site.test' },
    ...(agentTokenCap !== null ? { agentTokenCap } : {}),
  });
  await templates(store, run.id, 40);
  const agent = (templateId: string, over: Partial<TemplateAgentState> = {}) => ({
    ...newTemplateAgentState({
      scope,
      runId: run.id,
      templateId,
      startedBy: { kind: 'deployment' },
    }),
    ...over,
  });
  const tokens = async () => (await getMigrationRun(ctx, scope, run.id)).agentTokens;
  return { ctx, store, clock, deps, run, agent, tokens };
}

/** A model that asks for its template every turn, at a usage the test sets. */
class LoopingAI implements AIProvider {
  readonly requests: GenerateRequest[] = [];
  inFlight = 0;
  most = 0;
  constructor(
    private readonly usage: (req: GenerateRequest) => GenerateResult['usage'],
    private readonly gate?: () => Promise<void>,
  ) {}
  async generate(req: GenerateRequest): Promise<GenerateResult> {
    this.requests.push(req);
    this.inFlight += 1;
    this.most = Math.max(this.most, this.inFlight);
    await this.gate?.();
    this.inFlight -= 1;
    return {
      text: '',
      toolCalls: [{ id: `c${this.requests.length}`, name: 'get_template', input: {} }],
      usage: this.usage(req),
    };
  }
}

describe('a run’s token cap as it is created', () => {
  it('defaults to what the agents’ own limits add up to, and is refused outside its bounds', async () => {
    expect(MIGRATION_DEFAULT_TOKEN_CAP).toBe(
      MIGRATION_AGENTS_PER_RUN * TEMPLATE_AGENT_LIMITS.maxTokens,
    );
    const { ctx, tokens } = await harness(null);
    expect(await tokens()).toEqual({
      cap: MIGRATION_DEFAULT_TOKEN_CAP,
      spent: 0,
      reserved: 0,
      stoppedTemplateIds: [],
    });
    for (const agentTokenCap of [
      MIGRATION_MIN_TOKEN_CAP - 1,
      MIGRATION_MAX_TOKEN_CAP + 1,
      300_000.5,
      Number.NaN,
    ]) {
      await expect(
        createMigrationRun(ctx, scope, {
          source: { kind: 'sitemap', url: 'https://site.test' },
          agentTokenCap,
        }),
      ).rejects.toThrow(ValidationError);
    }
  });

  it('is in the view a clustering answers with', async () => {
    const { ctx, run } = await harness();
    const source = new FakeSiteSource({});
    await inventorySite(ctx, { source, blob: new FakeBlobStore() }, scope, run.id);
    expect((await clusterPages(ctx, scope, run.id)).agentTokens.cap).toBe(CAP);
  });
});

describe('agents running at once', () => {
  it('never hold or spend more than the cap between them', async () => {
    const { ctx, deps, agent, tokens } = await harness(400_000);
    let answer: () => void = () => {};
    const gate = new Promise<void>((r) => {
      answer = r;
    });
    const ai = new LoopingAI(
      () => ({ inputTokens: 9_000, outputTokens: 1_000 }),
      () => gate,
    );
    const turns = Array.from({ length: 40 }, (_, i) =>
      templateAgentTurn(ctx, { ...deps, ai }, agent(`t${i}`)),
    );
    await vi.waitFor(async () => expect(ai.inFlight).toBeGreaterThan(0));
    await vi.waitFor(async () => {
      const now = await tokens();
      expect(now.reserved).toBeGreaterThan(0);
      // Not one more fits.
      expect(now.reserved + now.reserved / ai.inFlight).toBeGreaterThan(now.cap);
    });
    const now = await tokens();
    expect(now.reserved).toBeLessThanOrEqual(now.cap);
    expect(ai.inFlight).toBeLessThan(40);
    answer();
    const states = await Promise.all(turns);
    // The rest wait for what the others hold, and aren't stopped by it.
    const held = states.filter((s) => s.retryAfterSeconds !== undefined);
    expect(held).toHaveLength(40 - ai.requests.length);
    expect(held.every((s) => s.status === 'running')).toBe(true);
    expect(await tokens()).toMatchObject({ spent: ai.requests.length * 10_000, reserved: 0 });
  });

  it('stop cleanly when the cap is reached, with nothing over it', async () => {
    const { ctx, deps, agent, tokens, store, run } = await harness(400_000);
    const ai = new LoopingAI(() => ({ inputTokens: 3_000, outputTokens: 4_000 }));
    let states = Array.from({ length: 8 }, (_, i) => agent(`t${i}`));
    for (let i = 0; i < 40 && states.some((s) => s.status === 'running'); i++) {
      states = await Promise.all(states.map((s) => templateAgentTurn(ctx, { ...deps, ai }, s)));
    }
    expect(states.every((s) => s.status === 'stopped')).toBe(true);
    expect(states[0]?.summary).toMatch(/token cap \(400000\).*authored by a person/);
    const now = await tokens();
    expect(now.spent).toBeLessThanOrEqual(now.cap);
    expect(now.spent).toBe(states.reduce((n, s) => n + s.tokens, 0));
    expect(now.reserved).toBe(0);
    expect([...now.stoppedTemplateIds].sort()).toEqual(states.map((s) => s.templateId));
    // The run is as it was: spending is no part of it.
    expect(await store.migrations.getRun(scope, run.id)).toEqual(run);
  });

  it('overshoot only by what calls in flight report beyond their reservations', async () => {
    const { ctx, deps, agent, tokens } = await harness(300_000);
    const over = 5_000;
    let reserved = 0;
    const ai = new LoopingAI((req) => {
      // A provider that counts more than the call could have taken.
      const bound = callReservation(agent('t0'), req);
      reserved = bound;
      return { inputTokens: bound + over - 100, outputTokens: 100 };
    });
    let states = Array.from({ length: 6 }, (_, i) => agent(`t${i}`));
    for (let i = 0; i < 40 && states.some((s) => s.status === 'running'); i++) {
      states = await Promise.all(states.map((s) => templateAgentTurn(ctx, { ...deps, ai }, s)));
    }
    expect(reserved).toBeGreaterThan(0);
    expect(states.every((s) => s.status === 'stopped')).toBe(true);
    const now = await tokens();
    expect(now.spent).toBeGreaterThan(now.cap - 60_000);
    // At most one call each, and at most the excess of each.
    expect(now.spent).toBeLessThanOrEqual(now.cap + states.length * over);
  });

  it('wait behind the space’s AI budget first, holding nothing meanwhile', async () => {
    const { ctx, deps, agent, tokens } = await harness();
    const guarded: AppContext = {
      ...ctx,
      costGuard: new InMemoryCostGuard({ maxRequests: 0, maxTokens: 1, windowSeconds: 60 }),
    };
    const ai = new LoopingAI(() => ({ inputTokens: 1, outputTokens: 1 }));
    const state = await templateAgentTurn(
      guarded,
      { ...deps, ai },
      // Past the cap already: the space's refusal still comes first.
      agent('t0', { tokens: CAP }),
    );
    expect(state).toMatchObject({ status: 'running', tokens: CAP });
    expect(state.retryAfterSeconds).toBeGreaterThan(0);
    expect(await tokens()).toMatchObject({ spent: 0, reserved: 0, stoppedTemplateIds: [] });
  });
});

describe('a call that doesn’t end as it should', () => {
  const answering = () => new LoopingAI(() => ({ inputTokens: 2_000, outputTokens: 500 }));

  it('cut short by an eviction is counted once, at its reservation, however often retried', async () => {
    const { ctx, deps, agent, tokens } = await harness();
    let begun: TemplateAgentState | undefined;
    const evicted: AIProvider = { generate: () => new Promise(() => {}) };
    void templateAgentTurn(ctx, { ...deps, ai: evicted }, agent('t0'), async (s) => {
      begun ??= s;
    });
    await vi.waitFor(() => expect(begun).toBeDefined());
    const stored = begun as TemplateAgentState;
    const lost = FIRST(stored);
    expect(await tokens()).toMatchObject({ spent: 0, reserved: lost });

    // It comes back from what it stored, twice (the first retry is cut short before its own call).
    const limited = vi
      .spyOn(ctx.store.migrations, 'reserveAgentTokens')
      .mockRejectedValueOnce(new Error('D1 is away'));
    await expect(templateAgentTurn(ctx, { ...deps, ai: answering() }, stored)).rejects.toThrow();
    limited.mockRestore();
    const next = await templateAgentTurn(ctx, { ...deps, ai: answering() }, stored);
    expect(next).toMatchObject({ turns: 1, tokens: 2_500, abandoned: lost, calls: 2 });
    expect(next.call).toBeUndefined();
    expect(await tokens()).toMatchObject({ spent: 2_500 + lost, reserved: 0 });
  });

  it('whose reservation’s answer was lost reserves once', async () => {
    const { ctx, store, deps, agent, tokens } = await harness();
    const real = store.migrations.reserveAgentTokens.bind(store.migrations);
    const spy = vi
      .spyOn(store.migrations, 'reserveAgentTokens')
      .mockImplementationOnce(async (...args) => {
        await real(...args);
        throw new Error('the answer was lost');
      });
    const ai = answering();
    const state = agent('t0');
    await expect(templateAgentTurn(ctx, { ...deps, ai }, state)).rejects.toThrow(/lost/);
    expect(ai.requests).toHaveLength(0);
    const held = (await tokens()).reserved;
    expect(held).toBeGreaterThan(0);
    const next = await templateAgentTurn(ctx, { ...deps, ai }, state);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(next).toMatchObject({ calls: 1, tokens: 2_500 });
    expect(await tokens()).toMatchObject({ spent: 2_500, reserved: 0 });

    // And one who stops instead lets go of it.
    spy.mockImplementationOnce(async (...args) => {
      await real(...args);
      throw new Error('the answer was lost');
    });
    const other = agent('t1');
    await expect(templateAgentTurn(ctx, { ...deps, ai }, other)).rejects.toThrow(/lost/);
    await releaseAgentTokens(ctx, other);
    expect(await tokens()).toMatchObject({ spent: 2_500, reserved: 0 });
  });

  /** Refuses every call, for longer than a reservation lasts. */
  const closed = (ctx: AppContext): AppContext => ({
    ...ctx,
    costGuard: {
      consume: async () => ({ allowed: false, reason: 'tokens', retryAfterSeconds: 3_600 }),
      settle: async () => {},
    } as never,
  });
  const losingTheAnswer = (store: InMemoryContentStore) => {
    const real = store.migrations.reserveAgentTokens.bind(store.migrations);
    vi.spyOn(store.migrations, 'reserveAgentTokens').mockImplementationOnce(async (...args) => {
      await real(...args);
      throw new Error('the answer was lost');
    });
  };

  it('whose reservation went unheard is never slept on past its lapse (an earlier wait)', async () => {
    const { ctx, store, deps, agent } = await harness();
    losingTheAnswer(store);
    let kept: TemplateAgentState = agent('t0', { timeouts: 6, retryAfterSeconds: 1_800 });
    await expect(
      templateAgentTurn(ctx, { ...deps, ai: answering() }, kept, async (s) => {
        kept = s;
      }),
    ).rejects.toThrow(/lost/);
    expect(kept).toMatchObject({ unsettled: true });
    expect(kept).not.toHaveProperty('calls');
    expect(kept).not.toHaveProperty('retryAfterSeconds');
  });

  it('whose reservation went unheard is let go of before a long budget refusal', async () => {
    const { ctx, store, deps, agent, tokens } = await harness();
    losingTheAnswer(store);
    let kept = agent('t0');
    await expect(
      templateAgentTurn(ctx, { ...deps, ai: answering() }, kept, async (s) => {
        kept = s;
      }),
    ).rejects.toThrow(/lost/);
    expect((await tokens()).reserved).toBeGreaterThan(0);
    // Not yet: the store is away, so it comes back well before the hold lapses.
    vi.spyOn(store.migrations, 'settleAgentTokens')
      .mockRejectedValueOnce(new Error('away'))
      .mockRejectedValueOnce(new Error('away'));
    kept = await templateAgentTurn(closed(ctx), { ...deps, ai: answering() }, kept);
    expect(kept).toMatchObject({ unsettled: true, retryAfterSeconds: 300 });
    kept = await templateAgentTurn(closed(ctx), { ...deps, ai: answering() }, kept);
    expect(kept.retryAfterSeconds).toBe(3_600);
    expect(kept).not.toHaveProperty('unsettled');
    expect(await tokens()).toMatchObject({ spent: 0, reserved: 0 });
  });

  it('granted as its timeout fires is let go of, and again in case it lands late', async () => {
    const { ctx, store, deps, agent, tokens } = await harness();
    vi.useFakeTimers();
    let land: () => Promise<unknown> = async () => {};
    const real = store.migrations.reserveAgentTokens.bind(store.migrations);
    vi.spyOn(store.migrations, 'reserveAgentTokens').mockImplementationOnce(
      (...args) =>
        new Promise((resolve) => {
          land = () => real(...args).then((r) => (resolve(r), r));
        }),
    );
    const turning = templateAgentTurn(
      ctx,
      { ...deps, ai: answering() },
      agent('t0', { timeouts: 6 }),
    );
    await vi.advanceTimersByTimeAsync(90_000);
    const held = await turning;
    expect(held).toMatchObject({ unsettled: true, retryAfterSeconds: 300 });
    expect(await land()).toBe('granted');
    expect((await tokens()).reserved).toBeGreaterThan(0);
    const next = await templateAgentTurn(closed(ctx), { ...deps, ai: answering() }, held);
    expect(next).not.toHaveProperty('unsettled');
    expect(await tokens()).toMatchObject({ spent: 0, reserved: 0 });
  });

  it('reserved just before an eviction is neither waited on nor kept through a refusal', async () => {
    const { ctx, store, deps, agent, tokens, run } = await harness();
    const at = AT.toISOString();
    const until = new Date(AT.getTime() + 600_000).toISOString();
    const orphan = (templateId: string) =>
      store.migrations.reserveAgentTokens(scope, run.id, {
        templateId,
        seq: 1,
        spent: 0,
        tokens: CAP - 10_000,
        at,
        until,
      });
    // Waiting before, evicted between the reservation and its record: its own hold isn't in its way.
    await orphan('t0');
    const went = await templateAgentTurn(
      ctx,
      { ...deps, ai: answering() },
      agent('t0', { waiting: true, retryAfterSeconds: 30 }),
    );
    expect(went).toMatchObject({ turns: 1, tokens: 2_500 });
    await store.migrations.settleAgentTokens(scope, run.id, {
      templateId: 't0',
      seq: 1,
      spent: 0,
      at,
    });
    // Evicted the same way, then refused by the space's budget for longer than the hold lasts.
    await orphan('t1');
    const refused = await templateAgentTurn(closed(ctx), { ...deps, ai: answering() }, agent('t1'));
    expect(refused.retryAfterSeconds).toBe(3_600);
    expect(await tokens()).toMatchObject({ spent: 0, reserved: 0 });
  });

  it('is not made at all in mock mode: no provider is called, and none counted', async () => {
    const { ctx, deps, agent, tokens } = await harness();
    const ai = answering();
    const done = await templateAgentTurn(
      { ...ctx, ai: { mode: 'mock' } as never },
      { ...deps, ai },
      agent('t0'),
    );
    expect(done).toMatchObject({ status: 'done', turns: 1, tokens: 0 });
    expect(ai.requests).toHaveLength(0);
    expect(await tokens()).toMatchObject({ spent: 0, reserved: 0 });
    // Live, the same turn reserves before the same provider hears of it.
    const reserve = vi.spyOn(ctx.store.migrations, 'reserveAgentTokens');
    await templateAgentTurn(
      { ...ctx, ai: { mode: 'live' } as never },
      { ...deps, ai },
      agent('t1'),
    );
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(ai.requests).toHaveLength(1);
  });

  it('never waits on a reservation of its own whose answer was lost', async () => {
    const { ctx, store, deps, agent, tokens } = await harness();
    const real = store.migrations.reserveAgentTokens.bind(store.migrations);
    vi.spyOn(store.migrations, 'reserveAgentTokens').mockImplementationOnce(async (...args) => {
      await real(...args);
      throw new Error('the answer was lost');
    });
    const ai = answering();
    let kept: TemplateAgentState = agent('t0', {
      waiting: true,
      retryAfterSeconds: 30,
      prompt: { tokens: CAP - 100_000, messages: 0, tier: 'flagship' },
    });
    // Holds most of the cap itself.
    kept = {
      ...kept,
      tier: 'balanced',
      messages: [{ role: 'user', content: 'x'.repeat(130_000) }],
    };
    await expect(
      templateAgentTurn(ctx, { ...deps, ai }, kept, async (s) => {
        kept = s;
      }),
    ).rejects.toThrow(/lost/);
    expect((await tokens()).reserved).toBeGreaterThan(CAP / 2);
    expect(kept).not.toHaveProperty('waiting');
    const next = await templateAgentTurn(ctx, { ...deps, ai }, kept);
    expect(next).toMatchObject({ turns: 1, tokens: 2_500 });
  });

  it('whose settlement was lost is settled by the next reservation', async () => {
    const { ctx, store, deps, agent, tokens } = await harness();
    vi.spyOn(store.migrations, 'settleAgentTokens').mockRejectedValueOnce(new Error('away'));
    const ai = answering();
    const one = await templateAgentTurn(ctx, { ...deps, ai }, agent('t0'));
    expect(one).toMatchObject({ turns: 1, tokens: 2_500 });
    expect((await tokens()).reserved).toBeGreaterThan(0);
    await templateAgentTurn(ctx, { ...deps, ai }, one);
    expect(await tokens()).toMatchObject({ spent: 5_000, reserved: 0 });

    // An agent that ends on it says so, for its host to tell the run again.
    vi.spyOn(store.migrations, 'settleAgentTokens').mockRejectedValueOnce(new Error('away'));
    const last: AIProvider = {
      generate: async () => ({ text: 'done', usage: { inputTokens: 10, outputTokens: 5 } }),
    };
    const done = await templateAgentTurn(ctx, { ...deps, ai: last }, agent('t1'));
    expect(done).toMatchObject({ status: 'done', unsettled: true, tokens: 15 });
    expect(await releaseAgentTokens(ctx, done)).not.toHaveProperty('unsettled');
    expect(await tokens()).toMatchObject({ spent: 5_015, reserved: 0 });

    // One held back by the space's budget tells it meanwhile, so nobody is stopped by it.
    vi.spyOn(store.migrations, 'settleAgentTokens').mockRejectedValueOnce(new Error('away'));
    const late = await templateAgentTurn(ctx, { ...deps, ai }, agent('t2'));
    expect(late.unsettled).toBe(true);
    const guarded: AppContext = {
      ...ctx,
      costGuard: new InMemoryCostGuard({ maxRequests: 0, maxTokens: 1, windowSeconds: 60 }),
    };
    const held = await templateAgentTurn(guarded, { ...deps, ai }, late);
    expect(held).not.toHaveProperty('unsettled');
    expect(await tokens()).toMatchObject({ spent: 7_515, reserved: 0 });
  });

  it('is counted as it ended when the space’s meter fails around it', async () => {
    const { ctx, deps, agent, tokens } = await harness();
    const metered: AppContext = {
      ...ctx,
      costGuard: {
        consume: async () => ({ allowed: true }) as never,
        settle: async () => {
          throw new Error('the meter is away');
        },
        usage: async () => ({}) as never,
      } as never,
    };
    const kept: TemplateAgentState[] = [];
    const turn = (id: string, ai: AIProvider) =>
      templateAgentTurn(metered, { ...deps, ai }, agent(id), async (s) => {
        kept.push(s);
      });
    await expect(turn('t0', answering())).rejects.toThrow('meter');
    expect(kept.at(-1)).toMatchObject({ tokens: 2_500 });
    const billed = Object.assign(new Error('cut off'), {
      usage: { inputTokens: 900, outputTokens: 100 },
    });
    await expect(
      turn('t1', {
        generate: async () => {
          throw billed;
        },
      }),
    ).rejects.toThrow('meter');
    expect(kept.at(-1)).toMatchObject({ tokens: 1_000 });
    vi.useFakeTimers();
    const hung = turn('t2', { generate: () => new Promise(() => {}) });
    const refused = expect(hung).rejects.toThrow('meter');
    await vi.advanceTimersByTimeAsync(90_000);
    await refused;
    const lost = kept.at(-1)?.abandoned ?? 0;
    expect(lost).toBeGreaterThan(8_000);
    expect(await tokens()).toMatchObject({ spent: 3_500 + lost, reserved: 0 });
  });

  it('that keeps timing out waits longer each time, and is the agent’s own to run out of', async () => {
    const { ctx, deps, agent } = await harness(null);
    vi.useFakeTimers();
    const hung: AIProvider = { generate: () => new Promise(() => {}) };
    const waits: (number | undefined)[] = [];
    let state: TemplateAgentState = agent('t0');
    for (let i = 0; i < 7; i++) {
      const turning = templateAgentTurn(ctx, { ...deps, ai: hung }, state);
      await vi.advanceTimersByTimeAsync(90_000);
      state = await turning;
      waits.push(state.retryAfterSeconds);
    }
    expect(waits).toEqual([60, 120, 240, 480, 960, 1_800, 1_800]);
    const answered = await templateAgentTurn(ctx, { ...deps, ai: answering() }, state);
    expect(answered).not.toHaveProperty('timeouts');
    const out = { ...state, abandoned: TEMPLATE_AGENT_LIMITS.maxTokens };
    const stopped = await templateAgentTurn(ctx, { ...deps, ai: hung }, out);
    expect(stopped).toMatchObject({ status: 'stopped', summary: expect.stringMatching(/budget/) });
  });

  it('strands nothing: a reservation nobody settles counts as spent, so nobody waits on it', async () => {
    const { ctx, clock, deps, agent, tokens, store, run } = await harness();
    await store.migrations.reserveAgentTokens(scope, run.id, {
      templateId: 'gone',
      seq: 1,
      spent: 0,
      tokens: CAP - 5_000,
      at: AT.toISOString(),
      until: new Date(AT.getTime() + 600_000).toISOString(),
    });
    const ai = answering();
    const waiting = await templateAgentTurn(ctx, { ...deps, ai }, agent('t0'));
    expect(waiting).toMatchObject({ status: 'running', retryAfterSeconds: 30 });
    // Waiting, it asks the space's budget for nothing.
    const consume = vi.fn(async () => ({ allowed: true }) as never);
    const metered = { ...ctx, costGuard: { consume, settle: async () => {} } as never };
    const still = await templateAgentTurn(metered, { ...deps, ai }, waiting);
    expect(still).toMatchObject({ status: 'running', retryAfterSeconds: 30 });
    expect(consume).not.toHaveBeenCalled();
    clock.at += 600_001;
    const stopped = await templateAgentTurn(ctx, { ...deps, ai }, still);
    expect(stopped.status).toBe('stopped');
    expect(await tokens()).toMatchObject({ spent: CAP - 5_000, reserved: 0 });
  });

  it('that failed before the model ran lets go; one billed or timed out is counted', async () => {
    const { ctx, deps, agent, tokens } = await harness();
    const kept: TemplateAgentState[] = [];
    const failing = (err: unknown): AIProvider => ({
      generate: async () => {
        throw err;
      },
    });
    const turn = (id: string, err: unknown) =>
      templateAgentTurn(ctx, { ...deps, ai: failing(err) }, agent(id), async (s) => {
        kept.push(s);
      });
    await expect(turn('t0', new Error('503'))).rejects.toThrow('503');
    expect(await tokens()).toMatchObject({ spent: 0, reserved: 0 });
    const billed = Object.assign(new Error('cut off'), {
      usage: { inputTokens: 900, outputTokens: 100 },
    });
    await expect(turn('t1', billed)).rejects.toThrow('cut off');
    expect(kept.at(-1)).toMatchObject({ tokens: 1_000, calls: 1 });
    expect(await tokens()).toMatchObject({ spent: 1_000, reserved: 0 });
    // The provider's own timeout: it may have been billed, and nothing says.
    await expect(
      turn('t2', Object.assign(new Error('timed out'), { reason: 'timeout' })),
    ).rejects.toThrow('timed out');
    const lost = kept.at(-1)?.abandoned ?? 0;
    expect(lost).toBeGreaterThan(8_000);
    expect(await tokens()).toMatchObject({ spent: 1_000 + lost, reserved: 0 });
  });

  it('that outlives its timeout counts at its reservation, and the agent goes on later', async () => {
    const { ctx, deps, agent, tokens } = await harness();
    vi.useFakeTimers();
    const hung: AIProvider = { generate: () => new Promise(() => {}) };
    const turning = templateAgentTurn(ctx, { ...deps, ai: hung }, agent('t0'));
    await vi.advanceTimersByTimeAsync(90_000);
    const state = await turning;
    expect(state).toMatchObject({ status: 'running', turns: 0, tokens: 0, retryAfterSeconds: 60 });
    expect(state.call).toBeUndefined();
    expect(await tokens()).toMatchObject({ spent: state.abandoned, reserved: 0 });
    expect(state.abandoned).toBeGreaterThan(8_000);
  });

  it('begins no model call when its reservation answers after the timeout', async () => {
    const { ctx, store, deps, agent, tokens } = await harness();
    vi.useFakeTimers();
    let grant: () => void = () => {};
    const real = store.migrations.reserveAgentTokens.bind(store.migrations);
    vi.spyOn(store.migrations, 'reserveAgentTokens').mockImplementationOnce(async (...args) => {
      await new Promise<void>((r) => {
        grant = r;
      });
      return real(...args);
    });
    const ai = answering();
    const recorded: TemplateAgentState[] = [];
    const turning = templateAgentTurn(ctx, { ...deps, ai }, agent('t0'), async (s) => {
      recorded.push(s);
    });
    await vi.advanceTimersByTimeAsync(90_000);
    const state = await turning;
    grant();
    await vi.advanceTimersByTimeAsync(1);
    expect(ai.requests).toHaveLength(0);
    expect(recorded.filter((s) => s.call)).toHaveLength(0);
    // Its late reservation is the next call's own: reserved once, settled once.
    await templateAgentTurn(ctx, { ...deps, ai }, state);
    expect(await tokens()).toMatchObject({ spent: 2_500, reserved: 0 });
  });

  it('whose provider reports no usage is counted at its reservation', async () => {
    const { ctx, deps, agent, tokens } = await harness();
    const ai = new LoopingAI(() => ({ inputTokens: 0, outputTokens: 0 }));
    const state = await templateAgentTurn(ctx, { ...deps, ai }, agent('t0'));
    expect(state.abandoned).toBeGreaterThan(8_000);
    expect(await tokens()).toMatchObject({ spent: state.abandoned, reserved: 0 });
  });

  it('counts a paid answer though a tool fails after it, and only once', async () => {
    const { ctx, store, deps, agent, tokens, run } = await harness();
    const recorded: TemplateAgentState[] = [];
    const ai = answering();
    // Its access check reads the template first; the tool's read is the one that fails.
    vi.spyOn(store.migrations, 'getTemplate')
      .mockResolvedValueOnce(await store.migrations.getTemplate(scope, run.id, 't0'))
      .mockRejectedValueOnce(new Error('D1 is away'));
    await expect(
      templateAgentTurn(ctx, { ...deps, ai }, agent('t0'), async (s) => {
        recorded.push(s);
      }),
    ).rejects.toThrow('D1 is away');
    const again = await templateAgentTurn(ctx, { ...deps, ai }, recorded.at(-1) as never);
    expect(again).toMatchObject({ turns: 1, tokens: 5_000, calls: 2 });
    expect(await tokens()).toMatchObject({ spent: 5_000, reserved: 0 });
  });

  it('counts an answer once when keeping it fails', async () => {
    const { ctx, deps, agent, tokens } = await harness();
    let n = 0;
    await expect(
      templateAgentTurn(ctx, { ...deps, ai: answering() }, agent('t0'), async () => {
        if (++n === 2) throw new Error('storage is away');
      }),
    ).rejects.toThrow('storage is away');
    expect(n).toBe(2);
    expect((await tokens()).spent).toBe(0);
    expect((await tokens()).reserved).toBeGreaterThan(0);
  });
});

describe('runs and agents from before caps', () => {
  it('have the default cap, counted from each agent’s own total at its next turn', async () => {
    const { ctx, store, deps, agent } = await harness();
    // As the code before caps creates a run: no cap named.
    const old = {
      ...(await createMigrationRun(ctx, scope, {
        source: { kind: 'sitemap', url: 'https://old.test' },
      })),
      id: 'old-run',
    };
    await store.migrations.createRun(scope, old);
    await templates(store, old.id, 1);
    const ai = new LoopingAI(() => ({ inputTokens: 2_000, outputTokens: 500 }));
    const midFlight = { ...agent('t0'), runId: 'old-run', turns: 9, tokens: 250_000 };
    const next = await templateAgentTurn(ctx, { ...deps, ai }, midFlight);
    expect(next).toMatchObject({ status: 'running', turns: 10, tokens: 252_500, calls: 1 });
    expect((await getMigrationRun(ctx, scope, 'old-run')).agentTokens).toEqual({
      cap: MIGRATION_DEFAULT_TOKEN_CAP,
      spent: 252_500,
      reserved: 0,
      stoppedTemplateIds: [],
    });
    // Rolled back: the older code's turns carry the new fields along and say nothing to the run.
    const rolledBack = { ...next, turns: 12, tokens: 300_000, call: { turn: 11, tokens: 9_999 } };
    const forward = await templateAgentTurn(ctx, { ...deps, ai }, rolledBack);
    expect(forward.abandoned).toBeUndefined();
    expect((await getMigrationRun(ctx, scope, 'old-run')).agentTokens.spent).toBe(302_500);
  });

  it('stops an agent whose template is gone before it reserves, letting go of what it held', async () => {
    const { ctx, store, deps, agent, tokens, run } = await harness();
    // Reserved, and evicted before it could record it; then clustered again.
    await store.migrations.reserveAgentTokens(scope, run.id, {
      templateId: 't39',
      seq: 1,
      spent: 0,
      tokens: 50_000,
      at: AT.toISOString(),
      until: new Date(AT.getTime() + 600_000).toISOString(),
    });
    await templates(store, run.id, 1);
    const reserve = vi.spyOn(store.migrations, 'reserveAgentTokens');
    const ai = new LoopingAI(() => ({ inputTokens: 1, outputTokens: 1 }));
    const state = await templateAgentTurn(ctx, { ...deps, ai }, agent('t39'));
    expect(state).toMatchObject({
      status: 'stopped',
      summary: 'Stopped: the template is gone',
    });
    expect(reserve).not.toHaveBeenCalled();
    expect(ai.requests).toHaveLength(0);
    expect(await tokens()).toMatchObject({ spent: 0, reserved: 0 });
  });

  it('stops an agent whose run is gone, calling nothing', async () => {
    const { ctx, store, deps, agent } = await harness();
    const ai = new LoopingAI(() => ({ inputTokens: 1, outputTokens: 1 }));
    // Its template still reads: the reservation is what finds no run.
    const none = await store.migrations.getTemplate(scope, agent('t0').runId, 't0');
    vi.spyOn(store.migrations, 'getTemplate').mockResolvedValue(none);
    const state = await templateAgentTurn(ctx, { ...deps, ai }, { ...agent('t0'), runId: 'none' });
    expect(state).toMatchObject({ status: 'stopped', summary: 'Stopped: the run is gone' });
    expect(ai.requests).toHaveLength(0);
  });
});

describe('what a call reserves', () => {
  it('is the last prompt and what was added since, and the whole prompt on another tier', async () => {
    const { agent } = await harness();
    const said = (n: number) => ({ role: 'user' as const, content: 'x'.repeat(n) });
    const messages = [said(100_000), said(20_000)];
    const req: GenerateRequest = { prompt: '', messages, maxTokens: 8_000 };
    const first = callReservation(agent('t0', { messages }), req);
    expect(first).toBeGreaterThan(120_000 + 8_000);
    const prompt = { tokens: 30_000, messages: 1, tier: 'balanced' as const };
    const grown = callReservation(agent('t0', { messages, prompt }), req);
    expect(grown).toBeGreaterThan(30_000 + 20_000 + 8_000);
    expect(grown).toBeLessThan(59_000);
    expect(callReservation(agent('t0', { messages, prompt, tier: 'flagship' }), req)).toBe(first);
    // Bytes, not characters: a script of many bytes a character is never under-counted.
    const wide: GenerateRequest = {
      ...req,
      messages: [{ role: 'user', content: '漢'.repeat(1_000) }],
    };
    expect(callReservation(agent('t0'), wide)).toBeGreaterThan(3_000 + 8_000);
  });
});
