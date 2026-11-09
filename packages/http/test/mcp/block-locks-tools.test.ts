import { createHash } from 'node:crypto';
import { InProcessAgentRuntime, makeActivities } from '@contentworker/agent-runtime';
import {
  type AppContext,
  createContentType,
  createEntry,
  createSpace,
  publishContentType,
  SYSTEM_CALLER,
} from '@contentworker/application';
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
const reader: Principal = { spaceId: SPACE, kind: 'cpa', scopes: [SCOPES.previewRead] };
const locker: Principal = {
  spaceId: SPACE,
  kind: 'user',
  subject: 'locker@example.com',
  scopes: [SCOPES.previewRead, SCOPES.contentWrite],
  contentGrants: [{ contentTypeApiId: '*', actions: ['read', 'write', 'lock'] }],
};
const writer: Principal = {
  ...locker,
  subject: 'writer@example.com',
  contentGrants: [{ contentTypeApiId: '*', actions: ['read', 'write'] }],
};

async function setup() {
  const ctx: AppContext = {
    store: new InMemoryContentStore(),
    clock: new FixedClock(),
    ids: new SequenceIdGenerator('n'),
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
  return { ctx, deps };
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
    return {
      isError: r.isError === true,
      body: JSON.parse(text.startsWith('{') || text.startsWith('[') ? text : 'null') as never,
      text,
    };
  };
}

const field = (apiId: string, type: string, position: number) => ({
  apiId,
  name: apiId,
  type,
  position,
  localized: false,
  required: false,
});

const hero = (key: string) => ({ _type: 'hero', _key: key, heading: 'Hi' });

async function withPage() {
  const { ctx, deps } = await setup();
  const scope = { spaceId: SPACE, environmentId: 'main' };
  await createContentType(ctx, SYSTEM_CALLER, scope, {
    apiId: 'page',
    name: 'Page',
    displayField: 'title',
    fields: [
      field('title', 'Symbol', 0),
      {
        ...field('body', 'Array', 1),
        items: {
          type: 'Component',
          variants: [{ apiId: 'hero', name: 'Hero', fields: [field('heading', 'Symbol', 0)] }],
        },
      },
    ] as never,
  });
  await publishContentType(ctx, scope, 'page');
  const { entry } = await createEntry(ctx, scope, {
    contentTypeApiId: 'page',
    fields: { body: { 'en-US': [hero('a'), hero('b')] } },
  });
  return { ctx, deps, id: entry.id };
}

describe('block lock tools (MCP), on the HTTP routes’ use-cases', () => {
  it('sets against the version read, reads back, holds saves to it, and audits only the set', async () => {
    const { ctx, deps, id } = await withPage();
    const call = await connect(deps, locker);
    expect((await call('entries_block_locks_get', { id })).body).toMatchObject({
      version: 1,
      locks: [],
    });
    const set = await call('entries_block_locks_set', {
      id,
      expectedVersion: 1,
      locks: [{ field: 'body', keys: ['a', 'b'], depth: 'self' }],
    });
    expect(set.isError).toBe(false);
    expect(set.body).toMatchObject({
      unchanged: false,
      locks: [{ keys: ['a', 'b'], depth: 'self', lockedBy: 'locker@example.com' }],
    });
    expect((await call('entries_block_locks_get', { id })).body).toMatchObject({
      locks: [{ keys: ['a', 'b'] }],
    });
    const rows = await ctx.store.audit.list(SPACE, {});
    expect(
      rows.map((r) => [r.action, r.targetType, r.targetId, r.detail?.blockLocks?.locked.length]),
    ).toEqual([['MCP entries_block_locks_set', 'entry', id, 1]]);

    // A save that breaks the region, over MCP as over HTTP, is refused naming it.
    const save = await call('entries_update', {
      id,
      fields: { body: { 'en-US': [hero('b'), hero('a')] } },
    });
    expect(save.isError).toBe(true);
    expect(save.text).toContain('region_locked');

    const stale = await call('entries_block_locks_set', { id, expectedVersion: 2, locks: [] });
    expect(stale.isError).toBe(true);
  });

  it('sets only with the lock action; reads with preview:read', async () => {
    const { deps, id } = await withPage();
    const call = await connect(deps, writer);
    const refused = await call('entries_block_locks_set', {
      id,
      locks: [{ field: 'body', keys: ['a'] }],
    });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('content:lock:page');
    expect((await call('entries_block_locks_get', { id })).isError).toBe(false);
    const read = await connect(deps, reader);
    expect((await read('entries_block_locks_set', { id, locks: [] })).isError).toBe(true);
  });

  it('refuses another space’s key', async () => {
    const { deps, id } = await withPage();
    const other = await connect(deps, { ...locker, spaceId: 'space-2' });
    expect((await other('entries_block_locks_get', { id })).isError).toBe(true);
    expect((await other('entries_block_locks_set', { id, locks: [] })).isError).toBe(true);
  });
});
