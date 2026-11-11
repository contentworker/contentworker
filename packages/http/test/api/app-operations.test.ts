import { createPluginOperationRunner } from '@contentworker/application';
import type { ApiConfig } from '@contentworker/platform/config';
import type { PluginOperationInvocation, PluginRuntime } from '@contentworker/ports';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app';
import { testConfig } from './config';
import { wire } from './wire';

/** App operations over HTTP: the list, the invoke route and the per-space OpenAPI document. */

const MANIFEST = {
  manifestVersion: 2,
  id: 'com.example.ops',
  name: 'Ops',
  version: '1.0.0',
  capabilities: ['content:read'],
  allowedHosts: [],
  hooks: [],
  entrypoint: 'index.js',
  operations: [
    {
      name: 'echo',
      title: 'Echo',
      description: 'Returns its input',
      requires: 'preview:read',
      input: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      output: { type: 'object', properties: { text: { type: 'string' } } },
    },
    {
      name: 'publishAll',
      title: 'Publish all',
      description: 'Publishes',
      requires: 'content:publish',
      input: { type: 'object', properties: {} },
    },
  ],
};

const config: ApiConfig = testConfig({
  role: 'all',
  cmaKey: 'cma',
  cdaKey: 'cda',
  cpaKey: 'cpa',
  adminToken: 'admin',
  seed: {
    spaceId: 's1',
    environmentId: 'main',
    defaultLocale: 'en-US',
    locales: ['en-US'],
    scale: 1,
  },
});
const headers = (token: string) => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
});
const M = '/spaces/s1/environments/main';

let app: ReturnType<typeof createApp>;
let calls: PluginOperationInvocation[];

beforeEach(async () => {
  calls = [];
  const runtime: PluginRuntime = {
    async invoke(inv) {
      return { payload: inv.payload };
    },
    async runOperation(inv) {
      calls.push(inv);
      return inv.operation === 'echo' ? inv.input : { done: true };
    },
  };
  const wired = wire(config);
  const appOperations = createPluginOperationRunner(wired.ctx, wired.blob, runtime);
  const ctx = { ...wired.ctx, ...(appOperations ? { appOperations } : {}) };
  app = createApp(ctx, config, wired.rag, wired.blob, wired.ai);
  const install = await app.request('/spaces/s1/plugins', {
    method: 'POST',
    headers: headers('admin'),
    body: JSON.stringify({
      manifest: MANIFEST,
      bundle: 'export class Plugin {}',
      approvedCapabilities: ['content:read'],
    }),
  });
  expect(install.status).toBe(201);
  expect(await install.json()).toMatchObject({
    operations: [
      { name: 'echo', requires: 'preview:read', mode: 'sync' },
      { name: 'publishAll', requires: 'content:publish' },
    ],
  });
  await app.request('/spaces/s1/plugins/com.example.ops/enabled', {
    method: 'POST',
    headers: headers('admin'),
    body: JSON.stringify({ enabled: true }),
  });
});

const invoke = (op: string, body: unknown, token = 'cpa') =>
  app.request(`${M}/apps/com.example.ops/operations/${op}`, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify(body),
  });

describe('app operations over HTTP', () => {
  it('lists only what the caller may invoke', async () => {
    const list = async (token: string) =>
      (
        (await (await app.request(`${M}/apps/operations`, { headers: headers(token) })).json()) as {
          items: { name: string }[];
        }
      ).items.map((o) => o.name);
    expect(await list('cpa')).toEqual(['echo']);
    expect(await list('cma')).toEqual(['echo', 'publishAll']);
    expect(await list('cda')).toEqual([]);
  });

  it('invokes one and answers with its output', async () => {
    const res = await invoke('echo', { text: 'hi' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ output: { text: 'hi' } });
    expect(calls[0]?.capabilities).toEqual(['content:read']);
  });

  it('answers 422 off-schema, 403 without the scope and 404 for an unknown one', async () => {
    expect((await invoke('echo', { text: 1 })).status).toBe(422);
    expect((await invoke('publishAll', {})).status).toBe(403);
    expect((await invoke('nope', {})).status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it('describes the operations the caller may invoke as OpenAPI', async () => {
    const res = await app.request('/spaces/s1/apps/openapi.json', { headers: headers('cpa') });
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { openapi: string; paths: Record<string, unknown> };
    expect(doc.openapi).toBe('3.1.0');
    expect(Object.keys(doc.paths)).toEqual([
      '/spaces/s1/environments/{env}/apps/com.example.ops/operations/echo',
    ]);
    expect(doc.paths[Object.keys(doc.paths)[0] as string]).toMatchObject({
      post: {
        operationId: 'com.example.ops.echo',
        requestBody: { content: { 'application/json': { schema: MANIFEST.operations[0]?.input } } },
      },
    });
  });
});
