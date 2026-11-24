import { type ContentTypeDraft, type Principal, scopesForKind } from '@contentworker/domain';
import type { MigrationRunParams } from '@contentworker/ports';
import {
  FakeBlobStore,
  FakeSiteSource,
  FakeWorkflowSteps,
  FixedClock,
  InMemoryContentStore,
} from '@contentworker/test-kit';
import { InProcessImportScriptSandbox } from '@contentworker/test-kit/import-script';
import { describe, expect, it } from 'vitest';
import {
  type AppContext,
  approveTemplate,
  createMigrationRun,
  MIGRATION_PUBLISH_EVENT,
  type MigrationLoadSteps,
  migrationTemplateApprovedEvent,
  proposeTemplateModel,
  runSiteMigration,
  type SiteMigrationRunHost,
  setImportScript,
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
const editor: Principal = { spaceId: 'site', kind: 'cma', scopes: scopesForKind('cma') };

/** Load steps that record who they acted as. */
class RecordingLoad implements MigrationLoadSteps {
  readonly calls: { step: string; as: string; input: unknown }[] = [];
  private loads = 0;
  async loadTemplatePages(p: Principal, _s: unknown, input: unknown) {
    this.calls.push({ step: 'load', as: p.kind, input });
    this.loads += 1;
    return { loaded: 2, more: this.loads < 2 };
  }
  async relinkMigratedPages(p: Principal, _s: unknown, input: unknown) {
    this.calls.push({ step: 'relink', as: p.kind, input });
    return {};
  }
  async importMigrationRedirects(p: Principal, _s: unknown, input: unknown) {
    this.calls.push({ step: 'redirects', as: p.kind, input });
    return {};
  }
  async publishMigration(p: Principal, _s: unknown, input: unknown) {
    this.calls.push({ step: 'publish', as: p.kind, input });
    return { published: 3 };
  }
}

async function harness(withLoad = true) {
  let n = 0;
  const clock = new FixedClock(new Date('2026-11-20T00:00:00.000Z'));
  const ctx: AppContext = {
    store: new InMemoryContentStore(),
    clock,
    ids: { newId: () => `id-${String(++n).padStart(4, '0')}` },
  };
  const blob = new FakeBlobStore();
  const source = new FakeSiteSource(SITE);
  const started: string[] = [];
  const load = new RecordingLoad();
  const host: SiteMigrationRunHost = {
    ctx,
    site: { source, blob },
    authoring: { blob, sandbox: new InProcessImportScriptSandbox() },
    agents: {
      async start(input) {
        started.push(input.templateId);
      },
    },
    ...(withLoad ? { load } : {}),
  };
  const run = await createMigrationRun(ctx, scope, { source: { kind: 'sitemap', url: O } });
  const params: MigrationRunParams = { scope, runId: run.id, startedBy: { kind: 'deployment' } };
  const steps = new FakeWorkflowSteps(clock);
  return { ctx, clock, host, params, steps, started, load, source, run };
}

/** What the template's agent and its reviewer do, between the driver's passes. */
async function authorAndApprove(
  ctx: AppContext,
  host: SiteMigrationRunHost,
  ref: { runId: string; templateId: string },
) {
  await proposeTemplateModel(ctx, scope, { ...ref, model: MODEL });
  await setImportScript(ctx, host.authoring, scope, { ...ref, script: SCRIPT });
  await approveTemplate(ctx, editor, scope, ref);
}

describe('a migration run’s driver', () => {
  it('inventories, clusters, starts an agent per template and waits for approval', async () => {
    const { ctx, host, params, steps, started, load } = await harness();
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
    expect(second).toMatchObject({ status: 'waiting', on: ['publish approval'] });
    expect((await ctx.store.migrations.countPages(scope, params.runId)).byStage).toEqual({
      validated: 3,
    });
    expect(load.calls.map((c) => c.step)).toEqual(['load', 'load', 'redirects', 'relink']);
    // A replay (the instance woken again) starts no second agent and redoes no step.
    expect(started).toEqual([templateId]);

    steps.sendEvent(MIGRATION_PUBLISH_EVENT, { approvedBy: { kind: 'deployment' } });
    const done = await steps.run(() => runSiteMigration(steps, host, params));
    expect(done).toMatchObject({
      status: 'complete',
      value: { status: 'published', templates: [{ templateId, status: 'loaded' }] },
    });
    expect(load.calls.at(-1)).toMatchObject({ step: 'publish', as: 'admin' });
    const executed = steps.executed.length;
    await steps.run(() => runSiteMigration(steps, host, params));
    expect(steps.executed.length).toBe(executed);
  });

  it('transforms without loading while the load steps are not wired', async () => {
    const { ctx, host, params, steps } = await harness(false);
    await steps.run(() => runSiteMigration(steps, host, params));
    const [t] = await ctx.store.migrations.listTemplates(scope, params.runId);
    await authorAndApprove(ctx, host, { runId: params.runId, templateId: t?.id as string });
    steps.sendEvent(migrationTemplateApprovedEvent(t?.id as string), {
      approvedBy: { kind: 'deployment' },
    });
    const done = await steps.run(() => runSiteMigration(steps, host, params));
    expect(done).toMatchObject({
      status: 'complete',
      value: { status: 'transformed', templates: [{ status: 'transformed' }] },
    });
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
    const { clock, host, params, steps, load } = await harness();
    await steps.run(() => runSiteMigration(steps, host, params));
    clock.advance(15 * 24 * 60 * 60_000);
    const done = await steps.run(() => runSiteMigration(steps, host, params));
    expect(done).toMatchObject({
      status: 'complete',
      value: { status: 'clustered', templates: [{ status: 'timed-out' }] },
    });
    expect(load.calls).toEqual([]);
  });

  it('fails a template alone when its approver can no longer act', async () => {
    const { ctx, host, params, steps } = await harness();
    await steps.run(() => runSiteMigration(steps, host, params));
    const [t] = await ctx.store.migrations.listTemplates(scope, params.runId);
    await authorAndApprove(ctx, host, { runId: params.runId, templateId: t?.id as string });
    // A key that doesn't exist: the load step refuses, and that template fails alone.
    steps.sendEvent(migrationTemplateApprovedEvent(t?.id as string), {
      approvedBy: { kind: 'key', keyId: 'gone' },
    });
    const done = await steps.run(() => runSiteMigration(steps, host, params));
    expect(done).toMatchObject({
      status: 'complete',
      value: { status: 'clustered', templates: [{ status: 'failed' }] },
    });
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
