import { createHash } from 'node:crypto';
import { InProcessAgentRuntime, makeActivities } from '@contentworker/agent-runtime';
import {
  type AppContext,
  createEnvironment,
  createSpace,
  setEnvironmentAlias,
} from '@contentworker/application';
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
import type { McpDeps } from '../../src/mcp/deps.js';
import { buildServer } from '../../src/mcp/server.js';

const hasher = { hash: (v: string) => createHash('sha256').update(v).digest('hex') };

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
    hasher,
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

describe('environment_delete over MCP', () => {
  let deps: McpDeps;
  beforeEach(async () => {
    deps = makeDeps();
    for (const spaceId of ['space-1', 'space-2']) {
      await createSpace(deps.ctx, { spaceId, name: spaceId, defaultLocale: 'en-US' });
      await createEnvironment(deps.ctx, spaceId, 'staging');
    }
  });

  const remaining = async (spaceId: string) =>
    (await deps.ctx.store.spaces.listEnvironments(spaceId)).map((e) => e.id);

  it('refuses a key for another space, and a key without space:admin', async () => {
    const otherSpace = await connect(deps, {
      spaceId: 'space-1',
      kind: 'cma',
      scopes: [...scopesForKind('cma')],
    });
    const cross = await otherSpace.callTool({
      name: 'environment_delete',
      arguments: { environment: 'staging', confirm: 'staging', space: 'space-2' },
    });
    expect(cross.isError).toBe(true);
    const reader = await connect(deps, {
      spaceId: 'space-1',
      kind: 'cda',
      scopes: [...scopesForKind('cda')],
    });
    const denied = await reader.callTool({
      name: 'environment_delete',
      arguments: { environment: 'staging', confirm: 'staging', space: 'space-1' },
    });
    expect(denied.isError).toBe(true);
    expect(await remaining('space-1')).toContain('staging');
    expect(await remaining('space-2')).toContain('staging');
  });

  it('deletes for a space admin who confirms, and records who did it', async () => {
    const adminOfSpace: Principal = {
      spaceId: 'space-1',
      kind: 'user',
      subject: 'usr_ada',
      scopes: [SCOPES.spaceAdmin],
    };
    const client = await connect(deps, adminOfSpace);
    const unconfirmed = await client.callTool({
      name: 'environment_delete',
      arguments: { environment: 'staging', confirm: 'main', space: 'space-1' },
    });
    expect(unconfirmed.isError).toBe(true);
    const done = await client.callTool({
      name: 'environment_delete',
      arguments: { environment: 'staging', confirm: 'staging', space: 'space-1' },
    });
    expect(done.isError).toBeFalsy();
    expect(await remaining('space-1')).not.toContain('staging');
    const audit = await deps.ctx.store.audit.list('space-1', { environmentId: 'staging' });
    expect(audit.find((a) => a.action === 'environment.deleted')?.actor).toBe('usr_ada');
  });
});

describe('the environment a tool names', () => {
  let deps: McpDeps;
  const article = {
    apiId: 'article',
    name: 'Article',
    displayField: 'title',
    fields: [
      {
        apiId: 'title',
        name: 'Title',
        type: 'Symbol',
        localized: false,
        required: true,
        position: 0,
      },
    ],
  };
  const writer: Principal = { spaceId: 'space-1', kind: 'cma', scopes: [...scopesForKind('cma')] };
  beforeEach(async () => {
    deps = makeDeps();
    for (const spaceId of ['space-1', 'space-2']) {
      await createSpace(deps.ctx, { spaceId, name: spaceId, defaultLocale: 'en-US' });
      await createEnvironment(deps.ctx, spaceId, 'staging');
    }
  });

  it('must exist, so a typo collects nothing', async () => {
    const client = await connect(deps, writer);
    const typo = await client.callTool({
      name: 'model_create_content_type',
      arguments: { ...article, environment: 'stagign' },
    });
    expect(typo.isError).toBe(true);
    expect(JSON.stringify(typo.content)).toContain('not found');
    const scope = { spaceId: 'space-1', environmentId: 'stagign' };
    expect(await deps.ctx.store.contentTypes.list(scope)).toEqual([]);
  });

  it('resolves through an alias to its target', async () => {
    await setEnvironmentAlias(deps.ctx, 'space-1', 'live', 'staging');
    const client = await connect(deps, writer);
    const done = await client.callTool({
      name: 'model_create_content_type',
      arguments: { ...article, environment: 'live' },
    });
    expect(done.isError).toBeFalsy();
    const staging = { spaceId: 'space-1', environmentId: 'staging' };
    expect((await deps.ctx.store.contentTypes.list(staging)).map((t) => t.apiId)).toEqual([
      'article',
    ]);
  });

  it('is not revealed to a caller from another space', async () => {
    const client = await connect(deps, writer);
    const [real, missing] = await Promise.all(
      ['staging', 'nope'].map((environment) =>
        client.callTool({
          name: 'model_list_content_types',
          arguments: { space: 'space-2', environment },
        }),
      ),
    );
    expect(real?.content).toEqual(missing?.content);
  });
});
