import { createHash } from 'node:crypto';
import { structuredImportSources } from '@contentworker/adapters/import-structured';
import { InProcessAgentRuntime, makeActivities } from '@contentworker/agent-runtime';
import {
  type AppContext,
  createContentType,
  createSpace,
  publishContentType,
} from '@contentworker/application';
import type { Principal } from '@contentworker/domain';
import { SCOPES } from '@contentworker/domain';
import {
  FakeVideoHost,
  FixedClock,
  InMemoryContentStore,
  InMemoryVectorStore,
  LocalEmbeddingsProvider,
  SequenceIdGenerator,
  StubAIProvider,
} from '@contentworker/test-kit';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { beforeEach, describe, expect, it } from 'vitest';
import type { McpDeps } from '../../src/mcp/deps.js';
import { buildServer } from '../../src/mcp/server.js';

const SPACE = 'space-1';
const scope = { spaceId: SPACE, environmentId: 'main' };

// Stub AI returns schema-shaped values so generate/canvas tools work offline.
function stubAI() {
  return new StubAIProvider((req) => {
    const props =
      (req.outputSchema as { properties?: Record<string, { type?: string }> })?.properties ?? {};
    const out: Record<string, unknown> = {};
    for (const [key, def] of Object.entries(props)) {
      out[key] = def.type === 'integer' || def.type === 'number' ? 1 : `v-${key}`;
    }
    return out;
  });
}

function makeDeps(): McpDeps {
  const store = new InMemoryContentStore();
  const ctx: AppContext = {
    store,
    clock: new FixedClock(),
    ids: new SequenceIdGenerator('m'),
  };
  return {
    ctx,
    ai: stubAI(),
    rag: { embeddings: new LocalEmbeddingsProvider(8), vectors: new InMemoryVectorStore() },
    hasher: { hash: (v) => createHash('sha256').update(v).digest('hex') },
    adminToken: 'admin',
    agents: new InProcessAgentRuntime(makeActivities({ ctx, ai: new StubAIProvider(() => ({})) })),
  };
}

const adminPrincipal: Principal = { spaceId: '*', kind: 'admin', scopes: Object.values(SCOPES) };

/** Connects a Client to a freshly built server for the given principal. */
async function connect(deps: McpDeps, principal: Principal): Promise<Client> {
  const server = buildServer(deps, principal);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

/** Parses the JSON payload a tool returns via its text content. */
function payload(result: { content?: { type: string; text?: string }[] }): unknown {
  const text = result.content?.find((c) => c.type === 'text')?.text ?? 'null';
  return JSON.parse(text);
}

async function seed(deps: McpDeps) {
  const { ctx } = deps;
  await createSpace(ctx, { spaceId: SPACE, name: 'Shop', defaultLocale: 'en-US' });
  await createContentType(ctx, scope, {
    apiId: 'article',
    name: 'Article',
    displayField: 'title',
    fields: [
      {
        apiId: 'title',
        name: 'Title',
        type: 'Symbol',
        localized: false,
        required: true,
        position: 0,
      },
    ],
  });
  await publishContentType(ctx, scope, 'article');
}

describe('MCP tools (end-to-end over the in-memory transport)', () => {
  let deps: McpDeps;
  beforeEach(async () => {
    deps = makeDeps();
    await seed(deps);
  });

  it('lists content types', async () => {
    const client = await connect(deps, adminPrincipal);
    const res = await client.callTool({ name: 'model_list_content_types', arguments: {} });
    const types = payload(res) as { apiId: string }[];
    expect(types.map((t) => t.apiId)).toContain('article');
  });

  it('round-trips a function through create → list → delete', async () => {
    const client = await connect(deps, adminPrincipal);
    const created = payload(
      await client.callTool({
        name: 'function_create',
        arguments: { name: 'reindex', eventPattern: 'entry.*', url: 'https://example.com/h' },
      }),
    ) as { id: string };
    const listed = payload(await client.callTool({ name: 'functions_list', arguments: {} })) as {
      id: string;
    }[];
    expect(listed.map((f) => f.id)).toContain(created.id);

    await client.callTool({ name: 'function_delete', arguments: { id: created.id } });
    const after = payload(await client.callTool({ name: 'functions_list', arguments: {} })) as {
      id: string;
    }[];
    expect(after.map((f) => f.id)).not.toContain(created.id);
  });

  it('registers a UI extension', async () => {
    const client = await connect(deps, adminPrincipal);
    const created = payload(
      await client.callTool({
        name: 'app_extension_create',
        arguments: { name: 'widget', target: 'sidebar', entryUrl: 'https://example.com/w' },
      }),
    ) as { id: string; target: string };
    expect(created.target).toBe('sidebar');
    const listed = payload(
      await client.callTool({ name: 'app_extensions_list', arguments: {} }),
    ) as { id: string }[];
    expect(listed.map((a) => a.id)).toContain(created.id);
  });

  it('maps prose into structured fields (entry_from_canvas)', async () => {
    const client = await connect(deps, adminPrincipal);
    const res = payload(
      await client.callTool({
        name: 'entry_from_canvas',
        arguments: { contentType: 'article', prose: 'A short story about a title.' },
      }),
    ) as { fields: Record<string, Record<string, unknown>> };
    expect(res.fields.title?.['en-US']).toBe('v-title');
  });

  it('enforces RBAC: a delivery-only principal cannot create a function', async () => {
    const reader: Principal = { spaceId: SPACE, kind: 'cda', scopes: [SCOPES.deliveryRead] };
    const client = await connect(deps, reader);
    const res = await client.callTool({
      name: 'function_create',
      arguments: { name: 'x', eventPattern: '*', url: 'https://example.com/h' },
    });
    // The authorize() guard throws; the SDK surfaces it as an error result.
    expect(res.isError).toBe(true);
  });
});

describe('documentation tools', () => {
  let deps: McpDeps;
  /** A delivery-only key: the least-privileged principal the server accepts. */
  const cda: Principal = { spaceId: SPACE, kind: 'cda', scopes: [SCOPES.deliveryRead] };

  beforeEach(async () => {
    deps = makeDeps();
    await seed(deps);
  });

  it('lists pages with headings', async () => {
    const client = await connect(deps, adminPrincipal);
    const pages = payload(await client.callTool({ name: 'docs_list', arguments: {} })) as {
      path: string;
      headings: unknown[];
    }[];
    expect(pages.find((p) => p.path === 'api-reference')?.headings.length).toBeGreaterThan(1);
  });

  it('serves the docs to a delivery-only principal', async () => {
    // The docs are the same for every space and say nothing about anyone's
    // content. Gating them on content:manage would withhold them from exactly
    // the agent most likely to need them.
    const client = await connect(deps, cda);
    expect(
      (payload(await client.callTool({ name: 'docs_list', arguments: {} })) as []).length,
    ).toBeGreaterThan(0);
  });

  it('reads one section rather than a whole page', async () => {
    const client = await connect(deps, adminPrincipal);
    const whole = payload(
      await client.callTool({ name: 'docs_read', arguments: { path: 'architecture' } }),
    ) as { body: string };
    const pages = payload(await client.callTool({ name: 'docs_list', arguments: {} })) as {
      path: string;
      headings: { depth: number; slug: string }[];
    }[];
    const slug = pages.find((p) => p.path === 'architecture')?.headings.find((h) => h.depth === 2)
      ?.slug as string;
    const part = payload(
      await client.callTool({
        name: 'docs_read',
        arguments: { path: 'architecture', section: slug },
      }),
    ) as { body: string };
    expect(part.body.length).toBeLessThan(whole.body.length);
  });

  it('reports a missing page as an error rather than an empty body', async () => {
    const client = await connect(deps, adminPrincipal);
    const res = await client.callTool({ name: 'docs_read', arguments: { path: 'nope' } });
    // An empty body reads as "this page is blank", which would send an agent
    // off to invent conventions the docs actually state.
    expect(res.isError).toBe(true);
  });

  it('searches across pages and says where each hit is', async () => {
    const client = await connect(deps, adminPrincipal);
    const hits = payload(
      await client.callTool({ name: 'docs_search', arguments: { query: 'UUIDv7' } }),
    ) as { path: string; line: number }[];
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.line).toBeGreaterThan(0);
  });
});

describe('importing over MCP', () => {
  const item = (id: string, type: string) =>
    `<item><title>T${id}</title><wp:post_id>${id}</wp:post_id><wp:status>publish</wp:status><wp:post_type>${type}</wp:post_type></item>`;
  const WXR = `<rss xmlns:wp="http://wordpress.org/export/1.2/"><channel><wp:wxr_version>1.2</wp:wxr_version>${item('1', 'post')}${item('2', 'page')}${item('3', 'page')}</channel></rss>`;

  it('passes source options through, so an agent can choose what a WordPress export yields', async () => {
    // Without sourceOptions an agent could only ever read posts — the HTTP
    // surface could ask for pages and MCP could not.
    const deps = { ...makeDeps(), importSources: structuredImportSources() };
    await seed(deps);
    const client = await connect(deps, adminPrincipal);
    const analysis = payload(
      await client.callTool({
        name: 'import_analyze',
        arguments: {
          source: 'wxr',
          payload: WXR,
          contentTypeApiId: 'article',
          fields: { title: 'title' },
          sourceOptions: { postType: 'page' },
          space: SPACE,
        },
      }),
    ) as { records: number; willCreate: number };
    expect(analysis).toMatchObject({ records: 2, willCreate: 2 });
  });
});

describe('video asset tools', () => {
  it('creates a video upload and refreshes it through the same use-cases as the API', async () => {
    const deps = makeDeps();
    const video = new FakeVideoHost();
    const withVideo: McpDeps = { ...deps, ctx: { ...deps.ctx, video } };
    await seed(withVideo);
    const client = await connect(withVideo, adminPrincipal);

    const created = payload(
      await client.callTool({
        name: 'asset_video_create',
        arguments: { fileName: 'clip.mp4', contentType: 'video/mp4', space: SPACE },
      }),
    ) as { asset: { id: string }; upload: { uploadUrl: string } };
    expect(created.upload.uploadUrl).toBe('https://upload.video.local/vid-1');

    video.setVideo('vid-1', { status: 'ready', thumbnailUrl: 'https://cdn/t.jpg' });
    const refreshed = payload(
      await client.callTool({
        name: 'asset_video_refresh',
        arguments: { id: created.asset.id, space: SPACE },
      }),
    ) as { file: { video: { status: string; thumbnailUrl: string } } };
    expect(refreshed.file.video).toMatchObject({
      status: 'ready',
      thumbnailUrl: 'https://cdn/t.jpg',
    });
  });

  it('refuses a read-only principal', async () => {
    const deps = makeDeps();
    const withVideo: McpDeps = { ...deps, ctx: { ...deps.ctx, video: new FakeVideoHost() } };
    await seed(withVideo);
    const reader: Principal = { spaceId: SPACE, kind: 'cda', scopes: [SCOPES.deliveryRead] };
    const client = await connect(withVideo, reader);
    const res = await client.callTool({
      name: 'asset_video_create',
      arguments: { fileName: 'clip.mp4', contentType: 'video/mp4', space: SPACE },
    });
    expect(res.isError).toBe(true);
  });
});
