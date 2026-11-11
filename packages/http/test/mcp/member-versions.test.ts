import { createHash } from 'node:crypto';
import { InProcessAgentRuntime, makeActivities } from '@contentworker/agent-runtime';
import {
  type AppContext,
  addMember,
  createApiKey,
  createSpace,
  NO_SSO,
  presetRoleId,
  updateMember,
} from '@contentworker/application';
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

/** `role_preset_assign` for a person held to the version an agent read, as `PATCH /members/:id` is. */
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

describe('role_preset_assign for a person held to a version', () => {
  let deps: McpDeps;
  beforeEach(async () => {
    deps = makeDeps();
    await createSpace(deps.ctx, { spaceId: SPACE, name: 'S', defaultLocale: 'en-US' });
  });

  it('lists the version, assigns at it, and refuses a stale one with the version in force', async () => {
    const ada = await addMember(
      deps.ctx,
      SPACE,
      { email: 'ada@example.com', role: 'editor' },
      'system',
    );
    const client = await connect(deps, admin);
    const team = payload(await client.callTool({ name: 'team_list', arguments: {} })) as {
      people: { id: string; version: number }[];
    };
    expect(team.people.find((p) => p.id === ada.id)?.version).toBe(1);

    const given = payload(
      await client.callTool({
        name: 'role_preset_assign',
        arguments: { memberId: ada.id, preset: 'viewer', expectedVersion: 1 },
      }),
    );
    expect(given).toMatchObject({
      roleId: await presetRoleId(deps.ctx, SPACE, 'viewer'),
      version: 2,
    });

    // Someone turns Ada's access off; the agent's read is now stale.
    await updateMember(deps.ctx, SPACE, ada.id, { disabled: true }, NO_SSO, 'system');
    const stale = await client.callTool({
      name: 'role_preset_assign',
      arguments: { memberId: ada.id, preset: 'manager', expectedVersion: 2 },
    });
    expect(stale.isError).toBe(true);
    expect(JSON.stringify(stale.content)).toMatch(/version 3, not 2/);
    expect(await deps.ctx.store.members.get(SPACE, ada.id)).toMatchObject({
      roleId: await presetRoleId(deps.ctx, SPACE, 'viewer'),
      disabled: true,
      version: 3,
    });

    // Without a version it changes the role only, over whatever is there.
    const unversioned = payload(
      await client.callTool({
        name: 'role_preset_assign',
        arguments: { memberId: ada.id, preset: 'manager' },
      }),
    );
    expect(unversioned).toMatchObject({ disabled: true, version: 4 });
  });

  it('refuses a version with a key, which has none', async () => {
    const { apiKey } = await createApiKey(deps.ctx, hasher, {
      issuer: 'system',
      spaceId: SPACE,
      kind: 'cma',
    });
    const client = await connect(deps, admin);
    const res = await client.callTool({
      name: 'role_preset_assign',
      arguments: { keyId: apiKey.id, preset: 'viewer', expectedVersion: 1 },
    });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/Only a person/);
  });
});
