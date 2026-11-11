import { InProcessAgentRuntime, makeActivities } from '@contentworker/agent-runtime';
import {
  type AppContext,
  createPluginOperationRunner,
  installPlugin,
  setPluginEnabled,
} from '@contentworker/application';
import { type PluginManifest, type Principal, SCOPES } from '@contentworker/domain';
import type { PluginRuntime } from '@contentworker/ports';
import {
  FakeBlobStore,
  FixedClock,
  InMemoryContentStore,
  InMemoryVectorStore,
  LocalEmbeddingsProvider,
  SequenceIdGenerator,
  StubAIProvider,
} from '@contentworker/test-kit';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { beforeEach, describe, expect, it } from 'vitest';
import type { McpDeps } from '../../src/mcp/deps';
import { buildServer } from '../../src/mcp/server';

/** App operations over MCP: two generic tools, the same use-cases as REST. */

const SPACE = 'space-1';
const admin: Principal = { spaceId: '*', kind: 'admin', scopes: Object.values(SCOPES) };
const viewer: Principal = { spaceId: SPACE, kind: 'cpa', scopes: [SCOPES.previewRead] };

const manifest: PluginManifest = {
  manifestVersion: 2,
  id: 'com.example.ops',
  name: 'Ops',
  version: '1.0.0',
  capabilities: [],
  allowedHosts: [],
  hooks: [],
  entrypoint: 'index.js',
  operations: [
    {
      name: 'shout',
      title: 'Shout',
      description: 'Upper-cases text',
      requires: SCOPES.previewRead,
      input: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    },
    {
      name: 'wipe',
      title: 'Wipe',
      description: 'Needs publishing',
      requires: SCOPES.contentPublish,
      input: { type: 'object', properties: {} },
    },
  ],
};

let deps: McpDeps;

beforeEach(async () => {
  const store = new InMemoryContentStore();
  const blob = new FakeBlobStore();
  const base: AppContext = { store, clock: new FixedClock(), ids: new SequenceIdGenerator('m') };
  const runtime: PluginRuntime = {
    async invoke(inv) {
      return { payload: inv.payload };
    },
    async runOperation(inv) {
      return { text: String((inv.input as { text: string }).text).toUpperCase() };
    },
  };
  const appOperations = createPluginOperationRunner(base, blob, runtime);
  const ctx: AppContext = { ...base, ...(appOperations ? { appOperations } : {}) };
  deps = {
    ctx,
    ai: new StubAIProvider(() => ({})),
    rag: { embeddings: new LocalEmbeddingsProvider(8), vectors: new InMemoryVectorStore() },
    hasher: { hash: (v) => v },
    adminToken: 'admin',
    agents: new InProcessAgentRuntime(makeActivities({ ctx, ai: new StubAIProvider(() => ({})) })),
  };
  await installPlugin(ctx, blob, admin, SPACE, {
    manifest,
    bundle: '// ops',
    approvedCapabilities: [],
  });
  await setPluginEnabled(ctx, SPACE, manifest.id, true);
});

async function call(principal: Principal, name: string, args: Record<string, unknown>) {
  const server = buildServer(deps, principal);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
  const res = (await client.callTool({
    name,
    arguments: { space: SPACE, ...args },
  })) as { isError?: boolean; content?: { type: string; text?: string }[] };
  const text = res.content?.find((c) => c.type === 'text')?.text ?? '';
  return { isError: res.isError === true, text };
}

describe('app_operations_list', () => {
  it('lists what the caller may invoke, with the input schema', async () => {
    const res = await call(viewer, 'app_operations_list', {});
    expect(res.isError).toBe(false);
    const { items } = JSON.parse(res.text) as { items: { name: string; input: unknown }[] };
    expect(items.map((i) => i.name)).toEqual(['shout']);
    expect(items[0]?.input).toEqual(manifest.operations?.[0]?.input);
  });
});

describe('app_operation_invoke', () => {
  it('invokes an operation and returns its output', async () => {
    const res = await call(viewer, 'app_operation_invoke', {
      plugin: manifest.id,
      operation: 'shout',
      input: { text: 'hi' },
    });
    expect(res.isError).toBe(false);
    expect(JSON.parse(res.text)).toEqual({ output: { text: 'HI' } });
  });

  it('refuses an operation the caller lacks the scope for, as REST does', async () => {
    const res = await call(viewer, 'app_operation_invoke', {
      plugin: manifest.id,
      operation: 'wipe',
      input: {},
    });
    expect(res.isError).toBe(true);
  });
});
