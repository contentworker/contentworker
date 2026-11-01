import { createHash } from 'node:crypto';
import { InProcessAgentRuntime, makeActivities } from '@contentworker/agent-runtime';
import {
  type AppContext,
  createAsset,
  createContentType,
  createEntry,
  createSpace,
  listAssetRenditions,
  publishAsset,
  publishContentType,
  publishEntry,
} from '@contentworker/application';
import { type Principal, SCOPES } from '@contentworker/domain';
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
import { describe, expect, it } from 'vitest';
import type { McpDeps } from '../../src/mcp/deps';
import { buildServer } from '../../src/mcp/server';

const SPACE = 'space-1';
const scope = { spaceId: SPACE, environmentId: 'main' };
const admin: Principal = { spaceId: '*', kind: 'admin', scopes: Object.values(SCOPES) };
const reader: Principal = { spaceId: SPACE, kind: 'cpa', scopes: [SCOPES.previewRead] };

async function setup() {
  const ctx: AppContext = {
    store: new InMemoryContentStore(),
    clock: new FixedClock(),
    ids: new SequenceIdGenerator('m'),
  };
  const deps: McpDeps = {
    ctx,
    ai: new StubAIProvider(() => ({})),
    rag: { embeddings: new LocalEmbeddingsProvider(8), vectors: new InMemoryVectorStore() },
    hasher: { hash: (v) => createHash('sha256').update(v).digest('hex') },
    adminToken: 'admin',
    agents: new InProcessAgentRuntime(makeActivities({ ctx, ai: new StubAIProvider(() => ({})) })),
  };
  await createSpace(ctx, { spaceId: SPACE, name: 'Shop', defaultLocale: 'en-US' });
  const blob = new FakeBlobStore();
  const add = async (fileName: string, contentType: string) =>
    (await createAsset(ctx, blob, scope, { fileName, contentType })).asset;
  return { ctx, deps, add };
}

async function connect(deps: McpDeps, principal: Principal): Promise<Client> {
  const server = buildServer(deps, principal);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

function payload(result: { content?: { type: string; text?: string }[] }): unknown {
  return JSON.parse(result.content?.find((c) => c.type === 'text')?.text ?? 'null');
}

describe('asset library tools (MCP), on the same use-cases as the HTTP routes', () => {
  it('lists with filters and a cursor', async () => {
    const { deps, add } = await setup();
    const png = await add('a.png', 'image/png');
    await add('b.pdf', 'application/pdf');
    await add('c.png', 'image/png');
    const client = await connect(deps, reader);

    const first = payload(
      await client.callTool({
        name: 'assets_list',
        arguments: { kind: 'image', limit: 1, sort: 'updatedAt', order: 'asc', space: SPACE },
      }),
    ) as { items: { id: string }[]; nextCursor?: string };
    expect(first.items.map((a) => a.id)).toEqual([png.id]);
    expect(first.nextCursor).toBeTruthy();
    const next = payload(
      await client.callTool({
        name: 'assets_list',
        arguments: {
          kind: 'image',
          limit: 1,
          sort: 'updatedAt',
          order: 'asc',
          cursor: first.nextCursor,
          space: SPACE,
        },
      }),
    ) as { items: { id: string }[]; nextCursor?: string };
    expect(next.items).toHaveLength(1);
    expect(next.nextCursor).toBeUndefined();
  });

  it('manages folders and moves assets into them', async () => {
    const { deps, add } = await setup();
    const a = await add('a.png', 'image/png');
    const client = await connect(deps, admin);
    const call = async (name: string, args: Record<string, unknown>) =>
      client.callTool({ name, arguments: { space: SPACE, ...args } });

    const folder = payload(await call('asset_folders_create', { name: 'Brand' })) as {
      id: string;
    };
    const moved = payload(await call('assets_move', { ids: [a.id], folderId: folder.id }));
    expect(moved).toEqual({ moved: 1 });
    const inFolder = payload(await call('assets_list', { folderId: folder.id })) as {
      items: { id: string }[];
    };
    expect(inFolder.items.map((x) => x.id)).toEqual([a.id]);

    const renamed = payload(
      await call('asset_folders_update', { id: folder.id, name: 'Brand kit' }),
    );
    expect(renamed).toMatchObject({ name: 'Brand kit' });
    expect((await call('asset_folders_delete', { id: folder.id })).isError).toBe(true);
    await call('assets_move', { ids: [a.id], folderId: null });
    expect(payload(await call('asset_folders_delete', { id: folder.id }))).toEqual({
      deleted: folder.id,
    });
    expect(payload(await call('asset_folders_list', {}))).toEqual([]);
  });

  it('archives, restores and deletes; a linked asset comes back with its usage', async () => {
    const { ctx, deps, add } = await setup();
    const linked = await add('hero.png', 'image/png');
    await publishAsset(ctx, scope, linked.id);
    await createContentType(ctx, scope, {
      apiId: 'page',
      name: 'Page',
      displayField: 'title',
      fields: [
        {
          apiId: 'title',
          name: 'T',
          type: 'Symbol',
          localized: false,
          required: true,
          position: 0,
        },
        {
          apiId: 'hero',
          name: 'Hero',
          type: 'Link',
          linkType: 'Asset',
          localized: false,
          required: false,
          position: 1,
        },
      ],
    });
    await publishContentType(ctx, scope, 'page');
    const { entry } = await createEntry(ctx, scope, {
      contentTypeApiId: 'page',
      fields: { title: { 'en-US': 'P' }, hero: { 'en-US': { id: linked.id, linkType: 'Asset' } } },
    });
    await publishEntry(ctx, scope, entry.id);
    const client = await connect(deps, admin);
    const call = (name: string, id: string) =>
      client.callTool({ name, arguments: { id, space: SPACE } });

    expect(payload(await call('asset_archive', linked.id))).toMatchObject({ status: 'archived' });
    expect(payload(await call('asset_restore', linked.id))).toMatchObject({ status: 'draft' });

    const refused = await call('asset_delete', linked.id);
    expect(refused.isError).toBe(true);
    expect(payload(refused)).toMatchObject({
      error: { code: 'asset_in_use', usage: [{ fromEntryId: entry.id, toId: linked.id }] },
    });

    const free = await add('free.png', 'image/png');
    expect(payload(await call('asset_delete', free.id))).toEqual({ deleted: free.id });
  });

  it('holds writes to the same scopes as the API', async () => {
    const { deps, add } = await setup();
    const a = await add('a.png', 'image/png');
    const client = await connect(deps, reader);
    for (const [name, args] of [
      ['assets_move', { ids: [a.id], folderId: null }],
      ['asset_archive', { id: a.id }],
      ['asset_restore', { id: a.id }],
      ['asset_delete', { id: a.id }],
      ['asset_folders_create', { name: 'X' }],
    ] as const) {
      const res = await client.callTool({ name, arguments: { space: SPACE, ...args } });
      expect(res.isError, name).toBe(true);
    }
    const editor = await connect(deps, {
      spaceId: SPACE,
      kind: 'cma',
      scopes: [SCOPES.previewRead, SCOPES.contentWrite],
    });
    // Archiving and deleting take content:publish, as on HTTP.
    expect(
      (await editor.callTool({ name: 'asset_archive', arguments: { id: a.id, space: SPACE } }))
        .isError,
    ).toBe(true);
    expect(
      (await editor.callTool({ name: 'asset_delete', arguments: { id: a.id, space: SPACE } }))
        .isError,
    ).toBe(true);
  });

  it('manages rendition presets on the same use-cases as REST, with the same scopes', async () => {
    const { ctx, deps } = await setup();
    const blob = new FakeBlobStore();
    const client = await connect({ ...deps, blob }, admin);
    const call = async (name: string, args: Record<string, unknown>) =>
      client.callTool({ name, arguments: { space: SPACE, ...args } });

    const created = payload(
      await call('asset_renditions_create', { name: 'thumb', width: 200, fit: 'crop' }),
    );
    expect(created).toMatchObject({ name: 'thumb', width: 200, fit: 'crop' });
    expect((await call('asset_renditions_create', { name: 'thumb', width: 1 })).isError).toBe(true);
    expect(
      payload(await call('asset_renditions_update', { name: 'thumb', width: 300 })),
    ).toMatchObject({ name: 'thumb', width: 300 });
    // What MCP wrote is what the REST route reads: the same store, the same use-case.
    expect((await listAssetRenditions(ctx, scope)).map((r) => [r.name, r.width])).toEqual([
      ['thumb', 300],
    ]);
    expect(payload(await call('asset_renditions_list', {}))).toMatchObject({
      items: [{ name: 'thumb', width: 300 }],
    });

    // A Preview key reads presets but can't change them (content:manage, as on REST).
    const reader_ = await connect(deps, reader);
    expect(
      payload(
        await reader_.callTool({ name: 'asset_renditions_list', arguments: { space: SPACE } }),
      ),
    ).toMatchObject({ items: [{ name: 'thumb' }] });
    const denied = await reader_.callTool({
      name: 'asset_renditions_delete',
      arguments: { space: SPACE, name: 'thumb' },
    });
    expect(denied.isError).toBe(true);

    expect(payload(await call('asset_renditions_delete', { name: 'thumb' }))).toEqual({
      deleted: 'thumb',
    });
    expect(payload(await call('asset_renditions_list', {}))).toEqual({ items: [] });
  });

  it('hands out short-lived signed URLs in asset reads, as REST does', async () => {
    const { deps, add } = await setup();
    const a = await add('a.png', 'image/png');
    const client = await connect({ ...deps, blob: new FakeBlobStore() }, admin);
    const listed = payload(
      await client.callTool({ name: 'assets_list', arguments: { space: SPACE } }),
    ) as { items: { id: string; file: { url: string } }[] };
    expect(listed.items.find((x) => x.id === a.id)?.file.url).toMatch(/\?ttl=900$/);
    const archived = payload(
      await client.callTool({ name: 'asset_archive', arguments: { space: SPACE, id: a.id } }),
    ) as { file: { url: string } };
    expect(archived.file.url).toMatch(/\?ttl=900$/);
  });
});
