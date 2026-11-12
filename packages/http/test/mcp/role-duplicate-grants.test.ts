import { createHash } from 'node:crypto';
import { InProcessAgentRuntime, makeActivities } from '@contentworker/agent-runtime';
import { type AppContext, createRole, createSpace, getRole } from '@contentworker/application';
import { type Principal, SCOPES } from '@contentworker/domain';
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

/** `role_create` and `role_update` refuse a repeated content grant as `POST`/`PUT /roles` do. */
const SPACE = 'space-1';
const hasher = { hash: (v: string) => createHash('sha256').update(v).digest('hex') };
const admin: Principal = { spaceId: '*', kind: 'admin', scopes: Object.values(SCOPES) };

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

type ToolResult = { isError?: boolean; content?: { type: string; text?: string }[] };
const payload = (result: ToolResult): unknown =>
  JSON.parse(result.content?.find((c) => c.type === 'text')?.text ?? 'null');

describe('repeated content grants over MCP', () => {
  let deps: McpDeps;
  beforeEach(async () => {
    deps = makeDeps();
    await createSpace(deps.ctx, { spaceId: SPACE, name: 'S', defaultLocale: 'en-US' });
  });

  it('refuses role_create naming a type twice with the REST 422 body', async () => {
    const client = await connect(deps, admin);
    const result = (await client.callTool({
      name: 'role_create',
      arguments: {
        name: 'Two posts',
        scopes: ['content:write'],
        contentGrants: [
          { contentTypeApiId: 'post', actions: ['read'] },
          { contentTypeApiId: 'post', actions: ['write'] },
        ],
      },
    })) as ToolResult;
    expect(result.isError).toBe(true);
    expect(payload(result)).toMatchObject({
      error: {
        code: 'validation_failed',
        issues: [
          {
            field: 'contentGrants',
            message: 'More than one grant names "post"; merge them into one',
          },
        ],
      },
    });
  });

  it('refuses role_update with two wildcard grants and leaves the role as it was', async () => {
    const role = await createRole(deps.ctx, SPACE, {
      name: 'Readers',
      scopes: ['preview:read'],
      contentGrants: [{ contentTypeApiId: '*', actions: ['read'] }],
    });
    const client = await connect(deps, admin);
    const result = (await client.callTool({
      name: 'role_update',
      arguments: {
        id: role.id,
        name: 'Readers',
        scopes: ['preview:read'],
        contentGrants: [
          { contentTypeApiId: '*', actions: ['read'] },
          { contentTypeApiId: '*', actions: ['read', 'write'] },
        ],
        expectedVersion: 1,
      },
    })) as ToolResult;
    expect(result.isError).toBe(true);
    expect(payload(result)).toMatchObject({
      error: {
        code: 'validation_failed',
        issues: [
          {
            field: 'contentGrants',
            message: 'More than one grant covers every type ("*"); merge them into one',
          },
        ],
      },
    });
    expect(await getRole(deps.ctx, SPACE, role.id)).toEqual(role);
  });
});
