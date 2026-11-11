import { env, introspectWorkflowInstance } from 'cloudflare:test';
import {
  type AppContext,
  createPluginOperationRunner,
  createSpace,
  getAppOperationJob,
  installPlugin,
  invokeAppOperation,
  setPluginEnabled,
} from '@contentworker/application';
import { type PluginManifest, type Principal, SCOPES } from '@contentworker/domain';
import { CloudflareAppOperationJobStarter } from '@contentworker/platform/app-operations';
import type { PluginOperationInvocation } from '@contentworker/ports';
import { FakeBlobStore, InMemoryContentStore, SequenceIdGenerator } from '@contentworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import { appOperationTestState } from './fixtures/app-operation';

// The real Workflows engine (miniflare) running an accepted async operation: one instance per
// job, the run step once, the outcome recorded on the job. The plugin runner is a fake; the
// Worker Loader sandbox is tested in packages/adapters.

const admin: Principal = { spaceId: '*', kind: 'admin', scopes: Object.values(SCOPES) };
const editor: Principal = {
  spaceId: '*',
  kind: 'cma',
  scopes: [SCOPES.previewRead, SCOPES.contentWrite],
};

const manifest: PluginManifest = {
  manifestVersion: 2,
  id: 'com.example.audit',
  name: 'Audit',
  version: '1.0.0',
  capabilities: ['content:read'],
  allowedHosts: [],
  hooks: [],
  entrypoint: 'index.js',
  operations: [
    {
      name: 'auditAll',
      title: 'Audit all',
      description: 'Audits in the background',
      requires: SCOPES.previewRead,
      mode: 'async',
      input: { type: 'object', properties: { fail: { type: 'boolean' } } },
      output: { type: 'object', properties: { count: { type: 'integer' } } },
    },
  ],
};

let seq = 0;

describe('AppOperationWorkflow on Cloudflare Workflows', () => {
  let ctx: AppContext;
  let scope: { spaceId: string; environmentId: string };
  let calls: PluginOperationInvocation[];
  const starter = () => new CloudflareAppOperationJobStarter(env.APP_OPERATION_WF);

  beforeEach(async () => {
    seq += 1;
    scope = { spaceId: `ops${seq}`, environmentId: 'main' };
    calls = [];
    const blob = new FakeBlobStore();
    const base: AppContext = {
      store: new InMemoryContentStore(),
      clock: { now: () => new Date() },
      ids: new SequenceIdGenerator(`ops${seq}`),
    };
    const appOperations = createPluginOperationRunner(base, blob, {
      async invoke(inv) {
        return { payload: inv.payload };
      },
      async runOperation(inv) {
        calls.push(inv);
        if ((inv.input as { fail?: boolean }).fail) throw new Error('the upstream said no');
        return { count: 7 };
      },
    });
    ctx = { ...base, ...(appOperations ? { appOperations } : {}) };
    appOperationTestState.ctx = ctx;
    await createSpace(ctx, { spaceId: scope.spaceId, name: 'Ops', defaultLocale: 'en-US' });
    await installPlugin(ctx, blob, admin, scope.spaceId, {
      manifest,
      bundle: '// audit',
      approvedCapabilities: manifest.capabilities,
    });
    await setPluginEnabled(ctx, scope.spaceId, manifest.id, true);
  });

  async function accept(input: Record<string, unknown>) {
    const result = await invokeAppOperation(ctx, editor, scope, manifest.id, 'auditAll', input);
    if (!('job' in result)) throw new Error('expected a job');
    return result.job;
  }

  it('runs an accepted job once and records its output', async () => {
    const job = await accept({});
    await using instance = await introspectWorkflowInstance(
      env.APP_OPERATION_WF,
      `appop-${job.id}`,
    );
    expect(await starter().start({ scope, jobId: job.id })).toBe(true);
    await instance.waitForStatus('complete');
    expect(await instance.getOutput()).toBe('completed');
    // A redelivered request finds the run that exists.
    expect(await starter().start({ scope, jobId: job.id })).toBe(false);
    expect(calls).toHaveLength(1);
    expect(await getAppOperationJob(ctx, editor, scope, job.id)).toMatchObject({
      status: 'completed',
      output: { count: 7 },
    });
  });

  it('records a plugin failure as the job’s, without retrying it', async () => {
    const job = await accept({ fail: true });
    await using instance = await introspectWorkflowInstance(
      env.APP_OPERATION_WF,
      `appop-${job.id}`,
    );
    await starter().start({ scope, jobId: job.id });
    await instance.waitForStatus('complete');
    expect(calls).toHaveLength(1);
    expect(await getAppOperationJob(ctx, editor, scope, job.id)).toMatchObject({
      status: 'failed',
      error: 'the upstream said no',
    });
  });
});
