import {
  ConflictError,
  type FieldDefinition,
  ForbiddenError,
  NotFoundError,
  type Principal,
  ValidationError,
} from '@contentworker/domain';
import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@contentworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  type BlockCatalogPush,
  createContentType,
  createEntry,
  createSpace,
  findBlockCatalog,
  getBlockCatalog,
  getBlockUsage,
  getContentType,
  getEntry,
  listBlockCatalogVersions,
  publishContentType,
  publishEntry,
  pushBlockCatalog,
  SYSTEM_CALLER,
  updateContentType,
  updateEntry,
} from '../src/index';

const scope = { spaceId: 'site', environmentId: 'main' };
const staging = { spaceId: 'site', environmentId: 'staging' };

const field = (over: Partial<FieldDefinition> & Pick<FieldDefinition, 'apiId' | 'type'>) =>
  ({
    name: over.apiId,
    localized: false,
    required: false,
    position: 0,
    ...over,
  }) as FieldDefinition;

const developer: Principal = {
  spaceId: 'site',
  kind: 'user',
  subject: 'dev@example.com',
  scopes: ['content:manage', 'content:publish', 'content:read'],
};

const HERO = {
  id: 'hero',
  name: 'Hero',
  group: 'Headers',
  fields: [
    { apiId: 'heading', name: 'Heading', type: 'Symbol', required: true },
    { apiId: 'tone', name: 'Tone', type: 'Symbol', validations: { in: ['light', 'dark'] } },
  ],
};
const CARD = {
  id: 'card',
  name: 'Card',
  fields: [{ apiId: 'title', name: 'Title', type: 'Symbol' }],
  allowedParents: ['grid'],
};
const GRID = {
  id: 'grid',
  name: 'Grid',
  fields: [],
  slots: [{ apiId: 'items', name: 'Items', allowedChildren: ['card'], max: 6 }],
};
const TARGETS = [{ contentTypeApiId: 'page', field: 'body' }];

const conflict = async (p: Promise<unknown>): Promise<ConflictError> => {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  if (!(err instanceof ConflictError))
    throw new Error(`expected a ConflictError, got ${String(err)}`);
  return err;
};

describe('pushing a block catalog', () => {
  let ctx: AppContext;
  let store: InMemoryContentStore;
  let clock: FixedClock;

  beforeEach(async () => {
    store = new InMemoryContentStore();
    clock = new FixedClock(new Date('2026-11-07T10:00:00.000Z'));
    ctx = { store, clock, ids: new SequenceIdGenerator('b') };
    await createSpace(ctx, {
      spaceId: 'site',
      name: 'Site',
      defaultLocale: 'en-US',
      locales: ['en-US'],
    });
    store.seedSpace({
      spaceId: 'site',
      defaultLocale: 'en-US',
      locales: ['en-US'],
      environments: ['main', 'staging'],
    });
    for (const s of [scope, staging]) {
      await createContentType(ctx, SYSTEM_CALLER, s, {
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
                {
                  apiId: 'placeholder',
                  name: 'Placeholder',
                  fields: [field({ apiId: 'x', type: 'Symbol' })],
                },
              ],
            },
          }),
        ],
      });
      await publishContentType(ctx, s, 'page');
    }
  });

  const push = (input: Partial<Parameters<typeof pushBlockCatalog>[3]> = {}, s = scope) =>
    pushBlockCatalog(ctx, developer, s, {
      blocks: [HERO, GRID, CARD],
      targets: TARGETS,
      allowDestructive: true,
      ...input,
    });

  it('dry-runs the first push: what it adds and removes, and writes nothing', async () => {
    const plan = await push({ dryRun: true, allowDestructive: false });
    expect(plan).toMatchObject({
      dryRun: true,
      applied: false,
      unchanged: false,
      previousVersion: 0,
      version: 1,
      changes: { added: ['hero', 'grid', 'card'], changed: [], removed: [], renamed: [] },
      contentTypes: [
        {
          contentTypeApiId: 'page',
          fields: [{ field: 'body', added: ['hero', 'grid'], removed: ['placeholder'] }],
          destructive: true,
          published: true,
        },
      ],
      inUse: [],
    });
    expect(plan.hash).toMatch(/^[0-9a-f]{64}$/);
    await expect(getBlockCatalog(ctx, scope)).rejects.toThrow(NotFoundError);
    const page = await getContentType(ctx, scope, 'page');
    expect(page.fields[1]?.items?.variants?.map((v) => v.apiId)).toEqual(['placeholder']);
  });

  it('finds the catalog in force, or none before the first push, per environment', async () => {
    expect(await findBlockCatalog(ctx, scope)).toBeUndefined();
    await push();
    expect((await findBlockCatalog(ctx, scope))?.version).toBe(1);
    expect(await findBlockCatalog(ctx, { ...scope, environmentId: 'staging' })).toBeUndefined();
  });

  it('applies: revises and publishes the type, stores version 1, announces the publish', async () => {
    const before = await getContentType(ctx, scope, 'page');
    const done = await push();
    expect(done).toMatchObject({ applied: true, version: 1 });
    const page = await getContentType(ctx, scope, 'page');
    expect(page.status).toBe('published');
    expect(page.version).toBe(before.version + 1);
    const body = page.fields.find((f) => f.apiId === 'body');
    expect(body?.items?.variants?.map((v) => v.apiId)).toEqual(['hero', 'grid']);
    const grid = body?.items?.variants?.[1];
    expect(grid?.fields[0]).toMatchObject({
      apiId: 'items',
      items: { variants: [{ apiId: 'card' }] },
      validations: { size: { max: 6 } },
    });
    const catalog = await getBlockCatalog(ctx, scope);
    expect(catalog).toMatchObject({
      version: 1,
      hash: done.hash,
      pushedBy: 'dev@example.com',
      pushedAt: '2026-11-07T10:00:00.000Z',
      targets: TARGETS,
    });
    expect(catalog.blocks.map((b) => b.id)).toEqual(['hero', 'grid', 'card']);
    expect(
      store
        .allEvents()
        .filter((e) => e.type === 'content_type.published')
        .at(-1),
    ).toMatchObject({ contentTypeApiId: 'page', version: page.version });
  });

  it('leaves the revision a draft with publish: false', async () => {
    await push({ publish: false });
    expect((await getContentType(ctx, scope, 'page')).status).toBe('draft');
  });

  it('pushing the same catalog again changes and writes nothing', async () => {
    const first = await push();
    const page = await getContentType(ctx, scope, 'page');
    const again = await push();
    expect(again).toMatchObject({ applied: false, unchanged: true, version: 1, hash: first.hash });
    expect((await getContentType(ctx, scope, 'page')).version).toBe(page.version);
    expect(await listBlockCatalogVersions(ctx, scope)).toHaveLength(1);
  });

  it('refuses a removal without allowDestructive', async () => {
    const err = await conflict(push({ allowDestructive: false }));
    expect(err.message).toMatch(/allowDestructive/);
    expect((err.details as BlockCatalogPush).destructive).toBe(true);
    await expect(getBlockCatalog(ctx, scope)).rejects.toThrow(NotFoundError);
  });

  it('refuses to remove a block an entry still holds, naming the entry, with no override', async () => {
    await push();
    const { entry } = await createEntry(ctx, scope, {
      contentTypeApiId: 'page',
      fields: {
        title: { 'en-US': 'Home' },
        body: { 'en-US': [{ _type: 'grid', items: [{ _type: 'card', title: 'A' }] }] },
      },
    });
    const plan = await push({ blocks: [HERO], dryRun: true });
    expect(plan.inUse).toEqual([
      { contentTypeApiId: 'page', at: 'body: grid', kind: 'variant', entries: [entry.id] },
    ]);
    const err = await conflict(push({ blocks: [HERO] }));
    expect(err.message).toContain(`page.body: grid (entry ${entry.id})`);
    expect((await getBlockCatalog(ctx, scope)).version).toBe(1);
  });

  it('refuses a block prop an entry holds a value for', async () => {
    await push();
    await createEntry(ctx, scope, {
      contentTypeApiId: 'page',
      fields: {
        title: { 'en-US': 'Home' },
        body: { 'en-US': [{ _type: 'hero', heading: 'Hi', tone: 'dark' }] },
      },
    });
    const slimmer = { ...HERO, fields: [HERO.fields[0]] };
    const plan = await push({ blocks: [slimmer, GRID, CARD], dryRun: true });
    expect(plan.inUse).toMatchObject([{ at: 'body[hero].tone', kind: 'field' }]);
  });

  it('renames a block through aliases: stored blocks keep reading, and take the new id on save', async () => {
    await push();
    const { entry } = await createEntry(ctx, scope, {
      contentTypeApiId: 'page',
      fields: { title: { 'en-US': 'Home' }, body: { 'en-US': [{ _type: 'hero', heading: 'Hi' }] } },
    });
    await publishEntry(ctx, scope, entry.id);
    const renamed = { ...HERO, id: 'banner', name: 'Banner', aliases: ['hero'] };
    const done = await push({ blocks: [renamed, GRID, CARD], allowDestructive: false });
    expect(done).toMatchObject({
      applied: true,
      version: 2,
      destructive: false,
      changes: { renamed: [{ from: 'hero', to: 'banner' }], removed: [] },
    });
    const usage = await getBlockUsage(ctx, developer, scope);
    expect(usage.blocks.find((b) => b.id === 'banner')?.entries).toBe(1);
    const found = await getEntry(ctx, scope, entry.id);
    await updateEntry(ctx, scope, entry.id, found.fields);
    const saved = await getEntry(ctx, scope, entry.id);
    const blocks = (saved.fields.body?.['en-US'] ?? []) as { _type: string }[];
    expect(blocks[0]?._type).toBe('banner');
  });

  it('refuses to drop an alias while entries still hold blocks under it', async () => {
    await push();
    await createEntry(ctx, scope, {
      contentTypeApiId: 'page',
      fields: { title: { 'en-US': 'Home' }, body: { 'en-US': [{ _type: 'hero', heading: 'Hi' }] } },
    });
    const renamed = { ...HERO, id: 'banner', name: 'Banner', aliases: ['hero'] };
    await push({ blocks: [renamed, GRID, CARD] });
    // The entry still holds `_type: hero` (it hasn't been saved since). Forgetting the alias
    // would strand it.
    const plan = await push({
      blocks: [{ ...renamed, aliases: undefined }, GRID, CARD],
      dryRun: true,
    });
    expect(plan.destructive).toBe(true);
    expect(plan.inUse).toMatchObject([{ at: 'body: hero', kind: 'variant' }]);
    await conflict(push({ blocks: [{ ...renamed, aliases: undefined }, GRID, CARD] }));
  });

  it('needs content:publish to publish, and pushes drafts without it', async () => {
    const manageOnly: Principal = { ...developer, scopes: ['content:manage', 'content:read'] };
    await expect(
      pushBlockCatalog(ctx, manageOnly, scope, {
        blocks: [HERO],
        targets: TARGETS,
        allowDestructive: true,
      }),
    ).rejects.toThrow(ForbiddenError);
    const drafts = await pushBlockCatalog(ctx, manageOnly, scope, {
      blocks: [HERO],
      targets: TARGETS,
      allowDestructive: true,
      publish: false,
    });
    expect(drafts).toMatchObject({ applied: true, contentTypes: [{ published: false }] });
  });

  it('is unchanged on a second push of props the content model normalizes', async () => {
    const tidy = { ...HERO, fields: [{ ...HERO.fields[0], help: '' }, HERO.fields[1]] };
    await push({ blocks: [tidy, GRID, CARD] });
    const page = await getContentType(ctx, scope, 'page');
    expect(await push({ blocks: [tidy, GRID, CARD] })).toMatchObject({ unchanged: true });
    expect((await getContentType(ctx, scope, 'page')).version).toBe(page.version);
  });

  it('treats a retry whose first try landed as a no-op, whatever version it expected', async () => {
    await push({ expectedVersion: 0 });
    expect(await push({ expectedVersion: 0 })).toMatchObject({ unchanged: true, version: 1 });
  });

  it('refuses to overwrite a revision of a target type made while it was pushing', async () => {
    await push();
    // Someone revises `page` between the push's read and its commit.
    const get = store.contentTypes.get.bind(store.contentTypes);
    let raced = false;
    store.contentTypes.get = async (s, apiId) => {
      const read = await get(s, apiId);
      if (!raced && read && apiId === 'page') {
        raced = true;
        await updateContentType(ctx, SYSTEM_CALLER, s, 'page', { name: 'Landing page' });
      }
      return read;
    };
    const err = await conflict(push({ blocks: [{ ...HERO, name: 'Changed' }, GRID, CARD] }));
    expect(err.message).toMatch(/changed while it was being pushed/);
    expect((await getContentType(ctx, scope, 'page')).name).toBe('Landing page');
  });

  it('refuses a stale expectedVersion, and takes the current one', async () => {
    await push();
    const err = await conflict(push({ blocks: [HERO], expectedVersion: 0 }));
    expect(err.details).toEqual({ version: 1 });
    const done = await push({
      blocks: [{ ...HERO, name: 'Hero banner' }, GRID, CARD],
      expectedVersion: 1,
    });
    expect(done).toMatchObject({ applied: true, version: 2, changes: { changed: ['hero'] } });
  });

  it('turns a push that loses the race to another at commit into a conflict', async () => {
    await push();
    // Another push lands version 2 between this one's reads and its commit.
    const latest = store.blockCatalogs.latest.bind(store.blockCatalogs);
    let raced = false;
    store.blockCatalogs.latest = async (s) => {
      const read = await latest(s);
      if (!raced && read) {
        raced = true;
        await store.blockCatalogs.save(s, { ...read, version: 2, hash: 'other' });
        return read;
      }
      return read;
    };
    const err = await conflict(push({ blocks: [{ ...HERO, name: 'Changed' }, GRID, CARD] }));
    expect(err.message).toMatch(/changed while it was being pushed/);
    // The unit rolled back: the type is as version 1 left it.
    const page = await getContentType(ctx, scope, 'page');
    expect(page.fields[1]?.items?.variants?.[0]?.name).toBe('Hero');
  });

  it('refuses an invalid catalog and a target that is not a blocks field', async () => {
    await expect(push({ blocks: [{ id: 'x', name: 'X', fields: [] }] })).rejects.toThrow(
      ValidationError,
    );
    await expect(push({ targets: [{ contentTypeApiId: 'page', field: 'title' }] })).rejects.toThrow(
      ValidationError,
    );
  });

  it('refuses a thumbnail naming an asset that is not there', async () => {
    const err = await push({ blocks: [{ ...HERO, thumbnail: { assetId: 'missing' } }] }).then(
      () => null,
      (e: unknown) => e as ValidationError,
    );
    expect(err?.issues).toEqual([
      { field: 'blocks[hero].thumbnail', message: 'No asset "missing" in this environment' },
    ]);
  });

  it('keeps each environment’s catalog to itself', async () => {
    await push();
    await expect(getBlockCatalog(ctx, staging)).rejects.toThrow(NotFoundError);
    expect(await listBlockCatalogVersions(ctx, staging)).toEqual([]);
    const there = await push({}, staging);
    expect(there.version).toBe(1);
  });

  it('lists versions newest first, without their blocks, and reads an older one', async () => {
    await push();
    await push({ blocks: [{ ...HERO, name: 'Two' }, GRID, CARD] });
    await push({ blocks: [{ ...HERO, name: 'Three' }, GRID, CARD] });
    const versions = await listBlockCatalogVersions(ctx, scope, { limit: 2 });
    expect(versions.map((v) => v.version)).toEqual([3, 2]);
    expect(versions[0]).toMatchObject({ blockCount: 3, changes: { changed: ['hero'] } });
    expect(versions[0]).not.toHaveProperty('blocks');
    expect(
      (await listBlockCatalogVersions(ctx, scope, { before: 2 })).map((v) => v.version),
    ).toEqual([1]);
    expect((await getBlockCatalog(ctx, scope, 1)).blocks[0]?.name).toBe('Hero');
  });
});

describe('block usage', () => {
  let ctx: AppContext;
  let store: InMemoryContentStore;

  beforeEach(async () => {
    store = new InMemoryContentStore();
    ctx = { store, clock: new FixedClock(), ids: new SequenceIdGenerator('u') };
    await createSpace(ctx, {
      spaceId: 'site',
      name: 'Site',
      defaultLocale: 'en-US',
      locales: ['en-US'],
    });
    for (const apiId of ['page', 'post']) {
      await createContentType(ctx, SYSTEM_CALLER, scope, {
        apiId,
        name: apiId,
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
                {
                  apiId: 'hero',
                  name: 'Hero',
                  fields: [field({ apiId: 'heading', type: 'Symbol' })],
                },
              ],
            },
          }),
        ],
      });
    }
  });

  it('reads as empty before the first push', async () => {
    expect(await getBlockUsage(ctx, developer, scope)).toEqual({
      version: null,
      blocks: [],
      scanned: 0,
      complete: true,
    });
  });

  it('counts entries per block and per type, once per entry, and leaves out types the caller can’t read', async () => {
    await pushBlockCatalog(ctx, developer, scope, {
      blocks: [HERO, GRID, CARD],
      targets: [
        { contentTypeApiId: 'page', field: 'body' },
        { contentTypeApiId: 'post', field: 'body' },
      ],
    });
    const hero = (heading: string) => ({ _type: 'hero', heading });
    for (const [type, body] of [
      ['page', [hero('a'), hero('b')]],
      ['page', [{ _type: 'grid', items: [{ _type: 'card', title: 'x' }] }]],
      ['post', [hero('c')]],
    ] as const) {
      await createEntry(ctx, scope, {
        contentTypeApiId: type,
        fields: { title: { 'en-US': 't' }, body: { 'en-US': body } },
      });
    }
    const usage = await getBlockUsage(ctx, developer, scope);
    expect(usage).toMatchObject({ version: 1, scanned: 3, complete: true });
    expect(usage.blocks).toEqual([
      {
        id: 'hero',
        entries: 2,
        contentTypes: [
          { contentTypeApiId: 'page', entries: 1 },
          { contentTypeApiId: 'post', entries: 1 },
        ],
      },
      { id: 'grid', entries: 1, contentTypes: [{ contentTypeApiId: 'page', entries: 1 }] },
      { id: 'card', entries: 1, contentTypes: [{ contentTypeApiId: 'page', entries: 1 }] },
    ]);
    const pagesOnly: Principal = {
      ...developer,
      contentGrants: [{ contentTypeApiId: 'page', actions: ['read'] }],
    };
    const narrowed = await getBlockUsage(ctx, pagesOnly, scope);
    expect(narrowed.blocks[0]?.contentTypes).toEqual([{ contentTypeApiId: 'page', entries: 1 }]);
    expect(narrowed.scanned).toBe(2);
  });
});
