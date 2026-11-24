import {
  InvalidStateError,
  MIGRATION_MAX_CRAWL_DEPTH,
  MigrationClusteringHeldError,
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
  listMigrationPages,
  listMigrationRuns,
  listMigrationTemplates,
  SiteUnavailableError,
  sha256Hex,
  takeClustering,
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
      releaseId: null,
      clusteringHeldAt: null,
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

describe('a clustering the run’s driver takes on', () => {
  async function fetched() {
    const h = harness(SITE);
    const run = await createMigrationRun(h.ctx, scope, {
      source: { kind: 'sitemap', url: `${O}/` },
    });
    await inventorySite(h.ctx, h.deps, scope, run.id);
    await fetchSourcePages(h.ctx, h.deps, scope, run.id, { limit: 50 });
    const ids = async () =>
      (await h.store.migrations.listTemplates(scope, run.id)).map((t) => t.id).sort();
    const heldAt = async () =>
      (await h.store.migrations.getRun(scope, run.id))?.clusteringHeldAt ?? null;
    /** Runs `fn` once, after the next `listPages`: a clustering has read the run, and not written. */
    const midway = (fn: () => Promise<unknown>) => {
      const listPages = h.store.migrations.listPages.bind(h.store.migrations);
      let done = false;
      h.store.migrations.listPages = async (...args) => {
        const read = await listPages(...args);
        if (!done) {
          done = true;
          await fn();
        }
        return read;
      };
    };
    return { ...h, run, ids, heldAt, midway };
  }
  const taken = (list: readonly MigrationTemplate[]) => list.map((t) => t.id).sort();

  it('is the one it groups, and isn’t replaced', async () => {
    const { ctx, run, ids, heldAt } = await fetched();
    const templates = await takeClustering(ctx, scope, run.id);
    expect(templates).toHaveLength(2);
    expect(await heldAt()).toBe('2026-11-20T00:00:00.000Z');
    await expect(clusterPages(ctx, scope, run.id, { threshold: 0.9 })).rejects.toThrow(
      MigrationClusteringHeldError,
    );
    expect(await ids()).toEqual(taken(templates));
    // Taken again (the step run again, or a later driver): the same ones, and nothing written.
    const before = await ctx.store.migrations.getRun(scope, run.id);
    expect(taken(await takeClustering(ctx, scope, run.id))).toEqual(taken(templates));
    expect(await ctx.store.migrations.getRun(scope, run.id)).toEqual(before);
  });

  it('is the one a person made by hand, which they could replace until then', async () => {
    const { ctx, run, ids, heldAt } = await fetched();
    const first = await clusterPages(ctx, scope, run.id);
    const second = await clusterPages(ctx, scope, run.id);
    expect(second.run.clusteringHeldAt).toBeNull();
    expect(taken(second.templates)).not.toEqual(taken(first.templates));
    expect(taken(await takeClustering(ctx, scope, run.id))).toEqual(taken(second.templates));
    expect(await heldAt()).not.toBeNull();
    await expect(clusterPages(ctx, scope, run.id)).rejects.toThrow(MigrationClusteringHeldError);
    expect(await ids()).toEqual(taken(second.templates));
  });

  it('beats a clustering that began before it and commits after', async () => {
    const { ctx, run, ids, midway } = await fetched();
    const { templates } = await clusterPages(ctx, scope, run.id);
    midway(() => takeClustering(ctx, scope, run.id));
    await expect(clusterPages(ctx, scope, run.id)).rejects.toThrow(MigrationClusteringHeldError);
    expect(await ids()).toEqual(taken(templates));
  });

  it('beats a first clustering that began before it, too', async () => {
    const { ctx, run, ids, midway } = await fetched();
    let driver: readonly MigrationTemplate[] = [];
    midway(async () => {
      driver = await takeClustering(ctx, scope, run.id);
    });
    await expect(clusterPages(ctx, scope, run.id)).rejects.toThrow(MigrationClusteringHeldError);
    expect(driver).toHaveLength(2);
    expect(await ids()).toEqual(taken(driver));
  });

  it('loses to one that commits first, which it takes when it reads again', async () => {
    const { ctx, store, run, ids, heldAt, midway } = await fetched();
    // The driver was grouping the pages itself.
    let hand: readonly MigrationTemplate[] = [];
    midway(async () => {
      hand = (await clusterPages(ctx, scope, run.id)).templates;
    });
    await expect(takeClustering(ctx, scope, run.id)).rejects.toThrow(TransactionConflictError);
    expect(await heldAt()).toBeNull();
    expect(await ids()).toEqual(taken(hand));

    // It was taking what a person had made, as they made it again: after it read the run, and
    // after it read the templates.
    for (const read of ['getRun', 'listTemplates'] as const) {
      const repo = store.migrations as unknown as Record<string, (...a: unknown[]) => unknown>;
      const inner = repo[read]?.bind(store.migrations) as (...a: unknown[]) => Promise<unknown>;
      repo[read] = async (...args) => {
        const result = await inner(...args);
        repo[read] = inner;
        hand = (await clusterPages(ctx, scope, run.id)).templates;
        return result;
      };
      await expect(takeClustering(ctx, scope, run.id)).rejects.toThrow(TransactionConflictError);
      expect(await heldAt()).toBeNull();
    }
    expect(taken(await takeClustering(ctx, scope, run.id))).toEqual(taken(hand));
    expect(await heldAt()).not.toBeNull();
    expect(await ids()).toEqual(taken(hand));
  });

  it('is left unheld when it has no templates, and the run’s state is refused as before', async () => {
    const { ctx, deps } = harness({ [`${O}/gone`]: 404 });
    const run = await createMigrationRun(ctx, scope, { source: { kind: 'sitemap', url: `${O}/` } });
    await expect(takeClustering(ctx, scope, run.id)).rejects.toThrow(InvalidStateError);
    await inventorySite(ctx, deps, scope, run.id);
    await fetchSourcePages(ctx, deps, scope, run.id, { limit: 50 });
    expect(await takeClustering(ctx, scope, run.id)).toEqual([]);
    expect(await takeClustering(ctx, scope, run.id)).toEqual([]);
    expect((await clusterPages(ctx, scope, run.id)).run.clusteringHeldAt).toBeNull();
    await expect(takeClustering(ctx, other, run.id)).rejects.toThrow(NotFoundError);
  });
});

describe('reading a run back', () => {
  it('lists runs newest first, per environment, capped', async () => {
    const { ctx } = harness({});
    const first = await createMigrationRun(ctx, scope, { source: { kind: 'crawl', url: `${O}/` } });
    const second = await createMigrationRun(ctx, scope, {
      source: { kind: 'sitemap', url: `${O}/sitemap.xml` },
    });
    await createMigrationRun(ctx, other, { source: { kind: 'crawl', url: `${O}/` } });
    expect((await listMigrationRuns(ctx, scope)).items.map((r) => r.id)).toEqual([
      second.id,
      first.id,
    ]);
    expect((await listMigrationRuns(ctx, scope, { limit: 1 })).items).toHaveLength(1);
    expect((await listMigrationRuns(ctx, scope, { limit: 0 })).items).toHaveLength(1);
    expect((await listMigrationRuns(ctx, other)).items).toHaveLength(1);
  });

  it('pages through pages by stage and template, with a cursor only while more follow', async () => {
    const { ctx, deps } = harness(SITE);
    const run = await createMigrationRun(ctx, scope, { source: { kind: 'sitemap', url: `${O}/` } });
    await inventorySite(ctx, deps, scope, run.id);
    for (let more = true; more; ) {
      more = (await fetchSourcePages(ctx, deps, scope, run.id)).more;
    }
    const { templates } = await clusterPages(ctx, scope, run.id);

    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await listMigrationPages(ctx, scope, run.id, {
        limit: 2,
        ...(cursor ? { cursor } : {}),
      });
      expect(page.items.length).toBeLessThanOrEqual(2);
      seen.push(...page.items.map((p) => p.url));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual(Object.keys(SITE));
    // Exactly a page's worth left: no cursor to a page that would be empty.
    const all = await listMigrationPages(ctx, scope, run.id, { limit: 6 });
    expect(all.items).toHaveLength(6);
    expect(all.nextCursor).toBeUndefined();

    // The 404 never got HTML, so clustering left it discovered.
    const discovered = await listMigrationPages(ctx, scope, run.id, { stage: 'discovered' });
    expect(discovered.items.map((p) => p.url)).toEqual([`${O}/blog/gone`]);
    const largest = templates[0] as MigrationTemplate;
    const ofTemplate = await listMigrationPages(ctx, scope, run.id, { templateId: largest.id });
    expect(ofTemplate.items).toHaveLength(largest.pageCount);
    expect(ofTemplate.items.every((p) => p.stage === 'clustered')).toBe(true);

    expect((await listMigrationTemplates(ctx, scope, run.id)).items).toEqual(templates);
  });

  it('answers 404 for a run in another environment and refuses an unknown stage', async () => {
    const { ctx } = harness({});
    const run = await createMigrationRun(ctx, scope, { source: { kind: 'crawl', url: `${O}/` } });
    await expect(listMigrationPages(ctx, other, run.id)).rejects.toThrow(NotFoundError);
    await expect(listMigrationTemplates(ctx, other, run.id)).rejects.toThrow(NotFoundError);
    await expect(
      listMigrationPages(ctx, scope, run.id, { stage: 'finished' as 'loaded' }),
    ).rejects.toThrow(ValidationError);
  });
});
