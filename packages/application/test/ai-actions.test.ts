import { ForbiddenError, NotFoundError, type Principal, SCOPES } from '@contentworker/domain';
import {
  FixedClock,
  InMemoryContentStore,
  SequenceIdGenerator,
  StubAIProvider,
} from '@contentworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  createAIAction,
  createContentType,
  createEntry,
  createSpace,
  deleteAIAction,
  getEntry,
  listAIActions,
  renderTemplate,
  runAIAction,
  SYSTEM_CALLER,
  templateVariables,
} from '../src/index';

const scope = { spaceId: 'blog', environmentId: 'main' };

function setup() {
  const store = new InMemoryContentStore();
  const ctx: AppContext = { store, clock: new FixedClock(), ids: new SequenceIdGenerator('x') };
  return { ctx };
}

describe('template helpers', () => {
  it('extracts distinct variable names', () => {
    expect(templateVariables('Hi {{name}}, see {{field.title}} and {{name}}')).toEqual([
      'name',
      'field.title',
    ]);
  });
  it('renders known tokens and blanks unknown', () => {
    expect(renderTemplate('A {{x}} B {{y}}', { x: '1' })).toBe('A 1 B ');
  });
});

describe('AI Actions CRUD', () => {
  let ctx: AppContext;
  beforeEach(async () => {
    ({ ctx } = setup());
    await createSpace(ctx, { spaceId: 'blog', name: 'Blog', defaultLocale: 'en-US' });
  });

  it('creates an action and derives its variables', async () => {
    const action = await createAIAction(ctx, scope, {
      name: 'SEO title',
      promptTemplate: 'Write an SEO title for {{field.body}} aimed at {{audience}}.',
      targetField: 'title',
    });
    expect(action.variables.sort()).toEqual(['audience', 'field.body']);
    expect(action.tier).toBe('balanced');
    expect(await listAIActions(ctx, scope)).toHaveLength(1);
  });

  it('deletes an action', async () => {
    const a = await createAIAction(ctx, scope, { name: 'X', promptTemplate: 'hi' });
    await deleteAIAction(ctx, scope, a.id);
    expect(await listAIActions(ctx, scope)).toHaveLength(0);
  });
});

describe('runAIAction', () => {
  let ctx: AppContext;
  beforeEach(async () => {
    ({ ctx } = setup());
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
        {
          apiId: 'body',
          name: 'Body',
          type: 'Text',
          localized: false,
          required: false,
          position: 1,
        },
      ],
    });
  });

  it('renders the entry fields into the prompt and writes the target field on apply', async () => {
    const { entry } = await createEntry(ctx, scope, {
      contentTypeApiId: 'post',
      fields: { title: { 'en-US': 'Draft' }, body: { 'en-US': 'A post about cats.' } },
    });
    const action = await createAIAction(ctx, scope, {
      name: 'Retitle',
      promptTemplate: 'Title for: {{field.body}}',
      targetField: 'title',
    });
    let seenPrompt = '';
    const ai = new StubAIProvider((req) => {
      seenPrompt = req.prompt;
      return 'Cats: A Complete Guide';
    });
    const result = await runAIAction(ctx, ai, scope, action.id, { entryId: entry.id, apply: true });
    expect(seenPrompt).toContain('A post about cats.');
    expect(result.applied).toBe(true);
    const { fields } = await getEntry(ctx, scope, entry.id);
    expect(fields.title?.['en-US']).toBe('Cats: A Complete Guide');
  });

  it('runs standalone with manual variables (no entry)', async () => {
    const action = await createAIAction(ctx, scope, {
      name: 'Slogan',
      promptTemplate: 'Slogan for {{brand}}',
    });
    const ai = new StubAIProvider(() => 'Just do it');
    const result = await runAIAction(ctx, ai, scope, action.id, { variables: { brand: 'Acme' } });
    expect(result.output).toBe('Just do it');
    expect(result.applied).toBe(false);
  });

  it('throws for an unknown action', async () => {
    const ai = new StubAIProvider(() => 'x');
    await expect(runAIAction(ctx, ai, scope, 'nope')).rejects.toThrow(NotFoundError);
  });

  describe('for a restricted principal', () => {
    const grant = (actions: ('read' | 'write')[], contentTypeApiId = 'post'): Principal => ({
      spaceId: 'blog',
      kind: 'cma',
      scopes: [SCOPES.contentWrite],
      contentGrants: [{ contentTypeApiId, actions, deniedFields: ['body'] }],
    });
    const newPost = async () =>
      (
        await createEntry(ctx, scope, {
          contentTypeApiId: 'post',
          fields: { title: { 'en-US': 'Draft' }, body: { 'en-US': 'secret body' } },
        })
      ).entry.id;

    it('never renders a field the role denies, and the apply keeps it', async () => {
      const entryId = await newPost();
      const action = await createAIAction(ctx, scope, {
        name: 'Retitle',
        promptTemplate: 'Title for: {{field.title}} / {{field.body}}',
        targetField: 'title',
      });
      const ai = new StubAIProvider(() => 'New title');
      const result = await runAIAction(
        ctx,
        ai,
        scope,
        action.id,
        { entryId, apply: true },
        { principal: grant(['read', 'write']) },
      );
      expect(result.applied).toBe(true);
      expect(ai.requests[0]?.prompt).toBe('Title for: Draft / ');
      const { fields } = await getEntry(ctx, scope, entryId);
      expect(fields).toEqual({ title: { 'en-US': 'New title' }, body: { 'en-US': 'secret body' } });
    });

    it('refuses a run over a type the role can’t read, or an apply it can’t write', async () => {
      const entryId = await newPost();
      const action = await createAIAction(ctx, scope, {
        name: 'Retitle',
        promptTemplate: '{{field.title}}',
        targetField: 'title',
      });
      const ai = new StubAIProvider(() => 'x');
      await expect(
        runAIAction(ctx, ai, scope, action.id, { entryId }, { principal: grant(['read'], 'page') }),
      ).rejects.toThrow(ForbiddenError);
      await expect(
        runAIAction(
          ctx,
          ai,
          scope,
          action.id,
          { entryId, apply: true },
          { principal: grant(['read']) },
        ),
      ).rejects.toThrow('content:write:post');
      expect(ai.requests).toHaveLength(0);
      // A read-only run is the reader's to make.
      const dry = await runAIAction(
        ctx,
        ai,
        scope,
        action.id,
        { entryId },
        { principal: grant(['read']) },
      );
      expect(dry.applied).toBe(false);
    });

    it('refuses an action whose target field the role denies', async () => {
      const entryId = await newPost();
      const action = await createAIAction(ctx, scope, {
        name: 'Rebody',
        promptTemplate: '{{field.title}}',
        targetField: 'body',
      });
      const ai = new StubAIProvider(() => 'overwritten');
      await expect(
        runAIAction(
          ctx,
          ai,
          scope,
          action.id,
          { entryId, apply: true },
          { principal: grant(['read', 'write']) },
        ),
      ).rejects.toThrow('content:read:post.body');
      expect(ai.requests).toHaveLength(0);
      expect((await getEntry(ctx, scope, entryId)).fields.body).toEqual({
        'en-US': 'secret body',
      });
    });
  });
});
