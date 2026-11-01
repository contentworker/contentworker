import { createHash } from 'node:crypto';
import { InProcessAgentRuntime, makeActivities } from '@contentworker/agent-runtime';
import { type AppContext, createEnvironment, createSpace } from '@contentworker/application';
import { type Principal, SCOPES, scopesForKind } from '@contentworker/domain';
import {
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

const SPACE = 'space-1';

function makeDeps(): McpDeps {
  const ctx: AppContext = {
    store: new InMemoryContentStore(),
    clock: new FixedClock(),
    ids: new SequenceIdGenerator('m'),
  };
  return {
    ctx,
    ai: new StubAIProvider(() => ({})),
    rag: { embeddings: new LocalEmbeddingsProvider(8), vectors: new InMemoryVectorStore() },
    hasher: { hash: (v: string) => createHash('sha256').update(v).digest('hex') },
    adminToken: 'admin',
    agents: new InProcessAgentRuntime(makeActivities({ ctx, ai: new StubAIProvider(() => ({})) })),
  };
}

async function connect(deps: McpDeps, principal: Principal): Promise<Client> {
  const server = buildServer(deps, principal);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

function payload(result: { content?: { type: string; text?: string }[] }): unknown {
  return JSON.parse(result.content?.find((c) => c.type === 'text')?.text ?? 'null');
}

interface Summary {
  id: string;
  url: string;
  environmentId: string | null;
}

const admin: Principal = { spaceId: SPACE, kind: 'user', scopes: [SCOPES.spaceAdmin] };
const hook = { url: 'https://hooks.example.com/cw', topics: ['*'], secret: 'shh' };

describe('webhook tools over MCP', () => {
  let deps: McpDeps;
  let client: Client;
  const call = async (name: string, args: Record<string, unknown>) =>
    client.callTool({ name, arguments: args });
  const ids = async (environment: string) =>
    (payload(await call('webhooks_list', { environment })) as { items: Summary[] }).items
      .map((h) => h.id)
      .sort();

  beforeEach(async () => {
    deps = makeDeps();
    await createSpace(deps.ctx, { spaceId: SPACE, name: 'Shop', defaultLocale: 'en-US' });
    await createEnvironment(deps.ctx, SPACE, 'staging');
    client = await connect(deps, admin);
  });

  it('creates, lists, updates and deletes through the same use-cases as REST', async () => {
    const scoped = payload(
      await call('webhook_create', { ...hook, environment: 'staging' }),
    ) as Summary;
    expect(scoped.environmentId).toBe('staging');
    // The signing secret is the caller's own and is never echoed, as REST.
    expect(scoped).not.toHaveProperty('secret');
    const wide = payload(
      await call('webhook_create', { ...hook, allEnvironments: true, environment: 'staging' }),
    ) as Summary;
    expect(wide.environmentId).toBeNull();
    const mainHook = payload(await call('webhook_create', hook)) as Summary;
    expect(mainHook.environmentId).toBe('main');

    expect(await ids('staging')).toEqual([scoped.id, wide.id].sort());
    expect(await ids('main')).toEqual([mainHook.id, wide.id].sort());

    // Another environment's hook is not found from here.
    expect((await call('webhook_update', { id: scoped.id, active: false })).isError).toBe(true);
    expect((await call('webhook_delete', { id: scoped.id })).isError).toBe(true);
    expect((await call('webhook_deliveries', { id: scoped.id })).isError).toBe(true);

    const kept = payload(
      await call('webhook_update', { id: scoped.id, active: false, environment: 'staging' }),
    ) as Summary & { active: boolean };
    expect(kept).toMatchObject({ active: false, environmentId: 'staging' });
    const moved = payload(
      await call('webhook_update', {
        id: scoped.id,
        allEnvironments: true,
        environment: 'staging',
      }),
    ) as Summary;
    expect(moved.environmentId).toBeNull();

    expect(
      payload(await call('webhook_deliveries', { id: scoped.id, limit: 5 })) as { items: [] },
    ).toEqual({ items: [] });
    expect(payload(await call('webhook_delete', { id: scoped.id }))).toEqual({
      deleted: scoped.id,
    });
    expect(await ids('staging')).toEqual([wide.id]);
  });

  it('refuses a private target, as REST does', async () => {
    const res = await call('webhook_create', { ...hook, url: 'http://127.0.0.1/hook' });
    expect(res.isError).toBe(true);
    expect(await ids('main')).toEqual([]);
  });

  it('refuses a key without space:admin, and one for another space', async () => {
    const editor = await connect(deps, {
      spaceId: SPACE,
      kind: 'cma',
      scopes: [...scopesForKind('cma')].filter((s) => s !== SCOPES.spaceAdmin),
    });
    expect((await editor.callTool({ name: 'webhooks_list', arguments: {} })).isError).toBe(true);
    expect((await editor.callTool({ name: 'webhook_create', arguments: hook })).isError).toBe(true);
    const other = await connect(deps, {
      spaceId: 'space-2',
      kind: 'user',
      scopes: [SCOPES.spaceAdmin],
    });
    expect(
      (await other.callTool({ name: 'webhook_create', arguments: { ...hook, space: SPACE } }))
        .isError,
    ).toBe(true);
    expect(await ids('main')).toEqual([]);
  });
});
