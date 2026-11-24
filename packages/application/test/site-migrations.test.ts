import {
  InvalidStateError,
  MIGRATION_MAX_CRAWL_DEPTH,
  type MigrationTemplate,
  NotFoundError,
  ValidationError,
} from '@contentworker/domain';
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
  SiteUnavailableError,
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

/** A site to crawl: the start page links into the blog and the shop; the blog links deeper. */
const CRAWL = {
  [`${O}/`]:
    '<nav><a href="/blog/one">1</a><a href="/blog/two">2</a><a href="/shop/kettle">k</a><a href="/blog/gone">g</a></nav>',
  [`${O}/blog/one`]: article('One').replace(
    '</main>',
    '<a href="/blog/three">3</a><a href="/">home</a></main>',
  ),
  [`${O}/blog/two`]: article('Two').replace('</main>', '<a href="/blog/one">1</a></main>'),
  [`${O}/blog/three`]: article('Three'),
  [`${O}/blog/gone`]: 404,
  [`${O}/shop/kettle`]: product('Kettle'),
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
    expect(first).toEqual({ fetched: 3, failed: 1, added: 0, more: true });
    const second = await fetchSourcePages(ctx, deps, scope, run.id, { limit: 4 });
    expect(second).toEqual({ fetched: 1, failed: 0, added: 0, more: false });
    expect(await fetchSourcePages(ctx, deps, scope, run.id)).toEqual({
      fetched: 0,
      failed: 0,
      added: 0,
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

  it('crawls a batch at a time from the pages table, and resumes where it stopped', async () => {
    const { ctx, deps, source, blob } = harness(CRAWL);
    const run = await createMigrationRun(ctx, scope, {
      source: { kind: 'crawl', url: `${O}/`, exclude: ['/shop/**'] },
    });
    const inventoried = await inventorySite(ctx, deps, scope, run.id);
    // The start page only, nothing fetched yet.
    expect(inventoried.inventory?.added).toBe(1);
    expect(source.fetched).toEqual([]);

    // Each step fetches the waiting pages and adds their links one level deeper.
    const one = await fetchSourcePages(ctx, deps, scope, run.id, { limit: 1 });
    expect(one).toEqual({ fetched: 1, failed: 0, added: 3, more: true });
    // A step that dies here loses nothing: the frontier is the run's pages.
    let steps = 1;
    for (let more = true; more; steps += 1) {
      more = (await fetchSourcePages(ctx, deps, scope, run.id, { limit: 2 })).more;
    }
    const pages = await ctx.store.migrations.listPages(scope, run.id, { limit: 50 });
    expect(pages.map((p) => [p.path, p.depth])).toEqual([
      ['/', 0],
      ['/blog/one', 1],
      ['/blog/two', 1],
      ['/blog/gone', 1],
      ['/blog/three', 2],
    ]);
    // Each page fetched once; the excluded shop never.
    expect(source.fetched.sort()).toEqual(pages.map((p) => p.url).sort());
    expect(blob.keys().length).toBe(4);
    expect(steps).toBeGreaterThan(2);
    expect((await clusterPages(ctx, scope, run.id)).templates.length).toBe(2);
  });

  it('stops adding crawl pages at maxPages and past the depth cap', async () => {
    const chain: Record<string, string> = {};
    for (let i = 0; i < 12; i += 1) chain[`${O}/p${i}`] = `<a href="/p${i + 1}">next</a>`;
    const { ctx, deps } = harness(chain);
    const deep = await createMigrationRun(ctx, scope, {
      source: { kind: 'crawl', url: `${O}/p0` },
    });
    await inventorySite(ctx, deps, scope, deep.id);
    while ((await fetchSourcePages(ctx, deps, scope, deep.id)).more) {}
    const depths = (await ctx.store.migrations.listPages(scope, deep.id, { limit: 50 })).map(
      (p) => p.depth,
    );
    expect(Math.max(...depths)).toBe(MIGRATION_MAX_CRAWL_DEPTH);
    expect(depths.length).toBe(MIGRATION_MAX_CRAWL_DEPTH + 1);

    const fake = harness(CRAWL);
    const small = await createMigrationRun(fake.ctx, scope, {
      source: { kind: 'crawl', url: `${O}/`, maxPages: 3 },
    });
    await inventorySite(fake.ctx, fake.deps, scope, small.id);
    while ((await fetchSourcePages(fake.ctx, fake.deps, scope, small.id)).more) {}
    expect((await fake.ctx.store.migrations.countPages(scope, small.id)).total).toBe(3);
  });

  it('writes nothing while the site is unavailable, and says to try again', async () => {
    const { ctx, deps, source, store } = harness(SITE);
    const run = await createMigrationRun(ctx, scope, { source: { kind: 'sitemap', url: `${O}/` } });
    source.unavailable = 'robots.txt answered 503';
    await expect(inventorySite(ctx, deps, scope, run.id)).rejects.toThrow(SiteUnavailableError);
    expect((await store.migrations.getRun(scope, run.id))?.status).toBe('created');
    source.unavailable = undefined;
    await inventorySite(ctx, deps, scope, run.id);
    source.unavailable = 'robots.txt answered 503';
    expect(await fetchSourcePages(ctx, deps, scope, run.id)).toEqual({
      fetched: 0,
      failed: 0,
      added: 0,
      more: true,
      unavailable: 'robots.txt answered 503',
    });
    // No page took an error for it: the batch waits, whole.
    expect(await store.migrations.countPages(scope, run.id)).toMatchObject({
      failed: 0,
      fetched: 0,
    });
    source.unavailable = undefined;
    expect((await fetchSourcePages(ctx, deps, scope, run.id, { limit: 50 })).more).toBe(false);
  });

  it('adds nothing and stores nothing again on a second inventory of the same site', async () => {
    const { ctx, deps, blob } = harness(SITE);
    const run = await createMigrationRun(ctx, scope, { source: { kind: 'sitemap', url: `${O}/` } });
    await inventorySite(ctx, deps, scope, run.id);
    await fetchSourcePages(ctx, deps, scope, run.id, { limit: 50 });
    const puts = blob.keys().length;
    const again = await inventorySite(ctx, deps, scope, run.id);
    expect(again.inventory?.added).toBe(0);
    expect(again.version).toBe(3);
    expect((await ctx.store.migrations.countPages(scope, run.id)).total).toBe(6);
    expect(blob.keys().length).toBe(puts);
    expect((await fetchSourcePages(ctx, deps, scope, run.id)).fetched).toBe(0);
  });

  it('clusters again in place, but not once a template is past pending, nor before an inventory', async () => {
    const { ctx, deps, store } = harness(SITE);
    const run = await createMigrationRun(ctx, scope, { source: { kind: 'sitemap', url: `${O}/` } });
    await expect(clusterPages(ctx, scope, run.id)).rejects.toThrow(InvalidStateError);
    await inventorySite(ctx, deps, scope, run.id);
    await fetchSourcePages(ctx, deps, scope, run.id, { limit: 50 });
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

    // A template being authored (written by a later step) is never replaced, by the use-case or
    // the store.
    const [key, t] = [...store.migrations.templateData.entries()][0] as [string, MigrationTemplate];
    store.migrations.templateData.set(key, { ...t, status: 'authoring' });
    await expect(clusterPages(ctx, scope, run.id)).rejects.toThrow(InvalidStateError);
    await expect(
      store.migrations.replaceTemplates(scope, run.id, [], '2026-11-20T00:00:00.000Z'),
    ).rejects.toThrow(TransactionConflictError);
  });

  it('writes no templates when it loses the race to another clustering', async () => {
    const { ctx, deps, store } = harness(SITE);
    const run = await createMigrationRun(ctx, scope, { source: { kind: 'sitemap', url: `${O}/` } });
    await inventorySite(ctx, deps, scope, run.id);
    await fetchSourcePages(ctx, deps, scope, run.id, { limit: 50 });
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
    expect((await store.migrations.getRun(scope, run.id))?.status).toBe('inventoried');
  });
});
