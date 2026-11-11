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

/** `role_update` held to the version an agent read, as `PUT /roles/:id` is. */
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

const payload = (result: { content?: { type: string; text?: string }[] }): unknown =>
  JSON.parse(result.content?.find((c) => c.type === 'text')?.text ?? 'null');

describe('the role_update tool held to a version', () => {
  let deps: McpDeps;
  beforeEach(async () => {
    deps = makeDeps();
    await createSpace(deps.ctx, { spaceId: SPACE, name: 'S', defaultLocale: 'en-US' });
  });

  it('answers the version, saves at it, and refuses a stale one with the version in force', async () => {
    const role = await createRole(deps.ctx, SPACE, { name: 'Writers', scopes: ['preview:read'] });
    const client = await connect(deps, admin);
    const listed = payload(await client.callTool({ name: 'roles_list', arguments: {} })) as {
      id: string;
      version: number;
    }[];
    expect(listed.find((r) => r.id === role.id)?.version).toBe(1);

    const saved = payload(
      await client.callTool({
        name: 'role_update',
        arguments: { id: role.id, name: 'Authors', scopes: ['preview:read'], expectedVersion: 1 },
      }),
    );
    expect(saved).toMatchObject({ name: 'Authors', version: 2 });

    const stale = await client.callTool({
      name: 'role_update',
      arguments: { id: role.id, name: 'Mine', scopes: [], expectedVersion: 1 },
    });
    expect(stale.isError).toBe(true);
    expect(JSON.stringify(stale.content)).toMatch(/version 2, not 1/);
    expect(await getRole(deps.ctx, SPACE, role.id)).toMatchObject({ name: 'Authors', version: 2 });

    // Without a version it saves over whatever is there, as before.
    const unversioned = payload(
      await client.callTool({
        name: 'role_update',
        arguments: { id: role.id, name: 'Any', scopes: ['preview:read'] },
      }),
    );
    expect(unversioned).toMatchObject({ name: 'Any', version: 3 });
  });
});
