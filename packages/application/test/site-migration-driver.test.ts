import {
  ConflictError,
  type ContentTypeDraft,
  ForbiddenError,
  InvalidStateError,
  MigrationDriverFinishedError,
  type MigrationDriverStatus,
  MigrationGoAheadTakenError,
  NotFoundError,
  type Principal,
  SCOPES,
  scopesForKind,
  ValidationError,
} from '@contentworker/domain';
import {
  type MigrationDriverState,
  type MigrationPublishApproved,
  type MigrationRunner,
  type MigrationRunParams,
  type MigrationTemplateApproved,
  TransactionConflictError,
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
  migrationDriver,
  proposeTemplateModel,
  publishMigration,
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

/**
 * Records what the driver was sent, in order, with what the store held when it was sent. `signal`
 * makes every signal fail one way: no instance, a finished one, or the binding failing.
 */
class RecordingRunner implements MigrationRunner {
  readonly calls: { kind: string; at?: string | undefined; payload?: unknown }[] = [];
  readonly started = new Set<string>();
  readonly finished = new Set<string>();
  signal: 'ok' | 'missing' | 'finished' | 'broken' = 'ok';
  constructor(private readonly ctx: AppContext) {}
  async start(params: MigrationRunParams): Promise<MigrationDriverState> {
    this.calls.push({ kind: 'start', payload: params });
    if (this.finished.has(params.runId)) return 'finished';
    if (this.started.has(params.runId)) return 'running';
    this.started.add(params.runId);
    return 'started';
  }
  private refuse(runId: string): void {
    if (this.signal === 'missing') throw new NotFoundError('Migration driver', runId);
    if (this.signal === 'finished' || this.finished.has(runId)) {
      throw new MigrationDriverFinishedError(runId);
    }
    if (this.signal === 'broken') throw new Error('internal error: Workflows is unavailable');
  }
  async templateApproved(
    s: typeof scope,
    runId: string,
    templateId: string,
    event: MigrationTemplateApproved,
  ): Promise<void> {
    this.refuse(runId);
    const t = await this.ctx.store.migrations.getTemplate(s, runId, templateId);
    this.calls.push({ kind: 'templateApproved', at: t?.status, payload: event });
  }
  async publishApproved(
    _s: typeof scope,
    runId: string,
    event: MigrationPublishApproved,
  ): Promise<void> {
    this.refuse(runId);
    if (!this.started.has(runId)) throw new NotFoundError('Migration driver', runId);
    this.calls.push({ kind: 'publishApproved', payload: event });
  }
  /** What Workflows answers when asked; by default, what was started and finished here. */
  answer: MigrationDriverStatus | 'broken' | 'silent' | undefined;
  asked = 0;
  async status(_s: typeof scope, runId: string): Promise<MigrationDriverStatus> {
    this.asked += 1;
    if (this.answer === 'broken') throw new Error('internal error: Workflows is unavailable');
    if (this.answer === 'silent') return new Promise(() => {});
    if (this.answer) return this.answer;
    if (this.finished.has(runId)) return 'finished';
    return this.started.has(runId) ? 'waiting' : 'none';
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
      recorded: true,
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
    runner.signal = 'missing';
    const first = await approveMigrationTemplate(ctx, runner, admin, scope, { ...ref, reviewed });
    expect(first).toMatchObject({
      template: { status: 'approved' },
      signalled: false,
      reason: 'no-driver',
    });
    runner.signal = 'ok';
    const again = await approveMigrationTemplate(ctx, runner, admin, scope, { ...ref, reviewed });
    expect(again.signalled).toBe(true);
    expect(runner.calls.map((c) => c.kind)).toEqual(['templateApproved']);
  });
});

describe('a driver that has finished, or a run that has ended', () => {
  it('says why a driver wasn’t told: none bound, finished, or unreachable now', async () => {
    const { ctx, ref, reviewed, runner } = await harness();
    expect(
      await approveMigrationTemplate(ctx, undefined, admin, scope, { ...ref, reviewed }),
    ).toMatchObject({ signalled: false, reason: 'no-driver' });
    runner.signal = 'finished';
    expect(
      await approveMigrationTemplate(ctx, runner, admin, scope, { ...ref, reviewed }),
    ).toMatchObject({ signalled: false, reason: 'driver-finished' });
    // A transient failure isn't read as "no driver": the approval stands, and it says to retry.
    runner.signal = 'broken';
    expect(
      await approveMigrationTemplate(ctx, runner, admin, scope, { ...ref, reviewed }),
    ).toMatchObject({ template: { status: 'approved' }, signalled: false, reason: 'unreachable' });
  });

  it('refuses to start, or give the go-ahead to, a run whose driver has finished', async () => {
    const { ctx, run, runner } = await harness();
    runner.finished.add(run.id);
    await expect(startMigration(ctx, runner, admin, scope, run.id)).rejects.toThrow(
      MigrationDriverFinishedError,
    );
    await expect(
      approveMigrationPublish(ctx, runner, admin, scope, { runId: run.id }),
    ).rejects.toThrow(MigrationDriverFinishedError);
    expect(runner.calls.filter((c) => c.kind === 'publishApproved')).toEqual([]);
  });

  it('refuses to start, or give the go-ahead to, a stopped run, without asking the driver', async () => {
    const { ctx, store, run, runner } = await harness();
    const current = await store.migrations.getRun(scope, run.id);
    await store.migrations.saveRun(
      scope,
      {
        ...(current as typeof run),
        status: 'stopped',
        error: 'The go-ahead to publish never came',
        version: (current?.version ?? 0) + 1,
      },
      current?.version ?? 0,
    );
    await expect(startMigration(ctx, runner, admin, scope, run.id)).rejects.toThrow(
      /has stopped \(The go-ahead to publish never came\)/,
    );
    await expect(
      approveMigrationPublish(ctx, runner, admin, scope, { runId: run.id }),
    ).rejects.toThrow(InvalidStateError);
    expect(runner.calls).toEqual([]);
  });
});

describe('publishing a run directly', () => {
  it('refuses a release named without viaRelease, as the go-ahead does', async () => {
    const { ctx, run } = await harness();
    for (const named of [{ releaseId: 'r1' }, { releaseTitle: 'Launch' }]) {
      await expect(
        publishMigration(ctx, admin, scope, { runId: run.id, ...named }),
      ).rejects.toThrow(ValidationError);
    }
  });
});

describe('the go-ahead to publish', () => {
  it('names the caller as the approver, and needs content:write through a release', async () => {
    const { ctx, run, runner } = await harness();
    await startMigration(ctx, runner, admin, scope, run.id);
    await expect(
      approveMigrationPublish(ctx, runner, key([SCOPES.contentPublish]), scope, {
        runId: run.id,
        viaRelease: true,
      }),
    ).rejects.toThrow(ForbiddenError);
    await approveMigrationPublish(
      ctx,
      runner,
      key([SCOPES.contentPublish, SCOPES.contentWrite]),
      scope,
      { runId: run.id, viaRelease: true, releaseTitle: ' Launch ' },
    );
    // The event says it all still, for an engine from before go-aheads were recorded.
    expect(sent(runner)).toEqual([
      {
        approvedBy: { kind: 'key', keyId: 'key-1' },
        viaRelease: true,
        releaseTitle: 'Launch',
        recorded: true,
      },
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

const sent = (runner: RecordingRunner) =>
  runner.calls.filter((c) => c.kind === 'publishApproved').map((c) => c.payload);

describe('one go-ahead per run', () => {
  const started = async () => {
    const h = await harness();
    await startMigration(h.ctx, h.runner, admin, scope, h.run.id);
    const give = (principal: Principal, input: Record<string, unknown> = {}) =>
      approveMigrationPublish(h.ctx, h.runner, principal, scope, { runId: h.run.id, ...input });
    const held = async () => (await h.store.migrations.getRun(scope, h.run.id))?.goAhead;
    return { ...h, give, held };
  };
  const publisher = key([SCOPES.contentPublish, SCOPES.contentWrite]);

  it('is recorded with who, when and for what, before the driver hears of it', async () => {
    const { store, run, runner, give, held } = await started();
    let atSend: unknown;
    const send = runner.publishApproved.bind(runner);
    runner.publishApproved = async (...args) => {
      atSend = await held();
      return send(...args);
    };
    expect(await give(publisher)).toEqual({ signalled: true });
    const goAhead = {
      approvedBy: { kind: 'key', keyId: 'key-1' },
      at: '2026-11-20T00:00:00.000Z',
      target: {},
    };
    expect(atSend).toEqual({ ...goAhead, deliveredAt: null });
    expect(await held()).toEqual({ ...goAhead, deliveredAt: '2026-11-20T00:00:00.000Z' });
    // Nothing else of the run moved.
    expect(await store.migrations.getRun(scope, run.id)).toMatchObject({
      status: run.status,
      driver: { startedBy: { kind: 'deployment' } },
    });
  });

  it('answers the same one from the same caller again, telling only a driver that goes on', async () => {
    const { store, run, runner, give } = await started();
    await give(publisher);
    const version = (await store.migrations.getRun(scope, run.id))?.version;
    expect(await give(publisher)).toEqual({ signalled: true });
    expect(sent(runner)).toHaveLength(2);
    // Even once its driver has published and finished, or can't be asked.
    runner.finished.add(run.id);
    expect(await give(publisher)).toEqual({ signalled: true });
    runner.answer = 'broken';
    expect(await give(publisher)).toEqual({ signalled: true });
    expect(sent(runner)).toHaveLength(2);
    expect((await store.migrations.getRun(scope, run.id))?.version).toBe(version);
  });

  it('refuses another’s, or one for another target, with a conflict that says neither', async () => {
    const { runner, give, held } = await started();
    await give(publisher, { viaRelease: true });
    const before = await held();
    for (const [who, input] of [
      [publisher, {}],
      [publisher, { viaRelease: true, releaseTitle: 'Launch' }],
      [admin, { viaRelease: true }],
      [admin, {}],
    ] as const) {
      const err = await give(who, input).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(MigrationGoAheadTakenError);
      expect(err).toBeInstanceOf(ConflictError);
      expect(err).toMatchObject({ code: 'conflict', details: { reason: 'go_ahead_taken' } });
      expect(JSON.stringify([(err as Error).message, (err as ConflictError).details])).not.toMatch(
        /key-1|release/,
      );
    }
    expect(await held()).toEqual(before);
    expect(sent(runner)).toHaveLength(1);
  });

  it('is sent again when it was recorded but didn’t reach the driver', async () => {
    const { runner, give, held } = await started();
    runner.signal = 'broken';
    expect(await give(publisher)).toEqual({ signalled: false, reason: 'unreachable' });
    expect(await held()).toMatchObject({ deliveredAt: null });
    // Recorded all the same: nobody else's takes its place meanwhile.
    runner.signal = 'ok';
    await expect(give(admin)).rejects.toThrow(MigrationGoAheadTakenError);
    expect(await give(publisher)).toEqual({ signalled: true });
    expect(sent(runner)).toHaveLength(1);
    expect((await held())?.deliveredAt).toBeTruthy();
  });

  it('is sent again though the release it names has shipped meanwhile', async () => {
    const { store, runner, give } = await started();
    const release = {
      id: 'rel-1',
      title: 'Launch',
      status: 'open' as const,
      createdAt: '2026-11-20T00:00:00.000Z',
    };
    await store.releases.create(scope, release);
    runner.signal = 'broken';
    await give(publisher, { viaRelease: true, releaseId: 'rel-1' });
    runner.signal = 'ok';
    const get = store.releases.get.bind(store.releases);
    store.releases.get = async (...args) => {
      const r = await get(...args);
      return r && { ...r, status: 'released' as never };
    };
    expect(await give(publisher, { viaRelease: true, releaseId: 'rel-1' })).toEqual({
      signalled: true,
    });
  });

  it('is won by exactly one of two given at once', async () => {
    const { runner, give, held } = await started();
    const other: Principal = { ...publisher, keyId: 'key-2' };
    const results = await Promise.allSettled([
      give(publisher),
      give(other),
      give(publisher, { viaRelease: true }),
    ]);
    const lost = results.filter((r) => r.status === 'rejected');
    expect(lost).toHaveLength(2);
    for (const r of lost) expect(r.reason).toBeInstanceOf(MigrationGoAheadTakenError);
    const won = (await held())?.approvedBy;
    expect(sent(runner)).toEqual([expect.objectContaining({ approvedBy: won })]);
  });

  it('reads the run again when another step wrote it first, and stops if it ended', async () => {
    const { store, run, runner, give } = await started();
    const save = store.migrations.saveRun.bind(store.migrations);
    let lose = 1;
    store.migrations.saveRun = async (s, r, v) => {
      if (r.goAhead && lose-- > 0) {
        const now = (await store.migrations.getRun(s, run.id)) as typeof run;
        await save(s, { ...now, status: 'stopped', version: now.version + 1 }, now.version);
        throw new TransactionConflictError();
      }
      return save(s, r, v);
    };
    await expect(give(publisher)).rejects.toThrow(/has stopped/);
    expect(sent(runner)).toEqual([]);
  });

  it('records nothing while Workflows can’t be asked, or for a run with no driver', async () => {
    const { runner, give, held } = await started();
    runner.answer = 'broken';
    await expect(give(publisher)).rejects.toThrow(/unavailable/);
    runner.answer = 'none';
    await expect(give(publisher)).rejects.toThrow(NotFoundError);
    runner.answer = 'finished';
    await expect(give(publisher)).rejects.toThrow(MigrationDriverFinishedError);
    expect(await held()).toBeNull();
    expect(sent(runner)).toEqual([]);
  });

  it('is never called delivered to a driver started before go-aheads were recorded', async () => {
    const { run, runner, give, held, store } = await started();
    const now = (await store.migrations.getRun(scope, run.id)) as typeof run;
    await store.migrations.saveRun(
      scope,
      { ...now, driver: null, version: now.version + 1 },
      now.version,
    );
    // It may have taken one already, and then drops this: sending it again stays possible.
    expect(await give(publisher)).toEqual({ signalled: true });
    expect(await held()).toMatchObject({ deliveredAt: null });
    expect(await give(publisher)).toEqual({ signalled: true });
    expect(sent(runner)).toHaveLength(2);
    // Forgotten by Workflows, it isn't one that was never started.
    runner.answer = 'none';
    const after = (await store.migrations.getRun(scope, run.id)) as typeof run;
    expect(await migrationDriver(runner, admin, scope, after)).toMatchObject({ state: 'finished' });
  });

  it('keeps the run from being started again once Workflows has forgotten its driver', async () => {
    const { ctx, run, runner, give } = await started();
    await give(publisher);
    expect(await startMigration(ctx, runner, admin, scope, run.id)).toEqual({ started: false });
    runner.answer = 'none';
    await expect(startMigration(ctx, runner, admin, scope, run.id)).rejects.toThrow(
      MigrationDriverFinishedError,
    );
    expect(runner.calls.filter((c) => c.kind === 'start')).toHaveLength(1);
  });
});

describe('reading a run’s driver', () => {
  const read = async (h: Awaited<ReturnType<typeof harness>>, who: Principal = admin) => {
    const run = await h.store.migrations.getRun(scope, h.run.id);
    return migrationDriver(h.runner, who, scope, run as NonNullable<typeof run>);
  };

  it('says it has none, then who started it and when, and the go-ahead given', async () => {
    const h = await harness();
    expect(await read(h)).toEqual({
      state: 'none',
      startedBy: null,
      startedAt: null,
      startedByYou: false,
      goAhead: { status: 'none' },
    });
    const starter = key([SCOPES.migrationRun]);
    await startMigration(h.ctx, h.runner, starter, scope, h.run.id);
    expect(await read(h, starter)).toEqual({
      state: 'waiting',
      startedBy: { kind: 'key', keyId: 'key-1' },
      startedAt: '2026-11-20T00:00:00.000Z',
      startedByYou: true,
      goAhead: { status: 'none' },
    });
    await approveMigrationPublish(h.ctx, h.runner, admin, scope, {
      runId: h.run.id,
      viaRelease: true,
    });
    expect(await read(h, starter)).toMatchObject({
      goAhead: {
        status: 'given',
        approvedBy: { kind: 'deployment' },
        approvedAt: '2026-11-20T00:00:00.000Z',
        viaRelease: true,
        byYou: false,
        delivered: true,
      },
    });
    expect((await read(h)).goAhead).toMatchObject({ byYou: true });
  });

  it('says unknown, never no, for what wasn’t recorded or can’t be asked', async () => {
    const h = await harness();
    // Started by an api from before this was recorded.
    h.runner.started.add(h.run.id);
    expect(await read(h)).toMatchObject({
      state: 'waiting',
      startedBy: null,
      goAhead: { status: 'unknown' },
    });
    h.runner.answer = 'broken';
    expect(await read(h)).toMatchObject({ state: 'unknown', goAhead: { status: 'unknown' } });
    h.runner.answer = undefined;
    await startMigration(h.ctx, h.runner, admin, scope, h.run.id);
    // Running already: whoever calls start now didn't start it.
    expect(await read(h)).toMatchObject({ startedBy: null });
  });

  it('never holds a read up for Workflows', async () => {
    const h = await harness();
    h.runner.answer = 'silent';
    const at = Date.now();
    expect(await read(h)).toMatchObject({ state: 'unknown' });
    expect(Date.now() - at).toBeLessThan(4_000);
  });

  it('takes a driver Workflows forgot for finished, and doesn’t ask about a run that ended', async () => {
    const h = await harness();
    await startMigration(h.ctx, h.runner, admin, scope, h.run.id);
    h.runner.answer = 'none';
    expect(await read(h)).toMatchObject({ state: 'finished' });
    const now = (await h.store.migrations.getRun(scope, h.run.id)) as typeof h.run;
    await h.store.migrations.saveRun(
      scope,
      { ...now, status: 'stopped', version: now.version + 1 },
      now.version,
    );
    h.runner.asked = 0;
    expect(await read(h)).toMatchObject({ state: 'finished' });
    expect(h.runner.asked).toBe(0);
    expect(await migrationDriver(undefined, admin, scope, h.run)).toMatchObject({ state: 'none' });
  });

  it('records the start even when the run was written meanwhile', async () => {
    const h = await harness();
    const save = h.store.migrations.saveRun.bind(h.store.migrations);
    let lose = 2;
    h.store.migrations.saveRun = async (s, r, v) => {
      if (lose-- > 0) throw new TransactionConflictError();
      return save(s, r, v);
    };
    await startMigration(h.ctx, h.runner, admin, scope, h.run.id);
    expect(await read(h)).toMatchObject({ startedBy: { kind: 'deployment' } });
    // And a start whose record never lands has started all the same: the driver records itself.
    const other = await harness();
    other.store.migrations.saveRun = async () => {
      throw new Error('D1 is unavailable');
    };
    expect(await startMigration(other.ctx, other.runner, admin, scope, other.run.id)).toEqual({
      started: true,
    });
  });
});
