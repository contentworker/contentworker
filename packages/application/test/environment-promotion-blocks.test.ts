import {
  ConflictError,
  type FieldDefinition,
  type Principal,
  SCOPES,
  ValidationError,
} from '@contentworker/domain';
import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@contentworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  approvePromotion,
  compareEnvironments,
  comparisonFor,
  createContentType,
  createEntry,
  createEnvironment,
  createSpace,
  getEffectiveBlockRules,
  publishContentType,
  pushBlockCatalog,
  requestPromotion,
  SYSTEM_CALLER,
  setBlockConfig,
} from '../src/index';

/**
 * A promotion copies the block catalog and block config (snapshots and clones carry them too:
 * `snapshot-blocks.test.ts`), pinned on both sides, and asks for approval when they change what
 * editors may do in the target.
 */

const spaceId = 'site';
const main = { spaceId, environmentId: 'main' };
const staging = { spaceId, environmentId: 'staging' };
const qa = { spaceId, environmentId: 'qa' };

const admin: Principal = {
  spaceId,
  kind: 'user',
  subject: 'admin@example.com',
  scopes: [SCOPES.contentManage, SCOPES.contentPublish, SCOPES.contentWrite],
};
const approver: Principal = { ...admin, subject: 'grace@example.com' };

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
const BANNER = {
  id: 'banner',
  name: 'Banner',
  fields: [{ apiId: 'text', name: 'Text', type: 'Symbol' }],
};

/** The top of a page takes only grids; a grid only quotes, three at most. */
const NARROWING = {
  targets: [{ contentTypeApiId: 'page', field: 'body', blocks: ['grid'] }],
  blocks: [{ block: 'grid', slots: { items: { allowedChildren: ['quote'], max: 3 } } }],
};

let ctx: AppContext;
let store: InMemoryContentStore;

async function seedPage(scope: typeof main) {
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
            { apiId: 'hero', name: 'Hero', fields: [field({ apiId: 'heading', type: 'Symbol' })] },
          ],
        },
      }),
    ],
  });
  await publishContentType(ctx, scope, 'page');
}

beforeEach(async () => {
  store = new InMemoryContentStore();
  ctx = {
    store,
    clock: new FixedClock(new Date('2026-11-09T10:00:00.000Z')),
    ids: new SequenceIdGenerator('b'),
  };
  await createSpace(ctx, { spaceId, name: 'Site', defaultLocale: 'en-US' });
  for (const env of ['staging', 'qa']) await createEnvironment(ctx, spaceId, env);
});

/** A save the target should refuse once the config arrives: a hero at the top of a page. */
const heroPage = (scope: typeof main) =>
  createEntry(ctx, scope, {
    contentTypeApiId: 'page',
    fields: {
      title: { 'en-US': 'Home' },
      body: { 'en-US': [{ _type: 'hero', _key: 'h1', heading: 'Hi' }] },
    },
  });

const rulesOf = async (scope: typeof main) => {
  const { targets, blocks, stale } = await getEffectiveBlockRules(ctx, scope);
  return { targets, blocks, stale };
};

describe('promoting blocks between environments', () => {
  beforeEach(async () => {
    for (const s of [staging, qa]) {
      await seedPage(s);
      await pushBlockCatalog(ctx, admin, s, { blocks: BLOCKS, targets: TARGETS });
    }
  });

  it('asks for approval when the catalog or config changes what editors may do, then copies both', async () => {
    await pushBlockCatalog(ctx, admin, staging, {
      blocks: [...BLOCKS, BANNER],
      targets: TARGETS,
    });
    await setBlockConfig(ctx, admin, staging, { expectedVersion: 0, ...NARROWING });

    const p = await requestPromotion(ctx, admin, spaceId, { source: 'staging', target: 'qa' });
    expect(p.status).toBe('awaiting_approval');
    expect(p.blocks).toEqual({
      catalogVersion: 2,
      configVersion: 1,
      targetCatalogVersion: 1,
      targetConfigVersion: 0,
    });
    expect(p.risk.protectedTarget).toBe(false);
    // Banner is new, but the config keeps it off the top of a page: the rules say what moves.
    expect(p.risk.reasons).toEqual([
      'The block catalog adds "banner"',
      'The block rules change: page.body takes grid (was: takes hero, grid)',
      'The block rules change: grid.slots.items takes quote, at most 3 (was: takes card, quote, at most 6)',
    ]);
    expect((await store.blockCatalogs.latest(qa))?.version).toBe(1);

    const done = await approvePromotion(ctx, approver, spaceId, p.id);
    expect(done).toMatchObject({
      status: 'completed',
      result: { blocks: { catalog: true, config: true } },
    });
    expect((await store.blockCatalogs.latest(qa))?.hash).toBe(
      (await store.blockCatalogs.latest(staging))?.hash,
    );
    expect(await rulesOf(qa)).toMatchObject({
      targets: (await rulesOf(staging)).targets,
      blocks: (await rulesOf(staging)).blocks,
    });
    await expect(heroPage(qa)).rejects.toBeInstanceOf(ValidationError);
  });

  it('copies a config alone, and only when asked for alongside a selection', async () => {
    await setBlockConfig(ctx, admin, staging, { expectedVersion: 0, ...NARROWING });
    await expect(
      requestPromotion(ctx, admin, spaceId, { source: 'staging', target: 'qa', entries: [] }),
    ).rejects.toBeInstanceOf(ValidationError);

    const p = await requestPromotion(ctx, admin, spaceId, {
      source: 'staging',
      target: 'qa',
      entries: [],
      blocks: true,
    });
    expect(p.contentTypes).toEqual([]);
    expect(p.blocks).toMatchObject({ catalogVersion: 1, configVersion: 1 });
    expect(p.status).toBe('awaiting_approval');
    const done = await approvePromotion(ctx, approver, spaceId, p.id);
    expect(done.result?.blocks).toEqual({ catalog: false, config: true });
    expect((await store.blockConfigs.get(qa))?.targets).toEqual(NARROWING.targets);
  });

  it('copies no blocks when they already match', async () => {
    const e = await createEntry(ctx, staging, {
      contentTypeApiId: 'page',
      fields: { title: { 'en-US': 'Same' } },
    });
    const p = await requestPromotion(ctx, admin, spaceId, { source: 'staging', target: 'qa' });
    expect(p.entries.map((x) => x.entryId)).toEqual([e.entry.id]);
    expect(p.blocks).toBeUndefined();
    expect(p).toMatchObject({ status: 'completed', risk: { requiresApproval: false } });
    expect(p.result?.blocks).toBeUndefined();
  });

  it('fails the apply when the source catalog moved after the request', async () => {
    await pushBlockCatalog(ctx, admin, staging, { blocks: [...BLOCKS, BANNER], targets: TARGETS });
    const p = await requestPromotion(ctx, admin, spaceId, { source: 'staging', target: 'qa' });
    await pushBlockCatalog(ctx, admin, staging, {
      blocks: [...BLOCKS, BANNER, { ...BANNER, id: 'promo', name: 'Promo' }],
      targets: TARGETS,
    });
    await expect(approvePromotion(ctx, approver, spaceId, p.id)).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect((await store.promotions.get(spaceId, p.id))?.status).toBe('failed');
    expect((await store.blockCatalogs.latest(qa))?.version).toBe(1);
  });

  it('names what a catalog removes that entries in the target still use', async () => {
    await createEntry(ctx, qa, {
      contentTypeApiId: 'page',
      fields: {
        title: { 'en-US': 'Quoted' },
        body: {
          'en-US': [
            {
              _type: 'grid',
              _key: 'g1',
              items: [{ _type: 'quote', _key: 'q1', text: 'Hello' }],
            },
          ],
        },
      },
    });
    await pushBlockCatalog(ctx, admin, staging, {
      blocks: [
        BLOCKS[0],
        { ...BLOCKS[1], slots: [{ ...BLOCKS[1]?.slots?.[0], allowedChildren: ['card'] }] },
        BLOCKS[2],
      ],
      targets: TARGETS,
      allowDestructive: true,
    });
    // The types alone are left out, so the push itself is what would remove the quote in qa:
    // refused when requested, as the apply would refuse it however it was approved.
    const [quoted] = await store.entries.list(qa, { contentTypeApiId: 'page' });
    const err = await requestPromotion(ctx, admin, spaceId, {
      source: 'staging',
      target: 'qa',
      entries: [],
      blocks: true,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).issues).toEqual([
      {
        field: 'blocks',
        message: `The block catalog can't go to qa: it removes what entries there still hold (page.body[grid].items: quote (entry ${quoted?.entry.id})); change those entries first. Request with blocks: false to promote the rest`,
      },
    ]);
    expect(await store.promotions.list(spaceId)).toEqual([]);
  });

  it('names a removal no entry holds, and applies it once approved', async () => {
    await pushBlockCatalog(ctx, admin, staging, {
      blocks: [
        BLOCKS[0],
        { ...BLOCKS[1], slots: [{ ...BLOCKS[1]?.slots?.[0], allowedChildren: ['card'] }] },
        BLOCKS[2],
      ],
      targets: TARGETS,
      allowDestructive: true,
    });
    const p = await requestPromotion(ctx, admin, spaceId, {
      source: 'staging',
      target: 'qa',
      entries: [],
      blocks: true,
    });
    expect(p.status).toBe('awaiting_approval');
    expect(p.risk.reasons).toEqual([
      'The block catalog removes "quote"; changes "grid"',
      'The block catalog removes blocks or block props from the content type "page"',
      'The block rules change: grid.slots.items takes card, at most 6 (was: takes card, quote, at most 6)',
    ]);
    const done = await approvePromotion(ctx, approver, spaceId, p.id);
    expect(done.result?.blocks).toEqual({ catalog: true, config: false });
  });

  it('fails the apply, writing nothing, when the target moved after the request', async () => {
    await setBlockConfig(ctx, admin, staging, { expectedVersion: 0, ...NARROWING });
    const p = await requestPromotion(ctx, admin, spaceId, { source: 'staging', target: 'qa' });
    expect(p.blocks).toEqual({
      catalogVersion: 1,
      configVersion: 1,
      targetCatalogVersion: 1,
      targetConfigVersion: 0,
    });
    // A lock set in qa while the promotion waits: the approver never saw it go.
    const lock = { contentTypeApiId: 'page', field: 'body', locked: true };
    await setBlockConfig(ctx, admin, qa, { expectedVersion: 0, targets: [lock], blocks: [] });
    await expect(approvePromotion(ctx, approver, spaceId, p.id)).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect(await store.promotions.get(spaceId, p.id)).toMatchObject({ status: 'failed' });
    expect((await store.blockConfigs.get(qa))?.targets).toEqual([lock]);
  });

  it('checks every pin before writing: a source config set since leaves the target’s types alone', async () => {
    await pushBlockCatalog(ctx, admin, staging, { blocks: [...BLOCKS, BANNER], targets: TARGETS });
    await setBlockConfig(ctx, admin, staging, { expectedVersion: 0, ...NARROWING });
    const before = await store.contentTypes.get(qa, 'page');
    const p = await requestPromotion(ctx, admin, spaceId, { source: 'staging', target: 'qa' });
    expect(p.contentTypes.map((t) => t.apiId)).toEqual(['page']);
    await setBlockConfig(ctx, admin, staging, { expectedVersion: 1, targets: [], blocks: [] });
    await expect(approvePromotion(ctx, approver, spaceId, p.id)).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect((await store.contentTypes.get(qa, 'page'))?.version).toBe(before?.version);
    expect((await store.promotions.get(spaceId, p.id))?.result?.contentTypes).toEqual([]);
  });

  it('takes content:manage to approve a promotion with blocks', async () => {
    await setBlockConfig(ctx, admin, staging, { expectedVersion: 0, ...NARROWING });
    const p = await requestPromotion(ctx, admin, spaceId, { source: 'staging', target: 'qa' });
    const publisher: Principal = { ...approver, scopes: [SCOPES.contentPublish] };
    await expect(approvePromotion(ctx, publisher, spaceId, p.id)).rejects.toThrow(/content:manage/);
  });
});

describe('comparing blocks between environments', () => {
  beforeEach(async () => {
    await seedPage(staging);
    await seedPage(qa);
  });

  it('reports the catalog by hash and the config by what it narrows, never copying them', async () => {
    const none = await compareEnvironments(ctx, spaceId, 'staging', 'qa');
    expect(none.blocks).toEqual({ catalog: 'unchanged', config: 'unchanged' });

    await pushBlockCatalog(ctx, admin, staging, { blocks: BLOCKS, targets: TARGETS });
    await setBlockConfig(ctx, admin, staging, { expectedVersion: 0, ...NARROWING });
    expect((await compareEnvironments(ctx, spaceId, 'staging', 'qa')).blocks).toEqual({
      catalog: 'added',
      config: 'added',
    });
    expect((await compareEnvironments(ctx, spaceId, 'qa', 'staging')).blocks).toEqual({
      catalog: 'removed',
      config: 'removed',
    });

    await pushBlockCatalog(ctx, admin, qa, { blocks: BLOCKS, targets: TARGETS });
    await setBlockConfig(ctx, admin, qa, {
      expectedVersion: 0,
      targets: NARROWING.targets,
      blocks: [],
    });
    expect((await compareEnvironments(ctx, spaceId, 'staging', 'qa')).blocks).toEqual({
      catalog: 'unchanged',
      config: 'changed',
    });
    // A config set back to nothing narrows nothing, as one never set.
    await setBlockConfig(ctx, admin, staging, { expectedVersion: 1, targets: [], blocks: [] });
    await setBlockConfig(ctx, admin, qa, { expectedVersion: 1, targets: [], blocks: [] });
    expect((await compareEnvironments(ctx, spaceId, 'staging', 'qa')).blocks?.config).toBe(
      'unchanged',
    );
  });

  it('leaves the blocks out for a role limited to some types', async () => {
    const diff = await compareEnvironments(ctx, spaceId, 'staging', 'qa');
    const limited: Principal = {
      ...admin,
      contentGrants: [{ contentTypeApiId: 'page', actions: ['read'] }],
    };
    expect(comparisonFor(admin, diff).blocks).toEqual(diff.blocks);
    expect(comparisonFor(limited, diff)).not.toHaveProperty('blocks');
  });
});
