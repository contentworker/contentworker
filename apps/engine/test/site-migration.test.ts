import {
  env,
  introspectWorkflowInstance,
  runDurableObjectAlarm,
  runInDurableObject,
} from 'cloudflare:test';
import {
  type AppContext,
  approveMigrationPublish,
  approveTemplate,
  clusterPages,
  createMigrationRun,
  fetchSourcePages,
  inventorySite,
  migrationDriver,
  proposeTemplateModel,
  reopenTemplate,
  setImportScript,
  templateReviewDigest,
} from '@contentworker/application';
import {
  type ContentTypeDraft,
  MigrationClusteringHeldError,
  MigrationDriverFinishedError,
  NotFoundError,
  scopesForKind,
} from '@contentworker/domain';
import {
  CloudflareMigrationRunner,
  migrationInstanceId,
  templateAgentName,
} from '@contentworker/platform/site-migration';
import type {
  AIProvider,
  GenerateRequest,
  GenerateResult,
  ImportScriptRun,
  ImportScriptSandbox,
  ToolCall,
} from '@contentworker/ports';
import {
  FakeBlobStore,
  FakeRemoteFetcher,
  FakeSiteSource,
  InMemoryContentStore,
  SequenceIdGenerator,
} from '@contentworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import { migrationTestState } from './fixtures/migration';

// Miniflare's real Workflows engine driving a site migration run, and a real Durable Object
// running a template agent's loop on its alarms. The site, the sandbox (Worker Loader can't run
// in the pool) and the model are fakes; the store is the test's in-memory one.

const O = 'https://site.test';
const article = (title: string) =>
  `<html><body><main><article><h1>${title}</h1><div class="body"><p>${title} text here.</p></div></article></main></body></html>`;
const SITE: Record<string, string> = {
  [`${O}/blog/one`]: article('One'),
  [`${O}/blog/two`]: article('Two'),
};
const MODEL: ContentTypeDraft = {
  apiId: 'post',
  name: 'Post',
  displayField: 'title',
  urlPattern: '/blog/{slug}',
  fields: [
    {
      apiId: 'title',
      name: 'Title',
      type: 'Symbol',
      localized: false,
      required: true,
      position: 0,
    },
    { apiId: 'slug', name: 'Slug', type: 'Slug', localized: false, required: true, position: 1 },
    {
      apiId: 'body',
      name: 'Body',
      type: 'Array',
      localized: false,
      required: false,
      position: 2,
      items: {
        type: 'Component',
        variants: [
          {
            apiId: 'text',
            name: 'Text',
            fields: [
              {
                apiId: 'text',
                name: 'Text',
                type: 'Text',
                localized: false,
                required: false,
                position: 0,
              },
            ],
          },
        ],
      },
    },
  ],
};

/** A sandbox that answers as the script would: the page's heading and paragraph. */
const sandbox: ImportScriptSandbox = {
  async run(input: ImportScriptRun) {
    const title = /<h1>(.*?)<\/h1>/.exec(input.page.html)?.[1] ?? '';
    const text = /<p>(.*?)<\/p>/.exec(input.page.html)?.[1] ?? '';
    return {
      ok: true,
      output: {
        fields: { title, slug: input.page.url.split('/').pop() },
        blocks: [{ variant: 'text', fields: { text } }],
        assets: [],
        links: [],
      },
      logs: [],
    };
  },
};

let seq = 0;

function context(): { ctx: AppContext; scope: { spaceId: string; environmentId: string } } {
  seq += 1;
  const store = new InMemoryContentStore();
  store.seedSpace({ spaceId: `mig${seq}`, defaultLocale: 'en-US', locales: ['en-US'] });
  const ctx: AppContext = {
    store,
    clock: { now: () => new Date() },
    ids: new SequenceIdGenerator(`mig${seq}`),
  };
  migrationTestState.ctx = ctx;
  migrationTestState.blob = new FakeBlobStore();
  migrationTestState.source = new FakeSiteSource(SITE);
  migrationTestState.sandbox = sandbox;
  migrationTestState.started = [];
  migrationTestState.fetcher = new FakeRemoteFetcher();
  return { ctx, scope: { spaceId: `mig${seq}`, environmentId: 'main' } };
}

describe('MigrationWorkflow on Cloudflare Workflows', () => {
  beforeEach(() => {
    migrationTestState.ai = undefined;
  });

  it('runs inventory to publish, waiting for the template’s approval and the go-ahead', async () => {
    const { ctx, scope } = context();
    const run = await createMigrationRun(ctx, scope, { source: { kind: 'sitemap', url: O } });
    const runner = new CloudflareMigrationRunner(env.MIGRATION_WF);
    const params = { scope, runId: run.id, startedBy: { kind: 'deployment' as const } };

    await using instance = await introspectWorkflowInstance(
      env.MIGRATION_WF,
      migrationInstanceId(run.id),
    );
    expect(await runner.start(params)).toBe('started');
    // A second start (a retried request) finds the driver that exists.
    expect(await runner.start(params)).toBe('running');
    const clustered = (await instance.waitForStepResult({ name: 'cluster' })) as {
      ok: { id: string }[];
    };
    const templateId = clustered.ok[0]?.id as string;
    expect(templateId).toBeTruthy();
    await instance.waitForStepResult({ name: `start agent ${templateId}` });
    expect(migrationTestState.started).toEqual([templateId]);

    // The agent's work and a person's approval, then the approval's event.
    const ref = { runId: run.id, templateId };
    const blob = migrationTestState.blob as FakeBlobStore;
    await proposeTemplateModel(ctx, scope, { ...ref, model: MODEL });
    await setImportScript(ctx, { blob }, scope, { ...ref, script: 'export default () => ({})' });
    const authored = await ctx.store.migrations.getTemplate(scope, run.id, templateId);
    await approveTemplate(
      ctx,
      { spaceId: scope.spaceId, kind: 'admin', scopes: scopesForKind('cma') },
      scope,
      { ...ref, reviewed: templateReviewDigest(authored as never) },
    );
    await runner.templateApproved(scope, run.id, templateId, {});
    await instance.waitForStepResult({ name: 'relink 0' });
    expect((await ctx.store.migrations.countPages(scope, run.id)).byStage).toEqual({ loaded: 2 });

    await runner.publishApproved(scope, run.id, { approvedBy: { kind: 'deployment' } });
    await instance.waitForStatus('complete');
    expect(await instance.getOutput()).toMatchObject({
      status: 'published',
      templates: [{ templateId, status: 'loaded' }],
    });
    expect((await ctx.store.migrations.countPages(scope, run.id)).byStage).toEqual({
      published: 2,
    });
  });
});

describe('MigrationWorkflow and clustering again', () => {
  async function clusteredByHand() {
    const { ctx, scope } = context();
    const run = await createMigrationRun(ctx, scope, { source: { kind: 'sitemap', url: O } });
    const { blob, source } = migrationTestState as Required<typeof migrationTestState>;
    await inventorySite(ctx, { blob, source }, scope, run.id);
    while ((await fetchSourcePages(ctx, { blob, source }, scope, run.id)).more) {}
    await clusterPages(ctx, scope, run.id);
    const recluster = () => clusterPages(ctx, scope, run.id);
    const ids = async () =>
      (await ctx.store.migrations.listTemplates(scope, run.id)).map((t) => t.id);
    const params = { scope, runId: run.id, startedBy: { kind: 'deployment' as const } };
    const runner = new CloudflareMigrationRunner(env.MIGRATION_WF);
    return { ctx, scope, run, recluster, ids, params, runner };
  }

  it('takes the templates made by hand last, then refuses another grouping, restarted or terminated', async () => {
    const h = await clusteredByHand();
    const { templates } = await h.recluster();
    await using instance = await introspectWorkflowInstance(
      env.MIGRATION_WF,
      migrationInstanceId(h.run.id),
    );
    await h.runner.start(h.params);
    const taken = (await instance.waitForStepResult({ name: 'cluster' })) as {
      ok: { id: string }[];
    };
    expect(taken.ok.map((t) => t.id)).toEqual(templates.map((t) => t.id));
    await expect(h.recluster()).rejects.toThrow(MigrationClusteringHeldError);
    expect(await h.ids()).toEqual(templates.map((t) => t.id));

    // Run from its first step again, it takes the same templates.
    const driver = await env.MIGRATION_WF.get(migrationInstanceId(h.run.id));
    await instance.waitForStepResult({ name: `start agent ${templates[0]?.id}` });
    migrationTestState.started = [];
    await driver.restart();
    await expect
      .poll(() => migrationTestState.started, { timeout: 10_000 })
      .toEqual(templates.map((t) => t.id));

    // Ended with nothing recorded on the run: the grouping is kept, and its templates authored.
    await driver.terminate();
    await instance.waitForStatus('terminated');
    expect((await h.ctx.store.migrations.getRun(h.scope, h.run.id))?.status).toBe('clustered');
    await expect(h.recluster()).rejects.toThrow(MigrationClusteringHeldError);
    const ref = { runId: h.run.id, templateId: templates[0]?.id as string };
    await expect(
      proposeTemplateModel(h.ctx, h.scope, { ...ref, model: MODEL }),
    ).resolves.toMatchObject({ status: 'authoring' });
  });

  it('goes on from a clustering recorded before there was a hold', async () => {
    const h = await clusteredByHand();
    const [templateId] = await h.ids();
    await using instance = await introspectWorkflowInstance(
      env.MIGRATION_WF,
      migrationInstanceId(h.run.id),
    );
    await instance.modify(async (m) => {
      await m.mockStepResult(
        { name: 'cluster' },
        { ok: [{ id: templateId, status: 'pending', held: false }] },
      );
    });
    await h.runner.start(h.params);
    await instance.waitForStepResult({ name: `start agent ${templateId}` });
    expect(migrationTestState.started).toEqual([templateId]);
    // Its step never runs again, so nothing holds the run; a template being authored does.
    expect((await h.ctx.store.migrations.getRun(h.scope, h.run.id))?.clusteringHeldAt).toBeNull();
    const ref = { runId: h.run.id, templateId: templateId as string };
    await proposeTemplateModel(h.ctx, h.scope, { ...ref, model: MODEL });
    await expect(h.recluster()).rejects.toThrow('already being authored');
    await (await env.MIGRATION_WF.get(migrationInstanceId(h.run.id))).terminate();
  });
});

describe('MigrationWorkflow with a template reopened', () => {
  it('waits again, takes each version approved again through, and completes with waits open', async () => {
    const { ctx, scope } = context();
    const run = await createMigrationRun(ctx, scope, { source: { kind: 'sitemap', url: O } });
    const runner = new CloudflareMigrationRunner(env.MIGRATION_WF);
    const editor = {
      spaceId: scope.spaceId,
      kind: 'admin' as const,
      scopes: scopesForKind('cma'),
    };
    await using instance = await introspectWorkflowInstance(
      env.MIGRATION_WF,
      migrationInstanceId(run.id),
    );
    await runner.start({
      scope,
      runId: run.id,
      startedBy: { kind: 'deployment' },
      recorded: true,
    });
    const clustered = (await instance.waitForStepResult({ name: 'cluster' })) as {
      ok: { id: string }[];
    };
    const templateId = clustered.ok[0]?.id as string;
    const ref = { runId: run.id, templateId };
    const blob = migrationTestState.blob as FakeBlobStore;
    const reviewed = async () => {
      const t = await ctx.store.migrations.getTemplate(scope, run.id, templateId);
      return { ...ref, reviewed: templateReviewDigest(t as never) };
    };
    await proposeTemplateModel(ctx, scope, { ...ref, model: MODEL });
    await setImportScript(ctx, { blob }, scope, { ...ref, script: 'export default () => ({})' });
    // Approved and reopened before the driver looks: its event finds nothing to act on.
    await approveTemplate(ctx, editor, scope, await reviewed());
    await reopenTemplate(ctx, editor, scope, await reviewed());
    await runner.templateApproved(scope, run.id, templateId, {});
    await instance.waitForStepResult({ name: `approver ${templateId}` });
    expect((await ctx.store.migrations.countPages(scope, run.id)).byStage).toEqual({
      clustered: 2,
    });

    await setImportScript(ctx, { blob }, scope, {
      ...ref,
      script: 'export default () => ({ a: 1 })',
    });
    await approveTemplate(ctx, editor, scope, await reviewed());
    await runner.templateApproved(scope, run.id, templateId, {});
    await instance.waitForStepResult({ name: `load ${templateId} 0 round 2` });
    await instance.waitForStepResult({ name: 'relink 0' });
    expect((await ctx.store.migrations.countPages(scope, run.id)).byStage).toEqual({ loaded: 2 });

    // Reopened and approved again while it waits for the go-ahead: the next round hears of it.
    await reopenTemplate(ctx, editor, scope, await reviewed());
    await setImportScript(ctx, { blob }, scope, {
      ...ref,
      script: 'export default () => ({ a: 2 })',
    });
    await approveTemplate(ctx, editor, scope, await reviewed());
    await runner.templateApproved(scope, run.id, templateId, {});
    await instance.waitForStepResult({ name: `redirects ${templateId} round 3` });

    await runner.publishApproved(scope, run.id, { approvedBy: { kind: 'deployment' } });
    await instance.waitForStatus('complete');
    expect(await instance.getOutput()).toMatchObject({
      status: 'published',
      templates: [{ templateId, status: 'loaded' }],
    });
    expect((await ctx.store.migrations.countPages(scope, run.id)).byStage).toEqual({
      published: 2,
    });
  });
});

describe('MigrationWorkflow’s go-ahead', () => {
  /** A run driven to its wait for the go-ahead. */
  async function waiting() {
    const { ctx, scope } = context();
    const run = await createMigrationRun(ctx, scope, { source: { kind: 'sitemap', url: O } });
    const runner = new CloudflareMigrationRunner(env.MIGRATION_WF);
    const editor = { spaceId: scope.spaceId, kind: 'admin' as const, scopes: scopesForKind('cma') };
    const instance = await introspectWorkflowInstance(
      env.MIGRATION_WF,
      migrationInstanceId(run.id),
    );
    expect(await runner.status(scope, run.id)).toBe('none');
    await runner.start({
      scope,
      runId: run.id,
      startedBy: { kind: 'deployment' },
      recorded: true,
    });
    const clustered = (await instance.waitForStepResult({ name: 'cluster' })) as {
      ok: { id: string }[];
    };
    const ref = { runId: run.id, templateId: clustered.ok[0]?.id as string };
    const blob = migrationTestState.blob as FakeBlobStore;
    await proposeTemplateModel(ctx, scope, { ...ref, model: MODEL });
    await setImportScript(ctx, { blob }, scope, { ...ref, script: 'export default () => ({})' });
    const t = await ctx.store.migrations.getTemplate(scope, run.id, ref.templateId);
    await approveTemplate(ctx, editor, scope, {
      ...ref,
      reviewed: templateReviewDigest(t as never),
    });
    await runner.templateApproved(scope, run.id, ref.templateId, {});
    await instance.waitForStepResult({ name: 'relink 0' });
    const read = async () => {
      const r = await ctx.store.migrations.getRun(scope, run.id);
      return migrationDriver(runner, editor, scope, r as NonNullable<typeof r>);
    };
    return { ctx, scope, run, runner, editor, instance, read };
  }

  it('is given once and taken from the run; its event told again is dropped', async () => {
    const { ctx, scope, run, runner, editor, instance, read } = await waiting();
    await using _ = instance;
    expect(await read()).toMatchObject({
      state: expect.stringMatching(/^(running|waiting)$/),
      startedBy: { kind: 'deployment' },
      goAhead: { status: 'none' },
    });
    const given = { runId: run.id, viaRelease: true };
    expect(await approveMigrationPublish(ctx, runner, editor, scope, given)).toEqual({
      signalled: true,
    });
    // Sent twice over, and once as something else: only what the run holds is done.
    await runner
      .publishApproved(scope, run.id, { approvedBy: { kind: 'deployment' }, recorded: true })
      .catch(() => undefined);
    await instance.waitForStatus('complete');
    expect(await instance.getOutput()).toMatchObject({ status: 'published' });
    expect((await ctx.store.migrations.countPages(scope, run.id)).byStage).toEqual({ loaded: 2 });
    expect((await ctx.store.migrations.getRun(scope, run.id))?.releaseId).toBeTruthy();
    expect(await read()).toMatchObject({
      state: 'finished',
      goAhead: { status: 'given', viaRelease: true, delivered: true },
    });
    // Told again after it finished, by the one who gave it: answered, as it was.
    expect(await approveMigrationPublish(ctx, runner, editor, scope, given)).toEqual({
      signalled: true,
    });
  });

  it('takes one an api from before they were recorded sent, and records it', async () => {
    const { ctx, scope, run, runner, instance } = await waiting();
    await using _ = instance;
    await runner.publishApproved(scope, run.id, { approvedBy: { kind: 'deployment' } });
    await instance.waitForStatus('complete');
    expect(await instance.getOutput()).toMatchObject({ status: 'published' });
    expect((await ctx.store.migrations.getRun(scope, run.id))?.goAhead).toMatchObject({
      approvedBy: { kind: 'deployment' },
      target: {},
      deliveredAt: expect.any(String),
    });
    expect((await ctx.store.migrations.countPages(scope, run.id)).byStage).toEqual({
      published: 2,
    });
  });

  it('publishes one it was never told of when its wait runs out', async () => {
    const { ctx, scope } = context();
    const run = await createMigrationRun(ctx, scope, { source: { kind: 'sitemap', url: O } });
    const runner = new CloudflareMigrationRunner(env.MIGRATION_WF);
    const editor = { spaceId: scope.spaceId, kind: 'admin' as const, scopes: scopesForKind('cma') };
    await using instance = await introspectWorkflowInstance(
      env.MIGRATION_WF,
      migrationInstanceId(run.id),
    );
    await instance.modify(async (m) => {
      await m.forceEventTimeout({ name: 'publish approval' });
    });
    await runner.start({
      scope,
      runId: run.id,
      startedBy: { kind: 'deployment' },
      recorded: true,
    });
    const clustered = (await instance.waitForStepResult({ name: 'cluster' })) as {
      ok: { id: string }[];
    };
    const ref = { runId: run.id, templateId: clustered.ok[0]?.id as string };
    const blob = migrationTestState.blob as FakeBlobStore;
    await proposeTemplateModel(ctx, scope, { ...ref, model: MODEL });
    await setImportScript(ctx, { blob }, scope, { ...ref, script: 'export default () => ({})' });
    const t = await ctx.store.migrations.getTemplate(scope, run.id, ref.templateId);
    await approveTemplate(ctx, editor, scope, {
      ...ref,
      reviewed: templateReviewDigest(t as never),
    });
    const mute = {
      start: runner.start.bind(runner),
      templateApproved: runner.templateApproved.bind(runner),
      status: runner.status.bind(runner),
      publishApproved: async () => {
        throw new Error('unreachable');
      },
    };
    expect(await approveMigrationPublish(ctx, mute, editor, scope, { runId: run.id })).toEqual({
      signalled: false,
      reason: 'unreachable',
    });
    await runner.templateApproved(scope, run.id, ref.templateId, {});
    await instance.waitForStatus('complete');
    expect(await instance.getOutput()).toMatchObject({ status: 'published' });
  });
});

describe('CloudflareMigrationRunner', () => {
  it('answers a run with no driver as not found, for either signal', async () => {
    const runner = new CloudflareMigrationRunner(env.MIGRATION_WF);
    const scope = { spaceId: 'mig-none', environmentId: 'main' };
    await expect(
      runner.publishApproved(scope, 'never-started', { approvedBy: { kind: 'deployment' } }),
    ).rejects.toThrow(NotFoundError);
    await expect(runner.templateApproved(scope, 'never-started', 't', {})).rejects.toThrow(
      NotFoundError,
    );
  });

  it('reports a finished driver as finished, and refuses to signal it', async () => {
    const { ctx, scope } = context();
    const run = await createMigrationRun(ctx, scope, { source: { kind: 'sitemap', url: O } });
    const runner = new CloudflareMigrationRunner(env.MIGRATION_WF);
    const params = { scope, runId: run.id, startedBy: { kind: 'deployment' as const } };
    await using instance = await introspectWorkflowInstance(
      env.MIGRATION_WF,
      migrationInstanceId(run.id),
    );
    expect(await runner.start(params)).toBe('started');
    await instance.waitForStepResult({ name: 'cluster' });
    await (await env.MIGRATION_WF.get(migrationInstanceId(run.id))).terminate();
    await instance.waitForStatus('terminated');

    expect(await runner.start(params)).toBe('finished');
    expect(await runner.status(scope, run.id)).toBe('finished');
    await expect(runner.templateApproved(scope, run.id, 't', {})).rejects.toThrow(
      MigrationDriverFinishedError,
    );
    await expect(
      runner.publishApproved(scope, run.id, { approvedBy: { kind: 'deployment' } }),
    ).rejects.toThrow(MigrationDriverFinishedError);
  });

  it('never reads a binding that fails as a run with no driver', async () => {
    const broken = new CloudflareMigrationRunner({
      createBatch: env.MIGRATION_WF.createBatch.bind(env.MIGRATION_WF),
      get: async () => {
        throw new Error('internal error: the Workflows service is unavailable');
      },
    });
    const scope = { spaceId: 'mig-none', environmentId: 'main' };
    const sent = broken.publishApproved(scope, 'r', { approvedBy: { kind: 'deployment' } });
    await expect(sent).rejects.toThrow(/unavailable/);
    await expect(sent).rejects.not.toThrow(NotFoundError);
    await expect(broken.status(scope, 'r')).rejects.toThrow(/unavailable/);
  });
});

describe('a driver’s status', () => {
  it.each([
    ['queued', 'running'],
    ['running', 'running'],
    ['waiting', 'waiting'],
    ['paused', 'paused'],
    ['waitingForPause', 'paused'],
    ['complete', 'finished'],
    ['errored', 'finished'],
    ['terminated', 'finished'],
    ['unknown', 'unknown'],
    ['somethingNew', 'unknown'],
  ])('reads %s as %s', async (status, expected) => {
    const runner = new CloudflareMigrationRunner({
      createBatch: env.MIGRATION_WF.createBatch.bind(env.MIGRATION_WF),
      get: async () => ({ status: async () => ({ status }) }) as never,
    });
    expect(await runner.status({ spaceId: 's', environmentId: 'main' }, 'r')).toBe(expected);
  });
});

/** A model that answers from a script, one turn at a time. */
class ScriptedAI implements AIProvider {
  readonly requests: GenerateRequest[] = [];
  constructor(private readonly turns: (ToolCall[] | string)[]) {}
  async generate(req: GenerateRequest): Promise<GenerateResult> {
    this.requests.push(req);
    const next = this.turns.shift() ?? 'done';
    return typeof next === 'string'
      ? { text: next, usage: { inputTokens: 10, outputTokens: 5 } }
      : { text: '', toolCalls: next, usage: { inputTokens: 10, outputTokens: 5 } };
  }
}

describe('MigrationTemplateAgent', () => {
  it('runs its tool loop on its alarms, keeps its conversation, and starts once', async () => {
    const { ctx, scope } = context();
    const run = await createMigrationRun(ctx, scope, { source: { kind: 'sitemap', url: O } });
    const deps = {
      source: migrationTestState.source as FakeSiteSource,
      blob: migrationTestState.blob as FakeBlobStore,
    };
    await inventorySite(ctx, deps, scope, run.id);
    while ((await fetchSourcePages(ctx, deps, scope, run.id)).more) {}
    const { templates } = await clusterPages(ctx, scope, run.id);
    const template = templates[0];
    if (!template) throw new Error('no template');
    const ai = new ScriptedAI([
      [{ id: 'c1', name: 'get_source_page', input: { pageId: template.samplePageIds[0] } }],
      [
        { id: 'c2', name: 'propose_model', input: { model: MODEL } },
        { id: 'c3', name: 'write_import_script', input: { script: 'export default () => ({})' } },
      ],
      [{ id: 'c4', name: 'try_import_script', input: {} }],
      'Proposed "post"; both samples pass.',
    ]);
    migrationTestState.ai = ai;
    const input = {
      scope,
      runId: run.id,
      templateId: template.id,
      startedBy: { kind: 'deployment' as const },
    };
    const stub = env.MIGRATION_AGENT.get(env.MIGRATION_AGENT.idFromName(templateAgentName(input)));
    expect(await stub.start(input)).toEqual({ started: true });
    expect(await stub.start(input)).toEqual({ started: false });

    // Three turns an alarm: two alarms see it done.
    for (let i = 0; i < 5 && (await stub.status())?.status === 'running'; i++) {
      await runDurableObjectAlarm(stub);
    }
    expect(await stub.status()).toMatchObject({ status: 'done', turns: 4, tier: 'balanced' });
    expect((await stub.status())?.summary).toMatch(/both samples pass/);
    const authored = await ctx.store.migrations.getTemplate(scope, run.id, template.id);
    expect(authored).toMatchObject({ status: 'authoring', proposal: { apiId: 'post' } });
    expect(authored?.lastTry).toMatchObject({ pages: 2, ok: 2, passed: 2 });
    // Each turn after the first carried the conversation, read back from storage across alarms.
    expect(ai.requests.at(-1)?.messages?.filter((m) => m.role === 'tool')).toHaveLength(4);
    // Done: its one remaining alarm is the retention one, which deletes the conversation.
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await stub.status()).toBeNull();
    expect(await runDurableObjectAlarm(stub)).toBe(false);
  });

  it('keeps a turn it saved when a later turn of the same alarm fails, and always sets the next alarm', async () => {
    const { ctx, scope } = context();
    const run = await createMigrationRun(ctx, scope, { source: { kind: 'sitemap', url: O } });
    const deps = {
      source: migrationTestState.source as FakeSiteSource,
      blob: migrationTestState.blob as FakeBlobStore,
    };
    await inventorySite(ctx, deps, scope, run.id);
    while ((await fetchSourcePages(ctx, deps, scope, run.id)).more) {}
    const { templates } = await clusterPages(ctx, scope, run.id);
    const template = templates[0];
    if (!template) throw new Error('no template');
    // Turn 1 answers; turn 2's model call fails; turn 3 (the next alarm) sees turn 1.
    const requests: GenerateRequest[] = [];
    let calls = 0;
    migrationTestState.ai = {
      async generate(req) {
        requests.push(req);
        calls += 1;
        if (calls === 2) throw new Error('the model fell over');
        if (calls === 1) {
          return {
            text: '',
            toolCalls: [{ id: 'k1', name: 'get_template', input: {} }],
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        }
        return { text: 'done', usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const input = {
      scope,
      runId: run.id,
      templateId: template.id,
      startedBy: { kind: 'deployment' as const },
    };
    const stub = env.MIGRATION_AGENT.get(env.MIGRATION_AGENT.idFromName(templateAgentName(input)));
    await stub.start(input);
    await runDurableObjectAlarm(stub);
    expect(await stub.status()).toMatchObject({ status: 'running', turns: 1 });
    // The failure set the next alarm (with backoff), and kept turn 1's messages.
    await runInDurableObject(stub, async (_o, state) => {
      expect(await state.storage.getAlarm()).not.toBeNull();
      expect((await state.storage.get<{ messageCount: number }>('meta'))?.messageCount).toBe(3);
    });
    await runDurableObjectAlarm(stub);
    expect(await stub.status()).toMatchObject({ status: 'done', turns: 2 });
    expect(requests.at(-1)?.messages?.filter((m) => m.role === 'tool')).toHaveLength(1);
  });

  it('gets its alarm back on a second start when it lost it', async () => {
    const { ctx, scope } = context();
    const run = await createMigrationRun(ctx, scope, { source: { kind: 'sitemap', url: O } });
    const input = {
      scope,
      runId: run.id,
      templateId: 'lost-alarm',
      startedBy: { kind: 'deployment' as const },
    };
    const stub = env.MIGRATION_AGENT.get(env.MIGRATION_AGENT.idFromName(templateAgentName(input)));
    await stub.start(input);
    await runInDurableObject(stub, async (_o, state) => {
      await state.storage.deleteAlarm();
    });
    expect(await stub.start(input)).toEqual({ started: false });
    await runInDurableObject(stub, async (_o, state) => {
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
  });
});
