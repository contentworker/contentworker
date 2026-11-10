import type { FieldDefinition } from '@contentworker/domain';
import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@contentworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  cloneEnvironment,
  createAsset,
  createChangeLog,
  createContentType,
  createEntry,
  createEnvironment,
  type EnvironmentSnapshot,
  exportSnapshot,
  getBlockCatalog,
  getBlockConfig,
  importSnapshot,
  listBlockCatalogVersions,
  publishContentType,
  pushBlockCatalog,
  SYSTEM_CALLER,
  setBlockConfig,
  updateContentType,
  withChanges,
} from '../src/index';

/**
 * The block catalog and the block config travel with an environment: an export carries both, an
 * import makes them the target's (the catalog first, the config checked against it), and a clone
 * copies them. What fails the checks is left behind and named, never a failed import.
 */

const source = { spaceId: 's1', environmentId: 'main' };
const target = { spaceId: 's1', environmentId: 'copy' };

const field = (over: Partial<FieldDefinition> & Pick<FieldDefinition, 'apiId' | 'type'>) =>
  ({
    name: over.apiId,
    localized: false,
    required: false,
    position: 0,
    ...over,
  }) as FieldDefinition;

const BLOCKS = [
  { id: 'hero', name: 'Hero', fields: [{ apiId: 'heading', name: 'Heading', type: 'Symbol' }] },
  {
    id: 'grid',
    name: 'Grid',
    fields: [],
    slots: [{ apiId: 'items', name: 'Items', allowedChildren: ['card', 'quote'], max: 6 }],
  },
  {
    id: 'card',
    name: 'Card',
    fields: [{ apiId: 'title', name: 'Title', type: 'Symbol' }],
    allowedParents: ['grid'],
  },
  {
    id: 'quote',
    name: 'Quote',
    fields: [{ apiId: 'text', name: 'Text', type: 'Symbol' }],
    allowedParents: ['grid'],
  },
];
const TARGETS = [{ contentTypeApiId: 'page', field: 'body' }];

/** The top of a page takes only grids, a grid only cards, three at most, and its order is fixed. */
const NARROWING = {
  targets: [{ contentTypeApiId: 'page', field: 'body', blocks: ['grid'] }],
  blocks: [
    { block: 'grid', slots: { items: { allowedChildren: ['card'], max: 3, locked: true } } },
  ],
};

let ctx: AppContext;
let store: InMemoryContentStore;

beforeEach(async () => {
  store = new InMemoryContentStore();
  store.seedSpace({ spaceId: 's1', defaultLocale: 'en-US', locales: ['en-US'] });
  ctx = {
    store,
    clock: new FixedClock(new Date('2026-11-09T09:00:00.000Z')),
    ids: new SequenceIdGenerator('b'),
  };
  await createEnvironment(ctx, 's1', 'copy');
  await createContentType(ctx, SYSTEM_CALLER, source, {
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
            { apiId: 'hero', name: 'Hero', fields: [field({ apiId: 'heading', type: 'Symbol' })] },
          ],
        },
      }),
    ],
  });
  await publishContentType(ctx, source, 'page');
});

const push = (blocks: unknown = BLOCKS, scope = source, expectedVersion?: number) =>
  pushBlockCatalog(ctx, SYSTEM_CALLER, scope, {
    blocks,
    targets: TARGETS,
    allowDestructive: true,
    ...(expectedVersion !== undefined ? { expectedVersion } : {}),
  });
const configure = (input: Partial<typeof NARROWING> = {}, scope = source, expectedVersion = 0) =>
  setBlockConfig(ctx, SYSTEM_CALLER, scope, { expectedVersion, ...NARROWING, ...input });

describe('exporting the blocks', () => {
  it('carries the catalog in force (manifests, targets, version, hash) and the config', async () => {
    await push();
    const second = await push(BLOCKS.map((b) => (b.id === 'hero' ? { ...b, name: 'Banner' } : b)));
    await configure();

    const snapshot = await exportSnapshot(ctx, source);
    expect(snapshot.blockCatalog).toEqual({
      version: 2,
      hash: second.hash,
      blocks: (await getBlockCatalog(ctx, source)).blocks,
      targets: TARGETS,
    });
    expect(snapshot.blockConfig).toEqual({ version: 1, ...NARROWING });
    // Portable JSON: what an operator downloads is what an import reads.
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
  });

  it('leaves both sections out of an environment with neither', async () => {
    const snapshot = await exportSnapshot(ctx, source);
    expect(snapshot).not.toHaveProperty('blockCatalog');
    expect(snapshot).not.toHaveProperty('blockConfig');
  });
});

describe('importing the blocks', () => {
  beforeEach(async () => {
    await push();
    await configure();
  });

  it('makes the catalog and then the config the target’s, each at version 1', async () => {
    const snapshot = await exportSnapshot(ctx, source);
    const report = await importSnapshot(ctx, target, snapshot);
    expect(report).toMatchObject({ blockCatalog: true, blockConfig: true, skipped: [] });

    const catalog = await getBlockCatalog(ctx, target);
    expect(catalog).toMatchObject({
      version: 1,
      hash: snapshot.blockCatalog?.hash,
      targets: TARGETS,
      changes: { added: BLOCKS.map((b) => b.id), changed: [], removed: [], renamed: [] },
      pushedAt: '2026-11-09T09:00:00.000Z',
      pushedBy: null,
    });
    expect(catalog.blocks).toEqual(snapshot.blockCatalog?.blocks);
    expect(await getBlockConfig(ctx, target)).toEqual({
      version: 1,
      ...NARROWING,
      updatedAt: '2026-11-09T09:00:00.000Z',
      updatedBy: null,
    });
    // The variants already line up with the imported types: pushing the same catalog there is a
    // no-op, as it is at the source.
    const again = await push(BLOCKS, target, 1);
    expect(again).toMatchObject({ unchanged: true, contentTypes: [] });
  });

  it('holds entry saves in the target to the imported config', async () => {
    await importSnapshot(ctx, target, await exportSnapshot(ctx, source));
    // A hero at the top of a page: the code allows it, the config (grids only) doesn't.
    await expect(
      createEntry(ctx, target, {
        contentTypeApiId: 'page',
        fields: {
          title: { 'en-US': 'Home' },
          body: { 'en-US': [{ _type: 'hero', _key: 'h1', heading: 'Hi' }] },
        },
      }),
    ).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: 'block_not_allowed_here' })],
    });
  });

  it('says in a dry run what it will carry, writing nothing', async () => {
    const report = await importSnapshot(ctx, target, await exportSnapshot(ctx, source), {
      dryRun: true,
    });
    expect(report).toMatchObject({ dryRun: true, blockCatalog: true, blockConfig: true });
    expect(await store.blockCatalogs.latest(target)).toBeNull();
    expect(await store.blockConfigs.get(target)).toBeNull();
  });

  it('still imports a snapshot written before the blocks travelled, leaving them out', async () => {
    const { blockCatalog: _c, blockConfig: _k, ...older } = await exportSnapshot(ctx, source);
    const report = await importSnapshot(ctx, target, older as EnvironmentSnapshot);
    expect(report).toMatchObject({ contentTypes: 1, blockCatalog: false, blockConfig: false });
    expect(report.skipped).toEqual([]);
    expect(await store.blockCatalogs.latest(target)).toBeNull();
    expect((await getBlockConfig(ctx, target)).version).toBe(0);
    // The types still carry the variants the source's push gave them.
    const page = await store.contentTypes.get(target, 'page');
    const body = page?.fields.find((f) => f.apiId === 'body');
    expect(body?.items?.variants?.map((v) => v.apiId)).toEqual(['hero', 'grid']);
  });

  it('leaves behind, and names, a config that widens the snapshot’s catalog', async () => {
    const snapshot = await exportSnapshot(ctx, source);
    // Six cards is the code's own bound: a config may only tighten it.
    const widened: EnvironmentSnapshot = {
      ...snapshot,
      blockConfig: {
        version: 1,
        targets: [],
        blocks: [{ block: 'grid', slots: { items: { max: 12 } } }],
      },
    };
    const dry = await importSnapshot(ctx, target, widened, { dryRun: true });
    expect(dry).toMatchObject({ blockCatalog: true, blockConfig: false });
    expect(dry.skipped.join('\n')).toMatch(/^block config: left behind.*blocks\[grid\]/m);

    const report = await importSnapshot(ctx, target, widened);
    expect(report.blockConfig).toBe(false);
    expect(report.skipped).toEqual(dry.skipped);
    // The rest of the import went ahead: the catalog is there, the config never set.
    expect((await getBlockCatalog(ctx, target)).version).toBe(1);
    expect(await store.blockConfigs.get(target)).toBeNull();
  });

  it('leaves behind a catalog whose targets the snapshot’s model lacks, and its config with it', async () => {
    const snapshot = await exportSnapshot(ctx, source);
    const report = await importSnapshot(ctx, target, {
      ...snapshot,
      blockCatalog: {
        ...(snapshot.blockCatalog as NonNullable<EnvironmentSnapshot['blockCatalog']>),
        targets: [{ contentTypeApiId: 'post', field: 'body' }],
      },
    });
    expect(report).toMatchObject({ contentTypes: 1, blockCatalog: false, blockConfig: false });
    expect(report.skipped.join('\n')).toMatch(/block catalog: left behind.*No content type "post"/);
    expect(report.skipped.join('\n')).toMatch(/block config: left behind/);
    expect(await store.blockCatalogs.latest(target)).toBeNull();
    expect(await store.blockConfigs.get(target)).toBeNull();
  });

  it('works the hash out again rather than trusting the file’s', async () => {
    const snapshot = await exportSnapshot(ctx, source);
    const catalog = snapshot.blockCatalog as NonNullable<EnvironmentSnapshot['blockCatalog']>;
    await importSnapshot(ctx, target, {
      ...snapshot,
      blockCatalog: { ...catalog, hash: 'forged' },
    });
    expect((await getBlockCatalog(ctx, target)).hash).toBe(catalog.hash);
  });

  it('replaces what a target without content types already holds, as the next version', async () => {
    // What a target with no content types can still hold: the catalog and config left behind when
    // the types they shaped were deleted.
    await store.blockCatalogs.save(target, await getBlockCatalog(ctx, source));
    await configure(
      { targets: [], blocks: [{ block: 'grid', slots: { items: { max: 2 } } }] },
      target,
    );
    // A different catalog from the target's, so the import has something to replace.
    await push(
      BLOCKS.map((b) => (b.id === 'hero' ? { ...b, name: 'Banner' } : b)),
      source,
      1,
    );

    const report = await importSnapshot(ctx, target, await exportSnapshot(ctx, source));
    expect(report).toMatchObject({ blockCatalog: true, blockConfig: true });
    expect(await getBlockCatalog(ctx, target)).toMatchObject({ version: 2, targets: TARGETS });
    expect(await getBlockConfig(ctx, target)).toMatchObject({ version: 2, ...NARROWING });
    expect((await listBlockCatalogVersions(ctx, target)).map((v) => v.version)).toEqual([2, 1]);
  });

  it('leaves the target’s own when a push there commits first, and says so', async () => {
    const snapshot = await exportSnapshot(ctx, source);
    // The write reads no catalog in the target, but a push lands version 1 before it commits.
    const latest = store.blockCatalogs.latest.bind(store.blockCatalogs);
    let reads = 0;
    store.blockCatalogs.latest = async (scope) => {
      if (scope.environmentId !== target.environmentId || ++reads < 2) return latest(scope);
      store.blockCatalogs.latest = latest;
      await store.blockCatalogs.save(target, await getBlockCatalog(ctx, source));
      return null;
    };
    const report = await importSnapshot(ctx, target, snapshot);
    expect(report.skipped.join('\n')).toMatch(/changed there during the import/);
    // The report says what the write did, not what the checks expected.
    expect(report).toMatchObject({ blockCatalog: false, blockConfig: false });
    expect(await getBlockCatalog(ctx, target)).toMatchObject({ version: 1, pushedBy: null });
    expect(await store.blockConfigs.get(target)).toBeNull();
    // The content went ahead regardless.
    expect(await store.contentTypes.get(target, 'page')).not.toBeNull();
  });

  it('leaves both behind when the target’s catalog retired an id the snapshot’s uses', async () => {
    // The target renamed hero to banner: "hero" may never come back as another block's id.
    const banner = { ...BLOCKS[0], id: 'banner', name: 'Banner', aliases: ['hero'] };
    await store.blockCatalogs.save(target, {
      version: 1,
      hash: 'target',
      blocks: [banner] as never,
      targets: [],
      changes: { added: ['banner'], changed: [], removed: [], renamed: [] },
      pushedAt: '2026-11-01T00:00:00.000Z',
      pushedBy: null,
    });
    const snapshot = await exportSnapshot(ctx, source);

    const dry = await importSnapshot(ctx, target, snapshot, { dryRun: true });
    expect(dry).toMatchObject({ blockCatalog: false, blockConfig: false });
    expect(dry.skipped).toEqual([
      expect.stringMatching(
        /^block catalog: left behind, the target's catalog retired an id.*hero/,
      ),
      'block config: left behind with its block catalog',
    ]);

    const report = await importSnapshot(ctx, target, snapshot);
    expect(report).toMatchObject({ blockCatalog: false, blockConfig: false });
    expect(report.skipped).toEqual(dry.skipped);
    expect(await getBlockCatalog(ctx, target)).toMatchObject({ version: 1, hash: 'target' });
    expect(await store.blockConfigs.get(target)).toBeNull();
  });

  it('leaves behind a catalog whose thumbnails name assets the snapshot doesn’t carry', async () => {
    const files = {
      getUploadUrl: async () => 'https://upload',
      getDownloadUrl: async () => 'https://download',
      delete: async () => {},
    } as never;
    const { asset } = await createAsset(ctx, files, source, {
      fileName: 'hero.png',
      contentType: 'image/png',
    });
    await push(
      BLOCKS.map((b) => (b.id === 'hero' ? { ...b, thumbnail: { assetId: asset.id } } : b)),
    );
    const snapshot = await exportSnapshot(ctx, source);

    // An export carries the asset with the catalog, so its thumbnail travels.
    const whole = await importSnapshot(ctx, target, snapshot, { dryRun: true });
    expect(whole).toMatchObject({ blockCatalog: true, blockConfig: true });

    const report = await importSnapshot(ctx, target, { ...snapshot, assets: [] });
    expect(report).toMatchObject({ blockCatalog: false, blockConfig: false });
    expect(report.skipped.join('\n')).toContain(
      `block catalog: left behind, its thumbnails name assets the snapshot doesn't carry: hero (${asset.id})`,
    );
    expect(await store.blockCatalogs.latest(target)).toBeNull();
  });

  it('leaves behind a catalog the snapshot’s types don’t line up with', async () => {
    const snapshot = await exportSnapshot(ctx, source);
    // The file's page type lost the grid variant the catalog makes: carried as it is, the
    // catalog would say the page takes a block its type can't hold.
    const contentTypes = snapshot.contentTypes.map((ct) => ({
      ...ct,
      fields: ct.fields.map((f) =>
        f.apiId === 'body' && f.items
          ? { ...f, items: { ...f.items, variants: f.items.variants?.slice(0, 1) } }
          : f,
      ),
    }));
    const report = await importSnapshot(ctx, target, { ...snapshot, contentTypes });
    expect(report).toMatchObject({ contentTypes: 1, blockCatalog: false, blockConfig: false });
    expect(report.skipped.join('\n')).toContain(
      "block catalog: left behind, the snapshot's content types don't hold the variants it makes: page.body",
    );
  });

  it('notes the config it sets for the audit row, as a set does', async () => {
    const changes = createChangeLog();
    await importSnapshot(withChanges(ctx, changes), target, await exportSnapshot(ctx, source));
    expect(changes.detail()?.blockConfig).toMatchObject({ from: 0, to: 1, removed: [] });
    expect(changes.detail()?.blockConfig?.added).toEqual([
      'targets[page.body]',
      'blocks[grid].slots.items',
    ]);
  });
});

describe('cloning the blocks', () => {
  it('copies the catalog and config in force, starting the copy’s history at version 1', async () => {
    await push();
    await push(BLOCKS.map((b) => (b.id === 'hero' ? { ...b, name: 'Banner' } : b)));
    await configure();
    await configure({ targets: [] }, source, 1);

    const report = await cloneEnvironment(ctx, source, target);
    expect(report).toMatchObject({ blockCatalog: true, blockConfig: true, skipped: [] });
    const [from, to] = [await getBlockCatalog(ctx, source), await getBlockCatalog(ctx, target)];
    expect(from.version).toBe(2);
    expect(to).toMatchObject({ version: 1, hash: from.hash, blocks: from.blocks });
    expect(await getBlockConfig(ctx, target)).toMatchObject({
      version: 1,
      targets: [],
      blocks: NARROWING.blocks,
    });
    // The source keeps its own history.
    expect((await getBlockConfig(ctx, source)).version).toBe(2);
  });

  it('carries a config gone stale at the source as it is, where an uploaded file would not', async () => {
    await push();
    // A grid takes only quotes: valid while the code has them.
    const stale = {
      targets: NARROWING.targets,
      blocks: [{ block: 'grid', slots: { items: { allowedChildren: ['quote'] } } }],
    };
    await configure(stale);
    // Code moves first: quotes leave the catalog, and the narrowing that names them is stale at
    // the source (ignored there, not an error).
    await push(
      BLOCKS.filter((b) => b.id !== 'quote').map((b) =>
        b.id === 'grid'
          ? { ...b, slots: [{ apiId: 'items', name: 'Items', allowedChildren: ['card'], max: 6 }] }
          : b,
      ),
    );

    const cloned = await cloneEnvironment(ctx, source, target);
    expect(cloned).toMatchObject({ blockConfig: true, skipped: [] });
    expect(await getBlockConfig(ctx, target)).toMatchObject({ version: 1, ...stale });

    const other = { spaceId: 's1', environmentId: 'upload' };
    await createEnvironment(ctx, 's1', 'upload');
    const uploaded = await importSnapshot(ctx, other, await exportSnapshot(ctx, source));
    expect(uploaded).toMatchObject({ blockCatalog: true, blockConfig: false });
    expect(uploaded.skipped.join('\n')).toMatch(/block config: left behind.*quote/);
  });

  it('carries the catalog in force when a type has since drifted from it', async () => {
    await push();
    await configure({ targets: [] });
    // The targeted field is gone from the type, so a push of this catalog would now be refused;
    // the source still holds it in force, and so does the copy.
    await updateContentType(ctx, SYSTEM_CALLER, source, 'page', {
      fields: [field({ apiId: 'title', type: 'Symbol' })],
    });
    const report = await cloneEnvironment(ctx, source, target);
    expect(report).toMatchObject({ blockCatalog: true, blockConfig: true, skipped: [] });
    const from = await getBlockCatalog(ctx, source);
    expect(await getBlockCatalog(ctx, target)).toMatchObject({ version: 1, hash: from.hash });

    // An uploaded copy of the same export has no such standing.
    const other = { spaceId: 's1', environmentId: 'upload' };
    await createEnvironment(ctx, 's1', 'upload');
    const uploaded = await importSnapshot(ctx, other, await exportSnapshot(ctx, source));
    expect(uploaded).toMatchObject({ blockCatalog: false, blockConfig: false });
    expect(uploaded.skipped.join('\n')).toMatch(/block catalog: left behind.*has no field "body"/);
  });

  it('carries thumbnails, their assets coming along', async () => {
    const files = {
      getUploadUrl: async () => 'https://upload',
      getDownloadUrl: async () => 'https://download',
      delete: async () => {},
    } as never;
    const { asset } = await createAsset(ctx, files, source, {
      fileName: 'hero.png',
      contentType: 'image/png',
    });
    await push(
      BLOCKS.map((b) => (b.id === 'hero' ? { ...b, thumbnail: { assetId: asset.id } } : b)),
    );
    const report = await cloneEnvironment(ctx, source, target);
    expect(report).toMatchObject({ blockCatalog: true });
    const hero = (await getBlockCatalog(ctx, target)).blocks.find((b) => b.id === 'hero');
    expect(hero?.thumbnail).toEqual({ assetId: asset.id });
    expect(await store.assets.get(target, asset.id)).not.toBeNull();
  });
});
