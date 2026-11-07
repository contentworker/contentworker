import { createHash } from 'node:crypto';
import { InProcessAgentRuntime, makeActivities } from '@contentworker/agent-runtime';
import {
  type AppContext,
  createSpace,
  principalFromPreviewToken,
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
const TEMPLATE = 'https://site.example/blog/{field:slug}?entry={id}&token={token}';
const hasher = { hash: (v: string) => createHash('sha256').update(v).digest('hex') };

async function connect(principal: Principal = admin) {
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
    hasher,
    adminToken: 'admin',
    agents: new InProcessAgentRuntime(makeActivities({ ctx, ai: new StubAIProvider(() => ({})) })),
    blob: new FakeBlobStore(),
    inviteOrigin: 'https://admin.example',
  };
  await createSpace(ctx, { spaceId: SPACE, name: 'Site', defaultLocale: 'en-US' });
  const connectAs = async (p: Principal) => {
    const server = buildServer(deps, p);
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
  };
  return { call: await connectAs(principal), connectAs, ctx };
}

const post = {
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
    { apiId: 'slug', name: 'Slug', type: 'Slug', localized: false, required: false, position: 1 },
  ],
};

describe('content type preview URL template through MCP', () => {
  it('stores, reads back and clears the template, as the route does', async () => {
    const { call } = await connect();
    const created = await call('model_create_content_type', {
      ...post,
      preview: { urlTemplate: TEMPLATE },
    });
    expect(created.isError, created.text).toBe(false);
    const read = async () =>
      JSON.parse((await call('model_get_content_type', { apiId: 'post' })).text) as Record<
        string,
        unknown
      >;
    expect((await read()).preview).toEqual({ urlTemplate: TEMPLATE });
    await call('model_create_content_type', { ...post, preview: null });
    expect(await read()).not.toHaveProperty('preview');
  });

  it('refuses a template the domain refuses', async () => {
    const { call } = await connect();
    const res = await call('model_create_content_type', {
      ...post,
      preview: { urlTemplate: 'http://site.example/?token={token}' },
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('preview.urlTemplate');
  });

  it('mints a preview link whose frontend URL is the filled template', async () => {
    const { call, ctx } = await connect();
    await call('model_create_content_type', { ...post, preview: { urlTemplate: TEMPLATE } });
    const created = JSON.parse(
      (
        await call('entries_create', {
          contentType: 'post',
          fields: { title: { 'en-US': 'Hello' }, slug: { 'en-US': 'hello-world' } },
        })
      ).text,
    ) as { entry: { id: string } };
    const id = created.entry.id;
    const res = await call('entries_preview_link', { id });
    expect(res.isError, res.text).toBe(false);
    const link = JSON.parse(res.text) as { url: string; frontendUrl: string; token: string };
    expect(link.url).toBe(
      `https://admin.example/preview/${SPACE}/main/entries/${id}?preview_token=${link.token}`,
    );
    expect(link.frontendUrl).toBe(
      `https://site.example/blog/hello-world?entry=${id}&token=${link.token}`,
    );
    const scope = { spaceId: SPACE, environmentId: 'main' };
    expect(await principalFromPreviewToken(ctx, hasher, scope, id, link.token)).not.toBeNull();
  });

  it('refuses a caller without content:write', async () => {
    const { call, connectAs } = await connect();
    await call('model_create_content_type', post);
    const created = JSON.parse(
      (
        await call('entries_create', {
          contentType: 'post',
          fields: { title: { 'en-US': 'Hello' } },
        })
      ).text,
    ) as { entry: { id: string } };
    const reader = await connectAs({
      spaceId: SPACE,
      kind: 'cpa',
      scopes: [SCOPES.previewRead],
    });
    const res = await reader('entries_preview_link', { id: created.entry.id });
    expect(res.isError).toBe(true);
  });
});
