import {
  env,
  introspectWorkflowInstance,
  runDurableObjectAlarm,
  runInDurableObject,
} from 'cloudflare:test';
import {
  type AppContext,
  approveTemplate,
  clusterPages,
  createMigrationRun,
  fetchSourcePages,
  inventorySite,
  proposeTemplateModel,
  setImportScript,
  templateReviewDigest,
} from '@contentworker/application';
import { type ContentTypeDraft, NotFoundError, scopesForKind } from '@contentworker/domain';
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
    expect(await runner.start(params)).toBe(true);
    // A second start (a retried request) finds the driver that exists.
    expect(await runner.start(params)).toBe(false);
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
