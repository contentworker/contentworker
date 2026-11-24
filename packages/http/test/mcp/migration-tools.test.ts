import { createHash } from 'node:crypto';
import { InProcessAgentRuntime, makeActivities } from '@contentworker/agent-runtime';
import { type AppContext, createEnvironment, createSpace } from '@contentworker/application';
import { type Principal, SCOPES } from '@contentworker/domain';
import {
  FakeBlobStore,
  FakePasswordHasher,
  FakeSiteSource,
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

const SPACE = 'space-1';
const O = 'https://site.test';
const runner: Principal = { spaceId: SPACE, kind: 'cma', scopes: [SCOPES.migrationRun] };
const manager: Principal = { spaceId: SPACE, kind: 'cma', scopes: [SCOPES.contentManage] };
const editor: Principal = {
  spaceId: SPACE,
  kind: 'cma',
  scopes: [SCOPES.contentWrite, SCOPES.previewRead],
};
const otherSpace: Principal = { spaceId: 'space-2', kind: 'cma', scopes: [SCOPES.migrationRun] };

const article = (title: string) =>
  `<html><head><title>${title}</title></head><body><main><article><h1>${title}</h1><p>${title} text.</p></article></main></body></html>`;
const SITE = {
  [`${O}/`]: '<nav><a href="/blog/one">1</a><a href="/blog/two">2</a><a href="/gone">g</a></nav>',
  [`${O}/blog/one`]: article('One'),
  [`${O}/blog/two`]: article('Two'),
  [`${O}/gone`]: 404,
};

async function setup(opts: { siteSource?: boolean } = {}) {
  const ctx: AppContext = {
    store: new InMemoryContentStore(),
    clock: new FixedClock(),
    ids: new SequenceIdGenerator('m'),
    passwords: new FakePasswordHasher(),
  };
  const source = new FakeSiteSource(SITE);
  const deps: McpDeps = {
    ctx,
    ai: new StubAIProvider(() => ({})),
    rag: { embeddings: new LocalEmbeddingsProvider(8), vectors: new InMemoryVectorStore() },
    hasher: { hash: (v) => createHash('sha256').update(v).digest('hex') },
    adminToken: 'admin',
    agents: new InProcessAgentRuntime(makeActivities({ ctx, ai: new StubAIProvider(() => ({})) })),
    blob: new FakeBlobStore(),
    ...(opts.siteSource === false ? {} : { siteSource: source }),
  };
  await createSpace(ctx, { spaceId: SPACE, name: 'Site', defaultLocale: 'en-US' });
  return { ctx, deps, source };
}

async function connect(deps: McpDeps, principal: Principal) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await buildServer(deps, principal).connect(serverTransport);
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
      body: (text.startsWith('{') ? JSON.parse(text) : null) as never,
      text,
    };
  };
}

interface Run {
  id: string;
  status: string;
}

describe('site migration tools', () => {
  it('take a crawl from a start page to templates, as the HTTP routes do', async () => {
    const { deps, source } = await setup();
    const call = await connect(deps, runner);
    const created = await call('migration_create', {
      name: 'Old site',
      source: { kind: 'crawl', url: `${O}/` },
    });
    expect(created.isError).toBe(false);
    const run = created.body as Run;
    expect(run).toMatchObject({ name: 'Old site', status: 'created' });

    expect((await call('migration_inventory', { run: run.id })).body).toMatchObject({
      status: 'inventoried',
      inventory: { added: 1 },
    });
    // The crawl goes on as pages are fetched: the start page's links join the run.
    const first = (await call('migration_fetch_pages', { run: run.id })).body as {
      added: number;
      more: boolean;
    };
    expect(first).toMatchObject({ fetched: 1, added: 3, more: true });
    let more = first.more;
    while (more)
      more = ((await call('migration_fetch_pages', { run: run.id })).body as typeof first).more;
    expect(source.fetched.sort()).toEqual(Object.keys(SITE).sort());

    const clustered = (await call('migration_cluster', { run: run.id, threshold: 0.6 })).body as {
      run: Run;
      templates: { id: string; pageCount: number }[];
    };
    expect(clustered.run.status).toBe('clustered');
    const status = (await call('migration_status', { run: run.id })).body as {
      pages: { total: number; failed: number };
    };
    expect(status.pages).toMatchObject({ total: 4, failed: 1 });
    const templates = (await call('migration_templates', { run: run.id })).body as {
      items: { id: string }[];
    };
    expect(templates.items.map((t) => t.id)).toEqual(clustered.templates.map((t) => t.id));

    const page = (await call('migration_pages', { run: run.id, limit: 2 })).body as {
      items: { url: string; html: unknown }[];
      nextCursor?: string;
    };
    expect(page.items).toHaveLength(2);
    const rest = (await call('migration_pages', { run: run.id, cursor: page.nextCursor })).body as {
      items: { url: string }[];
      nextCursor?: string;
    };
    expect([...page.items, ...rest.items].map((p) => p.url).sort()).toEqual(
      Object.keys(SITE).sort(),
    );
    expect(rest.nextCursor).toBeUndefined();
    const failed = (await call('migration_pages', { run: run.id, stage: 'discovered' })).body as {
      items: { url: string; error: string }[];
    };
    expect(failed.items.map((p) => p.url)).toEqual([`${O}/gone`]);
    // Hash and size only: no HTML, no storage key, no fingerprint.
    const text = (await call('migration_pages', { run: run.id })).text;
    expect(text).not.toMatch(/<nav|<html|"key"|fingerprint/);

    const list = (await call('migration_list')).body as { items: Run[] };
    expect(list.items.map((r) => r.id)).toEqual([run.id]);
  });

  it('give steps to migration:run alone, and reads to migration:run or content:manage', async () => {
    const { deps } = await setup();
    const run = (
      await (
        await connect(deps, runner)
      )('migration_create', {
        source: { kind: 'sitemap', url: `${O}/` },
      })
    ).body as Run;
    const asManager = await connect(deps, manager);
    for (const tool of ['migration_inventory', 'migration_fetch_pages', 'migration_cluster']) {
      const refused = await asManager(tool, { run: run.id });
      expect(refused.isError, tool).toBe(true);
      expect(refused.text, tool).toMatch(/migration:run/);
    }
    expect(
      (await asManager('migration_create', { source: { kind: 'crawl', url: `${O}/` } })).isError,
    ).toBe(true);
    for (const tool of ['migration_status', 'migration_pages', 'migration_templates']) {
      expect((await asManager(tool, { run: run.id })).isError, tool).toBe(false);
    }
    expect((await asManager('migration_list')).isError).toBe(false);
    const asEditor = await connect(deps, editor);
    const refused = await asEditor('migration_status', { run: run.id });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/"migration:run" or "content:manage"/);

    // Listed to whoever can use them, and only them.
    expect(toolListedFor(manager, 'migration_status')).toBe(true);
    expect(toolListedFor(manager, 'migration_fetch_pages')).toBe(false);
    expect(toolListedFor(editor, 'migration_status')).toBe(false);
    expect(toolListedFor({ ...editor, scopes: [SCOPES.spaceAdmin] }, 'migration_create')).toBe(
      true,
    );
  });

  it('keep a run to its space and environment', async () => {
    const { ctx, deps } = await setup();
    await createSpace(ctx, { spaceId: 'space-2', name: 'Other', defaultLocale: 'en-US' });
    await createEnvironment(ctx, SPACE, 'staging');
    const call = await connect(deps, runner);
    const run = (await call('migration_create', { source: { kind: 'crawl', url: `${O}/` } }))
      .body as Run;
    const inStaging = await call('migration_status', { run: run.id, environment: 'staging' });
    expect(inStaging.isError).toBe(true);
    expect(inStaging.text).toMatch(/not found/);
    expect(
      ((await call('migration_list', { environment: 'staging' })).body as { items: [] }).items,
    ).toEqual([]);
    const elsewhere = await (await connect(deps, otherSpace))('migration_status', { run: run.id });
    expect(elsewhere.isError).toBe(true);
  });

  it('refuse an internal address, and say when reading sites is not configured', async () => {
    const { deps } = await setup({ siteSource: false });
    const call = await connect(deps, runner);
    const ssrf = await call('migration_create', {
      source: { kind: 'crawl', url: 'http://169.254.169.254/latest' },
    });
    expect(ssrf.isError).toBe(true);
    expect(ssrf.text).toMatch(/source\.url/);
    const run = (await call('migration_create', { source: { kind: 'crawl', url: `${O}/` } }))
      .body as Run;
    expect((await call('migration_fetch_pages', { run: run.id, limit: 11 })).isError).toBe(true);
    const unconfigured = await call('migration_inventory', { run: run.id });
    expect(unconfigured.isError).toBe(true);
    expect(unconfigured.text).toMatch(/not configured/);
  });

  it('report an unreadable site without writing, and a fetch says so in its answer', async () => {
    const { deps, source } = await setup();
    const call = await connect(deps, runner);
    const run = (await call('migration_create', { source: { kind: 'crawl', url: `${O}/` } }))
      .body as Run;
    source.unavailable = 'robots.txt answered 503';
    const inventory = await call('migration_inventory', { run: run.id });
    expect(inventory.isError).toBe(true);
    expect(inventory.text).toMatch(/site can't be read now/);
    expect(
      ((await call('migration_status', { run: run.id })).body as { run: Run }).run.status,
    ).toBe('created');
    source.unavailable = undefined;
    await call('migration_inventory', { run: run.id });
    source.unavailable = 'robots.txt answered 503';
    expect((await call('migration_fetch_pages', { run: run.id })).body).toMatchObject({
      fetched: 0,
      more: true,
      unavailable: 'robots.txt answered 503',
    });
  });
});
