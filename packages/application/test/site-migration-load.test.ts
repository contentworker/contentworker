import {
  type FieldDefinition,
  ForbiddenError,
  type ImportScriptOutput,
  InvalidStateError,
  type MigrationPage,
  type MigrationRun,
  type MigrationTemplate,
  NotFoundError,
  type Principal,
  type RichTextNode,
  SCOPES,
} from '@contentworker/domain';
import {
  type RemoteFetcher,
  type RemoteFile,
  TransactionConflictError,
} from '@contentworker/ports';
import { FakeBlobStore, FixedClock, InMemoryContentStore } from '@contentworker/test-kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type AppContext,
  createContentType,
  createEntry,
  createMigrationRun,
  getEntry,
  importMigrationRedirects,
  listRedirects,
  loadTemplatePages,
  publishContentType,
  publishMigration,
  publishRelease,
  relinkMigratedPages,
  SYSTEM_CALLER,
  sha256Hex,
  updateEntry,
} from '../src/index';

const scope = { spaceId: 'site', environmentId: 'main' };
const other = { spaceId: 'site', environmentId: 'staging' };
const O = 'https://site.test';
const admin: Principal = { spaceId: '*', kind: 'admin', scopes: Object.values(SCOPES) };
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

const field = (over: Partial<FieldDefinition> & Pick<FieldDefinition, 'apiId' | 'type'>) =>
  ({
    name: over.apiId,
    localized: false,
    required: false,
    position: 0,
    ...over,
  }) as FieldDefinition;

const ARTICLE: FieldDefinition[] = [
  field({ apiId: 'title', type: 'Symbol', required: true }),
  field({ apiId: 'slug', type: 'Slug', position: 1 }),
  field({ apiId: 'sourceUrl', type: 'Symbol', unique: true, position: 2 }),
  field({ apiId: 'summary', type: 'RichText', position: 3 }),
  field({
    apiId: 'sections',
    type: 'Array',
    position: 4,
    items: {
      type: 'Component',
      variants: [
        {
          apiId: 'hero',
          name: 'Hero',
          fields: [
            field({ apiId: 'heading', type: 'Symbol' }),
            field({ apiId: 'image', type: 'Link', linkType: 'Asset', position: 1 }),
          ],
        },
        { apiId: 'text', name: 'Text', fields: [field({ apiId: 'body', type: 'RichText' })] },
      ],
    },
  }),
];

/** A fetcher answering each URL from `files` (404 otherwise), counting what it was asked for. */
function fetcher(files: Record<string, RemoteFile>): RemoteFetcher & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async get() {
      throw new Error('not used');
    },
    async getBytes(url) {
      calls.push(url);
      return files[url] ?? { status: 404, bytes: new Uint8Array() };
    },
  };
}

/** An article page's output: a title, a hero with the shared image, and a text block. */
const article = (name: string, body: string, over: Partial<ImportScriptOutput> = {}) =>
  ({
    fields: { title: name, slug: name.toLowerCase() },
    blocks: [
      { variant: 'hero', fields: { heading: name, image: { $asset: '/img/shared.png' } } },
      { variant: 'text', fields: { body: { $html: body } } },
    ],
    assets: [{ url: `${O}/img/shared.png`, alt: 'Shared' }],
    links: [],
    ...over,
  }) satisfies ImportScriptOutput;

let n = 0;
let store: InMemoryContentStore;
let clock: FixedClock;
let ctx: AppContext;
let blob: FakeBlobStore;
let files: ReturnType<typeof fetcher>;
let deps: { blob: FakeBlobStore; fetcher: RemoteFetcher };

beforeEach(async () => {
  n = 0;
  store = new InMemoryContentStore();
  store.seedSpace({ spaceId: 'site', defaultLocale: 'en-US', locales: ['en-US'] });
  clock = new FixedClock(new Date('2026-11-20T00:00:00.000Z'));
  ctx = {
    store,
    clock,
    ids: { newId: () => `id-${String(++n).padStart(4, '0')}` },
    actor: 'ed@example.com',
  };
  blob = new FakeBlobStore();
  files = fetcher({
    [`${O}/img/shared.png`]: { status: 200, contentType: 'image/png', bytes: PNG },
    [`${O}/img/one.png`]: { status: 200, contentType: 'image/png', bytes: PNG },
  });
  deps = { blob, fetcher: files };
  await defineArticle(ARTICLE);
});

async function defineArticle(fields: FieldDefinition[], at = scope) {
  await createContentType(ctx, SYSTEM_CALLER, at, {
    apiId: 'article',
    name: 'Article',
    displayField: 'title',
    urlPattern: '/articles/{slug}',
    fields,
  });
  await publishContentType(ctx, at, 'article');
}

/**
 * A run whose pages (in the order given) are transformed and `validated` under one template: each
 * page's output stored as the script left it, as the transform step will.
 */
async function seed(
  pages: Record<string, ImportScriptOutput | string | null>,
  template: Partial<MigrationTemplate> = {},
): Promise<{ run: MigrationRun; template: MigrationTemplate; pages: MigrationPage[] }> {
  const run = await createMigrationRun(ctx, scope, {
    source: { kind: 'sitemap', url: `${O}/sitemap.xml` },
  });
  const at = clock.now().toISOString();
  const list: MigrationPage[] = Object.keys(pages).map((path) => ({
    id: ctx.ids.newId(),
    runId: run.id,
    url: `${O}${path}`,
    path,
    depth: 0,
    stage: 'discovered',
    templateId: null,
    title: null,
    lastModified: null,
    httpStatus: 200,
    html: null,
    fingerprint: null,
    output: null,
    score: null,
    entryId: null,
    unresolvedLinks: 0,
    error: null,
    createdAt: at,
    updatedAt: at,
  }));
  await store.migrations.addPages(scope, run.id, list);
  const t: MigrationTemplate = {
    id: ctx.ids.newId(),
    runId: run.id,
    label: 'Articles',
    status: 'approved',
    pageCount: list.length,
    samplePageIds: [],
    fingerprint: [],
    contentTypeId: 'article',
    script: null,
    version: 1,
    createdAt: at,
    updatedAt: at,
    ...template,
  };
  await store.migrations.replaceTemplates(
    scope,
    run.id,
    [{ template: t, pageIds: list.map((p) => p.id) }],
    at,
  );
  const transformed = await Promise.all(
    list.map(async (p) => {
      const output = pages[p.path];
      if (output === null || output === undefined) {
        return { ...p, templateId: t.id, stage: 'validated' as const };
      }
      const raw = typeof output === 'string' ? output : JSON.stringify(output);
      const sha256 = sha256Hex(raw);
      const key = `migrations/${scope.spaceId}/${scope.environmentId}/${run.id}/output/${sha256}.json`;
      await blob.put(key, raw, 'application/json');
      return {
        ...p,
        templateId: t.id,
        stage: 'validated' as const,
        output: { key, sha256, bytes: raw.length },
      };
    }),
  );
  await store.migrations.savePages(scope, run.id, transformed);
  return { run, template: t, pages: transformed };
}

const pageAt = async (run: MigrationRun, path: string) =>
  (await store.migrations.listPages(scope, run.id, { limit: 100 })).find(
    (p) => p.path === path,
  ) as MigrationPage;

const entryOf = async (run: MigrationRun, path: string) =>
  getEntry(ctx, scope, (await pageAt(run, path)).entryId as string);

const articles = async () =>
  (await store.entries.list(scope, { contentTypeApiId: 'article', limit: 100 })).length;

/** Every node of a type in a rich-text value, however deep. */
const nodes = (value: unknown, type: string): RichTextNode[] => {
  const out: RichTextNode[] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      if ((v as RichTextNode).nodeType === type) out.push(v as RichTextNode);
      Object.values(v).forEach(walk);
    }
  };
  walk(value);
  return out;
};

const SITE = {
  '/blog/one': article(
    'One',
    `<p>See <a href="/blog/two">two</a> and <a href="https://elsewhere.test/x">elsewhere</a>.</p><p><img src="/img/one.png" alt="One pic"></p>`,
    // Relative, as a page writes it: resolved against the page's URL.
    { assets: [{ url: `${O}/img/shared.png`, alt: 'Shared' }, { url: '/img/one.png' }] },
  ),
  '/blog/two': article('Two', '<p>Back to <a href="one">one</a>.</p>'),
  '/blog/three': article('Three', '<p>Also <a href="/blog/one#top">one</a>.</p>'),
};

describe('loading a template’s pages', () => {
  it('writes one entry per page through the planner, with its blocks, assets and links', async () => {
    const { run, template } = await seed(SITE);
    const first = await loadTemplatePages(ctx, deps, admin, scope, {
      runId: run.id,
      templateId: template.id,
      batchSize: 2,
    });
    expect(first).toMatchObject({ loaded: 2, failed: [], assetFailures: [], more: true });
    // one → two and two → one: neither had an entry when the batch read the run.
    expect(first.unresolvedLinks).toBe(2);

    const one = await entryOf(run, '/blog/one');
    expect(one.fields.sourceUrl).toEqual({ 'en-US': `${O}/blog/one` });
    expect(one.fields.title).toEqual({ 'en-US': 'One' });
    const sections = one.fields.sections?.['en-US'] as Record<string, unknown>[];
    expect(sections.map((s) => s._type)).toEqual(['hero', 'text']);
    const hero = sections[0] as { image: { id: string; linkType: string } };
    expect(hero.image.linkType).toBe('Asset');
    // The image in the fragment is an embedded asset; the links stay hyperlinks for now.
    const embedded = nodes(sections[1], 'embedded-asset-block');
    expect(embedded).toHaveLength(1);
    expect(nodes(sections[1], 'hyperlink').map((h) => h.data?.uri)).toEqual([
      '/blog/two',
      'https://elsewhere.test/x',
    ]);
    // No markup anywhere in what was stored.
    expect(JSON.stringify(one.fields)).not.toMatch(/\$html|<p>|<img/);
    expect(await pageAt(run, '/blog/one')).toMatchObject({
      stage: 'loaded',
      entryId: one.entry.id,
      unresolvedLinks: 1,
      error: null,
    });

    // The shared image was downloaded once for both pages, and is the same asset in both.
    expect(files.calls.filter((u) => u.endsWith('/shared.png'))).toHaveLength(1);
    const two = await entryOf(run, '/blog/two');
    const twoHero = (
      two.fields.sections?.['en-US'] as { image?: { id: string } }[] | undefined
    )?.[0];
    expect(twoHero?.image?.id).toBe(hero.image.id);

    // The next batch's link to a loaded page is an entry link straight away.
    const second = await loadTemplatePages(ctx, deps, admin, scope, {
      runId: run.id,
      templateId: template.id,
      batchSize: 2,
    });
    expect(second).toMatchObject({ loaded: 1, unresolvedLinks: 0, more: false });
    const three = await entryOf(run, '/blog/three');
    expect(nodes(three.fields, 'entry-hyperlink').map((l) => l.data?.target?.id)).toEqual([
      one.entry.id,
    ]);
    // Still one download of the shared file: the run remembers what it brought in.
    expect(files.calls.filter((u) => u.endsWith('/shared.png'))).toHaveLength(1);
    expect(await articles()).toBe(3);
    expect(
      await loadTemplatePages(ctx, deps, admin, scope, { runId: run.id, templateId: template.id }),
    ).toMatchObject({ loaded: 0, more: false });
  });

  it('updates the same entries when the pages are loaded again, never adding to them', async () => {
    const { run, template } = await seed(SITE);
    await loadTemplatePages(ctx, deps, admin, scope, { runId: run.id, templateId: template.id });
    const before = await entryOf(run, '/blog/one');
    // As if the pages were transformed again: back to validated.
    const pages = await store.migrations.listPages(scope, run.id, { limit: 100 });
    await store.migrations.savePages(
      scope,
      run.id,
      pages.map((p) => ({ ...p, stage: 'validated' })),
    );
    const again = await loadTemplatePages(ctx, deps, admin, scope, {
      runId: run.id,
      templateId: template.id,
    });
    expect(again).toMatchObject({ loaded: 3, failed: [], more: false });
    expect(await articles()).toBe(3);
    const after = await entryOf(run, '/blog/one');
    expect(after.entry.id).toBe(before.entry.id);
    expect(after.entry.currentVersion).toBeGreaterThan(before.entry.currentVersion);
    // Now every page had an entry when the batch read the run: the links resolve at load.
    expect(nodes(after.fields, 'entry-hyperlink')).toHaveLength(1);
    expect(files.calls).toHaveLength(2);
  });

  it('loads a page without an asset it can’t download, and refuses a page the type refuses', async () => {
    const { run, template } = await seed({
      '/blog/one': article('One', '<p><img src="/img/gone.png" alt="Gone"></p>', {
        assets: [{ url: `${O}/img/shared.png` }, { url: `${O}/img/gone.png` }],
      }),
      '/blog/untitled': article('Untitled', '<p>x</p>', { fields: {} }),
      '/blog/extra': article('Extra', '<p>x</p>', { fields: { title: 'Extra', nope: 1 } }),
      '/blog/garbled': '{ not json',
      '/blog/empty': null,
    });
    const result = await loadTemplatePages(ctx, deps, admin, scope, {
      runId: run.id,
      templateId: template.id,
    });
    expect(result.loaded).toBe(1);
    expect(result.assetFailures).toEqual([
      { pageId: expect.any(String), url: `${O}/img/gone.png`, error: expect.stringMatching(/404/) },
    ]);
    const one = await entryOf(run, '/blog/one');
    // The lost image stays a link to where it was; the shared one still made it.
    expect(nodes(one.fields, 'embedded-asset-block')).toHaveLength(0);
    expect(nodes(one.fields, 'hyperlink').map((h) => h.data?.uri)).toEqual(['/img/gone.png']);

    const reasons = Object.fromEntries(
      result.failed.map((f) => [new URL(f.url).pathname, f.error]),
    );
    expect(reasons['/blog/untitled']).toMatch(/title/);
    expect(reasons['/blog/extra']).toMatch(/Fields not on "article": nope/);
    expect(reasons['/blog/garbled']).toMatch(/not JSON/);
    expect(reasons['/blog/empty']).toMatch(/no import script output/);
    for (const path of Object.keys(reasons)) {
      expect(await pageAt(run, path)).toMatchObject({ stage: 'needs-fix', entryId: null });
    }
    // A refused page isn't taken again, even when needs-fix pages are asked for.
    expect(
      await loadTemplatePages(ctx, deps, admin, scope, {
        runId: run.id,
        templateId: template.id,
        includeNeedsFix: true,
      }),
    ).toMatchObject({ loaded: 0, more: false });
    expect(await articles()).toBe(1);
  });

  it('refuses output whose bytes aren’t the ones the page was scored on', async () => {
    const { run, template, pages } = await seed({ '/blog/one': SITE['/blog/one'] });
    await blob.put(pages[0]?.output?.key as string, JSON.stringify(SITE['/blog/two']), 'x');
    const result = await loadTemplatePages(ctx, deps, admin, scope, {
      runId: run.id,
      templateId: template.id,
    });
    expect(result.failed[0]?.error).toMatch(/not the one it was scored on/);
  });

  it('takes needs-fix pages only when asked', async () => {
    const { run, template, pages } = await seed({ '/blog/one': SITE['/blog/one'] });
    await store.migrations.savePages(scope, run.id, [
      { ...(pages[0] as MigrationPage), stage: 'needs-fix' },
    ]);
    const input = { runId: run.id, templateId: template.id };
    expect(await loadTemplatePages(ctx, deps, admin, scope, input)).toMatchObject({ loaded: 0 });
    expect(
      await loadTemplatePages(ctx, deps, admin, scope, { ...input, includeNeedsFix: true }),
    ).toMatchObject({ loaded: 1 });
  });

  it('refuses a template that isn’t ready, and a content type without the identity field', async () => {
    const pending = await seed({ '/a': SITE['/blog/one'] }, { status: 'authoring' });
    await expect(
      loadTemplatePages(ctx, deps, admin, scope, {
        runId: pending.run.id,
        templateId: pending.template.id,
      }),
    ).rejects.toThrow(InvalidStateError);
    const untyped = await seed({ '/a': SITE['/blog/one'] }, { contentTypeId: null });
    await expect(
      loadTemplatePages(ctx, deps, admin, scope, {
        runId: untyped.run.id,
        templateId: untyped.template.id,
      }),
    ).rejects.toThrow(/no content type/);
    const missing = await seed({ '/a': SITE['/blog/one'] }, { contentTypeId: 'gone' });
    await expect(
      loadTemplatePages(ctx, deps, admin, scope, {
        runId: missing.run.id,
        templateId: missing.template.id,
      }),
    ).rejects.toThrow(/doesn't exist/);

    // Not unique: two loads racing on one page could both create.
    await defineArticle(
      ARTICLE.map((f) => (f.apiId === 'sourceUrl' ? { ...f, unique: false } : f)),
    );
    const loose = await seed({ '/a': SITE['/blog/one'] });
    await expect(
      loadTemplatePages(ctx, deps, admin, scope, {
        runId: loose.run.id,
        templateId: loose.template.id,
      }),
    ).rejects.toThrow(/needs a "sourceUrl" field \(Symbol or Text, unique, not localized\)/);
    expect(await articles()).toBe(0);
  });

  it('is refused for a role that can’t write the type, and keeps to its scope', async () => {
    const { run, template } = await seed(SITE);
    const reader: Principal = {
      spaceId: 'site',
      kind: 'user',
      scopes: [SCOPES.contentRead],
    };
    await expect(
      loadTemplatePages(ctx, deps, reader, scope, { runId: run.id, templateId: template.id }),
    ).rejects.toThrow(ForbiddenError);
    await expect(
      loadTemplatePages(ctx, deps, admin, other, { runId: run.id, templateId: template.id }),
    ).rejects.toThrow(NotFoundError);
    // Refused before anything was downloaded on its behalf.
    const editorElsewhere: Principal = {
      spaceId: 'site',
      kind: 'user',
      scopes: [SCOPES.contentWrite],
      contentGrants: [{ contentTypeApiId: 'page', actions: ['read', 'write'] }],
    };
    await expect(
      loadTemplatePages(ctx, deps, editorElsewhere, scope, {
        runId: run.id,
        templateId: template.id,
      }),
    ).rejects.toThrow(ForbiddenError);
    expect(files.calls).toEqual([]);
    expect(await articles()).toBe(0);
    expect((await pageAt(run, '/blog/one')).stage).toBe('validated');
  });

  it('loads the batch again from a fresh read when a page moved meanwhile', async () => {
    const { run, template } = await seed(SITE);
    const move = store.migrations.movePages.bind(store.migrations);
    let raced = false;
    const spy = vi.spyOn(store.migrations, 'movePages').mockImplementation(async (s, r, moves) => {
      if (!raced) {
        raced = true;
        // Another step rewrote a page after the load read it.
        const page = await store.migrations.getPage(s, r, moves[0]?.page.id as string);
        await store.migrations.savePages(s, r, [
          { ...(page as MigrationPage), updatedAt: '2026-11-20T00:00:00.001Z' },
        ]);
      }
      return move(s, r, moves);
    });
    const result = await loadTemplatePages(ctx, deps, admin, scope, {
      runId: run.id,
      templateId: template.id,
    });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ loaded: 3, more: false });
    // The second attempt matched the entries the first wrote.
    expect(await articles()).toBe(3);
    spy.mockRestore();
  });

  it('gives up after its attempts when it keeps losing, with no entry written twice', async () => {
    const { run, template } = await seed(SITE);
    const spy = vi
      .spyOn(store.migrations, 'movePages')
      .mockRejectedValue(new TransactionConflictError());
    await expect(
      loadTemplatePages(ctx, deps, admin, scope, { runId: run.id, templateId: template.id }),
    ).rejects.toThrow(TransactionConflictError);
    expect(spy).toHaveBeenCalledTimes(3);
    spy.mockRestore();
    expect(await articles()).toBe(3);
    expect((await pageAt(run, '/blog/one')).stage).toBe('validated');
  });
});

describe('loading, under review', () => {
  const plain = (name: string) =>
    article(name, '<p>Just text.</p>', {
      blocks: [{ variant: 'text', fields: { body: { $html: '<p>Just text.</p>' } } }],
      assets: [],
    });

  it('records each asset as it lands, so a step stopped partway fetches only the rest again', async () => {
    const { run, template } = await seed({ '/blog/one': SITE['/blog/one'] });
    const put = blob.put.bind(blob);
    let puts = 0;
    const spy = vi.spyOn(blob, 'put').mockImplementation(async (key, body, type) => {
      // The second file's write fails: storage, not the file, so the step stops.
      if (++puts === 2) throw new Error('bucket unavailable');
      return put(key, body, type);
    });
    await expect(
      loadTemplatePages(ctx, deps, admin, scope, { runId: run.id, templateId: template.id }),
    ).rejects.toThrow('bucket unavailable');
    spy.mockRestore();
    const result = await loadTemplatePages(ctx, deps, admin, scope, {
      runId: run.id,
      templateId: template.id,
    });
    expect(result).toMatchObject({ loaded: 1, assetFailures: [] });
    // The first file was fetched once; only the one that failed was fetched again.
    expect(files.calls.filter((u) => u.endsWith('/shared.png'))).toHaveLength(1);
    expect(files.calls.filter((u) => u.endsWith('/one.png'))).toHaveLength(2);
    const { items } = await store.assets.list(scope, { limit: 100, filters: { status: 'all' } });
    expect(items).toHaveLength(2);
    // Stamped with who asked.
    expect(items.map((a) => a.createdBy)).toEqual(['admin-token', 'admin-token']);
  });

  it('loads a page again when another write took its sourceUrl as it planned, rather than refusing it', async () => {
    const { run, template } = await seed({ '/blog/one': plain('One') });
    const find = store.entries.findUniqueConflicts.bind(store.entries);
    let raced = false;
    const spy = vi
      .spyOn(store.entries, 'findUniqueConflicts')
      .mockImplementation(async (s, claims, exclude) => {
        const held = await find(s, claims, exclude);
        if (!raced) {
          raced = true;
          // Another load wrote the page's entry after this one looked, and stopped before moving
          // the page: this load plans a create, and the claim refuses it.
          await createEntry(ctx, scope, {
            contentTypeApiId: 'article',
            fields: { title: { 'en-US': 'Other' }, sourceUrl: { 'en-US': `${O}/blog/one` } },
          });
        }
        return held;
      });
    const result = await loadTemplatePages(ctx, deps, admin, scope, {
      runId: run.id,
      templateId: template.id,
    });
    spy.mockRestore();
    expect(result).toMatchObject({ loaded: 1, failed: [], deferred: [], more: false });
    expect(await articles()).toBe(1);
    const page = await pageAt(run, '/blog/one');
    expect(page).toMatchObject({ stage: 'loaded', error: null });
    // The second attempt found the other write's entry and updated it.
    expect((await getEntry(ctx, scope, page.entryId as string)).fields.title).toEqual({
      'en-US': 'One',
    });
  });

  it('leaves a page to the load that won when two load it at once', async () => {
    const { run, template } = await seed({ '/blog/one': plain('One') });
    const find = store.entries.findUniqueConflicts.bind(store.entries);
    let raced = false;
    const spy = vi
      .spyOn(store.entries, 'findUniqueConflicts')
      .mockImplementation(async (s, claims, exclude) => {
        const held = await find(s, claims, exclude);
        if (!raced) {
          raced = true;
          clock.advance(1);
          await loadTemplatePages(ctx, deps, admin, scope, {
            runId: run.id,
            templateId: template.id,
          });
        }
        return held;
      });
    const outer = await loadTemplatePages(ctx, deps, admin, scope, {
      runId: run.id,
      templateId: template.id,
    });
    spy.mockRestore();
    expect(outer).toMatchObject({ loaded: 0, failed: [], deferred: [], more: false });
    expect(await articles()).toBe(1);
    expect(await pageAt(run, '/blog/one')).toMatchObject({ stage: 'loaded', error: null });
  });

  it('looks up only the batch’s source URLs, not every entry of the type', async () => {
    const { run, template } = await seed({ '/blog/one': plain('One') });
    const list = vi.spyOn(store.entries, 'list');
    await loadTemplatePages(ctx, deps, admin, scope, { runId: run.id, templateId: template.id });
    expect(list).not.toHaveBeenCalled();
    list.mockRestore();
  });

  it('refuses a page whose markers are out of place, or whose text is markup', async () => {
    const { run, template } = await seed({
      '/html-in-symbol': plain('A'),
      '/html-in-block': plain('B'),
      '/extra-keys': plain('C'),
      '/markup-title': plain('D'),
      '/prose': plain('E'),
    });
    const pages = await store.migrations.listPages(scope, run.id, { limit: 10 });
    const outputs: Record<string, ImportScriptOutput> = {
      '/html-in-symbol': { ...plain('A'), fields: { title: { $html: '<b>A</b>' } } },
      '/html-in-block': {
        ...plain('B'),
        blocks: [{ variant: 'hero', fields: { heading: { $html: '<p>B</p>' } } }],
      },
      '/extra-keys': {
        ...plain('C'),
        fields: { title: 'C', summary: { $html: '<p>C</p>', note: 'x' } },
      },
      '/markup-title': { ...plain('D'), fields: { title: '<p>D</p>' } },
      '/prose': { ...plain('E'), fields: { title: 'When a < b and b > c' } },
    };
    await store.migrations.savePages(
      scope,
      run.id,
      await Promise.all(
        pages.map(async (p) => {
          const raw = JSON.stringify(outputs[p.path]);
          const key = `${p.output?.key}.${p.path.slice(1)}`;
          await blob.put(key, raw, 'application/json');
          return { ...p, output: { key, sha256: sha256Hex(raw), bytes: raw.length } };
        }),
      ),
    );
    const result = await loadTemplatePages(ctx, deps, admin, scope, {
      runId: run.id,
      templateId: template.id,
    });
    const reasons = Object.fromEntries(
      result.failed.map((f) => [new URL(f.url).pathname, f.error]),
    );
    expect(reasons['/html-in-symbol']).toMatch(
      /fields\.title: \$html goes only in a RichText field/,
    );
    expect(reasons['/html-in-block']).toMatch(/blocks\[0\]\.heading: \$html goes only/);
    expect(reasons['/extra-keys']).toMatch(/fields\.summary: a \$html or \$asset marker/);
    expect(reasons['/markup-title']).toMatch(/fields\.title: holds markup/);
    expect(result.loaded).toBe(1);
    expect((await entryOf(run, '/prose')).fields.title).toEqual({
      'en-US': 'When a < b and b > c',
    });
  });

  it('refuses a role that may not query or write sourceUrl before downloading anything', async () => {
    const { run, template } = await seed(SITE);
    const grant = (over: object): Principal => ({
      spaceId: 'site',
      kind: 'user',
      scopes: [SCOPES.contentWrite],
      contentGrants: [{ contentTypeApiId: 'article', actions: ['read', 'write'], ...over }],
    });
    for (const who of [
      grant({ readOnlyFields: ['sourceUrl'] }),
      grant({ deniedFields: ['sourceUrl'] }),
    ]) {
      await expect(
        loadTemplatePages(ctx, deps, who, scope, { runId: run.id, templateId: template.id }),
      ).rejects.toThrow(ForbiddenError);
    }
    expect(files.calls).toEqual([]);
    expect(await articles()).toBe(0);
  });
});

describe('relinking migrated pages', () => {
  it('points the links left as hyperlinks at the entries loaded since, saving only those', async () => {
    const { run, template } = await seed(SITE);
    await loadTemplatePages(ctx, deps, admin, scope, {
      runId: run.id,
      templateId: template.id,
      batchSize: 2,
    });
    // Three loads after one and two, so it links to one at load and has nothing to relink.
    await loadTemplatePages(ctx, deps, admin, scope, { runId: run.id, templateId: template.id });
    const threeBefore = await entryOf(run, '/blog/three');

    const result = await relinkMigratedPages(ctx, admin, scope, { runId: run.id });
    expect(result).toEqual({ checked: 2, relinked: 2, unresolvedLinks: 0, skipped: [] });
    const one = await entryOf(run, '/blog/one');
    const two = await entryOf(run, '/blog/two');
    expect(nodes(one.fields, 'entry-hyperlink').map((l) => l.data?.target?.id)).toEqual([
      two.entry.id,
    ]);
    // The link to another site stays as it was, with its text.
    expect(nodes(one.fields, 'hyperlink').map((h) => h.data?.uri)).toEqual([
      'https://elsewhere.test/x',
    ]);
    expect(nodes(two.fields, 'entry-hyperlink').map((l) => l.data?.target?.id)).toEqual([
      one.entry.id,
    ]);
    expect((await pageAt(run, '/blog/one')).unresolvedLinks).toBe(0);
    expect((await entryOf(run, '/blog/three')).entry.currentVersion).toBe(
      threeBefore.entry.currentVersion,
    );

    // A second pass finds nothing to do and saves nothing.
    expect(await relinkMigratedPages(ctx, admin, scope, { runId: run.id })).toEqual({
      checked: 0,
      relinked: 0,
      unresolvedLinks: 0,
      skipped: [],
    });
    expect((await entryOf(run, '/blog/one')).entry.currentVersion).toBe(one.entry.currentVersion);
  });

  it('keeps a link to a page still waiting, and walks the run once with a cursor', async () => {
    const { run, template } = await seed(SITE);
    await loadTemplatePages(ctx, deps, admin, scope, {
      runId: run.id,
      templateId: template.id,
      batchSize: 1,
    });
    // Only one is loaded: its link to two has no entry to point at yet.
    const first = await relinkMigratedPages(ctx, admin, scope, { runId: run.id, batchSize: 1 });
    expect(first).toMatchObject({
      checked: 1,
      relinked: 0,
      unresolvedLinks: 1,
      next: expect.any(String),
    });
    const rest = await relinkMigratedPages(ctx, admin, scope, {
      runId: run.id,
      batchSize: 1,
      after: first.next as string,
    });
    expect(rest).toEqual({ checked: 0, relinked: 0, unresolvedLinks: 0, skipped: [] });
    expect((await pageAt(run, '/blog/one')).unresolvedLinks).toBe(1);
  });

  it('skips an entry edited after it was read, keeping its count for the next pass', async () => {
    const { run, template } = await seed(SITE);
    await loadTemplatePages(ctx, deps, admin, scope, {
      runId: run.id,
      templateId: template.id,
      batchSize: 2,
    });
    await loadTemplatePages(ctx, deps, admin, scope, { runId: run.id, templateId: template.id });
    const one = await pageAt(run, '/blog/one');
    const getMany = store.entries.getMany.bind(store.entries);
    const spy = vi.spyOn(store.entries, 'getMany').mockImplementationOnce(async (s, ids) => {
      const read = await getMany(s, ids);
      // An editor saves one's entry after the pass read it.
      await updateEntry(ctx, scope, one.entryId as string, {
        title: { 'en-US': 'Edited' },
        sourceUrl: { 'en-US': one.url },
      });
      return read;
    });
    const result = await relinkMigratedPages(ctx, admin, scope, { runId: run.id });
    spy.mockRestore();
    expect(result.relinked).toBe(1);
    expect(result.skipped).toEqual([
      { pageId: one.id, url: one.url, error: expect.stringMatching(/changed after it was read/) },
    ]);
    // The edit stands, and the page waits for the next pass.
    expect((await getEntry(ctx, scope, one.entryId as string)).fields.title).toEqual({
      'en-US': 'Edited',
    });
    expect((await pageAt(run, '/blog/one')).unresolvedLinks).toBe(1);
  });

  it('is refused for a role that can’t write', async () => {
    const { run } = await seed(SITE);
    await expect(
      relinkMigratedPages(
        ctx,
        { spaceId: 'site', kind: 'user', scopes: [SCOPES.contentRead] },
        scope,
        { runId: run.id },
      ),
    ).rejects.toThrow(ForbiddenError);
  });
});

describe('redirecting migrated pages', () => {
  it('redirects each old path to its entry’s new one, once, skipping a path that didn’t move', async () => {
    const { run, template } = await seed({
      '/blog/one': SITE['/blog/one'],
      '/blog/two': SITE['/blog/two'],
      // Already where its entry will live.
      '/articles/three': SITE['/blog/three'],
    });
    await loadTemplatePages(ctx, deps, admin, scope, { runId: run.id, templateId: template.id });
    const report = await importMigrationRedirects(ctx, admin, scope, { runId: run.id });
    expect(report).toMatchObject({
      created: 2,
      updated: 0,
      unchanged: 0,
      skipped: { identity: 1, noUrlPattern: 0, unresolved: 0 },
    });
    const redirects = await listRedirects(ctx, scope);
    expect(
      redirects.items.map((r) => [r.source, r.destination, r.status, r.origin]).sort(),
    ).toEqual([
      ['/blog/one', '/articles/one', 301, 'import'],
      ['/blog/two', '/articles/two', 301, 'import'],
    ]);
    // Run again: nothing changes.
    expect(await importMigrationRedirects(ctx, admin, scope, { runId: run.id })).toMatchObject({
      created: 0,
      unchanged: 2,
    });
  });

  it('needs content:manage', async () => {
    const { run } = await seed(SITE);
    await expect(
      importMigrationRedirects(
        ctx,
        { spaceId: 'site', kind: 'user', scopes: [SCOPES.contentWrite, SCOPES.contentPublish] },
        scope,
        { runId: run.id },
      ),
    ).rejects.toThrow(ForbiddenError);
  });
});

describe('publishing a migration', () => {
  it('publishes the loaded entries and moves their pages, once', async () => {
    const { run, template } = await seed(SITE);
    await loadTemplatePages(ctx, deps, admin, scope, { runId: run.id, templateId: template.id });
    const result = await publishMigration(ctx, admin, scope, { runId: run.id });
    expect(result).toEqual({ published: 3, added: 0, failed: [] });
    const one = await entryOf(run, '/blog/one');
    expect(one.entry.publishedVersion).toBe(one.entry.currentVersion);
    expect((await pageAt(run, '/blog/one')).stage).toBe('published');
    // Nothing is left to publish.
    expect(await publishMigration(ctx, admin, scope, { runId: run.id })).toEqual({
      published: 0,
      added: 0,
      failed: [],
    });
  });

  it('adds the entries to a release instead, and moves the pages once it has shipped', async () => {
    const { run, template } = await seed(SITE);
    await loadTemplatePages(ctx, deps, admin, scope, { runId: run.id, templateId: template.id });
    const staged = await publishMigration(ctx, admin, scope, {
      runId: run.id,
      templateId: template.id,
      viaRelease: true,
    });
    expect(staged).toMatchObject({ published: 0, added: 3, failed: [] });
    const items = await store.releases.listItems(scope, staged.releaseId as string);
    expect(items).toHaveLength(3);
    expect((await pageAt(run, '/blog/one')).stage).toBe('loaded');
    expect((await entryOf(run, '/blog/one')).entry.publishedVersion).toBeNull();

    await publishRelease(ctx, scope, staged.releaseId as string);
    const shipped = await entryOf(run, '/blog/one');
    // The pass finds the entries live and moves the pages without publishing again.
    expect(await publishMigration(ctx, admin, scope, { runId: run.id })).toMatchObject({
      published: 3,
    });
    expect((await entryOf(run, '/blog/one')).entry.currentVersion).toBe(
      shipped.entry.currentVersion,
    );
    expect((await pageAt(run, '/blog/one')).stage).toBe('published');
  });

  it('reuses the run’s release when the entries are added again', async () => {
    const { run, template } = await seed(SITE);
    await loadTemplatePages(ctx, deps, admin, scope, { runId: run.id, templateId: template.id });
    const first = await publishMigration(ctx, admin, scope, { runId: run.id, viaRelease: true });
    const again = await publishMigration(ctx, admin, scope, { runId: run.id, viaRelease: true });
    expect(again.releaseId).toBe(first.releaseId);
    expect(await store.releases.list(scope)).toHaveLength(1);
    expect(await store.releases.listItems(scope, first.releaseId as string)).toHaveLength(3);
    expect((await store.migrations.getRun(scope, run.id))?.releaseId).toBe(first.releaseId);
    // Once it has shipped, the next add opens a new one.
    await publishRelease(ctx, scope, first.releaseId as string);
    const next = await publishMigration(ctx, admin, scope, { runId: run.id, viaRelease: true });
    expect(next.releaseId).not.toBe(first.releaseId);
    expect(await store.releases.list(scope)).toHaveLength(2);
  });

  it('adds to a release a batch at a time, every batch into the run’s one release', async () => {
    const { run, template } = await seed(SITE);
    await loadTemplatePages(ctx, deps, admin, scope, { runId: run.id, templateId: template.id });
    const batches: { added: number; releaseId?: string; next?: string }[] = [];
    let after: string | undefined;
    do {
      const batch = await publishMigration(ctx, admin, scope, {
        runId: run.id,
        viaRelease: true,
        batchSize: 2,
        ...(after ? { after } : {}),
      });
      batches.push(batch);
      after = batch.next;
    } while (after);
    expect(batches.map((b) => b.added)).toEqual([2, 1]);
    expect(new Set(batches.map((b) => b.releaseId)).size).toBe(1);
    expect(await store.releases.list(scope)).toHaveLength(1);
    expect(await store.releases.listItems(scope, batches[0]?.releaseId as string)).toHaveLength(3);
  });

  it('needs content:write to go through a release, as making one does', async () => {
    const { run, template } = await seed(SITE);
    await loadTemplatePages(ctx, deps, admin, scope, { runId: run.id, templateId: template.id });
    const publisher: Principal = { spaceId: 'site', kind: 'user', scopes: [SCOPES.contentPublish] };
    await expect(
      publishMigration(ctx, publisher, scope, { runId: run.id, viaRelease: true }),
    ).rejects.toThrow(ForbiddenError);
    expect(await store.releases.list(scope)).toHaveLength(0);
    // Publishing directly is what content:publish holds.
    expect(await publishMigration(ctx, publisher, scope, { runId: run.id })).toMatchObject({
      published: 3,
    });
  });

  it('needs content:publish, and publish on the type', async () => {
    const { run, template } = await seed(SITE);
    await loadTemplatePages(ctx, deps, admin, scope, { runId: run.id, templateId: template.id });
    const writer: Principal = { spaceId: 'site', kind: 'user', scopes: [SCOPES.contentWrite] };
    await expect(publishMigration(ctx, writer, scope, { runId: run.id })).rejects.toThrow(
      ForbiddenError,
    );
    const noGrant: Principal = {
      spaceId: 'site',
      kind: 'user',
      scopes: [SCOPES.contentWrite, SCOPES.contentPublish],
      contentGrants: [{ contentTypeApiId: 'article', actions: ['read', 'write'] }],
    };
    for (const viaRelease of [false, true]) {
      await expect(
        publishMigration(ctx, noGrant, scope, { runId: run.id, viaRelease }),
      ).rejects.toThrow(ForbiddenError);
    }
    expect((await entryOf(run, '/blog/one')).entry.publishedVersion).toBeNull();
    expect((await store.releases.list(scope)).length).toBe(0);
  });

  it('keeps a page whose entry is gone loaded, with the reason', async () => {
    const { run, template } = await seed({ '/blog/one': SITE['/blog/one'] });
    await loadTemplatePages(ctx, deps, admin, scope, { runId: run.id, templateId: template.id });
    const page = await pageAt(run, '/blog/one');
    await store.migrations.savePages(scope, run.id, [{ ...page, entryId: 'gone' }]);
    const result = await publishMigration(ctx, admin, scope, { runId: run.id });
    expect(result.failed).toEqual([
      { pageId: page.id, url: page.url, error: 'The page’s entry no longer exists' },
    ]);
    expect(await pageAt(run, '/blog/one')).toMatchObject({
      stage: 'loaded',
      error: 'The page’s entry no longer exists',
    });
  });
});
