import {
  type AppContext,
  createContentType,
  createEnvironment,
  createSpace,
  getBlockCatalog,
  getContentType,
  listBlockCatalogVersions,
  pushBlockCatalog,
  SYSTEM_CALLER,
} from '@contentworker/application';
import type { BlockCatalog, FieldDefinition } from '@contentworker/domain';
import { TransactionConflictError } from '@contentworker/ports';
import { FixedClock } from '@contentworker/test-kit';
import { describe, expect, it } from 'vitest';
import { createD1Store } from '../src/store';
import { testDb } from './env';

/**
 * Block catalogs on D1 (0036_block_catalogs): one JSON document per pushed version, kept as
 * history; the version's primary key as the compare-and-set a push rides with, failing a lost
 * race at commit; a push's content type revisions and its catalog row in one batch; the history
 * read without the documents; and the table cleared with its environment. Each test makes its own
 * space: the file shares one database.
 */
const store = createD1Store(testDb);
const uid = () => crypto.randomUUID();
const AT = '2026-11-07T00:00:00.000Z';

const field = (over: Partial<FieldDefinition> & Pick<FieldDefinition, 'apiId' | 'type'>) =>
  ({
    name: over.apiId,
    localized: false,
    required: false,
    position: 0,
    ...over,
  }) as FieldDefinition;

const HERO = {
  id: 'hero',
  name: 'Hero',
  fields: [{ apiId: 'heading', name: 'Heading', type: 'Symbol' }],
};

async function harness() {
  const clock = new FixedClock(new Date(AT));
  const ctx: AppContext = { store, clock, ids: { newId: uid } };
  const spaceId = `blocks-${uid()}`;
  await createSpace(ctx, { spaceId, name: 'Blocks', defaultLocale: 'en-US', locales: ['en-US'] });
  const scope = { spaceId, environmentId: 'main' };
  await createContentType(ctx, SYSTEM_CALLER, scope, {
    apiId: 'page',
    name: 'Page',
    displayField: 'title',
    fields: [
      field({ apiId: 'title', type: 'Symbol' }),
      field({
        apiId: 'body',
        type: 'Array',
        position: 1,
        items: {
          type: 'Component',
          variants: [
            { apiId: 'hero', name: 'Hero', fields: [field({ apiId: 'x', type: 'Symbol' })] },
          ],
        },
      }),
    ],
  });
  return { ctx, clock, spaceId, scope };
}

const catalog = (version: number, over: Partial<BlockCatalog> = {}): BlockCatalog => ({
  version,
  hash: `h${version}`,
  blocks: [{ id: 'hero', name: 'Hero', fields: [] }],
  targets: [{ contentTypeApiId: 'page', field: 'body' }],
  breakpoints: [],
  changes: { added: ['hero'], changed: [], removed: [], renamed: [] },
  pushedAt: AT,
  pushedBy: 'dev@example.com',
  ...over,
});

describe('block catalogs on D1', () => {
  it('stores versions as history and reads the latest, one, and the list without documents', async () => {
    const { scope } = await harness();
    expect(await store.blockCatalogs.latest(scope)).toBeNull();
    for (const v of [1, 2, 3]) await store.blockCatalogs.save(scope, catalog(v));
    expect((await store.blockCatalogs.latest(scope))?.version).toBe(3);
    expect(await store.blockCatalogs.get(scope, 2)).toEqual(catalog(2));
    const listed = await store.blockCatalogs.list(scope, { limit: 2 });
    expect(listed.map((c) => c.version)).toEqual([3, 2]);
    const { blocks: _blocks, ...summary } = catalog(3);
    expect(listed[0]).toEqual({ ...summary, blockCount: 1 });
    expect(listed[0]).not.toHaveProperty('blocks');
    expect(
      (await store.blockCatalogs.list(scope, { limit: 10, before: 2 })).map((c) => c.version),
    ).toEqual([1]);
  });

  it('stores the breakpoints a version declares, and reads a version without them as none', async () => {
    const { scope } = await harness();
    const breakpoints = [
      { id: 'md', name: 'Tablet', minWidth: 768 },
      { id: 'lg', name: 'Desktop', minWidth: 1280 },
    ];
    await store.blockCatalogs.save(scope, catalog(1));
    await store.blockCatalogs.save(
      scope,
      catalog(2, { breakpoints, changes: { ...catalog(2).changes, breakpoints: true } }),
    );
    expect((await store.blockCatalogs.get(scope, 1))?.breakpoints).toEqual([]);
    expect((await store.blockCatalogs.latest(scope))?.breakpoints).toEqual(breakpoints);
    expect((await store.blockCatalogs.latest(scope))?.changes.breakpoints).toBe(true);
    const [listed] = await store.blockCatalogs.list(scope, { limit: 1 });
    expect(listed?.breakpoints).toEqual(breakpoints);
  });

  it('keeps one environment’s versions from another’s', async () => {
    const { ctx, spaceId, scope } = await harness();
    await createEnvironment(ctx, spaceId, 'other');
    await store.blockCatalogs.save(scope, catalog(1));
    expect(await store.blockCatalogs.latest({ spaceId, environmentId: 'other' })).toBeNull();
    // The same version number is free in another environment.
    await store.blockCatalogs.save({ spaceId, environmentId: 'other' }, catalog(1));
  });

  it('refuses a version already written: directly, and at commit inside a unit', async () => {
    const { scope } = await harness();
    await store.blockCatalogs.save(scope, catalog(1));
    await expect(store.blockCatalogs.save(scope, catalog(1, { hash: 'other' }))).rejects.toThrow(
      TransactionConflictError,
    );
    await expect(
      store.withTransaction(async (tx) => {
        await tx.contentTypes.save(scope, {
          ...(await getContentType(
            { store, clock: new FixedClock(), ids: { newId: uid } },
            scope,
            'page',
          )),
          name: 'Renamed in a lost unit',
        });
        await tx.blockCatalogs.save(scope, catalog(1, { hash: 'other' }));
      }),
    ).rejects.toThrow(TransactionConflictError);
    // Nothing in the unit landed.
    expect((await store.contentTypes.get(scope, 'page'))?.name).toBe('Page');
    expect((await store.blockCatalogs.get(scope, 1))?.hash).toBe('h1');
  });

  it('pushes through the use-case: the type revision and the version in one batch', async () => {
    const { ctx, scope } = await harness();
    const done = await pushBlockCatalog(ctx, SYSTEM_CALLER, scope, {
      blocks: [
        HERO,
        { id: 'quote', name: 'Quote', fields: [{ apiId: 'text', name: 'Text', type: 'Text' }] },
      ],
      targets: [{ contentTypeApiId: 'page', field: 'body' }],
      allowDestructive: true,
    });
    expect(done).toMatchObject({ applied: true, version: 1 });
    const page = await getContentType(ctx, scope, 'page');
    expect(page.status).toBe('published');
    expect(page.fields[1]?.items?.variants?.map((v) => v.apiId)).toEqual(['hero', 'quote']);
    expect((await getBlockCatalog(ctx, scope)).pushedBy).toBeNull();
    expect(await listBlockCatalogVersions(ctx, scope)).toHaveLength(1);
  });

  it('holds a catalog of the largest size a push takes', async () => {
    const { scope } = await harness();
    const blocks = Array.from({ length: 200 }, (_, i) => ({
      id: `block${i}`,
      name: `Block ${i}`,
      description: 'd'.repeat(900),
      fields: Array.from({ length: 5 }, (_, j) =>
        field({ apiId: `f${j}`, type: 'Symbol', position: j }),
      ),
    }));
    await store.blockCatalogs.save(scope, catalog(1, { blocks }));
    expect((await store.blockCatalogs.latest(scope))?.blocks).toHaveLength(200);
  });

  it('clears the table with its environment', async () => {
    const { ctx, clock, spaceId } = await harness();
    const env = `gone-${uid().slice(0, 8)}`;
    await createEnvironment(ctx, spaceId, env);
    await store.blockCatalogs.save({ spaceId, environmentId: env }, catalog(1));
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
    const n = await testDb
      .prepare('SELECT count(*) AS n FROM block_catalogs WHERE space_id = ? AND environment_id = ?')
      .bind(spaceId, env)
      .first<{ n: number }>();
    expect(n?.n).toBe(0);
  });
});
