import { createHash } from 'node:crypto';
import { InProcessAgentRuntime, makeActivities } from '@contentworker/agent-runtime';
import { type AppContext, createSpace, listPreviewEntries } from '@contentworker/application';
import { type Principal, scopesForKind } from '@contentworker/domain';
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

/** space_create and spaces_list: the MCP side of POST /spaces and GET /spaces, same checks. */
const hasher = { hash: (v: string) => createHash('sha256').update(v).digest('hex') };
const ADMIN: Principal = { spaceId: '*', kind: 'admin', scopes: [...scopesForKind('cma')] };

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
    blob: new FakeBlobStore(),
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

const text = (res: Awaited<ReturnType<Client['callTool']>>) =>
  JSON.parse((res.content as { text: string }[])[0]?.text ?? 'null');

describe('space tools over MCP', () => {
  let deps: McpDeps;
  beforeEach(async () => {
    deps = makeDeps();
    await createSpace(deps.ctx, { spaceId: 'space-1', name: 'One', defaultLocale: 'en-US' });
  });

  it('lets the deployment admin create a space with each starter', async () => {
    const admin = await connect(deps, ADMIN);
    const sample = await admin.callTool({
      name: 'space_create',
      arguments: { spaceId: 'acme', name: 'Acme', defaultLocale: 'en-US', starter: 'sample' },
    });
    expect(sample.isError).toBeFalsy();
    expect(text(sample)).toMatchObject({
      id: 'acme',
      starter: 'sample',
      installed: { contentTypes: 8, entries: 39 },
    });
    const acme = { spaceId: 'acme', environmentId: 'main' };
    expect(await listPreviewEntries(deps.ctx, acme, { locale: 'en-US', limit: 100 })).toHaveLength(
      39,
    );

    const empty = await admin.callTool({
      name: 'space_create',
      arguments: { spaceId: 'blank', name: 'Blank', defaultLocale: 'en-US' },
    });
    expect(text(empty)).toEqual({ id: 'blank', name: 'Blank', starter: 'empty' });

    const list = text(await admin.callTool({ name: 'spaces_list', arguments: {} }));
    expect(list.items.map((s: { id: string }) => s.id).sort()).toEqual([
      'acme',
      'blank',
      'space-1',
    ]);
  });

  it("refuses a space's own management and delivery keys", async () => {
    for (const kind of ['cma', 'cda'] as const) {
      const key = await connect(deps, {
        spaceId: 'space-1',
        kind,
        scopes: [...scopesForKind(kind)],
      });
      const res = await key.callTool({
        name: 'space_create',
        arguments: {
          spaceId: `by-${kind}`,
          name: 'Nope',
          defaultLocale: 'en-US',
          starter: 'sample',
        },
      });
      expect(res.isError, kind).toBe(true);
      expect(
        await deps.ctx.store.spaces.getConfig({ spaceId: `by-${kind}`, environmentId: 'main' }),
      ).toBe(null);
    }
  });

  it('refuses a person whose token is bound to one space, even with space:admin there', async () => {
    const member = await connect(deps, {
      spaceId: 'space-1',
      kind: 'user',
      subject: 'usr_1',
      scopes: [...scopesForKind('cma')],
    });
    const res = await member.callTool({
      name: 'space_create',
      arguments: { spaceId: 'mine', name: 'Mine', defaultLocale: 'en-US' },
    });
    expect(res.isError).toBe(true);
  });

  it('lists a scoped key only its own space', async () => {
    await createSpace(deps.ctx, { spaceId: 'space-2', name: 'Two', defaultLocale: 'en-US' });
    const key = await connect(deps, {
      spaceId: 'space-1',
      kind: 'cda',
      scopes: [...scopesForKind('cda')],
    });
    const list = text(await key.callTool({ name: 'spaces_list', arguments: {} }));
    expect(list.items).toEqual([{ id: 'space-1', name: 'One' }]);
  });

  it('refuses a space id the API refuses', async () => {
    const admin = await connect(deps, ADMIN);
    const res = await admin.callTool({
      name: 'space_create',
      arguments: { spaceId: '*', name: 'Star', defaultLocale: 'en-US' },
    });
    expect(res.isError).toBe(true);
  });
});
