import { createHash } from 'node:crypto';
import { InProcessAgentRuntime, makeActivities } from '@contentworker/agent-runtime';
import {
  type AppContext,
  createContentType,
  createEntry,
  createSpace,
  publishContentType,
  pushBlockCatalog,
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
const manager: Principal = {
  spaceId: SPACE,
  kind: 'cma',
  scopes: [SCOPES.previewRead, SCOPES.contentManage],
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

const NARROWING = {
  targets: [{ contentTypeApiId: 'page', field: 'body', blocks: ['hero'] }],
  blocks: [],
};

async function withCatalog() {
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
  await pushBlockCatalog(ctx, SYSTEM_CALLER, scope, {
    blocks: [
      { id: 'hero', name: 'Hero', fields: [{ apiId: 'heading', name: 'Heading', type: 'Symbol' }] },
      { id: 'quote', name: 'Quote', fields: [{ apiId: 'text', name: 'Text', type: 'Text' }] },
    ],
    targets: [{ contentTypeApiId: 'page', field: 'body' }],
  });
  return { ctx, deps, scope };
}

describe('block config tools (MCP), on the HTTP routes’ use-cases', () => {
  it('sets against the version read, reads it and the rules in force, and audits only the set', async () => {
    const { ctx, deps, scope } = await withCatalog();
    const call = await connect(deps, manager);
    expect((await call('blocks_config_get')).body).toMatchObject({ version: 0, targets: [] });

    const set = await call('blocks_config_set', { expectedVersion: 0, ...NARROWING });
    expect(set.isError).toBe(false);
    expect(set.body).toMatchObject({ unchanged: false, config: { version: 1, ...NARROWING } });
    expect((await call('blocks_config_get')).body).toMatchObject({ version: 1 });
    expect((await call('blocks_config_effective')).body).toMatchObject({
      configVersion: 1,
      targets: [{ field: 'body', blocks: ['hero'], narrowed: true }],
    });
    const rows = await ctx.store.audit.list(SPACE, {});
    expect(
      rows.map((r) => [r.action, r.environmentId, r.targetType, r.detail?.blockConfig?.to]),
    ).toEqual([['MCP blocks_config_set', 'main', 'block_config', 1]]);

    // Stale, and widening: refused as over HTTP.
    const stale = await call('blocks_config_set', { expectedVersion: 0, targets: [], blocks: [] });
    expect(stale.isError).toBe(true);
    expect(stale.text).toContain('at version 1, not 0');
    const wide = await call('blocks_config_set', {
      expectedVersion: 1,
      targets: [{ contentTypeApiId: 'page', field: 'body', blocks: ['card'] }],
      blocks: [],
    });
    expect(wide.isError).toBe(true);
    expect(wide.text).toContain('targets[page.body].blocks');

    // An entry save is held to it, whichever surface makes it.
    await expect(
      createEntry(ctx, scope, {
        contentTypeApiId: 'page',
        fields: { body: { 'en-US': [{ _type: 'quote', text: 'q' }] } },
      }),
    ).rejects.toThrow();
  });

  it('sets only with content:manage; reads with preview:read', async () => {
    const { deps } = await withCatalog();
    const read = await connect(deps, reader);
    const refused = await read('blocks_config_set', { expectedVersion: 0, ...NARROWING });
    expect(refused.isError).toBe(true);
    expect((await read('blocks_config_get')).isError).toBe(false);
    expect((await read('blocks_config_effective')).isError).toBe(false);
  });

  it('refuses another space’s key on every tool', async () => {
    const { deps } = await withCatalog();
    const other = await connect(deps, { ...manager, spaceId: 'space-2' });
    // `connect` sends every call to SPACE: this principal's key is space-2's.
    const set = await other('blocks_config_set', { expectedVersion: 0, ...NARROWING });
    expect(set.isError).toBe(true);
    expect((await other('blocks_config_get')).isError).toBe(true);
    expect((await other('blocks_config_effective')).isError).toBe(true);
  });
});
