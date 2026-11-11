import { createHash } from 'node:crypto';
import { InProcessAgentRuntime, makeActivities } from '@contentworker/agent-runtime';
import {
  type AppContext,
  consumeEvent,
  createContentType,
  createEntry,
  createSpace,
  publishEntry,
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
  RecordingWebhookSender,
  SequenceIdGenerator,
  StubAIProvider,
} from '@contentworker/test-kit';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import type { McpDeps } from '../../src/mcp/deps';
import { buildServer } from '../../src/mcp/server';

const SPACE = 'space-1';
const reader: Principal = { spaceId: SPACE, kind: 'cpa', scopes: [SCOPES.previewRead] };
const editor: Principal = {
  spaceId: SPACE,
  kind: 'cma',
  scopes: [SCOPES.previewRead, SCOPES.contentWrite, SCOPES.contentManage],
};
const admin: Principal = {
  spaceId: SPACE,
  kind: 'cma',
  scopes: [SCOPES.previewRead, SCOPES.contentWrite, SCOPES.spaceAdmin],
};

async function setup(maxTier?: 'balanced' | 'fast') {
  const ctx: AppContext = {
    store: new InMemoryContentStore(),
    clock: new FixedClock(),
    ids: new SequenceIdGenerator('n'),
    passwords: new FakePasswordHasher(),
    ...(maxTier ? { ai: { mode: 'live' as const, timeoutMs: 20_000, maxTier } } : {}),
  };
  const ai = new StubAIProvider(() => ({ title: 'Drafted' }));
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
  await createContentType(
    ctx,
    SYSTEM_CALLER,
    { spaceId: SPACE, environmentId: 'main' },
    {
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
    },
  );
  return { ctx, deps, ai };
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

describe('AI settings tools (MCP), on the HTTP routes’ use-cases', () => {
  it('sets against the version read, audits the set, and the capability refuses everywhere', async () => {
    const { ctx, deps, ai } = await setup();
    const call = await connect(deps, admin);
    expect((await call('ai_settings_get')).body).toMatchObject({
      version: 0,
      capabilities: { drafting: { enabled: true, tier: null, guidance: null } },
    });
    const set = await call('ai_settings_set', {
      expectedVersion: 0,
      capabilities: { drafting: { enabled: false } },
    });
    expect(set.isError).toBe(false);
    expect(set.body).toMatchObject({ unchanged: false, settings: { version: 1 } });

    const rows = await ctx.store.audit.list(SPACE, {});
    expect(rows.map((r) => [r.action, r.targetType, r.detail?.aiSettings])).toEqual([
      ['MCP ai_settings_set', 'ai_settings', { from: 0, to: 1, changed: ['drafting.enabled'] }],
    ]);

    // The drafting tool meets the same refusal the REST route does, before the model.
    const draft = await call('generate_draft', { contentType: 'post', prompt: 'x' });
    expect(draft.isError).toBe(true);
    expect(draft.text).toContain('ai_capability_disabled');
    expect(ai.requests).toHaveLength(0);

    const stale = await call('ai_settings_set', {
      expectedVersion: 0,
      capabilities: { drafting: { enabled: true } },
    });
    expect(stale.isError).toBe(true);
    expect(stale.text).toContain('at version 1, not 0');
  });

  it('sets only with space:admin; reads with preview:read', async () => {
    const { deps } = await setup();
    for (const p of [reader, editor]) {
      const call = await connect(deps, p);
      expect((await call('ai_settings_get')).isError).toBe(false);
      const refused = await call('ai_settings_set', {
        expectedVersion: 0,
        capabilities: { media: { enabled: false } },
      });
      expect(refused.isError).toBe(true);
    }
  });

  it('lets a delegated bearer holding space:admin set them: configuration, not lasting access', async () => {
    const { deps } = await setup();
    for (const [i, delegated] of [
      { ...admin, issuance: 'pat' as const },
      { ...admin, issuance: 'oauth' as const, clientId: 'client-1' },
    ].entries()) {
      const call = await connect(deps, delegated);
      const set = await call('ai_settings_set', {
        expectedVersion: i,
        capabilities: { media: { enabled: i === 0 ? false : true } },
      });
      expect(set.isError).toBe(false);
    }
  });

  it('refuses another space’s key on both tools', async () => {
    const { deps } = await setup();
    const other = await connect(deps, { ...admin, spaceId: 'space-2' });
    expect((await other('ai_settings_get')).isError).toBe(true);
    const set = await other('ai_settings_set', {
      expectedVersion: 0,
      capabilities: { media: { enabled: false } },
    });
    expect(set.isError).toBe(true);
  });

  it('reports the deployment’s cap as the REST route does: kept as set, run on the cap', async () => {
    const { deps, ai } = await setup('fast');
    const call = await connect(deps, admin);
    const set = await call('ai_settings_set', {
      expectedVersion: 0,
      capabilities: { drafting: { enabled: true, tier: 'balanced' } },
    });
    expect(set.isError).toBe(false);
    expect(set.body).toMatchObject({
      settings: {
        maxTier: 'fast',
        capabilities: { drafting: { tier: 'balanced', effectiveTier: 'fast' } },
      },
    });
    expect((await call('ai_settings_get')).body).toMatchObject({ maxTier: 'fast' });
    // And the drafting tool runs on the cap.
    await call('generate_draft', { contentType: 'post', prompt: 'x' });
    expect(ai.requests[0]?.tier).toBe('fast');
  });

  it('follows the search reindex a toggle starts, with content:manage', async () => {
    const { ctx, deps } = await setup();
    const call = await connect(deps, admin);
    expect((await call('search_reindex_job')).isError).toBe(true);
    const manager = await connect(deps, {
      ...admin,
      scopes: [...admin.scopes, SCOPES.contentManage],
    });
    expect((await manager('search_reindex_job')).body).toEqual({ job: null });
    const { entry } = await createEntry(
      ctx,
      { spaceId: SPACE, environmentId: 'main' },
      {
        contentTypeApiId: 'post',
        fields: { title: { 'en-US': 'Hello' } },
      },
    );
    await publishEntry(ctx, { spaceId: SPACE, environmentId: 'main' }, entry.id);
    const store = ctx.store as InMemoryContentStore;
    const before = store.allEvents().length;
    await manager('ai_settings_set', {
      expectedVersion: 0,
      capabilities: { search: { enabled: false } },
    });
    for (const e of store.allEvents().slice(before)) {
      await consumeEvent(ctx, { sender: new RecordingWebhookSender(), rag: deps.rag }, e);
    }
    expect((await manager('search_reindex_job')).body).toMatchObject({
      job: { action: 'search_reindex', status: 'running', config: { enabled: false } },
    });
    // A role that may publish but not change the AI settings can't stop it half way.
    const { job } = (await manager('search_reindex_job')).body as { job: { id: string } };
    const publisher = await connect(deps, {
      spaceId: SPACE,
      kind: 'cma',
      scopes: [SCOPES.contentWrite, SCOPES.contentPublish],
    });
    const refused = await publisher('bulk_job_cancel', { id: job.id });
    expect(refused.isError).toBe(true);
    expect((await manager('search_reindex_job')).body).toMatchObject({
      job: { status: 'running' },
    });
    // The cancel tool's own content:publish, and space:admin.
    const owner = await connect(deps, {
      ...admin,
      scopes: [...admin.scopes, SCOPES.contentManage, SCOPES.contentPublish],
    });
    const stopped = await owner('bulk_job_cancel', { id: job.id });
    expect(stopped.isError).toBe(false);
    expect(stopped.body).toMatchObject({ status: 'cancelled' });
  });
});
