import { createHash } from 'node:crypto';
import { InProcessAgentRuntime, makeActivities } from '@contentworker/agent-runtime';
import {
  type AppContext,
  authenticate,
  createSpace,
  listApiKeys,
  setEnvironmentAlias,
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
const spaceAdmin: Principal = {
  spaceId: SPACE,
  kind: 'user',
  subject: 'ada@example.com',
  scopes: [SCOPES.spaceAdmin],
};

let deps: McpDeps;

beforeEach(async () => {
  const ctx: AppContext = {
    store: new InMemoryContentStore(),
    clock: new FixedClock(),
    ids: new SequenceIdGenerator('f'),
  };
  deps = {
    ctx,
    ai: new StubAIProvider(() => ({})),
    rag: { embeddings: new LocalEmbeddingsProvider(8), vectors: new InMemoryVectorStore() },
    hasher,
    adminToken: 'admin',
    agents: new InProcessAgentRuntime(makeActivities({ ctx, ai: new StubAIProvider(() => ({})) })),
    inviteOrigin: 'https://acme.contentworker.app',
  };
  await createSpace(ctx, {
    spaceId: SPACE,
    name: 'Site',
    defaultLocale: 'en-US',
    environments: ['main', 'blue'],
  });
});

async function caller(principal: Principal) {
  const server = buildServer(deps, principal);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
  return async (args: Record<string, unknown>) => {
    const r = (await client.callTool({
      name: 'frontend_connect',
      arguments: { space: SPACE, ...args },
    })) as { isError?: boolean; content?: { type: string; text?: string }[] };
    return { isError: r.isError === true, text: r.content?.find((c) => c.type === 'text')?.text };
  };
}

describe('frontend_connect', () => {
  it('mints the keys with the endpoints, as the route does, and audits the key', async () => {
    const call = await caller(spaceAdmin);
    const res = await call({ name: 'Docs site', preview: true });
    expect(res.isError, res.text).toBe(false);
    const c = JSON.parse(res.text ?? '{}') as {
      environment: string;
      deliveryKey: { id: string; token: string };
      previewKey: { token: string };
      endpoints: { delivery: string; admin: string };
    };
    expect(c.environment).toBe('main');
    expect(c.endpoints).toMatchObject({
      admin: 'https://acme.contentworker.app',
      delivery: 'https://cdn.acme.contentworker.app',
    });
    expect((await authenticate(deps.ctx, hasher, c.deliveryKey.token)).kind).toBe('cda');
    expect((await authenticate(deps.ctx, hasher, c.previewKey.token)).kind).toBe('cpa');
    expect((await listApiKeys(deps.ctx, SPACE)).map((k) => k.name)).toEqual([
      'Docs site (delivery)',
      'Docs site (preview)',
    ]);
    const [row] = await deps.ctx.store.audit.list(SPACE, {});
    expect(row).toMatchObject({
      action: 'MCP frontend_connect',
      targetType: 'api_key',
      targetId: c.deliveryKey.id,
    });
    // The audit row keeps the call's arguments, never what it answered.
    expect(JSON.stringify(row)).not.toContain(c.deliveryKey.token);
  });

  it('keeps an alias the caller named, so the site follows its cutovers', async () => {
    await setEnvironmentAlias(deps.ctx, SPACE, 'live', 'blue');
    const call = await caller(spaceAdmin);
    const res = await call({ environment: 'live' });
    expect(res.isError, res.text).toBe(false);
    expect(JSON.parse(res.text ?? '{}').environment).toBe('live');
  });

  it('refuses a caller without space:admin and a delegated bearer, minting nothing', async () => {
    const editor = await caller({ spaceId: SPACE, kind: 'cma', scopes: [SCOPES.contentWrite] });
    expect((await editor({})).isError).toBe(true);
    const pat = await caller({ ...spaceAdmin, issuance: 'pat' });
    const refused = await pat({});
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/can't mint an API key/);
    // Another space's admin can't connect a frontend to this one.
    const outsider = await caller({ ...spaceAdmin, spaceId: 'other' });
    expect((await outsider({})).isError).toBe(true);
    expect(await listApiKeys(deps.ctx, SPACE)).toEqual([]);
  });
});
