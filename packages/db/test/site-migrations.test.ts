import { type AppContext, createEnvironment, createSpace } from '@contentworker/application';
import {
  ConflictError,
  checkMigrationSource,
  type MigrationPage,
  type MigrationRun,
  type MigrationTemplate,
} from '@contentworker/domain';
import { TransactionConflictError } from '@contentworker/ports';
import { FixedClock } from '@contentworker/test-kit';
import { describe, expect, it } from 'vitest';
import { createD1Store } from '../src/store';
import { testDb } from './env';

/**
 * Site migrations on D1 (0048_site_migrations): a run rewritten whole at its version's
 * compare-and-set, pages added past the 100-parameter cap with one page per URL, pages listed by
 * fetch state and stage, a clustering's templates and assignments replaced in one batch, scope
 * isolation, and the tables cleared with their environment. The file shares one database: each
 * test uses its own scope.
 */
const store = createD1Store(testDb);
const uid = () => crypto.randomUUID();
const AT = '2026-11-20T00:00:00.000Z';
const LATER = '2026-11-20T01:00:00.000Z';
const newScope = () => ({ spaceId: `mig-${uid()}`, environmentId: 'main' });

const run = (over: Partial<MigrationRun> = {}): MigrationRun => ({
  id: uid(),
  name: 'site.test',
  source: checkMigrationSource({
    kind: 'sitemap',
    url: 'https://site.test/',
    include: ['/blog/**'],
  }),
  status: 'created',
  threshold: 0.8,
  inventory: null,
  error: null,
  version: 1,
  createdAt: AT,
  createdBy: 'ed@example.com',
  updatedAt: AT,
  ...over,
});

const page = (runId: string, n: number, over: Partial<MigrationPage> = {}): MigrationPage => ({
  id: `p-${String(n).padStart(5, '0')}`,
  runId,
  url: `https://site.test/blog/${n}`,
  path: `/blog/${n}`,
  depth: 0,
  stage: 'discovered',
  templateId: null,
  title: null,
  lastModified: '2026-01-01',
  httpStatus: null,
  html: null,
  fingerprint: null,
  output: null,
  score: null,
  entryId: null,
  unresolvedLinks: 0,
  error: null,
  createdAt: AT,
  updatedAt: AT,
  ...over,
});

const template = (runId: string, over: Partial<MigrationTemplate> = {}): MigrationTemplate => ({
  id: uid(),
  runId,
  label: 'Template 1',
  status: 'pending',
  pageCount: 0,
  samplePageIds: [],
  fingerprint: ['0a0b0c0d'],
  contentTypeId: null,
  script: null,
  version: 1,
  createdAt: AT,
  updatedAt: AT,
  ...over,
});

describe('site migrations on D1', () => {
  it('writes a run whole and rewrites it only at its version', async () => {
    const scope = newScope();
    const r = run();
    await store.migrations.createRun(scope, r);
    expect(await store.migrations.getRun(scope, r.id)).toEqual(r);
    await expect(store.migrations.createRun(scope, r)).rejects.toThrow(ConflictError);

    const inventoried: MigrationRun = {
      ...r,
      status: 'inventoried',
      version: 2,
      updatedAt: LATER,
      inventory: {
        discovered: 3,
        added: 2,
        skipped: { robots: 1, filtered: 0, offOrigin: 0, overLimit: 0, invalid: 0 },
        warnings: ['a warning'],
      },
    };
    await store.migrations.saveRun(scope, inventoried, 1);
    expect(await store.migrations.getRun(scope, r.id)).toEqual(inventoried);
    // A stale writer loses, directly and inside a unit of work (at commit).
    await expect(store.migrations.saveRun(scope, { ...r, version: 2 }, 1)).rejects.toThrow(
      TransactionConflictError,
    );
    await expect(
      store.withTransaction(async (tx) => {
        await tx.migrations.saveRun(scope, { ...r, version: 2 }, 1);
      }),
    ).rejects.toThrow(TransactionConflictError);
    expect((await store.migrations.getRun(scope, r.id))?.status).toBe('inventoried');
  });

  it('lists runs newest first, and keeps each scope to itself', async () => {
    const scope = newScope();
    const other = { ...scope, environmentId: 'staging' };
    const older = run({ id: `0190-${uid()}` });
    const newer = run({ id: `0199-${uid()}` });
    await store.migrations.createRun(scope, older);
    await store.migrations.createRun(scope, newer);
    expect((await store.migrations.listRuns(scope, { limit: 10 })).map((x) => x.id)).toEqual([
      newer.id,
      older.id,
    ]);
    expect(await store.migrations.getRun(other, older.id)).toBeNull();
    expect(await store.migrations.listRuns(other, { limit: 10 })).toEqual([]);
    await store.migrations.addPages(scope, older.id, [page(older.id, 1)]);
    expect(await store.migrations.listPages(other, older.id, { limit: 10 })).toEqual([]);
    expect((await store.migrations.countPages(other, older.id)).total).toBe(0);
  });

  it('adds pages past the parameter cap, one per URL, and lists them by fetch state', async () => {
    const scope = newScope();
    const r = run();
    await store.migrations.createRun(scope, r);
    const all = Array.from({ length: 230 }, (_, i) => page(r.id, i));
    await store.migrations.addPages(scope, r.id, all);
    // Discovered again under new ids (a re-run inventory): nothing is added or changed.
    await store.migrations.addPages(
      scope,
      r.id,
      all.slice(0, 50).map((p) => ({ ...p, id: `again-${p.id}`, title: 'changed' })),
    );
    const counts = await store.migrations.countPages(scope, r.id);
    expect(counts).toEqual({ total: 230, fetched: 0, failed: 0, byStage: { discovered: 230 } });
    expect(await store.migrations.getPage(scope, r.id, 'p-00007')).toEqual(all[7]);

    const html = {
      key: `migrations/${scope.spaceId}/main/${r.id}/pages/p-00001.html`,
      sha256: 'ab',
      bytes: 10,
    };
    await store.migrations.savePages(scope, r.id, [
      {
        ...(all[1] as MigrationPage),
        html,
        httpStatus: 200,
        fingerprint: ['01', '02'],
        title: 'One',
      },
      { ...(all[2] as MigrationPage), httpStatus: 404, error: 'answered 404' },
      page(r.id, 99_999), // unknown: skipped
    ]);
    expect(await store.migrations.getPage(scope, r.id, 'p-99999')).toBeNull();
    expect((await store.migrations.getPage(scope, r.id, 'p-00001'))?.html).toEqual(html);

    const pending = await store.migrations.listPages(scope, r.id, { fetch: 'pending', limit: 500 });
    expect(pending.length).toBe(228);
    expect(pending.map((p) => p.id)).not.toContain('p-00001');
    expect(pending.map((p) => p.id)).not.toContain('p-00002');
    expect(
      (await store.migrations.listPages(scope, r.id, { fetch: 'fetched', limit: 10 })).map(
        (p) => p.id,
      ),
    ).toEqual(['p-00001']);
    // Paged by id.
    const first = await store.migrations.listPages(scope, r.id, { limit: 100 });
    const second = await store.migrations.listPages(scope, r.id, {
      limit: 200,
      after: first.at(-1)?.id,
    });
    expect(first.length + second.length).toBe(230);
    expect(await store.migrations.countPages(scope, r.id)).toMatchObject({ fetched: 1, failed: 1 });
  });

  it('replaces templates and their pages in one batch, past the cap', async () => {
    const scope = newScope();
    const r = run();
    await store.migrations.createRun(scope, r);
    const all = Array.from({ length: 640 }, (_, i) => page(r.id, i));
    for (let at = 0; at < all.length; at += 200) {
      await store.migrations.addPages(scope, r.id, all.slice(at, at + 200));
    }
    const ids = all.map((p) => p.id);
    const big = template(r.id, { pageCount: 600, samplePageIds: ids.slice(0, 3) });
    const small = template(r.id, { label: 'Template 2', pageCount: 30 });
    await store.migrations.replaceTemplates(
      scope,
      r.id,
      [
        { template: big, pageIds: ids.slice(0, 600) },
        { template: small, pageIds: ids.slice(600, 630) },
      ],
      LATER,
    );
    expect(await store.migrations.listTemplates(scope, r.id)).toEqual([big, small]);
    expect(await store.migrations.countPages(scope, r.id)).toMatchObject({
      byStage: { clustered: 630, discovered: 10 },
    });
    const p599 = await store.migrations.getPage(scope, r.id, ids[599] as string);
    expect(p599).toMatchObject({ templateId: big.id, stage: 'clustered', updatedAt: LATER });

    // Clustered again, with the run's compare-and-set: the old templates go, and pages in no
    // template go back to discovered.
    const only = template(r.id, { pageCount: 5 });
    await store.withTransaction(async (tx) => {
      await tx.migrations.replaceTemplates(
        scope,
        r.id,
        [{ template: only, pageIds: ids.slice(0, 5) }],
        LATER,
      );
      await tx.migrations.saveRun(scope, { ...r, status: 'clustered', version: 2 }, 1);
    });
    expect((await store.migrations.listTemplates(scope, r.id)).map((t) => t.id)).toEqual([only.id]);
    expect(await store.migrations.getTemplate(scope, r.id, big.id)).toBeNull();
    expect((await store.migrations.countPages(scope, r.id)).byStage).toEqual({
      clustered: 5,
      discovered: 635,
    });

    // A lost race writes none of it.
    await expect(
      store.withTransaction(async (tx) => {
        await tx.migrations.replaceTemplates(scope, r.id, [], LATER);
        await tx.migrations.saveRun(scope, { ...r, version: 3 }, 1);
      }),
    ).rejects.toThrow(TransactionConflictError);
    expect((await store.migrations.listTemplates(scope, r.id)).map((t) => t.id)).toEqual([only.id]);
  });

  it('clears its tables with their environment', async () => {
    const clock = new FixedClock(new Date(AT));
    const ctx: AppContext = { store, clock, ids: { newId: uid } };
    const spaceId = `mig-${uid()}`;
    await createSpace(ctx, { spaceId, name: 'M', defaultLocale: 'en-US', locales: ['en-US'] });
    const env = `gone-${uid().slice(0, 8)}`;
    await createEnvironment(ctx, spaceId, env);
    const scope = { spaceId, environmentId: env };
    const r = run();
    await store.migrations.createRun(scope, r);
    await store.migrations.addPages(scope, r.id, [page(r.id, 1)]);
    await store.migrations.addAssets(
      scope,
      r.id,
      [{ url: 'https://site.test/a.png', assetId: 'a1' }],
      AT,
    );
    await store.migrations.replaceTemplates(
      scope,
      r.id,
      [{ template: template(r.id), pageIds: ['p-00001'] }],
      AT,
    );
    await store.spaces.deleteEnvironment(spaceId, env, [], {
      id: uid(),
      spaceId,
      environmentId: env,
      at: clock.now().toISOString(),
      actor: 'test',
      action: 'environment.deleted',
      status: 200,
    });
    while ((await store.spaces.purgeEnvironmentStep(spaceId, env, 500, clock.now())) > 0) {}
    for (const table of [
      'migration_runs',
      'migration_templates',
      'migration_pages',
      'migration_assets',
    ]) {
      const n = await testDb
        .prepare(`SELECT count(*) AS n FROM ${table} WHERE space_id = ? AND environment_id = ?`)
        .bind(spaceId, env)
        .first<{ n: number }>();
      expect(n?.n, table).toBe(0);
    }
  });

  it('knows which URLs a run holds, past the cap, and keeps depth', async () => {
    const scope = newScope();
    const r = run();
    await store.migrations.createRun(scope, r);
    await store.migrations.addPages(
      scope,
      r.id,
      Array.from({ length: 150 }, (_, i) => page(r.id, i, { depth: i % 3 })),
    );
    const asked = Array.from({ length: 700 }, (_, i) => `https://site.test/blog/${i}`);
    expect((await store.migrations.knownUrls(scope, r.id, asked)).sort()).toEqual(
      asked.slice(0, 150).sort(),
    );
    expect(
      await store.migrations.knownUrls({ ...scope, environmentId: 'other' }, r.id, asked),
    ).toEqual([]);
    expect((await store.migrations.getPage(scope, r.id, 'p-00005'))?.depth).toBe(2);
  });

  it('writes more templates in one replacement than one statement binds', async () => {
    const scope = newScope();
    const r = run();
    await store.migrations.createRun(scope, r);
    const all = Array.from({ length: 20 }, (_, i) => page(r.id, i));
    await store.migrations.addPages(scope, r.id, all);
    // 14 columns a template: 7 a statement, so 20 take three.
    const many = all.map((p, i) =>
      template(r.id, {
        id: `t-${String(i).padStart(2, '0')}`,
        pageCount: 1,
        samplePageIds: [p.id],
      }),
    );
    await store.migrations.replaceTemplates(
      scope,
      r.id,
      many.map((t, i) => ({ template: t, pageIds: [all[i]?.id as string] })),
      LATER,
    );
    expect((await store.migrations.listTemplates(scope, r.id)).map((t) => t.id)).toEqual(
      many.map((t) => t.id),
    );
    expect((await store.migrations.countPages(scope, r.id)).byStage).toEqual({ clustered: 20 });
  });

  it('refuses to replace templates once one is past pending, directly and in a unit', async () => {
    const scope = newScope();
    const r = run();
    await store.migrations.createRun(scope, r);
    await store.migrations.addPages(scope, r.id, [page(r.id, 1)]);
    const authored = template(r.id, { status: 'authoring', pageCount: 1 });
    await store.migrations.replaceTemplates(
      scope,
      r.id,
      [{ template: authored, pageIds: ['p-00001'] }],
      AT,
    );
    await expect(store.migrations.replaceTemplates(scope, r.id, [], LATER)).rejects.toThrow(
      TransactionConflictError,
    );
    await expect(
      store.withTransaction(async (tx) => {
        await tx.migrations.replaceTemplates(scope, r.id, [], LATER);
        await tx.migrations.saveRun(scope, { ...r, version: 2 }, 1);
      }),
    ).rejects.toThrow(TransactionConflictError);
    expect((await store.migrations.listTemplates(scope, r.id)).map((t) => t.id)).toEqual([
      authored.id,
    ]);
    expect((await store.migrations.getRun(scope, r.id))?.version).toBe(1);
    expect((await store.migrations.getPage(scope, r.id, 'p-00001'))?.templateId).toBe(authored.id);
    // The guard leaves nothing behind.
    const left = await testDb.prepare('SELECT count(*) AS n FROM _guard').first<{ n: number }>();
    expect(left?.n).toBe(0);
  });

  it('moves pages only while each is as it was read, directly and in a unit', async () => {
    const scope = newScope();
    const r = run();
    await store.migrations.createRun(scope, r);
    const all = Array.from({ length: 120 }, (_, i) => page(r.id, i, { stage: 'validated' }));
    await store.migrations.addPages(scope, r.id, all);
    const loaded = (p: MigrationPage, n: number): MigrationPage => ({
      ...p,
      stage: 'loaded',
      entryId: `e-${n}`,
      unresolvedLinks: n % 3,
      updatedAt: LATER,
    });
    // More pages than one statement binds, each with its own compare-and-set.
    await store.migrations.movePages(
      scope,
      r.id,
      all.map((p, i) => ({ page: loaded(p, i), expected: AT })),
    );
    expect(await store.migrations.getPage(scope, r.id, 'p-00004')).toEqual(
      loaded(all[4] as MigrationPage, 4),
    );
    expect((await store.migrations.countPages(scope, r.id)).byStage).toEqual({ loaded: 120 });

    // One page written since it was read: none of the moves land, directly or in a unit.
    const back = (p: MigrationPage): MigrationPage => ({ ...p, stage: 'needs-fix', updatedAt: AT });
    const stale = [
      { page: back(all[0] as MigrationPage), expected: LATER },
      { page: back(all[1] as MigrationPage), expected: AT },
    ];
    await expect(store.migrations.movePages(scope, r.id, stale)).rejects.toThrow(
      TransactionConflictError,
    );
    await expect(
      store.withTransaction(async (tx) => {
        await tx.migrations.movePages(scope, r.id, stale);
      }),
    ).rejects.toThrow(TransactionConflictError);
    expect((await store.migrations.getPage(scope, r.id, 'p-00000'))?.stage).toBe('loaded');
    // Another scope's page of the same id is not this one.
    await expect(
      store.migrations.movePages({ ...scope, environmentId: 'other' }, r.id, [
        { page: back(all[0] as MigrationPage), expected: LATER },
      ]),
    ).rejects.toThrow(TransactionConflictError);
    const left = await testDb.prepare('SELECT count(*) AS n FROM _guard').first<{ n: number }>();
    expect(left?.n).toBe(0);
  });

  it('lists pages by unresolved links and by whether their last step failed', async () => {
    const scope = newScope();
    const r = run();
    await store.migrations.createRun(scope, r);
    await store.migrations.addPages(scope, r.id, [
      page(r.id, 1, { stage: 'loaded', entryId: 'e1', unresolvedLinks: 2 }),
      page(r.id, 2, { stage: 'loaded', entryId: 'e2' }),
      page(r.id, 3, { stage: 'needs-fix', error: 'refused' }),
      page(r.id, 4, { stage: 'needs-fix' }),
    ]);
    const ids = async (q: Parameters<typeof store.migrations.listPages>[2]) =>
      (await store.migrations.listPages(scope, r.id, q)).map((p) => p.id);
    expect(await ids({ limit: 10, unresolvedLinks: true })).toEqual(['p-00001']);
    expect(await ids({ limit: 10, stage: 'needs-fix', failed: false })).toEqual(['p-00004']);
    expect(await ids({ limit: 10, failed: true })).toEqual(['p-00003']);
    expect((await store.migrations.getPage(scope, r.id, 'p-00001'))?.unresolvedLinks).toBe(2);
  });

  it('finds the entries and assets a run holds by URL, past the cap', async () => {
    const scope = newScope();
    const r = run();
    await store.migrations.createRun(scope, r);
    await store.migrations.addPages(
      scope,
      r.id,
      Array.from({ length: 150 }, (_, i) =>
        page(r.id, i, i % 2 === 0 ? { stage: 'loaded', entryId: `e-${i}` } : {}),
      ),
    );
    const asked = Array.from({ length: 700 }, (_, i) => `https://site.test/blog/${i}`);
    const entries = await store.migrations.entriesByUrl(scope, r.id, asked);
    expect(entries).toHaveLength(75);
    expect(entries).toContainEqual({ url: 'https://site.test/blog/4', entryId: 'e-4' });
    expect(
      await store.migrations.entriesByUrl({ ...scope, environmentId: 'x' }, r.id, asked),
    ).toEqual([]);

    const files = Array.from({ length: 130 }, (_, i) => ({
      url: `https://cdn.test/${i}.png`,
      assetId: `a-${i}`,
    }));
    await store.migrations.addAssets(scope, r.id, files, AT);
    // Recorded again with other assets (a batch run twice): the first asset stays.
    await store.migrations.addAssets(
      scope,
      r.id,
      files.slice(0, 10).map((f) => ({ ...f, assetId: 'other' })),
      LATER,
    );
    const urls = Array.from({ length: 600 }, (_, i) => `https://cdn.test/${i}.png`);
    const found = await store.migrations.assetsByUrl(scope, r.id, urls);
    expect(found).toHaveLength(130);
    expect(found).toContainEqual({ url: 'https://cdn.test/3.png', assetId: 'a-3' });
    expect(await store.migrations.assetsByUrl(scope, 'another-run', urls)).toEqual([]);
  });
});
