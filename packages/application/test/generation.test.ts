import { ValidationError } from '@contentworker/domain';
import {
  FixedClock,
  InMemoryContentStore,
  SequenceIdGenerator,
  StubAIProvider,
} from '@contentworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  agentUsage,
  createContentType,
  createSpace,
  draftEntry,
  listAgentRuns,
} from '../src/index.js';

const scope = { spaceId: 'shop', environmentId: 'main' };

function makeContext() {
  const store = new InMemoryContentStore();
  const ctx: AppContext = { store, clock: new FixedClock(), ids: new SequenceIdGenerator('e') };
  return { ctx };
}

async function seedArticle(ctx: AppContext) {
  await createSpace(ctx, { spaceId: 'shop', name: 'Shop', defaultLocale: 'en-US' });
  await createContentType(ctx, scope, {
    apiId: 'article',
    name: 'Article',
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
      {
        apiId: 'wordCount',
        name: 'Word count',
        type: 'Integer',
        localized: false,
        required: false,
        position: 1,
        validations: { range: { min: 0 } },
      },
    ],
  });
}

describe('P6: AI generation over the content model', () => {
  let ctx: AppContext;
  beforeEach(() => {
    ({ ctx } = makeContext());
  });

  it('builds a schema from the content type and returns validated draft fields', async () => {
    await seedArticle(ctx);
    const ai = new StubAIProvider(() => ({ title: 'A Generated Headline', wordCount: 850 }));

    const result = await draftEntry(ctx, ai, scope, {
      contentTypeApiId: 'article',
      prompt: 'Write about TS',
    });

    expect(result.fields.title?.['en-US']).toBe('A Generated Headline');
    expect(result.fields.wordCount?.['en-US']).toBe(850);
    // The request carried a strict JSON schema derived from the content type.
    const schema = ai.requests[0]?.outputSchema as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(Object.keys(schema.properties)).toEqual(['title', 'wordCount']);
    expect(schema.required).toContain('title');
  });

  it('rejects model output that violates the content model (validation gate)', async () => {
    await seedArticle(ctx);
    // Model returns a negative wordCount, violating the range validation.
    const ai = new StubAIProvider(() => ({ title: 'Bad', wordCount: -5 }));

    await expect(
      draftEntry(ctx, ai, scope, { contentTypeApiId: 'article', prompt: 'x' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('passes the requested tier through to the provider', async () => {
    await seedArticle(ctx);
    const ai = new StubAIProvider(() => ({ title: 'T', wordCount: 1 }));
    await draftEntry(ctx, ai, scope, {
      contentTypeApiId: 'article',
      prompt: 'x',
      tier: 'flagship',
    });
    expect(ai.requests[0]?.tier).toBe('flagship');
  });

  it('records a generation as an agent run for the cost ledger', async () => {
    await seedArticle(ctx);
    const ai = new StubAIProvider(() => ({ title: 'T', wordCount: 1 }));
    await draftEntry(ctx, ai, scope, { contentTypeApiId: 'article', prompt: 'x' });

    const runs = await listAgentRuns(ctx, scope);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.workflow).toBe('generate');
    const usage = await agentUsage(ctx, scope);
    expect(usage.runs).toBe(1);
    // StubAIProvider reports 10 in / 20 out.
    expect(usage.inputTokens).toBe(10);
    expect(usage.outputTokens).toBe(20);
  });
});
