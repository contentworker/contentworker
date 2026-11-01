import {
  NODE_SPECS,
  type Principal,
  type RunContext,
  SCOPES,
  withDefaults,
} from '@contentworker/domain';
import {
  FixedClock,
  InMemoryContentStore,
  RecordingEmailSender,
  RecordingWebhookSender,
  SequenceIdGenerator,
} from '@contentworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  createContentType,
  createEntry,
  createRelease,
  createSpace,
  createTag,
  executeWorkflowNode,
  INTERPRETED_NODE_TYPES,
  loadRunEntry,
  type NodeResult,
  resumeWorkflowNode,
  setEntryMetadata,
  WORKFLOW_COMPENSATIONS,
  WORKFLOW_EXECUTORS,
  type WorkflowNodeDeps,
} from '../src/index';

const scope = { spaceId: 'blog', environmentId: 'main' };
const editor: Principal = {
  spaceId: 'blog',
  kind: 'user',
  subject: 'editor@example.com',
  scopes: [SCOPES.contentWrite, SCOPES.contentPublish, SCOPES.previewRead],
};
const reader: Principal = { ...editor, subject: 'r@example.com', scopes: [SCOPES.previewRead] };
const noSummary: Principal = {
  ...editor,
  subject: 'ro@example.com',
  contentGrants: [
    {
      contentTypeApiId: 'post',
      actions: ['read', 'write', 'publish'],
      readOnlyFields: ['summary'],
    },
  ],
};

describe('workflow node executors', () => {
  let ctx: AppContext;
  let entryId: string;
  let email: RecordingEmailSender;
  let webhooks: RecordingWebhookSender;
  let deps: WorkflowNodeDeps;

  beforeEach(async () => {
    ctx = {
      store: new InMemoryContentStore(),
      clock: new FixedClock(new Date('2026-03-04T10:00:00.000Z')),
      ids: new SequenceIdGenerator('id'),
      ai: { mode: 'mock', timeoutMs: 1000 },
    };
    email = new RecordingEmailSender();
    webhooks = new RecordingWebhookSender();
    deps = { email, webhooks };
    await createSpace(ctx, { spaceId: 'blog', name: 'Blog', defaultLocale: 'en-US' });
    await createContentType(ctx, scope, {
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
          apiId: 'summary',
          name: 'Summary',
          type: 'Text',
          localized: false,
          required: false,
          position: 1,
        },
        {
          apiId: 'body',
          name: 'Body',
          type: 'Text',
          localized: false,
          required: false,
          position: 2,
        },
      ],
    });
    entryId = (
      await createEntry(ctx, scope, {
        contentTypeApiId: 'post',
        fields: { title: { 'en-US': 'Spring news' }, body: { 'en-US': 'A short news story.' } },
      })
    ).entry.id;
  });

  const exec = async (
    type: string,
    config: Record<string, unknown> = {},
    principal: Principal = editor,
    vars: Record<string, unknown> = {},
  ): Promise<NodeResult> => {
    const entry = await loadRunEntry(ctx, scope, entryId);
    const run: RunContext = { entry, nodes: {}, vars, input: {}, now: 0, ref: entry.title ?? '' };
    return executeWorkflowNode(ctx, deps, {
      scope,
      runId: 'run-1',
      workflowId: 'wf-1',
      entryId,
      actor: { id: principal.subject ?? principal.kind, principal },
      node: { id: 'n', type, label: 'Node', config, position: { x: 0, y: 0 } },
      run,
      effectKey: 'n#1',
      retriesLeft: false,
    });
  };

  it('covers the catalog: every node has an executor or runs in the interpreter', () => {
    for (const spec of NODE_SPECS) {
      const handled = spec.type in WORKFLOW_EXECUTORS || INTERPRETED_NODE_TYPES.includes(spec.type);
      expect(handled, spec.type).toBe(true);
      if ('rollback' in spec && spec.rollback) {
        expect(spec.type in WORKFLOW_COMPENSATIONS, spec.type).toBe(true);
      }
    }
  });

  it('triggers pass through', async () => {
    expect(await exec('trigger.manual')).toEqual({ summary: 'Started' });
  });

  it('content.validate and content.policy branch on the entry', async () => {
    expect((await exec('content.validate')).branches).toEqual(['valid']);
    const policy = await exec('content.policy', {
      rules: [
        { rule: 'required_fields', fields: ['title', 'summary'] },
        { rule: 'forbidden_terms', terms: ['news'] },
      ],
    });
    expect(policy.branches).toEqual(['fail']);
    expect(policy.summary).toMatch(/Missing required fields: summary.*forbidden terms: news/);
    expect((await exec('content.policy', { rules: 'nope' })).failed).toMatch(/not valid/);
  });

  it('content.publish / unpublish call the publish use-cases and are idempotent', async () => {
    const r = await exec('content.publish');
    expect(r.output).toEqual({ version: 1, previousVersion: null, publishedByRun: true });
    expect(r.entry?.publishedVersion).toBe(1);
    // Retried after its publish committed: no second publish.
    expect((await exec('content.publish')).output).toMatchObject({ publishedByRun: false });
    expect(
      (await ctx.store.outbox.readPending(50)).filter((e) => e.type === 'entry.published'),
    ).toHaveLength(1);
    expect((await exec('content.unpublish')).output).toEqual({ unpublished: true, version: 1 });
    expect((await exec('content.unpublish')).summary).toBe('Not published');
  });

  it('refuses effects the run’s principal lacks, as the API would', async () => {
    expect((await exec('content.publish', {}, reader)).failed).toMatch(/content:publish/);
    expect(
      (await exec('content.set_fields', { values: { summary: 'x' } }, noSummary)).failed,
    ).toMatch(/content:write:post.summary/);
    expect((await ctx.store.entries.get(scope, entryId))?.entry.publishedVersion).toBeNull();
  });

  it('content.schedule schedules once and its compensation cancels it', async () => {
    const r = await exec('content.schedule', { action: 'publish', after: '2 days' });
    expect(r.output).toMatchObject({ action: 'publish', scheduledFor: '2026-03-06T10:00:00.000Z' });
    await exec('content.schedule', { action: 'publish', after: '2 days' });
    expect(await ctx.store.scheduledActions.list(scope, { status: 'pending' })).toHaveLength(1);
    const undo = await WORKFLOW_COMPENSATIONS['content.schedule']?.({
      ctx,
      deps,
      scope,
      runId: 'run-1',
      entryId,
      nodeType: 'content.schedule',
      output: r.output,
      effectKey: 'n#1',
    });
    expect(undo).toBe('Cancelled the scheduled publish');
  });

  it('content.add_to_release / publish_release use the release use-cases', async () => {
    const release = await createRelease(ctx, scope, { title: 'Spring' });
    const added = await exec('content.add_to_release', { releaseId: release.id });
    expect(added.output).toEqual({ releaseId: release.id, wasMember: false });
    const shipped = await exec(
      'content.publish_release',
      { releaseId: '{{vars.releaseId}}' },
      editor,
      {
        releaseId: release.id,
      },
    );
    expect(shipped.output).toMatchObject({ published: true, entries: 1 });
    expect(shipped.entry?.publishedVersion).toBe(1);
  });

  it('content.set_fields interpolates, keeps prior values, and its compensation restores them', async () => {
    const r = await exec('content.set_fields', { values: { summary: 'About {{ref}}' } });
    expect(r.entry?.fields?.summary?.['en-US']).toBe('About Spring news');
    expect(r.output).toMatchObject({ prior: { summary: null }, version: 2 });
    await WORKFLOW_COMPENSATIONS['content.set_fields']?.({
      ctx,
      deps,
      scope,
      runId: 'run-1',
      entryId,
      nodeType: 'content.set_fields',
      output: r.output,
      effectKey: 'n#1',
    });
    expect((await ctx.store.entries.get(scope, entryId))?.fields.summary).toBeUndefined();
  });

  it('content.set_tags adds, removes and replaces by name', async () => {
    const legal = await createTag(ctx, scope, { name: 'legal' });
    await setEntryMetadata(ctx, scope, entryId, { tags: [legal.id] });
    const added = await exec('content.set_tags', { tags: ['reviewed'], mode: 'add' });
    expect(added.entry?.tags).toEqual(['legal', 'reviewed']);
    const removed = await exec('content.set_tags', { tags: ['legal'], mode: 'remove' });
    expect(removed.entry?.tags).toEqual(['reviewed']);
    const undo = await WORKFLOW_COMPENSATIONS['content.set_tags']?.({
      ctx,
      deps,
      scope,
      runId: 'run-1',
      entryId,
      nodeType: 'content.set_tags',
      output: removed.output,
      effectKey: 'n#1',
    });
    expect(undo).toBe('Restored the previous tags');
    expect((await loadRunEntry(ctx, scope, entryId)).tags).toEqual(['legal', 'reviewed']);
  });

  it('content.stage, assign and comment write the collaboration records', async () => {
    const stage = await exec('content.stage', { stepId: 'in_review', name: 'In review' });
    expect(stage.vars).toEqual({ stage: 'in_review' });
    expect(await ctx.store.workflows.getState(scope, entryId)).toMatchObject({
      currentStepId: 'in_review',
    });
    const assign = await exec('content.assign', {
      assignee: 'sam',
      title: 'Check “{{ref}}”',
      due: '1 day',
    });
    const taskId = (assign.output as { taskId: string }).taskId;
    expect((await ctx.store.tasks.get(scope, taskId))?.body).toBe(
      'Check “Spring news” (due 2026-03-05T10:00:00.000Z)',
    );
    await WORKFLOW_COMPENSATIONS['content.assign']?.({
      ctx,
      deps,
      scope,
      runId: 'run-1',
      entryId,
      nodeType: 'content.assign',
      output: assign.output,
      effectKey: 'n#1',
    });
    expect((await ctx.store.tasks.get(scope, taskId))?.status).toBe('resolved');
    const comment = await exec('content.comment', { body: 'Look at {{ref}}' });
    expect(comment.summary).toBe('Look at Spring news');
  });

  it('content.notify emails through the EmailSender with the effect key', async () => {
    const r = await exec('content.notify', { to: ['ed@example.com, {{vars.owner}}'] }, editor, {
      owner: 'owner@example.com',
    });
    expect(r.failed).toBeUndefined();
    expect(email.sent).toEqual([
      {
        to: ['ed@example.com', 'owner@example.com'],
        subject: '“Spring news” needs attention',
        text: '“Spring news” needs attention.',
        idempotencyKey: 'run-1:n#1',
      },
    ]);
    expect((await exec('content.notify', { to: ['not-an-address'] })).failed).toMatch(
      /not an email/,
    );
  });

  it('content.webhook posts an interpolated payload, refusing private targets', async () => {
    const r = await exec('content.webhook', { url: 'https://hooks.example.com/x' });
    expect(r.output).toEqual({ url: 'https://hooks.example.com/x', status: 200 });
    expect(webhooks.sent[0]?.event).toMatchObject({
      id: 'run-1:n#1',
      type: 'workflow.webhook',
      payload: { entryId, title: 'Spring news' },
    });
    expect((await exec('content.webhook', { url: 'http://127.0.0.1/x' })).failed).toMatch(
      /private/,
    );
  });

  it('control.condition and control.set evaluate JSON Logic', async () => {
    const cond = await exec('control.condition', {
      expression: { '==': [{ var: 'entry.title' }, 'Spring news'] },
    });
    expect(cond.branches).toEqual(['true']);
    const set = await exec('control.set', { assign: { next_cycle: { '+': [1, 1] } } });
    expect(set).toMatchObject({ vars: { next_cycle: 2 }, summary: 'Next cycle 2' });
  });

  it('AI nodes answer from the heuristic in mock mode, with provenance', async () => {
    const classify = await exec('ai.classify', { labels: ['opinion', 'news'], into: 'kind' });
    expect(classify.vars).toEqual({ kind: 'news' });
    expect(classify.output).toMatchObject({ source: 'heuristic', fallback: 'mock' });

    const router = await exec('ai.router', { routes: ['publish', 'needs_review'] });
    // Mock mode is an expected fallback, so the router isn't failed closed.
    expect(router.branches).toEqual(['publish']);

    const moderate = await exec('ai.moderate');
    expect(moderate.branches).toEqual(['clean']);

    const summary = await exec('ai.summarize');
    expect(summary.vars).toEqual({ summary: 'Spring news' });

    const assess = await exec('ai.assess', withDefaults('ai.assess', {}));
    expect(['yes', 'no']).toContain(assess.branches?.[0]);
    expect(assess.vars?.assessment).toBeDefined();

    for (const type of ['ai.translate', 'ai.autofill', 'ai.suggest_tags']) {
      const r = await exec(type, { targetLocale: 'de-DE', field: 'summary' });
      expect(r.output, type).toMatchObject({ source: 'heuristic', fallback: 'mock' });
    }
  });

  it('gating AI nodes fail closed when the model is unavailable outside mock mode', async () => {
    ctx = { ...ctx, ai: { mode: 'live', timeoutMs: 1000 } };
    deps = {
      ...deps,
      ai: {
        async generate() {
          throw new Error('provider down');
        },
      },
    };
    expect((await exec('ai.moderate')).branches).toEqual(['flagged']);
    expect((await exec('ai.router', { routes: ['publish', 'needs_review'] })).branches).toEqual([
      'needs_review',
    ]);
    const assess = await exec('ai.assess', {
      ...withDefaults('ai.assess', {}),
      minConfidence: 0.5,
    });
    expect(assess.branches).toEqual(['unsure']);
  });

  it('ai.enrich proposes a review to wait on, and resumes by the review’s decision', async () => {
    ctx = { ...ctx, ai: { mode: 'live', timeoutMs: 1000 } };
    deps = {
      ...deps,
      ai: {
        async generate() {
          return {
            text: '',
            object: { summary: 'Short' },
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        },
      },
    };
    const r = await exec('ai.enrich', { awaitReview: true });
    expect(r.wait).toMatchObject({ kind: 'review', requiredScope: 'content:write' });
    const reviewId = r.wait?.reviewId as string;
    await ctx.store.agentReviews.decide(scope, reviewId, {
      status: 'rejected',
      decidedAt: ctx.clock.now().toISOString(),
    });
    const entry = await loadRunEntry(ctx, scope, entryId);
    const resumed = await resumeWorkflowNode(ctx, deps, {
      scope,
      runId: 'run-1',
      workflowId: 'wf-1',
      entryId,
      actor: { id: 'editor@example.com', principal: editor },
      node: { id: 'n', type: 'ai.enrich', label: 'Enrich', config: {}, position: { x: 0, y: 0 } },
      run: { entry, nodes: {}, vars: {}, input: {}, now: 0, ref: '' },
      effectKey: 'n#1',
      retriesLeft: false,
      before: r,
      payload: { decision: 'rejected', by: 'ed' },
    });
    expect(resumed.branches).toEqual(['rejected']);

    const applied = await exec('ai.enrich', { awaitReview: false });
    expect(applied.branches).toEqual(['applied']);
    expect(applied.entry?.fields?.summary?.['en-US']).toBe('Short');
  });
});
