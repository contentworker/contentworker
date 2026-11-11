import { createHash } from 'node:crypto';
import { InProcessAgentRuntime, makeActivities } from '@contentworker/agent-runtime';
import { type AppContext, createSpace, getContentType } from '@contentworker/application';
import { type Principal, SCOPES } from '@contentworker/domain';
import {
  FakeBlobStore,
  FakePasswordHasher,
  FixedClock,
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

const SPACE = 'space-1';
const admin: Principal = { spaceId: '*', kind: 'admin', scopes: Object.values(SCOPES) };

async function connect() {
  const ctx: AppContext = {
    store: new InMemoryContentStore(),
    clock: new FixedClock(),
    ids: new SequenceIdGenerator('g'),
    passwords: new FakePasswordHasher(),
  };
  const deps: McpDeps = {
    ctx,
    ai: new StubAIProvider(() => ({})),
    rag: { embeddings: new LocalEmbeddingsProvider(8), vectors: new InMemoryVectorStore() },
    hasher: { hash: (v) => createHash('sha256').update(v).digest('hex') },
    adminToken: 'admin',
    agents: new InProcessAgentRuntime(makeActivities({ ctx, ai: new StubAIProvider(() => ({})) })),
    blob: new FakeBlobStore(),
  };
  await createSpace(ctx, { spaceId: SPACE, name: 'Site', defaultLocale: 'en-US' });
  const server = buildServer(deps, admin);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: { space: SPACE, ...args } })) as {
      isError?: boolean;
      content?: { type: string; text?: string }[];
    };
    const text = r.content?.find((c) => c.type === 'text')?.text ?? 'null';
    return { isError: r.isError === true, text, body: JSON.parse(text) as unknown };
  };
  return { ctx, call };
}

const event = {
  apiId: 'event',
  name: 'Event',
  displayField: 'title',
  fields: [{ apiId: 'title', name: 'Title', type: 'Symbol', position: 0 }],
};

describe('model_create_content_type held to expectedVersion, as POST …/content-types is', () => {
  it('refuses a save made from an older version, and saves from the current one', async () => {
    const { ctx, call } = await connect();
    await call('model_create_content_type', event);
    await call('model_create_content_type', { ...event, description: 'Theirs' });

    const stale = await call('model_create_content_type', {
      ...event,
      agentInstructions: 'Mine',
      expectedVersion: 1,
    });
    expect(stale.isError).toBe(true);
    // REST's 409 body: the version it is at now is a detail, not words to read.
    expect(stale.body).toMatchObject({
      error: {
        code: 'conflict',
        message: expect.stringMatching(/version 2, not 1/),
        details: { version: 2, expectedVersion: 1 },
      },
    });
    const kept = await getContentType(ctx, { spaceId: SPACE, environmentId: 'main' }, 'event');
    expect(kept).toMatchObject({ version: 2, description: 'Theirs' });
    expect(kept.agentInstructions).toBeUndefined();

    const fresh = await call('model_create_content_type', {
      ...event,
      agentInstructions: 'Mine',
      expectedVersion: 2,
    });
    expect(fresh.isError, fresh.text).toBe(false);
    expect(fresh.body).toMatchObject({ version: 3, agentInstructions: 'Mine' });
  });

  it('still saves without one', async () => {
    const { call } = await connect();
    await call('model_create_content_type', event);
    const r = await call('model_create_content_type', { ...event, name: 'Gig' });
    expect(r.isError, r.text).toBe(false);
    expect(r.body).toMatchObject({ version: 2, name: 'Gig' });
  });
});
