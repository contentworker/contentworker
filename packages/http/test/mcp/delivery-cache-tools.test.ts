import { createHash } from 'node:crypto';
import { InProcessAgentRuntime, makeActivities } from '@contentworker/agent-runtime';
import { type AppContext, createSpace } from '@contentworker/application';
import { type Principal, SCOPES } from '@contentworker/domain';
import {
  FakeBlobStore,
  FakePasswordHasher,
  FixedClock,
  InMemoryCache,
  InMemoryContentStore,
  InMemoryVectorStore,
  LocalEmbeddingsProvider,
  SequenceIdGenerator,
  StubAIProvider,
} from '@contentworker/test-kit';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import type { McpDeps } from '../../src/mcp/deps';
import { buildServer } from '../../src/mcp/server';

/** `delivery_cache_refresh`: the route's twin, with `content:publish`. */
const SPACE = 'space-1';
const publisher: Principal = {
  spaceId: SPACE,
  kind: 'cma',
  scopes: [SCOPES.previewRead, SCOPES.contentWrite, SCOPES.contentPublish],
};
const writer: Principal = {
  spaceId: SPACE,
  kind: 'cma',
  scopes: [SCOPES.previewRead, SCOPES.contentWrite],
};

async function setup() {
  const clock = new FixedClock();
  const store = new InMemoryContentStore();
  const ctx: AppContext = {
    store,
    clock,
    ids: new SequenceIdGenerator('n'),
    passwords: new FakePasswordHasher(),
    cache: new InMemoryCache(),
  };
  const ai = new StubAIProvider(() => ({}));
  const deps: McpDeps = {
    ctx,
    ai,
    rag: { embeddings: new LocalEmbeddingsProvider(8), vectors: new InMemoryVectorStore() },
    hasher: { hash: (v) => createHash('sha256').update(v).digest('hex') },
    adminToken: 'admin',
    agents: new InProcessAgentRuntime(makeActivities({ ctx, ai })),
    blob: new FakeBlobStore(),
  };
  await createSpace(ctx, { spaceId: SPACE, name: 'Site', defaultLocale: 'en-US' });
  return { deps, store };
}

async function connect(deps: McpDeps, principal: Principal) {
  const server = buildServer(deps, principal);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
  return async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: { space: SPACE, ...args } })) as {
      isError?: boolean;
      content?: { type: string; text?: string }[];
    };
    const text = r.content?.find((c) => c.type === 'text')?.text ?? 'null';
    return { isError: r.isError === true, text };
  };
}

describe('delivery cache tools', () => {
  it('refreshes the environment for a publisher, once a minute', async () => {
    const { deps, store } = await setup();
    const call = await connect(deps, publisher);
    const before = store.allEvents().length;
    const first = await call('delivery_cache_refresh');
    expect(first.isError).toBe(false);
    expect(JSON.parse(first.text)).toEqual({ enqueued: true, environmentId: 'main' });
    expect(store.allEvents().slice(before)).toMatchObject([{ type: 'delivery.refresh_requested' }]);
    const again = await call('delivery_cache_refresh');
    expect(again.isError).toBe(true);
    expect(again.text).toContain('refreshed recently');
  });

  it('refuses a caller that cannot publish', async () => {
    const { deps } = await setup();
    const call = await connect(deps, writer);
    const r = await call('delivery_cache_refresh');
    expect(r.isError).toBe(true);
    expect(r.text).toContain('content:publish');
  });
});
