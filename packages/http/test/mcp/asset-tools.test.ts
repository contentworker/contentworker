import { createHash } from 'node:crypto';
import { InProcessAgentRuntime, makeActivities } from '@contentworker/agent-runtime';
import {
  type AppContext,
  auditActor,
  createAsset,
  createContentType,
  createEntry,
  createSpace,
  getPreviewAsset,
  listAssetRenditions,
  listPreviewAssets,
  publishAsset,
  publishContentType,
  publishEntry,
} from '@contentworker/application';
import { type Principal, SCOPES } from '@contentworker/domain';
import {
  FakeAssetIngestQueue,
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
      error: {
        code: 'asset_in_use',
        usage: [
          { fromEntryId: entry.id, toId: linked.id, contentTypeApiId: 'page', entryTitle: 'P' },
        ],
        total: 1,
      },
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

  it('reads assets as Preview does, with the same use-cases, scope and refusals as REST', async () => {
    const { ctx, deps, add } = await setup();
    const blob = new FakeBlobStore();
    const draft = await add('draft.png', 'image/png');
    const live = await add('live.pdf', 'application/pdf');
    await publishAsset(ctx, scope, live.id);
    const withBlob = { ...deps, blob };
    const client = await connect(withBlob, reader);
    const call = async (name: string, args: Record<string, unknown>) =>
      client.callTool({ name, arguments: { space: SPACE, ...args } });

    // The same payloads the use-cases (and so the REST routes) give.
    const got = await call('asset_preview_get', { id: draft.id });
    expect(got.isError).toBeFalsy();
    expect(payload(got)).toEqual(
      JSON.parse(JSON.stringify(await getPreviewAsset(ctx, blob, scope, draft.id))),
    );
    const page = await listPreviewAssets(ctx, blob, scope, { filters: { kind: 'image' } });
    expect(payload(await call('asset_preview_list', { kind: 'image' }))).toEqual(
      JSON.parse(JSON.stringify({ ...page, total: page.items.length })),
    );
    expect(page.items.map((a) => a.id)).toEqual([draft.id]);

    // previewRead is required: a Delivery-only key is refused both.
    const cda: Principal = { spaceId: SPACE, kind: 'cda', scopes: [SCOPES.deliveryRead] };
    const delivery = await connect(withBlob, cda);
    for (const name of ['asset_preview_get', 'asset_preview_list']) {
      const res = await delivery.callTool({ name, arguments: { space: SPACE, id: draft.id } });
      expect(res.isError, name).toBe(true);
    }

    // A key with content grants reads no assets: an empty list, a refused get.
    const granted = await connect(withBlob, {
      ...reader,
      contentGrants: [{ contentTypeApiId: 'page', actions: ['read'] }],
    } as Principal);
    expect(
      payload(await granted.callTool({ name: 'asset_preview_list', arguments: { space: SPACE } })),
    ).toEqual({ items: [], total: 0 });
    const refused = await granted.callTool({
      name: 'asset_preview_get',
      arguments: { space: SPACE, id: draft.id },
    });
    expect(refused.isError).toBe(true);
  });
});

describe('asset search and ingest tools (MCP), on the same use-cases as the HTTP routes', () => {
  it('assets_search searches the library, or what Delivery serves with delivered: true', async () => {
    const { ctx, deps, add } = await setup();
    const draft = await add('mug-draft.png', 'image/png');
    const live = await add('mug.pdf', 'application/pdf');
    await publishAsset(ctx, scope, live.id);
    const client = await connect(deps, admin);
    const search = async (args: Record<string, unknown>) =>
      payload(
        await client.callTool({ name: 'assets_search', arguments: { space: SPACE, ...args } }),
      ) as {
        items: { id: string }[];
        total: number;
        facets: { kind: Record<string, number> };
      };

    const lib = await search({ q: 'mug' });
    expect(lib.items.map((a) => a.id).sort()).toEqual([draft.id, live.id].sort());
    expect(lib.facets.kind).toEqual({ image: 1, document: 1 });
    expect((await search({ q: 'mug', kind: 'image' })).items.map((a) => a.id)).toEqual([draft.id]);
    expect((await search({ q: 'mug', delivered: true })).items.map((a) => a.id)).toEqual([live.id]);
  });

  it('checks scopes as the routes do', async () => {
    const { deps, add } = await setup();
    await add('mug.png', 'image/png');
    const deliveryOnly: Principal = {
      spaceId: SPACE,
      kind: 'cda',
      scopes: [SCOPES.deliveryRead],
    };
    const cda = await connect(deps, deliveryOnly);
    const lib = await cda.callTool({
      name: 'assets_search',
      arguments: { space: SPACE, q: 'mug' },
    });
    expect(lib.isError).toBe(true);
    // delivered: true is Delivery's ?q=: delivery:read and search:read.
    const deliveredReadOnly = await cda.callTool({
      name: 'assets_search',
      arguments: { space: SPACE, q: 'mug', delivered: true },
    });
    expect(deliveredReadOnly.isError).toBe(true);
    const searcher = await connect(deps, {
      ...deliveryOnly,
      scopes: [SCOPES.deliveryRead, SCOPES.searchRead],
    });
    const delivered = await searcher.callTool({
      name: 'assets_search',
      arguments: { space: SPACE, q: 'mug', delivered: true },
    });
    expect(delivered.isError).toBeFalsy();
    const granted = await connect(deps, {
      ...deliveryOnly,
      scopes: [SCOPES.deliveryRead, SCOPES.searchRead],
      contentGrants: [{ contentTypeApiId: 'post', actions: ['read'] }],
    } as Principal);
    expect(
      payload(
        await granted.callTool({
          name: 'assets_search',
          arguments: { space: SPACE, q: 'mug', delivered: true },
        }),
      ),
    ).toEqual({ items: [], total: 0, facets: { kind: {}, tag: {}, folder: {} } });
    const r = await connect(deps, reader);
    for (const [name, args] of [
      ['asset_reingest', { id: 'x' }],
      ['assets_reindex', {}],
    ] as const) {
      expect((await r.callTool({ name, arguments: { space: SPACE, ...args } })).isError, name).toBe(
        true,
      );
    }
  });

  it('asset_reingest queues a run; assets_reindex starts the bulk job', async () => {
    const { deps, add } = await setup();
    const a = await add('mug.png', 'image/png');
    const queue = new FakeAssetIngestQueue();
    const client = await connect({ ...deps, assetIngest: queue }, admin);
    const out = payload(
      await client.callTool({ name: 'asset_reingest', arguments: { space: SPACE, id: a.id } }),
    );
    expect(out).toMatchObject({ id: a.id, ingestStatus: 'pending' });
    expect(queue.requested).toHaveLength(1);
    const job = payload(
      // all: the re-ingested asset is pending, which the default reindex leaves alone.
      await client.callTool({ name: 'assets_reindex', arguments: { space: SPACE, all: true } }),
    );
    expect(job).toMatchObject({ assets: 1, job: { action: 'asset_reindex' } });
    // Without the queue it says so rather than doing nothing.
    const bare = await connect(deps, admin);
    expect(
      (await bare.callTool({ name: 'asset_reingest', arguments: { space: SPACE, id: a.id } }))
        .isError,
    ).toBe(true);
    const reindex = await bare.callTool({ name: 'assets_reindex', arguments: { space: SPACE } });
    expect(reindex.isError).toBe(true);
    expect(JSON.stringify(reindex.content)).toMatch(/ASSET_EVENTS_QUEUE/);
  });
});

describe('asset version, rights and bulk tools (MCP), with the HTTP routes’ scopes', () => {
  const writer: Principal = {
    spaceId: SPACE,
    kind: 'cma',
    // A key's subject is its id; the version history names the key kind, as REST records it.
    subject: 'key-1',
    scopes: [SCOPES.contentWrite, SCOPES.previewRead],
  };

  it('replaces a file, lists versions and restores one, as a write key may', async () => {
    const { deps, add } = await setup();
    const blob = new FakeBlobStore();
    const a = await add('hero.png', 'image/png');
    await blob.put(`${SPACE}/main/${a.id}/hero.png`, 'v1', 'image/png');
    const client = await connect({ ...deps, blob }, writer);
    const call = async (name: string, args: Record<string, unknown>) =>
      client.callTool({ name, arguments: { space: SPACE, ...args } });

    const started = payload(
      await call('asset_replace_file', {
        id: a.id,
        fileName: 'hero-2.png',
        contentType: 'image/png',
      }),
    ) as { commit: { version: number; fileName: string; contentType: string; attempt: string } };
    expect(started.commit).toEqual({
      version: 2,
      fileName: 'hero-2.png',
      contentType: 'image/png',
      attempt: expect.any(String),
    });
    const early = await call('asset_commit_file', { id: a.id, ...started.commit });
    expect(early.isError).toBe(true);

    await blob.put(
      `${SPACE}/main/${a.id}/v2/file-${started.commit.attempt}/hero-2.png`,
      'v2',
      'image/png',
    );
    expect(payload(await call('asset_commit_file', { id: a.id, ...started.commit }))).toMatchObject(
      { version: 2, file: { fileName: 'hero-2.png' } },
    );
    const versions = payload(await call('asset_versions_list', { id: a.id })) as {
      items: { version: number; current: boolean }[];
    };
    expect(versions.items.map((v) => v.version)).toEqual([2, 1]);
    expect(payload(await call('asset_restore_version', { id: a.id, version: 1 }))).toMatchObject({
      version: 3,
      file: { fileName: 'hero.png' },
    });
    const history = payload(await call('asset_versions_list', { id: a.id })) as {
      items: { version: number; createdBy?: string }[];
    };
    expect(history.items.filter((v) => v.version > 1).map((v) => v.createdBy)).toEqual([
      auditActor(writer),
      auditActor(writer),
    ]);

    // A read-only key does none of it.
    const reader2 = await connect({ ...deps, blob }, reader);
    expect(
      (
        await reader2.callTool({
          name: 'asset_restore_version',
          arguments: { space: SPACE, id: a.id, version: 2 },
        })
      ).isError,
    ).toBe(true);
  });

  it('sets rights with content:publish only, and an embargo refuses publishing by name', async () => {
    const { deps, add } = await setup();
    const a = await add('hero.png', 'image/png');
    const denied = await (await connect(deps, writer)).callTool({
      name: 'asset_set_rights',
      arguments: { space: SPACE, id: a.id, license: 'CC BY' },
    });
    expect(denied.isError).toBe(true);

    const client = await connect(deps, admin);
    const set = payload(
      await client.callTool({
        name: 'asset_set_rights',
        arguments: { space: SPACE, id: a.id, credit: 'Ana', embargoUntil: '2999-01-01T00:00:00Z' },
      }),
    );
    expect(set).toMatchObject({
      rights: { credit: 'Ana', embargoUntil: '2999-01-01T00:00:00.000Z' },
    });
    const invalid = await client.callTool({
      name: 'asset_set_rights',
      arguments: { space: SPACE, id: a.id, expiresAt: 'next week' },
    });
    expect(invalid.isError).toBe(true);

    const job = payload(
      await client.callTool({
        name: 'assets_bulk',
        arguments: { space: SPACE, action: 'publish', ids: [a.id] },
      }),
    );
    expect(job).toMatchObject({ action: 'asset_publish', totalItems: 1, status: 'running' });
  });

  it('starts a move or tag job with content:write, and refuses publishing ones', async () => {
    const { deps, add } = await setup();
    const a = await add('a.png', 'image/png');
    const client = await connect(deps, writer);
    const tag = payload(
      await client.callTool({
        name: 'assets_bulk',
        arguments: { space: SPACE, action: 'tag', ids: [a.id], addTags: ['hero'] },
      }),
    );
    expect(tag).toMatchObject({ action: 'asset_tag' });
    const archive = await client.callTool({
      name: 'assets_bulk',
      arguments: { space: SPACE, action: 'archive', ids: [a.id] },
    });
    expect(archive.isError).toBe(true);
  });
  it('takes the same metadata patches as the REST body, and refuses the same ones', async () => {
    const { deps, add } = await setup();
    const a = await add('a.png', 'image/png');
    const client = await connect(deps, admin);
    const call = async (args: Record<string, unknown>) =>
      client.callTool({
        name: 'asset_set_metadata',
        arguments: { space: SPACE, id: a.id, ...args },
      });

    const saved = await call({ altText: { 'en-US': 'A cup' }, tags: ['t1'], unknown: 1 });
    expect(saved.isError).toBeFalsy();
    expect(payload(saved)).toMatchObject({
      metadata: { altText: { 'en-US': 'A cup' }, tags: ['t1'] },
    });
    // Refused on REST too (packages/http/test/api/sdk-management-assets.test.ts).
    expect((await call({ altText: { 'en-US': 5 } })).isError).toBe(true);
    expect((await call({ tags: ['x'.repeat(129)] })).isError).toBe(true);
  });
});
