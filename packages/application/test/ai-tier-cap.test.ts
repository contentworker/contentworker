import { type AiModelTier, type Principal, SCOPES } from '@contentworker/domain';
import {
  FixedClock,
  InMemoryContentStore,
  SequenceIdGenerator,
  StubAIProvider,
  StubDecisionModel,
} from '@contentworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  aiCapability,
  aiRuntimeConfig,
  createContentType,
  createSpace,
  decide,
  decideWithBudget,
  defaultAiPolicy,
  draftEntry,
  generateJson,
  generateWithBudget,
  readAiSettings,
  SYSTEM_CALLER,
  setAiSettings,
} from '../src/index';

/**
 * The deployment's tier cap (AI_MAX_TIER): every tier a call resolves to, from a request, a space's
 * settings or a call site's default, runs on at most the cap; the settings keep what was set and
 * report what it runs on.
 */
const scope = { spaceId: 'blog', environmentId: 'main' };
const admin: Principal = {
  kind: 'user',
  subject: 'ada@example.com',
  scopes: [SCOPES.spaceAdmin],
} as Principal;

async function setup(maxTier?: AiModelTier): Promise<AppContext> {
  const ctx: AppContext = {
    store: new InMemoryContentStore(),
    clock: new FixedClock(),
    ids: new SequenceIdGenerator('e'),
    ai: { mode: 'live', timeoutMs: 20_000, ...(maxTier ? { maxTier } : {}) },
  };
  await createSpace(ctx, { spaceId: 'blog', name: 'Blog', defaultLocale: 'en-US' });
  await createContentType(ctx, SYSTEM_CALLER, scope, {
    apiId: 'post',
    name: 'Post',
    displayField: 'title',
    fields: [
      {
        apiId: 'title',
        name: 'Title',
        type: 'Symbol',
        localized: false,
        required: true,
        position: 0,
      },
    ],
  });
  return ctx;
}

const draftAi = () => new StubAIProvider(() => ({ title: 'Drafted' }));

describe('AI_MAX_TIER', () => {
  it('parses: empty or flagship is no cap, a tier is the cap, anything else is refused', () => {
    expect(aiRuntimeConfig({}).maxTier).toBeUndefined();
    expect(aiRuntimeConfig({ AI_MAX_TIER: '' }).maxTier).toBeUndefined();
    expect(aiRuntimeConfig({ AI_MAX_TIER: 'flagship' }).maxTier).toBeUndefined();
    expect(aiRuntimeConfig({ AI_MAX_TIER: 'balanced' }).maxTier).toBe('balanced');
    expect(aiRuntimeConfig({ AI_MAX_TIER: ' fast ' }).maxTier).toBe('fast');
    expect(() => aiRuntimeConfig({ AI_MAX_TIER: 'cheap' })).toThrow(/AI_MAX_TIER must be one of/);
  });
});

describe('the tier cap, on every tier a call resolves to', () => {
  let ctx: AppContext;
  beforeEach(async () => {
    ctx = await setup('balanced');
  });

  it('holds a space’s tier above the cap to the cap', async () => {
    await setAiSettings(ctx, admin, 'blog', {
      expectedVersion: 0,
      capabilities: { drafting: { enabled: true, tier: 'flagship' } },
    });
    const ai = draftAi();
    await draftEntry(ctx, ai, scope, { contentTypeApiId: 'post', prompt: 'x' });
    expect(ai.requests[0]?.tier).toBe('balanced');
  });

  it('holds a request’s own tier to the cap, and leaves one under it alone', async () => {
    const ai = draftAi();
    await draftEntry(ctx, ai, scope, { contentTypeApiId: 'post', prompt: 'x', tier: 'flagship' });
    await draftEntry(ctx, ai, scope, { contentTypeApiId: 'post', prompt: 'x', tier: 'fast' });
    expect(ai.requests.map((r) => r.tier)).toEqual(['balanced', 'fast']);
  });

  it('holds a call site’s flagship default to the cap (page layouts, Coworker)', async () => {
    const layout = await aiCapability(ctx, scope, 'layout');
    expect(layout.tier('flagship')).toBe('balanced');
    expect(layout.tier('fast')).toBe('fast');
    // Coworker while the first space is set up reads no settings, and is still held to it.
    expect(defaultAiPolicy('assistant', 'fast').tier('flagship')).toBe('fast');
    expect(defaultAiPolicy('assistant').tier('flagship')).toBe('flagship');
  });

  it('holds a tier named outright (a workflow node, no policy) and records the one that answered', async () => {
    const ai = new StubAIProvider(() => ({ label: 'x' }));
    const r = await generateJson(
      ctx,
      ai,
      scope,
      { prompt: 'p', tier: 'flagship', maxTokens: 10, outputSchema: { type: 'object' } },
      { prompt: 'workflow.classify', fallback: () => ({ label: 'f' }) },
    );
    expect(ai.requests[0]?.tier).toBe('balanced');
    expect(r.tier).toBe('balanced');
  });

  it('holds every call at the budget wrapper too, generation and decisions alike', async () => {
    const tight = await setup('fast');
    const ai = new StubAIProvider(() => ({}));
    await generateWithBudget(tight, ai, scope, { prompt: 'p', tier: 'flagship', maxTokens: 5 });
    // No tier named means the adapter's default (balanced), which is above a fast cap.
    await generateWithBudget(tight, ai, scope, { prompt: 'p', maxTokens: 5 });
    expect(ai.requests.map((r) => r.tier)).toEqual(['fast', 'fast']);

    const model = new StubDecisionModel();
    const questions = { ok: { type: 'noul' as const, question: 'Is it?' } };
    await decideWithBudget(ctx, model, scope, { state: 's', questions, tier: 'flagship' });
    const r = await decide(
      ctx,
      model,
      scope,
      { state: 's', questions, tier: 'flagship' },
      { prompt: 'p', fallback: () => ({}) },
    );
    expect(model.requests.map((q) => q.tier)).toEqual(['balanced', 'balanced']);
    expect(r.tier).toBe('balanced');
  });

  it('changes nothing without a cap', async () => {
    const free = await setup();
    const ai = draftAi();
    await draftEntry(free, ai, scope, { contentTypeApiId: 'post', prompt: 'x', tier: 'flagship' });
    expect(ai.requests[0]?.tier).toBe('flagship');
  });
});

describe('the settings under a cap', () => {
  it('accepts a tier above the cap, keeps it, and reports the tier it runs on', async () => {
    const ctx = await setup('balanced');
    const res = await setAiSettings(ctx, admin, 'blog', {
      expectedVersion: 0,
      capabilities: {
        drafting: { enabled: true, tier: 'flagship' },
        translation: { enabled: true, tier: 'fast' },
      },
    });
    expect(res.settings.maxTier).toBe('balanced');
    expect(res.settings.capabilities.drafting).toMatchObject({
      tier: 'flagship',
      effectiveTier: 'balanced',
    });
    expect(res.settings.capabilities.translation).toMatchObject({
      tier: 'fast',
      effectiveTier: 'fast',
    });
    // Unset stays unset: each call site's default, held to the cap where it runs.
    expect(res.settings.capabilities.layout).toMatchObject({ tier: null, effectiveTier: null });
    expect((await readAiSettings(ctx, 'blog')).capabilities.drafting.tier).toBe('flagship');

    // The same space on a deployment without the cap runs what it chose.
    const free: AppContext = { ...ctx, ai: { mode: 'live', timeoutMs: 20_000 } };
    const view = await readAiSettings(free, 'blog');
    expect(view.maxTier).toBe('flagship');
    expect(view.capabilities.drafting.effectiveTier).toBe('flagship');
  });
});
