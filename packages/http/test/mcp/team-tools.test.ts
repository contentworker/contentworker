import { createHash } from 'node:crypto';
import { InProcessAgentRuntime, makeActivities } from '@contentworker/agent-runtime';
import {
  type AppContext,
  addMember,
  createApiKey,
  createRole,
  createSpace,
  presetRoleId,
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

describe('MCP role presets and team tools', () => {
  let deps: McpDeps;
  beforeEach(async () => {
    deps = makeDeps();
    await createSpace(deps.ctx, { spaceId: SPACE, name: 'S', defaultLocale: 'en-US' });
  });

  it('lists the presets in order with their seeded role ids', async () => {
    const client = await connect(deps, admin);
    const presets = payload(
      await client.callTool({ name: 'role_presets_list', arguments: {} }),
    ) as { preset: string; roleId: string; scopes: string[] }[];
    expect(presets.map((p) => p.preset)).toEqual([
      'viewer',
      'approver',
      'editor',
      'manager',
      'admin',
    ]);
    expect(presets[1]?.scopes).toContain(SCOPES.workflowApprove);
  });

  it('assigns a preset to a key, and refuses demoting the last admin', async () => {
    const adminRole = await presetRoleId(deps.ctx, SPACE, 'admin');
    const only = await createApiKey(deps.ctx, hasher, {
      issuer: 'system',
      spaceId: SPACE,
      kind: 'cma',
      roleId: adminRole,
    });
    const reader = await createApiKey(deps.ctx, hasher, {
      issuer: 'system',
      spaceId: SPACE,
      kind: 'cda',
    });
    const client = await connect(deps, admin);

    const assigned = payload(
      await client.callTool({
        name: 'role_preset_assign',
        arguments: { keyId: reader.apiKey.id, preset: 'approver' },
      }),
    ) as { roleId: string };
    expect(assigned.roleId).toBe(await presetRoleId(deps.ctx, SPACE, 'approver'));

    const demote = await client.callTool({
      name: 'role_preset_assign',
      arguments: { keyId: only.apiKey.id, preset: 'editor' },
    });
    expect(demote.isError).toBe(true);
    expect(JSON.stringify(demote.content)).toMatch(/last active administrator/);

    const team = payload(await client.callTool({ name: 'team_list', arguments: {} })) as {
      adminCount: number;
      keys: { id: string; role: { preset?: string } | null }[];
    };
    expect(team.adminCount).toBe(1);
    expect(team.keys.find((k) => k.id === reader.apiKey.id)?.role?.preset).toBe('approver');
  });

  it('needs space:admin for every team tool', async () => {
    const editor: Principal = {
      spaceId: SPACE,
      kind: 'cma',
      scopes: [SCOPES.contentWrite, SCOPES.contentPublish],
    };
    const client = await connect(deps, editor);
    for (const name of ['role_presets_list', 'team_list']) {
      expect((await client.callTool({ name, arguments: {} })).isError).toBe(true);
    }
    const res = await client.callTool({
      name: 'role_preset_assign',
      arguments: { keyId: 'x', preset: 'admin' },
    });
    expect(res.isError).toBe(true);
  });

  it("refuses a delegated bearer a person's role, a widening of their role, or an invitation", async () => {
    await addMember(deps.ctx, SPACE, { email: 'keeper@example.com', role: 'admin' }, 'system');
    const grace = await addMember(
      deps.ctx,
      SPACE,
      { email: 'grace@example.com', role: 'viewer' },
      'system',
    );
    const role = await createRole(deps.ctx, SPACE, {
      name: 'Writer',
      scopes: [SCOPES.previewRead],
    });
    await addMember(deps.ctx, SPACE, { email: 'lin@example.com', role: role.id }, 'system');
    const person: Principal = {
      spaceId: SPACE,
      kind: 'user',
      subject: 'usr_ada',
      scopes: [SCOPES.spaceAdmin],
    };
    const promote = { memberId: grace.id, preset: 'admin' };
    const widen = { id: role.id, name: 'Writer', scopes: [SCOPES.previewRead, SCOPES.spaceAdmin] };
    for (const bearer of [
      { ...person, issuance: 'pat' as const },
      { ...person, issuance: 'oauth' as const, clientId: 'client-1' },
    ]) {
      const client = await connect(deps, bearer);
      const assigned = await client.callTool({ name: 'role_preset_assign', arguments: promote });
      expect(assigned.isError).toBe(true);
      expect(JSON.stringify(assigned.content)).toMatch(
        /personal access token or OAuth token can't change a person’s role; sign in/,
      );
      const widened = await client.callTool({ name: 'role_update', arguments: widen });
      expect(widened.isError).toBe(true);
      expect(JSON.stringify(widened.content)).toMatch(/can't widen a role someone on the team/);
      const invited = await client.callTool({
        name: 'invite_create',
        arguments: { email: 'mallory@example.com' },
      });
      expect(invited.isError).toBe(true);
      expect(JSON.stringify(invited.content)).toMatch(/can't invite people/);
    }
    expect((await deps.ctx.store.members.get(SPACE, grace.id))?.roleId).toBe(
      await presetRoleId(deps.ctx, SPACE, 'viewer'),
    );
    // The same person signed in to the admin, and the admin token, still can.
    const signedIn = await connect(deps, person);
    expect(
      (await signedIn.callTool({ name: 'role_preset_assign', arguments: promote })).isError,
    ).toBeFalsy();
    expect(
      (await signedIn.callTool({ name: 'role_update', arguments: widen })).isError,
    ).toBeFalsy();
    const root = await connect(deps, admin);
    expect(
      (
        await root.callTool({
          name: 'role_preset_assign',
          arguments: { memberId: grace.id, preset: 'editor' },
        })
      ).isError,
    ).toBeFalsy();
  });

  it('has no setup tool: setup is HTTP-only', async () => {
    const client = await connect(deps, admin);
    const { tools } = await client.listTools();
    expect(tools.some((t) => /setup/.test(t.name))).toBe(false);
  });
});
