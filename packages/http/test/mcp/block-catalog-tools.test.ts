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
const admin: Principal = { spaceId: '*', kind: 'admin', scopes: Object.values(SCOPES) };
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
  const blob = new FakeBlobStore();
  const deps: McpDeps = {
    ctx,
    ai: new StubAIProvider(() => ({})),
    rag: { embeddings: new LocalEmbeddingsProvider(8), vectors: new InMemoryVectorStore() },
    hasher: { hash: (v) => createHash('sha256').update(v).digest('hex') },
    adminToken: 'admin',
    agents: new InProcessAgentRuntime(makeActivities({ ctx, ai: new StubAIProvider(() => ({})) })),
    blob,
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
  const call = async (name: string, args: Record<string, unknown> = {}) => {
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
  return call;
}

const field = (apiId: string, type: string, position: number) => ({
  apiId,
  name: apiId,
  type,
  position,
  localized: false,
  required: false,
});

const BLOCKS = [
  {
    id: 'hero',
    name: 'Hero',
    fields: [{ apiId: 'heading', name: 'Heading', type: 'Symbol' }],
  },
  { id: 'quote', name: 'Quote', fields: [{ apiId: 'text', name: 'Text', type: 'Text' }] },
];
const TARGETS = [{ contentTypeApiId: 'page', field: 'body' }];

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
  return { ctx, deps, scope };
}

describe('block catalog tools (MCP), on the HTTP routes’ use-cases', () => {
  it('dry-runs, pushes against the reviewed version, and reads the catalog, versions and usage', async () => {
    const { ctx, deps, scope } = await withPage();
    const call = await connect(deps, {
      ...manager,
      scopes: [...manager.scopes, SCOPES.contentPublish],
    });
    expect((await call('blocks_catalog_get')).isError).toBe(true);

    const dry = await call('blocks_catalog_push', {
      blocks: BLOCKS,
      targets: TARGETS,
      dryRun: true,
    });
    expect(dry.isError).toBe(false);
    expect(dry.body).toMatchObject({
      dryRun: true,
      previousVersion: 0,
      contentTypes: [{ contentTypeApiId: 'page', fields: [{ added: ['quote'] }] }],
    });
    const pushed = await call('blocks_catalog_push', {
      blocks: BLOCKS,
      targets: TARGETS,
      expectedVersion: 0,
    });
    expect(pushed.body).toMatchObject({ applied: true, version: 1 });

    await createEntry(ctx, scope, {
      contentTypeApiId: 'page',
      fields: { title: { 'en-US': 'Home' }, body: { 'en-US': [{ _type: 'quote', text: 'q' }] } },
    });
    const got = await call('blocks_catalog_get');
    expect((got.body as { blocks: { id: string }[] }).blocks.map((b) => b.id)).toEqual([
      'hero',
      'quote',
    ]);
    expect((await call('blocks_catalog_get', { version: 1 })).isError).toBe(false);
    expect((await call('blocks_catalog_versions')).body).toMatchObject({ items: [{ version: 1 }] });
    expect((await call('blocks_usage')).body).toMatchObject({
      blocks: [
        { id: 'hero', entries: 0 },
        { id: 'quote', entries: 1 },
      ],
    });

    // A removal the entry still holds is refused, as over HTTP.
    const removing = await call('blocks_catalog_push', {
      blocks: BLOCKS.slice(0, 1),
      targets: TARGETS,
      allowDestructive: true,
    });
    expect(removing.isError).toBe(true);
    expect(removing.text).toContain('page.body: quote');
  });

  it('pushes only with content:manage; reads with preview:read', async () => {
    const { deps } = await withPage();
    // content:manage alone pushes drafts; publishing takes content:publish, as everywhere.
    const manage = await connect(deps, manager);
    expect(
      (await manage('blocks_catalog_push', { blocks: BLOCKS, targets: TARGETS })).isError,
    ).toBe(true);
    expect(
      (
        await manage('blocks_catalog_push', {
          blocks: BLOCKS,
          targets: TARGETS,
          publish: false,
          allowDestructive: true,
        })
      ).isError,
    ).toBe(false);
    const read = await connect(deps, reader);
    const refused = await read('blocks_catalog_push', {
      blocks: BLOCKS,
      targets: TARGETS,
      dryRun: true,
    });
    expect(refused.isError).toBe(true);
    const write = await connect(deps, admin);
    await write('blocks_catalog_push', { blocks: BLOCKS, targets: TARGETS });
    expect((await read('blocks_catalog_get')).isError).toBe(false);
    expect((await read('blocks_usage')).isError).toBe(false);
  });
});
