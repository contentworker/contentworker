import {
  type ContentTypeDraft,
  MigrationClusteringHeldError,
  type Principal,
  scopesForKind,
} from '@contentworker/domain';
import {
  type MigrationRunner,
  type MigrationRunParams,
  TransactionConflictError,
} from '@contentworker/ports';
import {
  FakeBlobStore,
  FakeRemoteFetcher,
  FakeSiteSource,
  FakeWorkflowSteps,
  FixedClock,
  InMemoryContentStore,
} from '@contentworker/test-kit';
import { InProcessImportScriptSandbox } from '@contentworker/test-kit/import-script';
import { describe, expect, it } from 'vitest';
import {
  type AppContext,
  approveMigrationPublish,
  approveTemplate,
  clusterPages,
  createMigrationRun,
  fetchSourcePages,
  inventorySite,
  MIGRATION_AGENTS_PER_RUN,
  MIGRATION_APPROVAL_WAITS,
  MIGRATION_DRIVEN_TEMPLATES,
  MIGRATION_PUBLISH_EVENT,
  migrationTemplateApprovedEvent,
  proposeTemplateModel,
  recordDriver,
  reopenTemplate,
  runSiteMigration,
  type SiteMigrationRunHost,
  setImportScript,
  templateReviewDigest,
} from '../src/index';

const scope = { spaceId: 'site', environmentId: 'main' };
const O = 'https://site.test';
const article = (title: string) =>
  `<html><body><main><article><h1>${title}</h1><div class="body"><p>${title} text here.</p></div></article></main></body></html>`;
const SITE: Record<string, string> = {
  [`${O}/blog/one`]: article('One'),
  [`${O}/blog/two`]: article('Two'),
  [`${O}/blog/three`]: article('Three'),
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
const SCRIPT = `export default (page) => ({
  fields: { title: page.text('h1'), slug: page.url.split('/').pop() },
  blocks: [{ variant: 'text', fields: { text: page.text('.body') } }],
  assets: [],
  links: [],
})`;
const editor: Principal = { spaceId: 'site', kind: 'admin', scopes: scopesForKind('cma') };

async function harness(site: Record<string, string> = SITE) {
  let n = 0;
  const clock = new FixedClock(new Date('2026-11-20T00:00:00.000Z'));
  const store = new InMemoryContentStore();
  store.seedSpace({ spaceId: 'site', defaultLocale: 'en-US', locales: ['en-US'] });
  const ctx: AppContext = {
    store,
    clock,
    ids: { newId: () => `id-${String(++n).padStart(4, '0')}` },
  };
  const blob = new FakeBlobStore();
  const source = new FakeSiteSource(site);
  const started: string[] = [];
  const host: SiteMigrationRunHost = {
    ctx,
    site: { source, blob },
    authoring: { blob, sandbox: new InProcessImportScriptSandbox() },
    agents: {
      async start(input) {
        started.push(input.templateId);
      },
    },
    load: { blob, fetcher: new FakeRemoteFetcher() },
  };
  const run = await createMigrationRun(ctx, scope, { source: { kind: 'sitemap', url: O } });
  const params: MigrationRunParams = {
    scope,
    runId: run.id,
    startedBy: { kind: 'deployment' },
    recorded: true,
  };
  const steps = new FakeWorkflowSteps(clock);
  return { ctx, clock, host, params, steps, started, source, run };
}

/** What the template's agent and its reviewer do, between the driver's passes. */
async function authorAndApprove(
  ctx: AppContext,
  host: SiteMigrationRunHost,
  ref: { runId: string; templateId: string },
) {
  await proposeTemplateModel(ctx, scope, { ...ref, model: MODEL });
  await setImportScript(ctx, host.authoring, scope, { ...ref, script: SCRIPT });
  const t = await ctx.store.migrations.getTemplate(scope, ref.runId, ref.templateId);
  await approveTemplate(ctx, editor, scope, { ...ref, reviewed: templateReviewDigest(t as never) });
}

const stages = async (ctx: AppContext, runId: string) =>
  (await ctx.store.migrations.countPages(scope, runId)).byStage;

describe('a migration run’s driver', () => {
  it('inventories, clusters, starts an agent per template and waits for approval', async () => {
    const { ctx, host, params, steps, started } = await harness();
    const first = await steps.run(() => runSiteMigration(steps, host, params));
    expect(first.status).toBe('waiting');
    const templates = await ctx.store.migrations.listTemplates(scope, params.runId);
    expect(templates).toHaveLength(1);
    const templateId = templates[0]?.id as string;
    expect(started).toEqual([templateId]);
    expect(first).toMatchObject({ on: [`approval ${templateId}`] });
    expect((await ctx.store.migrations.countPages(scope, params.runId)).byStage).toEqual({
      clustered: 3,
    });

    // The agent and a reviewer do their part; the approval arrives as an event.
    await authorAndApprove(ctx, host, { runId: params.runId, templateId });
    steps.sendEvent(migrationTemplateApprovedEvent(templateId), {
      approvedBy: { kind: 'deployment' },
    });
    const second = await steps.run(() => runSiteMigration(steps, host, params));
    // It waits for the go-ahead, and for the template's next approval should it be reopened.
    expect(second).toMatchObject({
      status: 'waiting',
      on: [`approval ${templateId} round 2`, 'publish approval'],
    });
    // Transformed, loaded as entries of the approved type, and redirected.
    expect(await stages(ctx, params.runId)).toEqual({ loaded: 3 });
    const pages = await ctx.store.migrations.listPages(scope, params.runId, { limit: 10 });
    expect(pages.every((p) => p.entryId !== null)).toBe(true);
    expect(steps.executed.some((n) => n.startsWith('redirects '))).toBe(true);
    expect(steps.executed.some((n) => n.startsWith('relink '))).toBe(true);
    // A replay (the instance woken again) starts no second agent and redoes no step.
    expect(started).toEqual([templateId]);

    steps.sendEvent(MIGRATION_PUBLISH_EVENT, { approvedBy: { kind: 'deployment' } });
    const done = await steps.run(() => runSiteMigration(steps, host, params));
    expect(done).toMatchObject({
      status: 'complete',
      value: { status: 'published', templates: [{ templateId, status: 'loaded' }] },
    });
    expect(await stages(ctx, params.runId)).toEqual({ published: 3 });
    const executed = steps.executed.length;
    await steps.run(() => runSiteMigration(steps, host, params));
    expect(steps.executed.length).toBe(executed);
  });

  it('waits out a site that can’t be read now, then goes on', async () => {
    const { ctx, clock, host, params, steps, source } = await harness();
    source.unavailable = 'robots.txt answered 503';
    const first = await steps.run(() => runSiteMigration(steps, host, params));
    expect(first).toMatchObject({ status: 'waiting', on: ['inventory wait 0'] });
    source.unavailable = undefined;
    clock.advance(11 * 60_000);
    const second = await steps.run(() => runSiteMigration(steps, host, params));
    expect(second.status).toBe('waiting');
    expect((await ctx.store.migrations.getRun(scope, params.runId))?.status).toBe('clustered');
  });

  it('lets a template whose approval never comes time out, and finishes', async () => {
    const { ctx, clock, host, params, steps } = await harness();
    await steps.run(() => runSiteMigration(steps, host, params));
    clock.advance(15 * 24 * 60 * 60_000);
    const done = await steps.run(() => runSiteMigration(steps, host, params));
    expect(done).toMatchObject({
      status: 'complete',
      value: { status: 'clustered', templates: [{ status: 'timed-out' }] },
    });
    expect(await stages(ctx, params.runId)).toEqual({ clustered: 3 });
    // Recorded, so starting it again is refused rather than finding the finished instance; its
    // templates can still be authored by hand.
    const run = await ctx.store.migrations.getRun(scope, params.runId);
    expect(run).toMatchObject({ status: 'stopped', error: expect.stringMatching(/approved/) });
    const templateId = (await ctx.store.migrations.listTemplates(scope, params.runId))[0]?.id;
    await expect(
      proposeTemplateModel(ctx, scope, {
        runId: params.runId,
        templateId: templateId as string,
        model: MODEL,
      }),
    ).resolves.toMatchObject({ status: 'authoring' });
  });

  it('records a run whose go-ahead to publish never comes as stopped, with its pages loaded', async () => {
    const { ctx, clock, host, params, steps } = await harness();
    await steps.run(() => runSiteMigration(steps, host, params));
    const templateId = (await ctx.store.migrations.listTemplates(scope, params.runId))[0]
      ?.id as string;
    await authorAndApprove(ctx, host, { runId: params.runId, templateId });
    steps.sendEvent(migrationTemplateApprovedEvent(templateId), {});
    await steps.run(() => runSiteMigration(steps, host, params));
    clock.advance(15 * 24 * 60 * 60_000);
    const done = await steps.run(() => runSiteMigration(steps, host, params));
    expect(done).toMatchObject({ status: 'complete', value: { status: 'loaded' } });
    expect(await ctx.store.migrations.getRun(scope, params.runId)).toMatchObject({
      status: 'stopped',
      error: expect.stringMatching(/go-ahead/),
    });
    expect(await stages(ctx, params.runId)).toEqual({ loaded: 3 });
  });

  it('adds every loaded entry to the run’s release through the go-ahead, a batch at a time', async () => {
    const { ctx, host, params, steps } = await harness();
    await steps.run(() => runSiteMigration(steps, host, params));
    const templateId = (await ctx.store.migrations.listTemplates(scope, params.runId))[0]
      ?.id as string;
    await authorAndApprove(ctx, host, { runId: params.runId, templateId });
    steps.sendEvent(migrationTemplateApprovedEvent(templateId), {});
    await steps.run(() => runSiteMigration(steps, host, params));
    steps.sendEvent(MIGRATION_PUBLISH_EVENT, {
      approvedBy: { kind: 'deployment' },
      viaRelease: true,
      releaseTitle: 'Launch',
    });
    const done = await steps.run(() => runSiteMigration(steps, host, params));
    expect(done).toMatchObject({ status: 'complete', value: { status: 'published' } });
    const run = await ctx.store.migrations.getRun(scope, params.runId);
    expect(run?.releaseId).toBeTruthy();
    const items = await ctx.store.releases.listItems(scope, run?.releaseId as string);
    expect(items).toHaveLength(3);
  });

  it('fails a template alone when its recorded approver can no longer act', async () => {
    const { ctx, host, params, steps } = await harness();
    await steps.run(() => runSiteMigration(steps, host, params));
    const [t] = await ctx.store.migrations.listTemplates(scope, params.runId);
    const ref = { runId: params.runId, templateId: t?.id as string };
    await authorAndApprove(ctx, host, ref);
    // The approval was a key's, since revoked.
    const approved = await ctx.store.migrations.getTemplate(scope, ref.runId, ref.templateId);
    await ctx.store.migrations.saveTemplate(scope, ref.runId, {
      ...(approved as NonNullable<typeof approved>),
      approvedBy: { kind: 'key', keyId: 'gone' },
    });
    steps.sendEvent(migrationTemplateApprovedEvent(ref.templateId), {});
    const done = await steps.run(() => runSiteMigration(steps, host, params));
    expect(done).toMatchObject({
      status: 'complete',
      value: { status: 'clustered', templates: [{ status: 'failed' }] },
    });
    // Transformed, but loaded as nobody.
    expect(await stages(ctx, params.runId)).toEqual({ validated: 3 });
  });

  it('takes an approval event as a wake-up only: the store says who approved, and whether', async () => {
    const { ctx, host, params, steps } = await harness();
    await steps.run(() => runSiteMigration(steps, host, params));
    const [t] = await ctx.store.migrations.listTemplates(scope, params.runId);
    // An event for a template nobody approved: nothing is transformed or loaded.
    steps.sendEvent(migrationTemplateApprovedEvent(t?.id as string), {
      approvedBy: { kind: 'deployment' },
    });
    const next = await steps.run(() => runSiteMigration(steps, host, params));
    expect(next).toMatchObject({ status: 'waiting', on: [`approval ${t?.id} round 2`] });
    expect(await stages(ctx, params.runId)).toEqual({ clustered: 3 });
  });

  it('publishes nothing on a go-ahead that names no approver', async () => {
    const { ctx, host, params, steps } = await harness();
    await steps.run(() => runSiteMigration(steps, host, params));
    const [t] = await ctx.store.migrations.listTemplates(scope, params.runId);
    await authorAndApprove(ctx, host, { runId: params.runId, templateId: t?.id as string });
    steps.sendEvent(migrationTemplateApprovedEvent(t?.id as string), {});
    await steps.run(() => runSiteMigration(steps, host, params));
    steps.sendEvent(MIGRATION_PUBLISH_EVENT, {});
    const done = await steps.run(() => runSiteMigration(steps, host, params));
    expect(done).toMatchObject({ status: 'complete', value: { status: 'failed' } });
    expect(await stages(ctx, params.runId)).toEqual({ loaded: 3 });
    expect((await ctx.store.migrations.getRun(scope, params.runId))?.status).toBe('failed');
  });

  it('stops when whoever started the run no longer acts in the space', async () => {
    const { ctx, host, params, steps, started } = await harness();
    const gone = { ...params, startedBy: { kind: 'member' as const, memberId: 'removed' } };
    const done = await steps.run(() => runSiteMigration(steps, host, gone));
    expect(done).toMatchObject({ status: 'complete', value: { status: 'failed' } });
    expect(started).toEqual([]);
    expect((await ctx.store.migrations.getRun(scope, params.runId))?.status).toBe('failed');
  });

  it('starts agents for the largest templates only, and drives a bounded number', async () => {
    const { ctx, host, params, steps, started, run } = await harness();
    // A site of many one-off structures: 60 templates, written as a clustering would.
    const at = '2026-11-20T00:00:00.000Z';
    const clusters = Array.from({ length: 60 }, (_, i) => ({
      template: {
        id: `t-${String(i).padStart(3, '0')}`,
        runId: run.id,
        label: `Template ${i + 1}`,
        status: 'pending' as const,
        pageCount: 60 - i,
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
    }));
    await ctx.store.migrations.replaceTemplates(scope, run.id, clusters, at);
    await ctx.store.migrations.saveRun(scope, { ...run, status: 'clustered', version: 2 }, 1);
    const first = await steps.run(() => runSiteMigration(steps, host, params));
    expect(started).toEqual(clusters.slice(0, MIGRATION_AGENTS_PER_RUN).map((c) => c.template.id));
    expect(first.status === 'waiting' && first.on.length).toBe(MIGRATION_DRIVEN_TEMPLATES);
  });

  it('leaves a failure record that keeps losing its race to the step’s retries', async () => {
    const { ctx, host, params, steps, run } = await harness();
    await ctx.store.migrations.saveRun(
      scope,
      { ...run, error: 'boom', status: 'created', version: 2 },
      1,
    );
    // Gone wrong (the starter can't act), and every write of the failure loses its race.
    const gone = { ...params, startedBy: { kind: 'member' as const, memberId: 'removed' } };
    ctx.store.migrations.saveRun = async () => {
      const { TransactionConflictError } = await import('@contentworker/ports');
      throw new TransactionConflictError();
    };
    const done = await steps.run(() => runSiteMigration(steps, host, gone));
    expect(done.status).toBe('errored');
    expect(steps.executed.filter((n) => n === 'record failure').length).toBeGreaterThan(1);
  });

  it('records a run gone wrong as failed', async () => {
    const { ctx, host, params, steps, run } = await harness();
    await ctx.store.migrations.saveRun(
      scope,
      { ...run, status: 'failed', error: 'bad', version: 2 },
      1,
    );
    const done = await steps.run(() => runSiteMigration(steps, host, params));
    expect(done).toMatchObject({ status: 'complete', value: { status: 'failed', error: 'bad' } });
  });
});

describe('clustering a run its driver has taken on', () => {
  type H = Awaited<ReturnType<typeof harness>>;
  const pass = (h: H) => h.steps.run(() => runSiteMigration(h.steps, h.host, h.params));
  const ids = async (h: H) =>
    (await h.ctx.store.migrations.listTemplates(scope, h.run.id)).map((t) => t.id);
  const byHand = async (h: H) => {
    await inventorySite(h.ctx, h.host.site, scope, h.run.id);
    while ((await fetchSourcePages(h.ctx, h.host.site, scope, h.run.id)).more) {}
    return clusterPages(h.ctx, scope, h.run.id);
  };
  const recluster = (h: H) => clusterPages(h.ctx, scope, h.run.id, { threshold: 0.9 });

  it('is refused while it waits, so its templates and approvals stand', async () => {
    const h = await harness();
    await pass(h);
    const before = await ids(h);
    await expect(recluster(h)).rejects.toThrow(MigrationClusteringHeldError);
    expect(await ids(h)).toEqual(before);
    const templateId = before[0] as string;
    await authorAndApprove(h.ctx, h.host, { runId: h.run.id, templateId });
    h.steps.sendEvent(migrationTemplateApprovedEvent(templateId), {});
    await pass(h);
    expect(await stages(h.ctx, h.run.id)).toEqual({ loaded: 3 });
  });

  it('is open on a run clustered by hand until it is started, and refused from then on', async () => {
    const h = await harness();
    const first = await byHand(h);
    const second = await recluster(h);
    expect(await ids(h)).not.toContain(first.templates[0]?.id);
    const templateId = second.templates[0]?.id;
    expect(await pass(h)).toMatchObject({ on: [`approval ${templateId}`] });
    expect(h.started).toEqual([templateId]);
    await expect(recluster(h)).rejects.toThrow(MigrationClusteringHeldError);
  });

  it('that commits as the driver takes the templates is the one the driver takes', async () => {
    const h = await harness();
    await byHand(h);
    // Between the step's read of the templates and its hold.
    const save = h.ctx.store.migrations.saveRun.bind(h.ctx.store.migrations);
    let raced = false;
    h.ctx.store.migrations.saveRun = async (...args) => {
      if (!raced && args[1].clusteringHeldAt) {
        raced = true;
        await recluster(h);
      }
      return save(...args);
    };
    const now = await pass(h);
    const [templateId] = await ids(h);
    expect(now).toMatchObject({ on: [`approval ${templateId}`] });
    expect(h.started).toEqual([templateId]);
    await expect(recluster(h)).rejects.toThrow(MigrationClusteringHeldError);
  });

  it('leaves a taking that keeps losing its race to the step’s retries', async () => {
    const h = await harness();
    await byHand(h);
    const save = h.ctx.store.migrations.saveRun.bind(h.ctx.store.migrations);
    let losses = 4;
    h.ctx.store.migrations.saveRun = async (...args) => {
      if (losses > 0 && args[1].clusteringHeldAt) {
        losses -= 1;
        throw new TransactionConflictError();
      }
      return save(...args);
    };
    expect((await pass(h)).status).toBe('waiting');
    expect(losses).toBe(0);
    expect(await h.ctx.store.migrations.getRun(scope, h.run.id)).toMatchObject({
      status: 'clustered',
      clusteringHeldAt: expect.any(String),
    });
  });

  it('stays refused when the step that took it runs again, its result lost', async () => {
    const h = await harness();
    await pass(h);
    const before = await ids(h);
    const run = await h.ctx.store.migrations.getRun(scope, h.run.id);
    h.steps.journal.delete('cluster');
    expect(await pass(h)).toMatchObject({ on: [`approval ${before[0]}`] });
    expect(await ids(h)).toEqual(before);
    expect(await h.ctx.store.migrations.getRun(scope, h.run.id)).toEqual(run);
  });

  it('leaves a run whose driver is gone with its templates to take on by hand, or drive again', async () => {
    const h = await harness();
    await pass(h);
    // Terminated: nothing more is recorded on the run.
    const [templateId] = await ids(h);
    await expect(recluster(h)).rejects.toThrow(MigrationClusteringHeldError);
    // Another driver, once the first one's instance is past its retention, takes the same ones.
    const again = { ...h, steps: new FakeWorkflowSteps(h.clock) };
    expect(await pass(again)).toMatchObject({ on: [`approval ${templateId}`] });
    await authorAndApprove(h.ctx, h.host, { runId: h.run.id, templateId: templateId as string });
    expect(
      (await h.ctx.store.migrations.getTemplate(scope, h.run.id, templateId as string))?.status,
    ).toBe('approved');
  });

  it('is refused by a stopped run’s state, and a failed one’s, as it was', async () => {
    const stopped = await harness();
    await pass(stopped);
    stopped.clock.advance(15 * 24 * 60 * 60_000);
    await pass(stopped);
    await expect(recluster(stopped)).rejects.toThrow('the run is stopped');

    const failed = await harness();
    await byHand(failed);
    failed.host.agents.start = async () => {
      throw new TransactionConflictError();
    };
    await pass(failed);
    expect((await failed.ctx.store.migrations.getRun(scope, failed.run.id))?.status).toBe('failed');
    await expect(recluster(failed)).rejects.toThrow('the run is failed');
  });

  it('goes on with a driver that recorded its clustering before there was a hold', async () => {
    const h = await harness();
    const { run } = await byHand(h);
    const [templateId] = await ids(h);
    h.steps.journal.set('read run', { ok: true, value: { ...run } });
    h.steps.journal.set('cluster', {
      ok: true,
      value: { ok: [{ id: templateId, status: 'pending', held: false }] },
    });
    expect(await pass(h)).toMatchObject({ on: [`approval ${templateId}`] });
    expect(h.steps.executed).not.toContain('cluster');
    // Nothing held it, so nothing refuses this but a template being authored.
    expect((await h.ctx.store.migrations.getRun(scope, h.run.id))?.clusteringHeldAt).toBeNull();
    await proposeTemplateModel(h.ctx, scope, {
      runId: h.run.id,
      templateId: templateId as string,
      model: MODEL,
    });
    await expect(recluster(h)).rejects.toThrow('already being authored');
  });
});

describe('the go-ahead a driver acts on', () => {
  type H = Awaited<ReturnType<typeof harness>>;
  const pass = (h: H) => h.steps.run(() => runSiteMigration(h.steps, h.host, h.params));
  const runOf = async (h: H) => {
    const run = await h.ctx.store.migrations.getRun(scope, h.params.runId);
    if (!run) throw new Error('no run');
    return run;
  };
  /** Its one template loaded, the driver waiting for the go-ahead. */
  const loaded = async () => {
    const h = await harness();
    await pass(h);
    const [t] = await h.ctx.store.migrations.listTemplates(scope, h.params.runId);
    const ref = { runId: h.params.runId, templateId: t?.id as string };
    await authorAndApprove(h.ctx, h.host, ref);
    h.steps.sendEvent(migrationTemplateApprovedEvent(ref.templateId), {});
    await pass(h);
    return h;
  };
  const runner = (h: H, deliver = true): MigrationRunner => ({
    start: async () => 'running',
    templateApproved: async () => undefined,
    status: async () => 'waiting',
    publishApproved: async (_s, _r, event) => {
      if (!deliver) throw new Error('unreachable');
      h.steps.sendEvent(MIGRATION_PUBLISH_EVENT, event);
    },
  });
  const give = (h: H, over: Record<string, unknown> = {}, deliver = true) =>
    approveMigrationPublish(h.ctx, runner(h, deliver), editor, scope, {
      runId: h.params.runId,
      ...over,
    });
  const save = async (h: H, over: Partial<Awaited<ReturnType<typeof runOf>>>) => {
    const run = await runOf(h);
    await h.ctx.store.migrations.saveRun(
      scope,
      { ...run, ...over, version: run.version + 1 },
      run.version,
    );
  };

  it('given while the driver lists the site, or takes its templates, fails neither', async () => {
    for (const at of ['inventoried', 'clustered']) {
      const h = await harness();
      if (at === 'clustered') {
        await inventorySite(h.ctx, h.host.site, scope, h.run.id);
        while ((await fetchSourcePages(h.ctx, h.host.site, scope, h.run.id)).more) {}
        await clusterPages(h.ctx, scope, h.run.id);
      }
      const saveRun = h.ctx.store.migrations.saveRun.bind(h.ctx.store.migrations);
      let losses = 4;
      h.ctx.store.migrations.saveRun = async (s, r, v) => {
        if (
          r.status === at &&
          (r.clusteringHeldAt || at === 'inventoried') &&
          !r.goAhead &&
          losses > 0
        ) {
          losses -= 1;
          // Each write of the run by someone else moves its version on.
          const now = await runOf(h);
          await saveRun(s, { ...now, version: now.version + 1 }, now.version);
          if (losses === 0) await give(h);
        }
        return saveRun(s, r, v);
      };
      expect((await pass(h)).status).toBe('waiting');
      expect(losses).toBe(0);
      expect(await runOf(h)).toMatchObject({
        status: 'clustered',
        clusteringHeldAt: expect.any(String),
        driver: { startedBy: { kind: 'deployment' } },
        goAhead: { approvedBy: { kind: 'deployment' } },
      });
    }
  });

  it('is kept by a clustering it crosses, which is sent again and not called held', async () => {
    const h = await harness();
    await inventorySite(h.ctx, h.host.site, scope, h.run.id);
    while ((await fetchSourcePages(h.ctx, h.host.site, scope, h.run.id)).more) {}
    const saveRun = h.ctx.store.migrations.saveRun.bind(h.ctx.store.migrations);
    let crossed = false;
    h.ctx.store.migrations.saveRun = async (s, r, v) => {
      if (!crossed && r.status === 'clustered') {
        crossed = true;
        await recordDriver(h.ctx, scope, h.run.id, { kind: 'deployment' });
      }
      return saveRun(s, r, v);
    };
    const withTx = h.ctx.store.withTransaction.bind(h.ctx.store);
    h.ctx.store.withTransaction = (async (fn: never) => {
      if (!crossed) {
        crossed = true;
        await recordDriver(h.ctx, scope, h.run.id, { kind: 'deployment' });
      }
      return withTx(fn);
    }) as never;
    await expect(clusterPages(h.ctx, scope, h.run.id)).rejects.toThrow(TransactionConflictError);
    await clusterPages(h.ctx, scope, h.run.id);
    expect(await runOf(h)).toMatchObject({
      status: 'clustered',
      clusteringHeldAt: null,
      driver: { startedBy: { kind: 'deployment' } },
    });
  });

  it('records who started it in its first step', async () => {
    const h = await harness();
    await pass(h);
    expect((await runOf(h)).driver).toEqual({
      startedBy: { kind: 'deployment' },
      startedAt: '2026-11-20T00:00:00.000Z',
    });
    const { version } = await runOf(h);
    await pass(h);
    expect((await runOf(h)).version).toBe(version);
  });

  it('records no start of an instance an earlier api started, so its go-ahead stays unknown', async () => {
    const h = await harness();
    const { recorded: _, ...params } = h.params;
    await h.steps.run(() => runSiteMigration(h.steps, h.host, params));
    expect((await runOf(h)).driver).toBeNull();
  });

  it.each(['told', 'late'])('publishes nothing as someone who lost access (%s)', async (how) => {
    const h = await loaded();
    await save(h, {
      goAhead: {
        approvedBy: { kind: 'key', keyId: 'revoked' },
        at: '2026-11-20T00:00:00.000Z',
        target: {},
        deliveredAt: null,
      },
    });
    if (how === 'late') h.clock.advance(15 * 24 * 60 * 60_000);
    else {
      h.steps.sendEvent(MIGRATION_PUBLISH_EVENT, {
        approvedBy: { kind: 'deployment' },
        recorded: true,
      });
    }
    expect(await pass(h)).toMatchObject({ status: 'complete', value: { status: 'failed' } });
    expect(await stages(h.ctx, h.params.runId)).toEqual({ loaded: 3 });
  });

  it('is the run’s, whatever the event says', async () => {
    const h = await loaded();
    await give(h, { viaRelease: true, releaseTitle: 'Launch' }, false);
    expect((await runOf(h)).goAhead?.deliveredAt).toBeNull();
    h.steps.sendEvent(MIGRATION_PUBLISH_EVENT, {
      approvedBy: { kind: 'key', keyId: 'someone-else' },
      recorded: true,
    });
    expect(await pass(h)).toMatchObject({ status: 'complete', value: { status: 'published' } });
    const run = await runOf(h);
    expect(run.releaseId).toBeTruthy();
    expect(await stages(h.ctx, run.id)).toEqual({ loaded: 3 });
    // Acted on, it certainly arrived.
    expect(run.goAhead).toMatchObject({
      approvedBy: { kind: 'deployment' },
      deliveredAt: expect.any(String),
    });
  });

  it('is taken once, however often its event comes', async () => {
    const h = await loaded();
    await give(h);
    for (let i = 0; i < 3; i++) {
      h.steps.sendEvent(MIGRATION_PUBLISH_EVENT, {
        approvedBy: { kind: 'deployment' },
        viaRelease: true,
        recorded: true,
      });
    }
    expect(await pass(h)).toMatchObject({ status: 'complete', value: { status: 'published' } });
    expect((await runOf(h)).releaseId).toBeNull();
    expect(await stages(h.ctx, h.params.runId)).toEqual({ published: 3 });
  });

  it('publishes nothing on a wake-up for a go-ahead the run doesn’t hold', async () => {
    const h = await loaded();
    h.steps.sendEvent(MIGRATION_PUBLISH_EVENT, {
      approvedBy: { kind: 'deployment' },
      recorded: true,
    });
    expect(await pass(h)).toMatchObject({ status: 'complete', value: { status: 'loaded' } });
    expect(await runOf(h)).toMatchObject({
      status: 'stopped',
      error: expect.stringMatching(/record/),
    });
    expect(await stages(h.ctx, h.params.runId)).toEqual({ loaded: 3 });
  });

  it('takes one that was recorded but never delivered when the wait runs out', async () => {
    const h = await loaded();
    await give(h, {}, false);
    h.clock.advance(15 * 24 * 60 * 60_000);
    expect(await pass(h)).toMatchObject({ status: 'complete', value: { status: 'published' } });
    expect(await runOf(h)).toMatchObject({
      status: 'clustered',
      goAhead: { deliveredAt: expect.any(String) },
    });
    expect(await stages(h.ctx, h.params.runId)).toEqual({ published: 3 });
    const executed = h.steps.executed.length;
    await pass(h);
    expect(h.steps.executed.length).toBe(executed);
  });

  it('stops over no go-ahead given as the wait ran out', async () => {
    const h = await loaded();
    const saveRun = h.ctx.store.migrations.saveRun.bind(h.ctx.store.migrations);
    let given = false;
    h.ctx.store.migrations.saveRun = async (s, r, v) => {
      if (r.status === 'stopped' && !given) {
        given = true;
        await give(h, {}, false);
      }
      return saveRun(s, r, v);
    };
    h.clock.advance(15 * 24 * 60 * 60_000);
    expect(await pass(h)).toMatchObject({ status: 'complete', value: { status: 'published' } });
    expect((await runOf(h)).status).toBe('clustered');
  });

  it('takes one sent before they were recorded as it was sent, and records it', async () => {
    const h = await loaded();
    h.steps.sendEvent(MIGRATION_PUBLISH_EVENT, {
      approvedBy: { kind: 'deployment' },
      viaRelease: true,
    });
    // Given since, to a run whose go-ahead wasn't on record: the one sent first stands.
    await save(h, {
      goAhead: {
        approvedBy: { kind: 'key', keyId: 'later' },
        at: '2026-11-20T01:00:00.000Z',
        target: {},
        deliveredAt: null,
      },
    });
    expect(await pass(h)).toMatchObject({ status: 'complete', value: { status: 'published' } });
    const run = await runOf(h);
    expect(run.releaseId).toBeTruthy();
    expect(run.goAhead).toEqual({
      approvedBy: { kind: 'deployment' },
      at: '2026-11-20T00:00:00.000Z',
      target: { viaRelease: true },
      deliveredAt: '2026-11-20T00:00:00.000Z',
    });
  });

  it('goes on under the one an earlier driver began publishing with', async () => {
    const h = await loaded();
    // As that driver recorded them: the event's payload, and the rounds it counted.
    h.steps.sendEvent(MIGRATION_PUBLISH_EVENT, { approvedBy: { kind: 'deployment' } });
    h.steps.journal.set('go-ahead rounds', { ok: true, value: [1] });
    await save(h, {
      goAhead: {
        approvedBy: { kind: 'key', keyId: 'later' },
        at: '2026-11-20T01:00:00.000Z',
        target: { viaRelease: true },
        deliveredAt: null,
      },
    });
    expect(await pass(h)).toMatchObject({ status: 'complete', value: { status: 'published' } });
    expect(await stages(h.ctx, h.params.runId)).toEqual({ published: 3 });
    expect((await runOf(h)).goAhead).toMatchObject({
      approvedBy: { kind: 'deployment' },
      target: {},
    });
  });

  it('publishes though its record keeps losing its race', async () => {
    const h = await loaded();
    h.steps.sendEvent(MIGRATION_PUBLISH_EVENT, { approvedBy: { kind: 'deployment' } });
    const { TransactionConflictError } = await import('@contentworker/ports');
    h.ctx.store.migrations.saveRun = async () => {
      throw new TransactionConflictError();
    };
    expect(await pass(h)).toMatchObject({ status: 'complete', value: { status: 'published' } });
  });

  it('keeps a stop an earlier driver recorded', async () => {
    const h = await loaded();
    h.steps.journal.set('publish approval', { ok: false, error: 'timed out' });
    h.steps.journal.set('record stop', { ok: true, value: true });
    expect(await pass(h)).toMatchObject({ status: 'complete', value: { status: 'loaded' } });
    expect(await stages(h.ctx, h.params.runId)).toEqual({ loaded: 3 });
  });
});

describe('a template reopened while its run is driven', () => {
  type H = Awaited<ReturnType<typeof harness>>;
  const pass = (h: H) => h.steps.run(() => runSiteMigration(h.steps, h.host, h.params));
  const templateOf = async (h: H, i = 0) => {
    const t = (await h.ctx.store.migrations.listTemplates(scope, h.params.runId))[i];
    if (!t) throw new Error('no template');
    return { runId: h.params.runId, templateId: t.id };
  };
  type Ref = Awaited<ReturnType<typeof templateOf>>;
  const digest = async (h: H, ref: Ref) => {
    const t = await h.ctx.store.migrations.getTemplate(scope, ref.runId, ref.templateId);
    return templateReviewDigest(t as NonNullable<typeof t>);
  };
  const tell = (h: H, ref: Ref) =>
    h.steps.sendEvent(migrationTemplateApprovedEvent(ref.templateId), {});
  const reopen = async (h: H, ref: Ref) =>
    reopenTemplate(h.ctx, editor, scope, { ...ref, reviewed: await digest(h, ref) });
  const approveWith = async (h: H, ref: Ref, script: string) => {
    await setImportScript(h.ctx, h.host.authoring, scope, { ...ref, script });
    await approveTemplate(h.ctx, editor, scope, { ...ref, reviewed: await digest(h, ref) });
  };
  const V2 = SCRIPT.replace("page.text('h1')", "page.text('h1') + ' v2'");
  const titles = async (h: H) =>
    (await h.ctx.store.entries.list(scope, { contentTypeApiId: 'post', limit: 100 }))
      .map((e) => Object.values(e.fields.title ?? {})[0])
      .sort();
  /** Runs `fn` once, as the next step whose name starts with `prefix` begins. */
  const before = (h: H, prefix: string, fn: () => Promise<unknown>) => {
    const run = h.steps.do.bind(h.steps) as (...a: unknown[]) => Promise<unknown>;
    let done = false;
    (h.steps as { do: unknown }).do = async (name: string, ...rest: unknown[]) => {
      if (!done && name.startsWith(prefix)) {
        done = true;
        await fn();
      }
      return run(name, ...rest);
    };
  };

  it('before it is loaded: the run waits again, and takes the newer version through', async () => {
    const h = await harness();
    await pass(h);
    const ref = await templateOf(h);
    await authorAndApprove(h.ctx, h.host, ref);
    tell(h, ref);
    before(h, `load ${ref.templateId}`, () => reopen(h, ref));
    const waiting = await pass(h);
    expect(waiting).toMatchObject({
      status: 'waiting',
      on: [`approval ${ref.templateId} round 2`],
    });
    expect(await stages(h.ctx, ref.runId)).toEqual({ validated: 3 });
    expect((await h.ctx.store.migrations.getRun(scope, ref.runId))?.status).toBe('clustered');
    // Woken by nothing: a replay of the first round redoes none of it.
    const executed = h.steps.executed.length;
    await pass(h);
    expect(h.steps.executed.length).toBe(executed);

    await approveWith(h, ref, V2);
    tell(h, ref);
    expect(await pass(h)).toMatchObject({
      on: [`approval ${ref.templateId} round 3`, 'publish approval'],
    });
    expect(await stages(h.ctx, ref.runId)).toEqual({ loaded: 3 });
    expect(await titles(h)).toEqual(['One v2', 'Three v2', 'Two v2']);
    expect(h.steps.executed).toContain(`transform ${ref.templateId} 0 round 2`);
    // The run's agent wasn't started again.
    expect(h.started).toEqual([ref.templateId]);
    h.steps.sendEvent(MIGRATION_PUBLISH_EVENT, { approvedBy: { kind: 'deployment' } });
    expect(await pass(h)).toMatchObject({
      status: 'complete',
      value: { status: 'published', templates: [{ status: 'loaded' }] },
    });
  });

  it('reopened and approved again before the driver’s next step: that step sees it', async () => {
    const h = await harness();
    await pass(h);
    const ref = await templateOf(h);
    await authorAndApprove(h.ctx, h.host, ref);
    tell(h, ref);
    before(h, `transform ${ref.templateId}`, async () => {
      await reopen(h, ref);
      await approveWith(h, ref, V2);
      tell(h, ref);
    });
    // The second approval's event was buffered, and wakes the second round.
    expect(await pass(h)).toMatchObject({
      on: [`approval ${ref.templateId} round 3`, 'publish approval'],
    });
    expect(await titles(h)).toEqual(['One v2', 'Three v2', 'Two v2']);
  });

  it('after it loaded: its loaded entries stay, and the rest of its pages are the new version’s', async () => {
    const h = await harness();
    await pass(h);
    const ref = await templateOf(h);
    await authorAndApprove(h.ctx, h.host, ref);
    tell(h, ref);
    // One page's script fails at first, so it is left as needs-fix.
    const broken = `export default (page) => {
      if (page.url.endsWith('/two')) throw new Error('no body');
      return (${SCRIPT.replace('export default ', '')})(page);
    }`;
    await reopen(h, ref);
    await approveWith(h, ref, broken);
    tell(h, ref);
    await pass(h);
    expect(await stages(h.ctx, ref.runId)).toEqual({ loaded: 2, 'needs-fix': 1 });
    // While it waits for the go-ahead.
    await reopen(h, ref);
    await pass(h);
    await approveWith(h, ref, V2);
    tell(h, ref);
    await pass(h);
    expect(await stages(h.ctx, ref.runId)).toEqual({ loaded: 3 });
    expect(await titles(h)).toEqual(['One', 'Three', 'Two v2']);
    h.steps.sendEvent(MIGRATION_PUBLISH_EVENT, { approvedBy: { kind: 'deployment' } });
    expect(await pass(h)).toMatchObject({ status: 'complete', value: { status: 'published' } });
    expect(await stages(h.ctx, ref.runId)).toEqual({ published: 3 });
  });

  it('takes an earlier approval’s buffered event for a wake-up with nothing to do', async () => {
    const h = await harness();
    await pass(h);
    const ref = await templateOf(h);
    await authorAndApprove(h.ctx, h.host, ref);
    // Told three times over.
    for (let i = 0; i < 3; i++) tell(h, ref);
    expect(await pass(h)).toMatchObject({
      on: expect.arrayContaining([`approval ${ref.templateId} round 4`, 'publish approval']),
    });
    expect(h.steps.executed.filter((n) => n.startsWith('transform '))).toHaveLength(1);
    // One left over while it is reopened answers for no approval either.
    await reopen(h, ref);
    tell(h, ref);
    expect(await pass(h)).toMatchObject({ on: expect.arrayContaining(['publish approval']) });
    expect(h.steps.executed.filter((n) => n.startsWith('transform '))).toHaveLength(1);
    await approveWith(h, ref, V2);
    tell(h, ref);
    await pass(h);
    expect(h.steps.executed).toContain(`transform ${ref.templateId} 0 round 5`);
  });

  it('publishes what is loaded on the go-ahead, and leaves the rest of it unpublished', async () => {
    const h = await harness();
    await pass(h);
    const ref = await templateOf(h);
    await authorAndApprove(h.ctx, h.host, ref);
    await reopen(h, ref);
    await approveWith(
      h,
      ref,
      `export default (page) => {
        if (page.url.endsWith('/two')) throw new Error('no body');
        return (${SCRIPT.replace('export default ', '')})(page);
      }`,
    );
    tell(h, ref);
    await pass(h);
    await reopen(h, ref);
    h.steps.sendEvent(MIGRATION_PUBLISH_EVENT, { approvedBy: { kind: 'deployment' } });
    expect(await pass(h)).toMatchObject({ status: 'complete', value: { status: 'published' } });
    expect(await stages(h.ctx, ref.runId)).toEqual({ published: 2, 'needs-fix': 1 });
    expect(
      (await h.ctx.store.migrations.getTemplate(scope, ref.runId, ref.templateId))?.status,
    ).toBe('authoring');
  });

  it('gives up waiting after a bounded number of rounds, without failing the run', async () => {
    const h = await harness();
    await pass(h);
    const ref = await templateOf(h);
    await authorAndApprove(h.ctx, h.host, ref);
    for (let i = 0; i < MIGRATION_APPROVAL_WAITS + 2; i++) tell(h, ref);
    expect(await pass(h)).toMatchObject({ status: 'waiting', on: ['publish approval'] });
    expect(await stages(h.ctx, ref.runId)).toEqual({ loaded: 3 });
    h.steps.sendEvent(MIGRATION_PUBLISH_EVENT, { approvedBy: { kind: 'deployment' } });
    expect(await pass(h)).toMatchObject({
      value: { status: 'published', templates: [{ status: 'loaded' }] },
    });
  });

  it('is still listened for after events with nothing to take through, and after a wait runs out', async () => {
    const h = await harness();
    await pass(h);
    const ref = await templateOf(h);
    await authorAndApprove(h.ctx, h.host, ref);
    // Told again and again, as someone pressing the button would: none of it is a round.
    for (let i = 0; i < 10; i++) tell(h, ref);
    await pass(h);
    // Its wait began before the go-ahead's here and runs out first.
    h.steps.deadlines.set(`approval ${ref.templateId} round 11`, 0);
    expect(await pass(h)).toMatchObject({
      on: expect.arrayContaining([`approval ${ref.templateId} round 12`, 'publish approval']),
    });
    await reopen(h, ref);
    await approveWith(h, ref, V2);
    tell(h, ref);
    await pass(h);
    expect(h.steps.executed).toContain(`transform ${ref.templateId} 0 round 12`);
  });

  it('finishes a round begun before the go-ahead, and begins none after, however it replays', async () => {
    const h = await harness();
    await pass(h);
    const ref = await templateOf(h);
    await authorAndApprove(h.ctx, h.host, ref);
    await reopen(h, ref);
    // One page is left for the next version.
    await approveWith(
      h,
      ref,
      `export default (page) => {
        if (page.url.endsWith('/two')) throw new Error('no body');
        return (${SCRIPT.replace('export default ', '')})(page);
      }`,
    );
    tell(h, ref);
    await pass(h);
    await reopen(h, ref);
    await approveWith(h, ref, V2);
    // The instance is evicted in the second round's load, with the go-ahead recorded.
    const real = h.steps.do.bind(h.steps) as (...a: unknown[]) => Promise<unknown>;
    let evicted = false;
    (h.steps as { do: unknown }).do = async (name: string, ...rest: unknown[]) => {
      if (!evicted && name.startsWith(`load ${ref.templateId}`) && name.endsWith('round 2')) {
        return new Promise(() => {});
      }
      return real(name, ...rest);
    };
    tell(h, ref);
    // (Nothing suspends a step that never answers, so the pass is left behind.)
    void runSiteMigration(h.steps, h.host, h.params);
    await new Promise((r) => setTimeout(r, 50));
    h.steps.sendEvent(MIGRATION_PUBLISH_EVENT, { approvedBy: { kind: 'deployment' } });
    void runSiteMigration(h.steps, h.host, h.params);
    await new Promise((r) => setTimeout(r, 50));
    expect(h.steps.journal.has('go-ahead rounds')).toBe(true);
    expect(h.steps.executed).not.toContain('publish 0');
    evicted = true;
    // An approval told after the go-ahead is too late for this driver.
    tell(h, ref);
    const done = await pass(h);
    expect(done).toMatchObject({ status: 'complete', value: { status: 'published' } });
    expect(await stages(h.ctx, ref.runId)).toEqual({ published: 3 });
    expect(h.steps.executed.some((n) => n.startsWith('transform ') && n.endsWith('round 3'))).toBe(
      false,
    );
    const executed = h.steps.executed.length;
    await pass(h);
    expect(h.steps.executed.length).toBe(executed);
  });

  it('writes no redirect under an approval withdrawn as it loaded: the go-ahead does', async () => {
    const h = await harness();
    await pass(h);
    const ref = await templateOf(h);
    await proposeTemplateModel(h.ctx, scope, {
      ...ref,
      model: { ...MODEL, urlPattern: '/news/{slug}' },
    });
    await approveWith(
      h,
      ref,
      `export default (page) => {
        if (page.url.endsWith('/two')) throw new Error('no body');
        return (${SCRIPT.replace('export default ', '')})(page);
      }`,
    );
    tell(h, ref);
    const count = async () => (await h.ctx.store.redirects.list(scope, { limit: 10 })).items.length;
    await pass(h);
    expect(await count()).toBe(2);
    await reopen(h, ref);
    await approveWith(h, ref, V2);
    tell(h, ref);
    before(h, `redirects ${ref.templateId} round 2`, () => reopen(h, ref));
    await pass(h);
    expect(await stages(h.ctx, ref.runId)).toEqual({ loaded: 3 });
    expect(await count()).toBe(2);
    h.steps.sendEvent(MIGRATION_PUBLISH_EVENT, { approvedBy: { kind: 'deployment' } });
    await pass(h);
    expect(await stages(h.ctx, ref.runId)).toEqual({ published: 3 });
    expect(await count()).toBe(3);
  });

  it('times out alone when it is never approved again', async () => {
    const h = await harness();
    await pass(h);
    const ref = await templateOf(h);
    await authorAndApprove(h.ctx, h.host, ref);
    tell(h, ref);
    before(h, `transform ${ref.templateId}`, () => reopen(h, ref));
    await pass(h);
    h.clock.advance(15 * 24 * 60 * 60_000);
    expect(await pass(h)).toMatchObject({
      status: 'complete',
      value: { status: 'clustered', templates: [{ status: 'timed-out' }] },
    });
    expect((await h.ctx.store.migrations.getRun(scope, ref.runId))?.status).toBe('stopped');
  });

  it('doesn’t hold up another template, or its publish', async () => {
    const h = await harness({
      [`${O}/shop/kettle`]:
        '<html><body><main><section class="hero"><h2>Kettle</h2></section><ul class="specs"><li><b>1</b></li></ul></main></body></html>',
      ...SITE,
    });
    await pass(h);
    const blog = await templateOf(h, 0);
    const shop = await templateOf(h, 1);
    for (const [ref, apiId] of [
      [blog, 'post'],
      [shop, 'product'],
    ] as const) {
      await proposeTemplateModel(h.ctx, scope, { ...ref, model: { ...MODEL, apiId, name: apiId } });
      await approveWith(h, ref, SCRIPT.replace("page.text('h1')", "page.text('h1, h2')"));
      tell(h, ref);
    }
    before(h, `load ${blog.templateId}`, () => reopen(h, blog));
    expect(await pass(h)).toMatchObject({
      status: 'waiting',
      on: expect.arrayContaining([`approval ${blog.templateId} round 2`, 'publish approval']),
    });
    expect(await stages(h.ctx, blog.runId)).toEqual({ validated: 3, loaded: 1 });
    h.steps.sendEvent(MIGRATION_PUBLISH_EVENT, { approvedBy: { kind: 'deployment' } });
    const done = await pass(h);
    expect(done).toMatchObject({ status: 'complete', value: { status: 'published' } });
    expect(done.status === 'complete' && done.value.templates).toEqual([
      { templateId: blog.templateId, status: 'reopened' },
      { templateId: shop.templateId, status: 'loaded', approvedBy: { kind: 'deployment' } },
    ]);
    expect(await stages(h.ctx, blog.runId)).toEqual({ validated: 3, published: 1 });
  });

  it('starts no agent on a template reopened before the driver was', async () => {
    const h = await harness();
    await inventorySite(h.ctx, h.host.site, scope, h.run.id);
    while ((await fetchSourcePages(h.ctx, h.host.site, scope, h.run.id)).more) {}
    await clusterPages(h.ctx, scope, h.run.id);
    const ref = await templateOf(h);
    await authorAndApprove(h.ctx, h.host, ref);
    await reopen(h, ref);
    expect(await pass(h)).toMatchObject({ on: [`approval ${ref.templateId}`] });
    expect(h.started).toEqual([]);
  });

  it('goes on with a run whose first round was recorded before templates could be reopened', async () => {
    const h = await harness();
    await pass(h);
    const ref = await templateOf(h);
    await authorAndApprove(h.ctx, h.host, ref);
    // As the earlier driver recorded them: who approved it, and no version.
    const id = ref.templateId;
    h.steps.journal.set(`approver ${id}`, { ok: true, value: { ok: { kind: 'deployment' } } });
    tell(h, ref);
    expect(await pass(h)).toMatchObject({
      on: [`approval ${id} round 2`, 'publish approval'],
    });
    expect(await stages(h.ctx, ref.runId)).toEqual({ loaded: 3 });
    // A later approval is newer than one with no version on record.
    await reopen(h, ref);
    await approveWith(h, ref, V2);
    tell(h, ref);
    await pass(h);
    expect(h.steps.executed).toContain(`transform ${id} 0 round 2`);
  });

  it('holds a round recorded with no version to the approver it names', async () => {
    const h = await harness();
    await pass(h);
    const ref = await templateOf(h);
    await authorAndApprove(h.ctx, h.host, ref);
    h.steps.journal.set(`approver ${ref.templateId}`, {
      ok: true,
      value: { ok: { kind: 'key', keyId: 'the-first-approver' } },
    });
    tell(h, ref);
    expect(await pass(h)).toMatchObject({ on: [`approval ${ref.templateId} round 2`] });
    expect(await stages(h.ctx, ref.runId)).toEqual({ clustered: 3 });
  });
});
