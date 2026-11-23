import { InvalidStateError, NotFoundError, ValidationError } from '@contentworker/domain';
import { TransactionConflictError } from '@contentworker/ports';
import {
  FakeBlobStore,
  FakeSiteSource,
  FixedClock,
  InMemoryContentStore,
} from '@contentworker/test-kit';
import { describe, expect, it } from 'vitest';
import {
  type AppContext,
  clusterPages,
  createMigrationRun,
  fetchSourcePages,
  getMigrationRun,
  inventorySite,
  sha256Hex,
} from '../src/index';

const scope = { spaceId: 'site', environmentId: 'main' };
const other = { spaceId: 'site', environmentId: 'staging' };
const O = 'https://site.test';

const article = (title: string) =>
  `<html><head><title>${title}</title></head><body><main><article class="post"><h1>${title}</h1><div class="meta"><span>Ada</span></div><div class="body"><p>${title} text.</p><figure><img src="/a.png"></figure></div></article></main></body></html>`;
const product = (name: string) =>
  `<html><body><main><section class="hero"><h2>${name}</h2></section><section class="specs"><table><tr><td>1</td></tr></table></section><ul class="gallery"><li><img src="/1.png"></li></ul></main></body></html>`;

function harness(pages: Record<string, string | number>) {
  let n = 0;
  const store = new InMemoryContentStore();
  const clock = new FixedClock(new Date('2026-11-20T00:00:00.000Z'));
  const ctx: AppContext = {
    store,
    clock,
    // Padded, so id order is creation order (as UUIDv7s are).
    ids: { newId: () => `id-${String(++n).padStart(4, '0')}` },
    actor: 'ed@example.com',
  };
  const source = new FakeSiteSource(pages, ['a warning from the source']);
  const blob = new FakeBlobStore();
  return { ctx, store, clock, source, blob, deps: { source, blob } };
}

const SITE = {
  [`${O}/blog/one`]: article('One'),
  [`${O}/shop/kettle`]: product('Kettle'),
  [`${O}/blog/two`]: article('Two'),
  [`${O}/blog/gone`]: 404,
  [`${O}/blog/three`]: article('Three'),
  [`${O}/shop/toaster`]: product('Toaster'),
};

describe('site migration runs', () => {
  it('are created with their source checked and defaults filled', async () => {
    const { ctx } = harness({});
    const run = await createMigrationRun(ctx, scope, {
      source: { kind: 'sitemap', url: `${O}/sitemap.xml` },
    });
    expect(run).toEqual({
      id: 'id-0001',
      name: 'site.test',
      source: {
        kind: 'sitemap',
        url: `${O}/sitemap.xml`,
        include: [],
        exclude: [],
        maxPages: 500,
      },
      status: 'created',
      threshold: 0.8,
      inventory: null,
      error: null,
      version: 1,
      createdAt: '2026-11-20T00:00:00.000Z',
      createdBy: 'ed@example.com',
      updatedAt: '2026-11-20T00:00:00.000Z',
    });
    expect((await getMigrationRun(ctx, scope, run.id)).pages.total).toBe(0);
    await expect(getMigrationRun(ctx, other, run.id)).rejects.toThrow(NotFoundError);
  });

  it('refuse a source the outbound guard refuses', async () => {
    const { ctx } = harness({});
    for (const url of [
      'http://127.0.0.1/',
      'http://169.254.169.254/latest',
      'http://intranet.local/',
    ]) {
      await expect(
        createMigrationRun(ctx, scope, { source: { kind: 'crawl', url } }),
      ).rejects.toThrow(ValidationError);
    }
    await expect(
      createMigrationRun(ctx, scope, { source: { kind: 'crawl', url: `${O}/`, maxPages: 0 } }),
    ).rejects.toThrow(ValidationError);
  });
});

describe('inventory, fetch and cluster, end to end', () => {
  it('takes a sitemap site from URLs to templates', async () => {
    const { ctx, deps, source, blob } = harness(SITE);
    const run = await createMigrationRun(ctx, scope, {
      source: { kind: 'sitemap', url: `${O}/`, exclude: ['/shop/toaster'] },
    });

    const inventoried = await inventorySite(ctx, deps, scope, run.id);
    expect(inventoried.status).toBe('inventoried');
    expect(inventoried.version).toBe(2);
    expect(inventoried.inventory).toEqual({
      discovered: 6,
      added: 5,
      skipped: { robots: 0, filtered: 1, offOrigin: 0, overLimit: 0, invalid: 0 },
      warnings: ['a warning from the source'],
    });
    // A sitemap gives URLs only: nothing fetched or stored yet.
    expect(blob.keys()).toEqual([]);

    // Fetched in batches until none are left; the 404 keeps its error and isn't retried.
    const first = await fetchSourcePages(ctx, deps, scope, run.id, { limit: 4 });
    expect(first).toEqual({ fetched: 3, failed: 1, more: true });
    const second = await fetchSourcePages(ctx, deps, scope, run.id, { limit: 4 });
    expect(second).toEqual({ fetched: 1, failed: 0, more: false });
    expect(await fetchSourcePages(ctx, deps, scope, run.id)).toEqual({
      fetched: 0,
      failed: 0,
      more: false,
    });
    expect(source.fetched.length).toBe(5);

    const pages = await ctx.store.migrations.listPages(scope, run.id, { limit: 10 });
    const one = pages.find((p) => p.url === `${O}/blog/one`);
    const html = SITE[`${O}/blog/one`] as string;
    expect(one).toMatchObject({
      path: '/blog/one',
      title: 'One',
      httpStatus: 200,
      error: null,
      html: {
        key: `migrations/site/main/${run.id}/html/${sha256Hex(html)}.html`,
        sha256: sha256Hex(html),
        bytes: html.length,
      },
    });
    expect(await blob.get(one?.html?.key as string)).toBe(html);
    expect(pages.find((p) => p.url === `${O}/blog/gone`)).toMatchObject({
      httpStatus: 404,
      error: 'answered 404',
      html: null,
    });

    const clustered = await clusterPages(ctx, scope, run.id);
    expect(clustered.run).toMatchObject({ status: 'clustered', version: 3 });
    expect(clustered.templates.map((t) => [t.label, t.pageCount])).toEqual([
      ['Template 1', 3],
      ['Template 2', 1],
    ]);
    expect(clustered.pages).toMatchObject({
      total: 5,
      fetched: 4,
      failed: 1,
      byStage: { clustered: 4, discovered: 1 },
    });
    const view = await getMigrationRun(ctx, scope, run.id);
    expect(view.templates).toEqual(clustered.templates);
    const blogTemplate = view.templates[0]?.id as string;
    const blogPages = await ctx.store.migrations.listPages(scope, run.id, {
      templateId: blogTemplate,
      limit: 10,
    });
    expect(blogPages.map((p) => p.path)).toEqual(['/blog/one', '/blog/two', '/blog/three']);
    // Nothing leaks into another environment.
    expect((await ctx.store.migrations.listRuns(other, { limit: 10 })).length).toBe(0);
  });

  it('stores what a crawl fetched as it inventories', async () => {
    const { ctx, deps, source, blob } = harness(SITE);
    const run = await createMigrationRun(ctx, scope, {
      source: { kind: 'crawl', url: `${O}/`, include: ['/blog/**'] },
    });
    await inventorySite(ctx, deps, scope, run.id);
    expect(source.fetched).toEqual([]);
    const counts = await ctx.store.migrations.countPages(scope, run.id);
    // The 404 the fake answers for a crawl is a URL only, waiting for the fetch step.
    expect(counts).toMatchObject({ total: 4, fetched: 3 });
    expect(blob.keys().length).toBe(3);
    expect((await clusterPages(ctx, scope, run.id)).templates.length).toBe(1);
  });

  it('adds nothing on a second inventory of the same site', async () => {
    const { ctx, deps } = harness(SITE);
    const run = await createMigrationRun(ctx, scope, { source: { kind: 'sitemap', url: `${O}/` } });
    await inventorySite(ctx, deps, scope, run.id);
    const again = await inventorySite(ctx, deps, scope, run.id);
    expect(again.inventory?.added).toBe(0);
    expect(again.version).toBe(3);
    expect((await ctx.store.migrations.countPages(scope, run.id)).total).toBe(6);
  });

  it('clusters again in place, but not once a template is past pending, nor before an inventory', async () => {
    const { ctx, deps, store } = harness(SITE);
    const run = await createMigrationRun(ctx, scope, { source: { kind: 'crawl', url: `${O}/` } });
    await expect(clusterPages(ctx, scope, run.id)).rejects.toThrow(InvalidStateError);
    await inventorySite(ctx, deps, scope, run.id);
    const first = await clusterPages(ctx, scope, run.id);
    // A stricter threshold splits nothing here, but replaces the templates whole.
    const second = await clusterPages(ctx, scope, run.id, { threshold: 0.9 });
    expect(second.templates.map((t) => t.pageCount)).toEqual(
      first.templates.map((t) => t.pageCount),
    );
    const ids = (await store.migrations.listTemplates(scope, run.id)).map((t) => t.id);
    expect(ids).toEqual(second.templates.map((t) => t.id));
    expect(ids).not.toContain(first.templates[0]?.id);
    // An inventory after clustering is refused: the pages would need clustering again.
    await expect(inventorySite(ctx, deps, scope, run.id)).rejects.toThrow(InvalidStateError);

    const [t] = await store.migrations.listTemplates(scope, run.id);
    await store.migrations.replaceTemplates(
      scope,
      run.id,
      [{ template: { ...(t as NonNullable<typeof t>), status: 'authoring' }, pageIds: [] }],
      '2026-11-20T00:00:00.000Z',
    );
    await expect(clusterPages(ctx, scope, run.id)).rejects.toThrow(InvalidStateError);
  });

  it('writes no templates when it loses the race to another clustering', async () => {
    const { ctx, deps, store } = harness(SITE);
    const run = await createMigrationRun(ctx, scope, { source: { kind: 'crawl', url: `${O}/` } });
    await inventorySite(ctx, deps, scope, run.id);
    // Another writer moves the run on between this clustering's read and its commit.
    const getRun = store.migrations.getRun.bind(store.migrations);
    store.migrations.getRun = async (s, id) => {
      const read = await getRun(s, id);
      if (read)
        await store.migrations.saveRun(s, { ...read, version: read.version + 1 }, read.version);
      return read;
    };
    await expect(clusterPages(ctx, scope, run.id)).rejects.toThrow(TransactionConflictError);
    expect(await store.migrations.listTemplates(scope, run.id)).toEqual([]);
    expect((await store.migrations.countPages(scope, run.id)).byStage).toEqual({ discovered: 6 });
  });
});
