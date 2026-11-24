import {
  ConflictError,
  type ContentTypeDraft,
  ForbiddenError,
  InvalidStateError,
  NotFoundError,
  type Principal,
  SCOPES,
  scopesForKind,
  ValidationError,
} from '@contentworker/domain';
import type {
  MigrationPublishApproved,
  MigrationRunner,
  MigrationRunParams,
  MigrationTemplateApproved,
} from '@contentworker/ports';
import {
  FakeBlobStore,
  FakeSiteSource,
  FixedClock,
  InMemoryContentStore,
} from '@contentworker/test-kit';
import { describe, expect, it } from 'vitest';
import {
  type AppContext,
  approveMigrationPublish,
  approveMigrationTemplate,
  clusterPages,
  createMigrationRun,
  fetchSourcePages,
  inventorySite,
  proposeTemplateModel,
  setImportScript,
  startMigration,
  templateReviewDigest,
} from '../src/index';

const scope = { spaceId: 'site', environmentId: 'main' };
const other = { spaceId: 'site', environmentId: 'staging' };
const O = 'https://site.test';
const page = (t: string) =>
  `<html><body><main><article><h1>${t}</h1><p>${t} text.</p></article></main></body></html>`;

const MODEL: ContentTypeDraft = {
  apiId: 'article',
  name: 'Article',
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
                name: 'T',
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

const admin: Principal = { spaceId: 'site', kind: 'admin', scopes: scopesForKind('cma') };
const key = (scopes: string[]): Principal => ({
  spaceId: 'site',
  kind: 'cma',
  keyId: 'key-1',
  scopes: scopes as Principal['scopes'],
});

/** Records what the driver was sent, in order, with what the store held when it was sent. */
class RecordingRunner implements MigrationRunner {
  readonly calls: { kind: string; at?: string | undefined; payload?: unknown }[] = [];
  readonly started = new Set<string>();
  failSignals = false;
  constructor(private readonly ctx: AppContext) {}
  async start(params: MigrationRunParams): Promise<boolean> {
    this.calls.push({ kind: 'start', payload: params });
    if (this.started.has(params.runId)) return false;
    this.started.add(params.runId);
    return true;
  }
  async templateApproved(
    s: typeof scope,
    runId: string,
    templateId: string,
    event: MigrationTemplateApproved,
  ): Promise<void> {
    if (this.failSignals) throw new NotFoundError('Migration driver', runId);
    const t = await this.ctx.store.migrations.getTemplate(s, runId, templateId);
    this.calls.push({ kind: 'templateApproved', at: t?.status, payload: event });
  }
  async publishApproved(
    _s: typeof scope,
    runId: string,
    event: MigrationPublishApproved,
  ): Promise<void> {
    if (!this.started.has(runId)) throw new NotFoundError('Migration driver', runId);
    this.calls.push({ kind: 'publishApproved', payload: event });
  }
}

async function harness() {
  let n = 0;
  const store = new InMemoryContentStore();
  const ctx: AppContext = {
    store,
    clock: new FixedClock(new Date('2026-11-20T00:00:00.000Z')),
    ids: { newId: () => `id-${String(++n).padStart(4, '0')}` },
  };
  const source = new FakeSiteSource({
    [`${O}/blog/one`]: page('One'),
    [`${O}/blog/two`]: page('Two'),
  });
  const blob = new FakeBlobStore();
  const created = await createMigrationRun(ctx, scope, { source: { kind: 'sitemap', url: O } });
  await inventorySite(ctx, { source, blob }, scope, created.id);
  while ((await fetchSourcePages(ctx, { source, blob }, scope, created.id)).more) {}
  const { templates, run } = await clusterPages(ctx, scope, created.id);
  const template = templates[0];
  if (!template) throw new Error('no template');
  const ref = { runId: run.id, templateId: template.id };
  await proposeTemplateModel(ctx, scope, { ...ref, model: MODEL });
  await setImportScript(ctx, { blob }, scope, { ...ref, script: 'export default () => ({})' });
  const authored = await store.migrations.getTemplate(scope, run.id, template.id);
  const reviewed = templateReviewDigest(authored as never);
  return { ctx, store, run, ref, reviewed, runner: new RecordingRunner(ctx) };
}

describe('starting a run’s driver', () => {
  it('starts it once, as the caller, and finds it running after', async () => {
    const { ctx, run, runner } = await harness();
    const caller = key([SCOPES.migrationRun]);
    expect(await startMigration(ctx, runner, caller, scope, run.id)).toEqual({ started: true });
    expect(await startMigration(ctx, runner, caller, scope, run.id)).toEqual({ started: false });
    expect(runner.calls[0]?.payload).toEqual({
      scope,
      runId: run.id,
      startedBy: { kind: 'key', keyId: 'key-1' },
    });
  });

  it('needs migration:run, and a run in the caller’s scope', async () => {
    const { ctx, run, runner } = await harness();
    await expect(
      startMigration(ctx, runner, key([SCOPES.contentManage]), scope, run.id),
    ).rejects.toThrow(ForbiddenError);
    await expect(startMigration(ctx, runner, admin, other, run.id)).rejects.toThrow(NotFoundError);
    expect(runner.calls).toEqual([]);
  });

  it('refuses a failed run', async () => {
    const { ctx, store, run, runner } = await harness();
    const current = await store.migrations.getRun(scope, run.id);
    await store.migrations.saveRun(
      scope,
      {
        ...(current as never as typeof run),
        status: 'failed',
        error: 'boom',
        version: (current?.version ?? 0) + 1,
      },
      current?.version ?? 0,
    );
    await expect(startMigration(ctx, runner, admin, scope, run.id)).rejects.toThrow(
      InvalidStateError,
    );
  });
});

describe('approving a template for the driver', () => {
  it('tells the driver only after the approval has committed', async () => {
    const { ctx, ref, reviewed, runner } = await harness();
    const { template, signalled } = await approveMigrationTemplate(ctx, runner, admin, scope, {
      ...ref,
      reviewed,
    });
    expect(template.status).toBe('approved');
    expect(signalled).toBe(true);
    // The store already held the approval when the event went.
    expect(runner.calls).toEqual([
      { kind: 'templateApproved', at: 'approved', payload: { approvedBy: { kind: 'deployment' } } },
    ]);
  });

  it('sends nothing on a stale digest, or without content:manage', async () => {
    const { ctx, ref, runner } = await harness();
    await expect(
      approveMigrationTemplate(ctx, runner, admin, scope, { ...ref, reviewed: 'stale' }),
    ).rejects.toThrow(ConflictError);
    await expect(
      approveMigrationTemplate(ctx, runner, key([SCOPES.migrationRun]), scope, {
        ...ref,
        reviewed: 'x',
      }),
    ).rejects.toThrow(ForbiddenError);
    expect(runner.calls).toEqual([]);
  });

  it('stands without a driver, and approving again tells it again', async () => {
    const { ctx, ref, reviewed, runner } = await harness();
    runner.failSignals = true;
    const first = await approveMigrationTemplate(ctx, runner, admin, scope, { ...ref, reviewed });
    expect(first).toMatchObject({ template: { status: 'approved' }, signalled: false });
    runner.failSignals = false;
    const again = await approveMigrationTemplate(ctx, runner, admin, scope, { ...ref, reviewed });
    expect(again.signalled).toBe(true);
    expect(runner.calls.map((c) => c.kind)).toEqual(['templateApproved']);
  });
});

describe('the go-ahead to publish', () => {
  it('names the caller as the approver, and needs content:write through a release', async () => {
    const { ctx, run, runner } = await harness();
    await startMigration(ctx, runner, admin, scope, run.id);
    const publisher = key([SCOPES.contentPublish]);
    await approveMigrationPublish(ctx, runner, publisher, scope, { runId: run.id });
    await expect(
      approveMigrationPublish(ctx, runner, publisher, scope, { runId: run.id, viaRelease: true }),
    ).rejects.toThrow(ForbiddenError);
    await approveMigrationPublish(
      ctx,
      runner,
      key([SCOPES.contentPublish, SCOPES.contentWrite]),
      scope,
      { runId: run.id, viaRelease: true, releaseTitle: 'Launch' },
    );
    expect(runner.calls.filter((c) => c.kind === 'publishApproved').map((c) => c.payload)).toEqual([
      { approvedBy: { kind: 'key', keyId: 'key-1' } },
      { approvedBy: { kind: 'key', keyId: 'key-1' }, viaRelease: true, releaseTitle: 'Launch' },
    ]);
  });

  it('refuses without content:publish, another scope’s run, a missing release, or no driver', async () => {
    const { ctx, run, runner } = await harness();
    await expect(
      approveMigrationPublish(ctx, runner, key([SCOPES.migrationRun]), scope, { runId: run.id }),
    ).rejects.toThrow(ForbiddenError);
    await expect(
      approveMigrationPublish(ctx, runner, admin, other, { runId: run.id }),
    ).rejects.toThrow(NotFoundError);
    await expect(
      approveMigrationPublish(ctx, runner, admin, scope, { runId: run.id, releaseId: 'r' }),
    ).rejects.toThrow(ValidationError);
    await expect(
      approveMigrationPublish(ctx, runner, admin, scope, {
        runId: run.id,
        viaRelease: true,
        releaseId: 'missing',
      }),
    ).rejects.toThrow(NotFoundError);
    // Never started: the driver isn't there to tell.
    await expect(
      approveMigrationPublish(ctx, runner, admin, scope, { runId: run.id }),
    ).rejects.toThrow(NotFoundError);
    expect(runner.calls).toEqual([]);
  });
});
