import { createHash } from 'node:crypto';
import { InProcessAgentRuntime, makeActivities } from '@contentworker/agent-runtime';
import {
  type AppContext,
  assetTextKey,
  createAsset,
  createContentType,
  createSpace,
  SYSTEM_CALLER,
} from '@contentworker/application';
import { type Principal, SCOPES } from '@contentworker/domain';
import {
  FakeAssetIngestQueue,
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
import { toolListedFor } from '../../src/mcp/tool-scopes';

/**
 * The AI project tools: the same use-cases, scopes and refusals as `…/ai-projects`, and
 * `projectId` on the AI tools, which answer what the project gave them.
 */
const SPACE = 'space-1';
const scope = { spaceId: SPACE, environmentId: 'main' };
const preview: Principal = { spaceId: SPACE, kind: 'cpa', scopes: [SCOPES.previewRead] };
const manager: Principal = {
  spaceId: SPACE,
  kind: 'cma',
  scopes: [SCOPES.previewRead, SCOPES.contentWrite, SCOPES.contentManage],
};
const admin: Principal = {
  spaceId: SPACE,
  kind: 'cma',
  scopes: [SCOPES.previewRead, SCOPES.contentWrite, SCOPES.contentManage, SCOPES.spaceAdmin],
};
const writerOnly: Principal = { spaceId: SPACE, kind: 'cma', scopes: [SCOPES.contentWrite] };

async function setup() {
  const blob = new FakeBlobStore();
  const ctx: AppContext = {
    store: new InMemoryContentStore(),
    clock: new FixedClock(),
    ids: new SequenceIdGenerator('n'),
    passwords: new FakePasswordHasher(),
    aiReferences: { blob, ingest: new FakeAssetIngestQueue() },
  };
  const ai = new StubAIProvider(() => ({ title: 'Drafted' }));
  const deps: McpDeps = {
    ctx,
    ai,
    rag: { embeddings: new LocalEmbeddingsProvider(8), vectors: new InMemoryVectorStore() },
    hasher: { hash: (v) => createHash('sha256').update(v).digest('hex') },
    adminToken: 'admin',
    agents: new InProcessAgentRuntime(makeActivities({ ctx, ai })),
    blob,
  };
  await createSpace(ctx, { spaceId: SPACE, name: 'Site', defaultLocale: 'en-US' });
  await createContentType(ctx, SYSTEM_CALLER, scope, {
    apiId: 'post',
    name: 'Post',
    displayField: 'title',
    fields: [
      {
        apiId: 'title',
        name: 'Title',
        type: 'Symbol',
        localized: false,
        required: false,
        position: 0,
      },
    ],
  });
  const { asset } = await createAsset(ctx, blob, scope, {
    fileName: 'spec.pdf',
    contentType: 'application/pdf',
  });
  await blob.put(asset.r2Key as string, 'bytes', 'application/pdf');
  await blob.put(
    assetTextKey(scope, asset.id, 1) as string,
    'Spec: 40 kg. '.repeat(1_000),
    'text/markdown',
  );
  return { ctx, deps, ai, asset };
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

describe('AI project tools (MCP)', () => {
  it('creates, reads, updates and deletes on the routes’ use-cases, audited by project', async () => {
    const { ctx, deps, asset } = await setup();
    const call = await connect(deps, manager);
    const created = await call('ai_project_create', {
      name: 'Northwind',
      instructions: 'Say spec sheet.',
      references: [{ assetId: asset.id }],
    });
    expect(created.isError).toBe(false);
    const { id } = created.body as { id: string };
    expect((await call('ai_project_get', { id })).body).toMatchObject({
      references: [{ assetId: asset.id, text: 'ready' }],
    });
    expect((await call('ai_projects_list')).body).toMatchObject({ total: 1 });
    const updated = await call('ai_project_update', {
      id,
      name: 'Northwind 2',
      expectedVersion: 1,
    });
    expect(updated.body).toMatchObject({ project: { version: 2 } });
    expect((await call('ai_project_delete', { id })).body).toEqual({ deleted: id });
    const rows = await ctx.store.audit.list(SPACE, {});
    // One row per write, whatever order a fixed clock lists them in.
    expect(rows.map((r) => [r.action, r.targetType, r.targetId]).sort()).toEqual([
      ['MCP ai_project_create', 'ai_project', id],
      ['MCP ai_project_delete', 'ai_project', id],
      ['MCP ai_project_update', 'ai_project', id],
    ]);
  });

  it('holds the default to space:admin and refuses a delete that would strand an action', async () => {
    const { deps } = await setup();
    const asManager = await connect(deps, manager);
    const asAdmin = await connect(deps, admin);
    const { id } = (await asManager('ai_project_create', { name: 'P' })).body as { id: string };
    expect((await asManager('ai_project_default_set', { projectId: id })).isError).toBe(true);
    expect((await asAdmin('ai_project_default_set', { projectId: id })).body).toEqual({
      projectId: id,
      unchanged: false,
    });
    expect(
      (await asManager('ai_project_update', { id, name: 'Q', expectedVersion: 2 })).isError,
    ).toBe(true);
    const other = (await asManager('ai_project_create', { name: 'Other' })).body as { id: string };
    await asManager('ai_action_create', { name: 'A', promptTemplate: 'x', projectId: other.id });
    const refused = await asManager('ai_project_delete', { id: other.id });
    expect(refused.isError).toBe(true);
    expect(refused.body).toMatchObject({ error: { code: 'project_in_use' } });
  });

  it('is not listed to, nor answers, a Preview key', async () => {
    const { deps } = await setup();
    expect(toolListedFor(preview, 'ai_projects_list')).toBe(false);
    const call = await connect(deps, preview);
    expect((await call('ai_projects_list')).isError).toBe(true);
  });

  it('takes projectId on generate_draft and answers what the project gave', async () => {
    const { deps, ai, asset } = await setup();
    const call = await connect(deps, admin);
    const { id } = (
      await call('ai_project_create', { name: 'P', references: [{ assetId: asset.id }] })
    ).body as { id: string };
    const draft = await call('generate_draft', { contentType: 'post', prompt: 'x', projectId: id });
    expect(draft.body).toMatchObject({
      project: { id, references: [{ assetId: asset.id, used: true }] },
    });
    expect(ai.requests.at(-1)?.prompt).toContain('40 kg');
  });

  it('reads a reference a page at a time, and only one the caller can read', async () => {
    const { deps, asset } = await setup();
    const call = await connect(deps, admin);
    const { id } = (
      await call('ai_project_create', { name: 'P', references: [{ assetId: asset.id }] })
    ).body as { id: string };
    const page = await call('ai_project_reference_read', { projectId: id, assetId: asset.id });
    expect(page.body).toMatchObject({ offset: 0, nextOffset: 6000, total: 13_000 });
    const next = await call('ai_project_reference_read', {
      projectId: id,
      assetId: asset.id,
      offset: 6000,
      limit: 12_000,
    });
    // The rest of the text: the page ends where it does.
    expect(next.body).toMatchObject({ offset: 6000, nextOffset: null, total: 13_000 });
    const noAssets = await connect(deps, writerOnly);
    expect(
      (await noAssets('ai_project_reference_read', { projectId: id, assetId: asset.id })).isError,
    ).toBe(true);
    expect(
      (await call('ai_project_reference_read', { projectId: id, assetId: 'not-a-reference' }))
        .isError,
    ).toBe(true);
  });
});
