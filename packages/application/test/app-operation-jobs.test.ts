import {
  APP_JOB_ACTIVE_WINDOW_MS,
  APP_JOB_RETENTION_SECONDS,
  APP_JOB_STALE_MS,
  APP_JOB_START_DEADLINE_MS,
  ASYNC_OPERATION_TIMEOUT_MS,
  ConflictError,
  type DomainEvent,
  MAX_ACTIVE_APP_JOBS,
  MAX_KEPT_APP_JOBS,
  NotFoundError,
  type PluginManifest,
  type PluginOperation,
  type Principal,
  SCOPES,
} from '@contentworker/domain';
import type {
  PluginCapabilities,
  PluginOperationInvocation,
  PluginRuntime,
} from '@contentworker/ports';
import {
  FakeBlobStore,
  FakeWorkflowSteps,
  FixedClock,
  InMemoryContentStore,
  RecordingWebhookSender,
  SequenceIdGenerator,
} from '@contentworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  type AppOperationJobView,
  addMember,
  authenticate,
  createApiKey,
  createPluginOperationRunner,
  createRole,
  dispatchEvent,
  getAppOperationJob,
  installPlugin,
  invokeAppOperation,
  listAppOperationJobs,
  principalForWebUser,
  revokeApiKey,
  runAppOperationJob,
  setPluginEnabled,
  sweepExpiredAppOperationJobs,
  updateRole,
  upgradePlugin,
} from '../src/index';

/**
 * Async app operations: accepted as a job (and its event) in one unit, run once by the engine's
 * Workflow with the grant narrowed to the caller snapshot, and read back only by principals who
 * could have run it themselves.
 */

const SPACE = 's1';
const scope = { spaceId: SPACE, environmentId: 'main' };
const admin: Principal = { spaceId: '*', kind: 'admin', scopes: Object.values(SCOPES) };
const viewer: Principal = { spaceId: SPACE, kind: 'cpa', scopes: [SCOPES.previewRead] };
const editor: Principal = {
  spaceId: SPACE,
  kind: 'cma',
  scopes: [SCOPES.previewRead, SCOPES.contentWrite],
};

const audit: PluginOperation = {
  name: 'auditAll',
  title: 'Audit every entry',
  description: 'Audits every entry, in the background',
  requires: SCOPES.previewRead,
  mode: 'async',
  input: { type: 'object', properties: { limit: { type: 'integer', minimum: 1 } } },
  output: { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'] },
};

const manifest = (over: Partial<PluginManifest> = {}): PluginManifest => ({
  manifestVersion: 2,
  id: 'com.example.audit',
  name: 'Audit',
  version: '1.0.0',
  capabilities: ['content:read', 'content:write'],
  allowedHosts: [],
  hooks: [],
  entrypoint: 'index.js',
  operations: [audit],
  ...over,
});

type Call = { inv: PluginOperationInvocation; caps: PluginCapabilities };
function fakeRuntime(
  answer: (inv: PluginOperationInvocation) => unknown = () => ({ count: 3 }),
): PluginRuntime & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    async invoke(inv) {
      return { payload: inv.payload };
    },
    async runOperation(inv, caps) {
      calls.push({ inv, caps });
      return answer(inv);
    },
  };
}

let ctx: AppContext;
let store: InMemoryContentStore;
let blob: FakeBlobStore;
let clock: FixedClock;
let runtime: ReturnType<typeof fakeRuntime>;

function withRuntime(r: PluginRuntime) {
  const appOperations = createPluginOperationRunner(ctx, blob, r);
  ctx = { ...ctx, ...(appOperations ? { appOperations } : {}) };
}

async function install(over: Partial<PluginManifest> = {}) {
  const m = manifest(over);
  await installPlugin(ctx, blob, admin, SPACE, {
    manifest: m,
    bundle: `// ${m.id} ${m.version}`,
    approvedCapabilities: m.capabilities,
  });
  await setPluginEnabled(ctx, SPACE, m.id, true);
}

async function start(principal: Principal = editor, input: unknown = { limit: 5 }) {
  const result = await invokeAppOperation(
    ctx,
    principal,
    scope,
    'com.example.audit',
    'auditAll',
    input,
  );
  if (!('job' in result)) throw new Error('expected a job');
  return result.job;
}

async function run(jobId: string, steps = new FakeWorkflowSteps(clock)) {
  const outcome = await steps.run(() => runAppOperationJob(steps, ctx, { scope, jobId }));
  return { outcome, steps };
}

beforeEach(async () => {
  blob = new FakeBlobStore();
  store = new InMemoryContentStore();
  store.seedSpace({ spaceId: SPACE, defaultLocale: 'en-US', locales: ['en-US'] });
  clock = new FixedClock();
  ctx = { store, clock, ids: new SequenceIdGenerator('j') };
  runtime = fakeRuntime();
  withRuntime(runtime);
  await install();
});

describe('accepting an async operation', () => {
  it('returns a pending job and its event at once, without running the plugin', async () => {
    const job = await start();
    expect(job).toMatchObject({
      plugin: 'com.example.audit',
      pluginVersion: '1.0.0',
      operation: 'auditAll',
      status: 'pending',
      input: { limit: 5 },
      createdBy: 'cma',
    });
    expect(job).not.toHaveProperty('caller');
    expect(Date.parse(job.expiresAt) - Date.parse(job.createdAt)).toBe(
      APP_JOB_RETENTION_SECONDS * 1000,
    );
    expect(runtime.calls).toEqual([]);
    expect(store.allEvents().at(-1)).toMatchObject({
      type: 'app_operation.requested',
      jobId: job.id,
      scope,
    });
  });

  it('refuses another while ten are pending or running, but not past a stale one', async () => {
    for (let i = 0; i < MAX_ACTIVE_APP_JOBS; i++) await start();
    await expect(start()).rejects.toBeInstanceOf(ConflictError);
    // Their Workflows never started: past the active window they stop counting.
    clock.advance(APP_JOB_ACTIVE_WINDOW_MS + 1);
    const fresh = await start();
    expect(fresh.status).toBe('pending');
  });

  it('refuses another once the environment keeps its limit of jobs, until they expire', async () => {
    const seeded = await start();
    const row = await store.appOperationJobs.get(scope, seeded.id);
    if (!row) throw new Error('no job');
    for (let i = 1; i < MAX_KEPT_APP_JOBS; i++) {
      await store.appOperationJobs.create(scope, {
        ...row,
        id: `kept-${i}`,
        status: 'completed',
        output: null,
      });
    }
    await expect(start()).rejects.toThrow(/jobs are kept here/);
    clock.advance(APP_JOB_RETENTION_SECONDS * 1000);
    expect((await start()).status).toBe('pending');
  });
});

describe('running a job on the Workflow', () => {
  it('runs the plugin once, with the long budget and the caller’s narrowed grant', async () => {
    const job = await start(viewer);
    const { outcome } = await run(job.id);
    expect(outcome).toEqual({ status: 'complete', value: 'completed' });
    expect(runtime.calls).toHaveLength(1);
    expect(runtime.calls[0]?.inv).toMatchObject({
      operation: 'auditAll',
      input: { limit: 5 },
      timeoutMs: ASYNC_OPERATION_TIMEOUT_MS,
      // The viewer holds no write scope, so the plugin's content:write doesn't reach it.
      capabilities: ['content:read'],
    });
    const done = await getAppOperationJob(ctx, viewer, scope, job.id);
    expect(done).toMatchObject({ status: 'completed', output: { count: 3 } });
    expect(done.startedAt).toBeDefined();
    expect(done.completedAt).toBeDefined();
  });

  it('never runs a job twice: a replayed or redelivered run finds it finished', async () => {
    const job = await start();
    const { steps } = await run(job.id);
    await steps.run(() => runAppOperationJob(steps, ctx, { scope, jobId: job.id }));
    const again = await run(job.id);
    expect(again.outcome).toEqual({ status: 'complete', value: 'skipped' });
    expect(runtime.calls).toHaveLength(1);
  });

  it('records a plugin failure, redacted, without retrying the run', async () => {
    withRuntime(
      fakeRuntime(() => {
        throw new Error('upstream refused Authorization: Bearer sk_live_abcdef1234567890');
      }),
    );
    const job = await start();
    const { outcome, steps } = await run(job.id);
    expect(outcome).toEqual({ status: 'complete', value: 'failed' });
    expect(steps.executed.filter((n) => n === 'run')).toHaveLength(1);
    const failed = await getAppOperationJob(ctx, editor, scope, job.id);
    expect(failed.status).toBe('failed');
    expect(failed.error).toMatch(/upstream refused/);
    expect(failed.error).not.toMatch(/sk_live_abcdef1234567890/);
    expect(failed).not.toHaveProperty('output');
  });

  it('never starts a job past its start deadline, on access copied that long ago', async () => {
    const job = await start();
    clock.advance(APP_JOB_START_DEADLINE_MS + 1);
    const { outcome } = await run(job.id);
    expect(outcome).toEqual({ status: 'complete', value: 'failed' });
    expect(runtime.calls).toEqual([]);
    expect((await getAppOperationJob(ctx, editor, scope, job.id)).error).toBe(
      'The operation did not start in time',
    );
  });

  it('runs nothing when the plugin is upgraded between the checks and the bundle load', async () => {
    const job = await start();
    // Swap the stored plugin's code under the run: the row read first still has the old checksum.
    const get = store.plugins.get.bind(store.plugins);
    let reads = 0;
    store.plugins.get = async (spaceId, id) => {
      reads += 1;
      // Read 1 is the claim's check, 2 the run step's, 3 the bundle load's.
      if (reads === 3) {
        await upgradePlugin(ctx, blob, admin, SPACE, {
          manifest: manifest({ version: '1.2.0' }),
          bundle: '// swapped in',
        });
      }
      return get(spaceId, id);
    };
    await run(job.id);
    expect(runtime.calls).toEqual([]);
    expect((await getAppOperationJob(ctx, editor, scope, job.id)).error).toMatch(
      /plugin changed while it started/,
    );
  });

  it('fails output off its schema', async () => {
    withRuntime(fakeRuntime(() => ({ count: 'three' })));
    const job = await start();
    await run(job.id);
    expect((await getAppOperationJob(ctx, editor, scope, job.id)).error).toMatch(
      /output does not match/,
    );
  });

  it('fails without running when the plugin changed or was disabled after it was accepted', async () => {
    const upgraded = await start();
    await upgradePlugin(ctx, blob, admin, SPACE, {
      manifest: manifest({ version: '1.1.0' }),
      bundle: '// a different bundle',
    });
    await run(upgraded.id);
    expect((await getAppOperationJob(ctx, editor, scope, upgraded.id)).error).toMatch(
      /changed, disabled or removed/,
    );

    const disabled = await start();
    await setPluginEnabled(ctx, SPACE, 'com.example.audit', false);
    await run(disabled.id);
    expect((await getAppOperationJob(ctx, editor, scope, disabled.id)).status).toBe('failed');
    expect(runtime.calls).toEqual([]);
  });

  it('fails the job at once where the deployment can’t start Workflows', async () => {
    const job = await start();
    const event = store.allEvents().at(-1) as DomainEvent;
    await dispatchEvent(ctx, { sender: new RecordingWebhookSender(), blob }, event);
    expect(await getAppOperationJob(ctx, editor, scope, job.id)).toMatchObject({
      status: 'failed',
      error: 'Async operations are not available on this deployment',
    });
  });

  it('starts the job’s Workflow from its event when one is bound', async () => {
    const job = await start();
    const started: string[] = [];
    await dispatchEvent(
      ctx,
      {
        sender: new RecordingWebhookSender(),
        blob,
        appOperationJobs: {
          start: async (p) => {
            started.push(`${p.scope.environmentId}/${p.jobId}`);
            return true;
          },
        },
      },
      store.allEvents().at(-1) as DomainEvent,
    );
    expect(started).toEqual([`main/${job.id}`]);
  });
});

describe('reading jobs', () => {
  it('shows a job only to principals who could have run it themselves', async () => {
    const job = await start(editor);
    const ids = (items: AppOperationJobView[]) => items.map((j) => j.id);
    expect((await getAppOperationJob(ctx, editor, scope, job.id)).id).toBe(job.id);
    expect((await getAppOperationJob(ctx, admin, scope, job.id)).id).toBe(job.id);
    // The viewer lacks content:write, which the editor's run could use.
    await expect(getAppOperationJob(ctx, viewer, scope, job.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(ids(await listAppOperationJobs(ctx, viewer, scope))).toEqual([]);
    // Same scopes, narrower content grants: not the same caller.
    const granted: Principal = {
      ...editor,
      kind: 'user',
      subject: 'ana@example.com',
      contentGrants: [{ contentTypeApiId: 'article', actions: ['read'] }],
    };
    await expect(getAppOperationJob(ctx, granted, scope, job.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(ids(await listAppOperationJobs(ctx, editor, scope))).toEqual([job.id]);
  });

  it('keeps jobs to their environment and space', async () => {
    const job = await start();
    const other = { spaceId: SPACE, environmentId: 'staging' };
    await expect(getAppOperationJob(ctx, admin, other, job.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(await listAppOperationJobs(ctx, admin, other)).toEqual([]);
    const elsewhere: Principal = { ...editor, spaceId: 's2' };
    await expect(getAppOperationJob(ctx, elsewhere, scope, job.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('reports a job whose Workflow never started, or never finished, as failed', async () => {
    const pending = await start();
    clock.advance(APP_JOB_START_DEADLINE_MS + 1);
    expect(await getAppOperationJob(ctx, editor, scope, pending.id)).toMatchObject({
      status: 'failed',
      error: 'The operation did not start in time',
    });
    const running = await start();
    await store.appOperationJobs.update(scope, running.id, {
      status: 'running',
      startedAt: clock.now().toISOString(),
    });
    clock.advance(APP_JOB_STALE_MS);
    expect((await getAppOperationJob(ctx, editor, scope, running.id)).status).toBe('running');
    clock.advance(1);
    expect(await getAppOperationJob(ctx, editor, scope, running.id)).toMatchObject({
      status: 'failed',
      error: 'The operation did not finish in time',
    });
  });

  it('records the job failed when the run step itself fails', async () => {
    const job = await start();
    const steps = new FakeWorkflowSteps(clock);
    const real = steps.do.bind(steps) as (...a: unknown[]) => Promise<unknown>;
    (steps as unknown as { do: (...a: unknown[]) => Promise<unknown> }).do = (...a) =>
      a[0] === 'run' ? Promise.reject(new Error('step crashed')) : real(...a);
    const outcome = await steps.run(() => runAppOperationJob(steps, ctx, { scope, jobId: job.id }));
    expect(outcome).toEqual({ status: 'complete', value: 'failed' });
    expect(await getAppOperationJob(ctx, editor, scope, job.id)).toMatchObject({
      status: 'failed',
      error: 'step crashed',
    });
  });

  it('sweeps jobs, and their output, past their retention', async () => {
    const job = await start();
    await run(job.id);
    expect(await sweepExpiredAppOperationJobs(ctx)).toEqual({ removed: 0 });
    clock.advance(APP_JOB_RETENTION_SECONDS * 1000);
    expect(await sweepExpiredAppOperationJobs(ctx)).toEqual({ removed: 1 });
    await expect(getAppOperationJob(ctx, admin, scope, job.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('sweeps a backlog past one batch in one tick', async () => {
    const seeded = await start();
    const row = await store.appOperationJobs.get(scope, seeded.id);
    if (!row) throw new Error('no job');
    for (let i = 0; i < 250; i++) {
      await store.appOperationJobs.create(scope, { ...row, id: `old-${i}` });
    }
    clock.advance(APP_JOB_RETENTION_SECONDS * 1000);
    expect(await sweepExpiredAppOperationJobs(ctx)).toEqual({ removed: 251 });
  });
});

describe('checking the caller again before a job runs', () => {
  const hasher = { hash: (v: string) => `h:${v}` };
  const readerRole = () =>
    createRole(ctx, SPACE, { name: 'Reader', scopes: [SCOPES.previewRead], contentGrants: [] });

  async function keyPrincipal(roleId: string) {
    const { token, apiKey } = await createApiKey(ctx, hasher, {
      issuer: 'system',
      spaceId: SPACE,
      kind: 'cma',
      roleId,
    });
    return { principal: await authenticate(ctx, hasher, token), keyId: apiKey.id };
  }

  it('fails without running when the key that started it was revoked; another key’s still runs', async () => {
    const role = await readerRole();
    const revoked = await keyPrincipal(role.id);
    const kept = await keyPrincipal(role.id);
    const gone = await start(revoked.principal);
    const live = await start(kept.principal);
    // The reference is the machinery's: callers never see it.
    expect(JSON.stringify(gone)).not.toContain(revoked.keyId);
    await revokeApiKey(ctx, SPACE, revoked.keyId);

    expect((await run(gone.id)).outcome).toEqual({ status: 'complete', value: 'failed' });
    expect(await getAppOperationJob(ctx, admin, scope, gone.id)).toMatchObject({
      status: 'failed',
      error: 'The API key or token that started this operation no longer works here',
    });
    expect(runtime.calls).toHaveLength(0);
    expect((await run(live.id)).outcome).toEqual({ status: 'complete', value: 'completed' });
    expect(runtime.calls).toHaveLength(1);
  });

  it('fails without running when the person’s role was narrowed after it was accepted', async () => {
    const role = await readerRole();
    await addMember(ctx, SPACE, { email: 'ann@example.com', role: role.id }, 'system');
    const ann = await principalForWebUser(ctx, SPACE, {
      sub: 'usr_ann',
      email: 'ann@example.com',
      role: 'member',
    });
    const job = await start(ann);
    await updateRole(
      ctx,
      SPACE,
      role.id,
      { name: 'Reader', scopes: [SCOPES.deliveryRead], contentGrants: [] },
      { sso: false },
      'system',
    );

    expect((await run(job.id)).outcome).toEqual({ status: 'complete', value: 'failed' });
    expect(await getAppOperationJob(ctx, admin, scope, job.id)).toMatchObject({
      error: 'The person that started this operation may no longer run it',
    });
    expect(runtime.calls).toEqual([]);
  });
});
