import {
  type BlockConfig,
  ConflictError,
  checkBlockCatalog,
  type FieldDefinition,
  type Principal,
  PromotionFailedError,
  SCOPES,
  ValidationError,
} from '@contentworker/domain';
import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@contentworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  approvePromotion,
  blockConfigChange,
  compareEnvironments,
  comparisonFor,
  createContentType,
  createEntry,
  createEnvironment,
  createSpace,
  getContentType,
  getEffectiveBlockRules,
  getPromotion,
  publishContentType,
  publishEntry,
  pushBlockCatalog,
  rejectPromotion,
  requestPromotion,
  SYSTEM_CALLER,
  setBlockConfig,
  updateContentType,
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

  it('copies breakpoints with the catalog, and entries with their overrides', async () => {
    const breakpoints = [{ id: 'lg', name: 'Desktop', minWidth: 1280 }];
    const toned = BLOCKS.map((b) =>
      b.id === 'hero'
        ? {
            ...b,
            responsive: ['tone'],
            fields: [
              ...b.fields,
              { apiId: 'tone', name: 'Tone', type: 'Symbol', validations: { in: ['a', 'b'] } },
            ],
          }
        : b,
    );
    await pushBlockCatalog(ctx, admin, staging, { blocks: toned, targets: TARGETS, breakpoints });
    const { entry } = await createEntry(ctx, staging, {
      contentTypeApiId: 'page',
      fields: {
        title: { 'en-US': 'Home' },
        body: {
          'en-US': [{ _type: 'hero', _key: 'h1', tone: 'a', _responsive: { lg: { tone: 'b' } } }],
        },
      },
    });
    const p = await requestPromotion(ctx, admin, spaceId, { source: 'staging', target: 'qa' });
    // A breakpoint change that strands nothing in the target needs no approval.
    expect(p.blocks).toMatchObject({ catalogVersion: 2, targetCatalogVersion: 1 });
    expect(p.status).not.toBe('awaiting_approval');
    expect(p.risk.reasons.join('\n')).not.toContain('stale');
    const done = await getPromotion(ctx, spaceId, p.id);
    expect(done.status).toBe('completed');
    expect((await store.blockCatalogs.latest(qa))?.breakpoints).toEqual(breakpoints);
    expect((await store.contentTypes.get(qa, 'page'))?.fields[1]?.items?.breakpoints).toEqual(
      breakpoints,
    );
    expect((await store.entries.get(qa, entry.id))?.fields.body?.['en-US']?.[0]).toMatchObject({
      _responsive: { lg: { tone: 'b' } },
    });
  });

  it('asks for approval when the catalog makes the target’s overrides stale', async () => {
    const breakpoints = [
      { id: 'md', name: 'Tablet', minWidth: 768 },
      { id: 'lg', name: 'Desktop', minWidth: 1280 },
    ];
    const toned = BLOCKS.map((b) =>
      b.id === 'hero'
        ? {
            ...b,
            responsive: ['tone'],
            fields: [
              ...b.fields,
              { apiId: 'tone', name: 'Tone', type: 'Symbol', validations: { in: ['a', 'b'] } },
            ],
          }
        : b,
    );
    for (const s of [staging, qa]) {
      await pushBlockCatalog(ctx, admin, s, { blocks: toned, targets: TARGETS, breakpoints });
    }
    for (const key of ['h1', 'h2']) {
      await createEntry(ctx, qa, {
        contentTypeApiId: 'page',
        fields: {
          title: { 'en-US': key },
          body: {
            'en-US': [{ _type: 'hero', _key: key, tone: 'a', _responsive: { lg: { tone: 'b' } } }],
          },
        },
      });
    }
    // Staging drops lg: promoted, the target's two blocks lose their lg override on next save.
    await pushBlockCatalog(ctx, admin, staging, {
      blocks: toned,
      targets: TARGETS,
      breakpoints: breakpoints.slice(0, 1),
    });
    const p = await requestPromotion(ctx, admin, spaceId, { source: 'staging', target: 'qa' });
    expect(p.status).toBe('awaiting_approval');
    expect(p.risk.reasons).toContain(
      'The block catalog makes 2 blocks\' overrides stale in the target\'s content type "page" (lg: tone)',
    );
    const done = await approvePromotion(ctx, approver, spaceId, p.id);
    expect(done.status).toBe('completed');
    expect((await store.blockCatalogs.latest(qa))?.breakpoints).toEqual(breakpoints.slice(0, 1));
  });

  it('judges a copied content type’s breakpoints too, and skips the entries it replaces', async () => {
    const breakpoints = [
      { id: 'md', name: 'Tablet', minWidth: 768 },
      { id: 'lg', name: 'Desktop', minWidth: 1280 },
    ];
    const toned = BLOCKS.map((b) =>
      b.id === 'hero'
        ? {
            ...b,
            responsive: ['tone'],
            fields: [
              ...b.fields,
              { apiId: 'tone', name: 'Tone', type: 'Symbol', validations: { in: ['a', 'b'] } },
            ],
          }
        : b,
    );
    for (const s of [staging, qa]) {
      await pushBlockCatalog(ctx, admin, s, { blocks: toned, targets: TARGETS, breakpoints });
    }
    const withLg = (title: string) => ({
      contentTypeApiId: 'page',
      id: `e-${title}`,
      fields: {
        title: { 'en-US': title },
        body: {
          'en-US': [{ _type: 'hero', _key: 'h1', tone: 'a', _responsive: { lg: { tone: 'b' } } }],
        },
      },
    });
    // `shared` is in both: a promotion of it writes over qa's copy. `own` is only qa's.
    await createEntry(ctx, staging, withLg('shared'));
    await createEntry(ctx, qa, withLg('shared'));
    await createEntry(ctx, qa, withLg('own'));
    // Staging's type drops lg by hand: no catalog is copied, only the type.
    const page = await getContentType(ctx, staging, 'page');
    await updateContentType(ctx, SYSTEM_CALLER, staging, 'page', {
      fields: page.fields.map((f) =>
        f.apiId === 'body' && f.items
          ? { ...f, items: { ...f.items, breakpoints: breakpoints.slice(0, 1) } }
          : f,
      ),
    });
    await publishContentType(ctx, staging, 'page');
    const line = (n: string) =>
      `The block catalog makes ${n} overrides stale in the target's content type "page" (lg: tone)`;

    // With `shared` copied over, only `own` loses its override.
    const one = await requestPromotion(ctx, admin, spaceId, {
      source: 'staging',
      target: 'qa',
      contentTypes: ['page'],
      entries: ['e-shared'],
    });
    expect(one.blocks).toBeUndefined();
    expect(one.status).toBe('awaiting_approval');
    expect(one.risk.reasons).toContain(line("1 block's"));
    await rejectPromotion(ctx, approver, spaceId, one.id);

    const both = await requestPromotion(ctx, admin, spaceId, {
      source: 'staging',
      target: 'qa',
      contentTypes: ['page'],
    });
    expect(both.risk.reasons).toContain(line("2 blocks'"));
  });

  it('asks for approval when promoted entries carry overrides the target doesn’t declare', async () => {
    const toned = BLOCKS.map((b) =>
      b.id === 'hero'
        ? {
            ...b,
            responsive: ['tone'],
            fields: [
              ...b.fields,
              { apiId: 'tone', name: 'Tone', type: 'Symbol', validations: { in: ['a', 'b'] } },
            ],
          }
        : b,
    );
    // The two environments' breakpoints have diverged: staging has xl, qa doesn't.
    const md = { id: 'md', name: 'Tablet', minWidth: 768 };
    await pushBlockCatalog(ctx, admin, staging, {
      blocks: toned,
      targets: TARGETS,
      breakpoints: [md, { id: 'xl', name: 'Wide', minWidth: 1600 }],
    });
    await pushBlockCatalog(ctx, admin, qa, { blocks: toned, targets: TARGETS, breakpoints: [md] });
    const { entry } = await createEntry(ctx, staging, {
      contentTypeApiId: 'page',
      fields: {
        title: { 'en-US': 'Home' },
        body: {
          'en-US': [
            {
              _type: 'hero',
              _key: 'h1',
              tone: 'a',
              _responsive: { xl: { tone: 'b' }, md: { tone: 'b' } },
            },
          ],
        },
      },
    });
    // Entries only: no type and no catalog copied, so the copy lands on qa's type and loses xl.
    const p = await requestPromotion(ctx, admin, spaceId, {
      source: 'staging',
      target: 'qa',
      entries: [entry.id],
    });
    expect(p.status).toBe('awaiting_approval');
    expect(p.risk.reasons).toContain(
      "The promoted entries carry 1 block's overrides the target's content type \"page\" doesn't declare (xl: tone)",
    );
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

  describe('when the entries holding what the catalog removes are the ones promoted', () => {
    const id = 'e-quoted';
    const grid = (child: object) => ({
      title: { 'en-US': 'Quoted' },
      body: { 'en-US': [{ _type: 'grid', _key: 'g1', items: [{ _key: 'c1', ...child }] }] },
    });
    beforeEach(async () => {
      // The same entry on both sides: qa's copy holds the quote, staging's has moved to a card.
      await createEntry(ctx, qa, {
        contentTypeApiId: 'page',
        id,
        fields: grid({ _type: 'quote', text: 'Hello' }),
      });
      await createEntry(ctx, staging, {
        contentTypeApiId: 'page',
        id,
        fields: grid({ _type: 'card', title: 'Hello' }),
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
    });

    it('lets the catalog go: the copy it would strand is the one the promotion replaces', async () => {
      const p = await requestPromotion(ctx, admin, spaceId, {
        source: 'staging',
        target: 'qa',
        entries: [id],
        blocks: true,
      });
      expect(p.status).toBe('awaiting_approval');
      const done = await approvePromotion(ctx, approver, spaceId, p.id);
      expect(done).toMatchObject({
        status: 'completed',
        result: { entries: [id], blocks: { catalog: true, config: false } },
      });
      expect((await store.blockCatalogs.latest(qa))?.version).toBe(2);
      expect((await store.entries.get(qa, id))?.fields).toEqual(
        grid({ _type: 'card', title: 'Hello' }),
      );
    });

    it('still refuses when the copy arrives as a draft over a published one holding it', async () => {
      await publishEntry(ctx, qa, id);
      const err = await requestPromotion(ctx, admin, spaceId, {
        source: 'staging',
        target: 'qa',
        entries: [id],
        blocks: true,
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).issues).toEqual([
        {
          field: 'blocks',
          message: `The block catalog can't go to qa: it removes what entries there still hold (page.body[grid].items: quote (entry ${id})); change those entries first. Request with blocks: false to promote the rest`,
        },
      ]);
      expect(await store.promotions.list(spaceId)).toEqual([]);
    });
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
      'The block catalog removes blocks or block props from the target\'s content type "page"',
      'The block rules change: grid.slots.items takes card, at most 6 (was: takes card, quote, at most 6)',
    ]);
    const done = await approvePromotion(ctx, approver, spaceId, p.id);
    expect(done.result?.blocks).toEqual({ catalog: true, config: false });
  });

  it('answers a catalog that landed before the config write failed with an error carrying the record', async () => {
    await pushBlockCatalog(ctx, admin, staging, { blocks: [...BLOCKS, BANNER], targets: TARGETS });
    await setBlockConfig(ctx, admin, staging, { expectedVersion: 0, ...NARROWING });
    // The blocks alone, so the catalog push is the first write that lands.
    const p = await requestPromotion(ctx, admin, spaceId, {
      source: 'staging',
      target: 'qa',
      contentTypes: [],
      entries: [],
      blocks: true,
    });
    const save = store.blockConfigs.save.bind(store.blockConfigs);
    store.blockConfigs.save = async () => {
      throw new Error('config write lost');
    };
    const err = await approvePromotion(ctx, approver, spaceId, p.id).catch((e: unknown) => e);
    store.blockConfigs.save = save;
    expect(err).toBeInstanceOf(PromotionFailedError);
    expect((err as PromotionFailedError).promotion).toMatchObject({
      id: p.id,
      status: 'failed',
      error: 'config write lost',
      result: { blocks: { catalog: true, config: false } },
    });
    expect((await store.blockCatalogs.latest(qa))?.version).toBe(2);
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

  it('names a removal from a copied type whose blocks field drifted from the source catalog', async () => {
    // A variant added by hand in staging, after its push: the push into qa takes it back out.
    const page = await store.contentTypes.get(staging, 'page');
    const fields = (page?.fields ?? []).map((f) =>
      f.apiId === 'body' && f.items?.variants
        ? {
            ...f,
            items: {
              ...f.items,
              variants: [
                ...f.items.variants,
                {
                  apiId: 'extra',
                  name: 'Extra',
                  fields: [field({ apiId: 'note', type: 'Symbol' })],
                },
              ],
            },
          }
        : f,
    );
    await updateContentType(ctx, SYSTEM_CALLER, staging, 'page', { fields });
    await publishContentType(ctx, staging, 'page');
    await setBlockConfig(ctx, admin, staging, { expectedVersion: 0, ...NARROWING });
    const p = await requestPromotion(ctx, admin, spaceId, { source: 'staging', target: 'qa' });
    expect(p.contentTypes.map((t) => t.apiId)).toEqual(['page']);
    expect(p.risk.reasons).toContain(
      'The block catalog removes blocks or block props from the copied content type "page"',
    );
  });

  it('refuses at the apply, before writing, a push an entry made since would block', async () => {
    await pushBlockCatalog(ctx, admin, staging, {
      blocks: [
        BLOCKS[0],
        { ...BLOCKS[1], slots: [{ ...BLOCKS[1]?.slots?.[0], allowedChildren: ['card'] }] },
        BLOCKS[2],
      ],
      targets: TARGETS,
      allowDestructive: true,
    });
    const before = await store.contentTypes.get(qa, 'page');
    // The types left out, so the push is what would take the quote out of qa's page.
    const p = await requestPromotion(ctx, admin, spaceId, {
      source: 'staging',
      target: 'qa',
      entries: [],
      blocks: true,
    });
    expect(p.status).toBe('awaiting_approval');
    // While it waits, an entry in qa takes up the quote the push removes.
    await createEntry(ctx, qa, {
      contentTypeApiId: 'page',
      fields: {
        title: { 'en-US': 'Quoted' },
        body: {
          'en-US': [
            { _type: 'grid', _key: 'g1', items: [{ _type: 'quote', _key: 'q1', text: 'Hi' }] },
          ],
        },
      },
    });
    await expect(approvePromotion(ctx, approver, spaceId, p.id)).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect((await store.contentTypes.get(qa, 'page'))?.version).toBe(before?.version);
    expect((await store.blockCatalogs.latest(qa))?.version).toBe(1);
    const failed = await store.promotions.get(spaceId, p.id);
    expect(failed?.status).toBe('failed');
    expect(failed?.result?.blocks).toBeUndefined();
  });

  it('says on the environment.promoted event what blocks landed', async () => {
    await setBlockConfig(ctx, admin, staging, { expectedVersion: 0, ...NARROWING });
    const p = await requestPromotion(ctx, admin, spaceId, {
      source: 'staging',
      target: 'qa',
      entries: [],
      blocks: true,
    });
    await approvePromotion(ctx, approver, spaceId, p.id);
    const events = (await store.outbox.readPending(1000)).filter(
      (e) => e.type === 'environment.promoted',
    );
    expect(events).toMatchObject([{ promotionId: p.id, blocks: { catalog: false, config: true } }]);
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
    // A source config set back to nothing is carried: over a narrowed target it is a change.
    await setBlockConfig(ctx, admin, staging, { expectedVersion: 1, targets: [], blocks: [] });
    expect((await compareEnvironments(ctx, spaceId, 'staging', 'qa')).blocks?.config).toBe(
      'changed',
    );
    const cleared = await requestPromotion(ctx, admin, spaceId, {
      source: 'staging',
      target: 'qa',
      entries: [],
      blocks: true,
    });
    expect(cleared.risk.reasons).toEqual([
      'The block rules change: page.body takes hero, grid (was: takes grid)',
    ]);
    await approvePromotion(ctx, approver, spaceId, cleared.id);
    expect(await store.blockConfigs.get(qa)).toMatchObject({ version: 2, targets: [], blocks: [] });
    expect((await compareEnvironments(ctx, spaceId, 'staging', 'qa')).blocks).toEqual({
      catalog: 'unchanged',
      config: 'unchanged',
    });
  });

  it('says nothing differs once a promotion has copied the blocks', async () => {
    await pushBlockCatalog(ctx, admin, staging, { blocks: BLOCKS, targets: TARGETS });
    await setBlockConfig(ctx, admin, staging, { expectedVersion: 0, ...NARROWING });
    const p = await requestPromotion(ctx, admin, spaceId, { source: 'staging', target: 'qa' });
    await approvePromotion(ctx, approver, spaceId, p.id);
    expect((await compareEnvironments(ctx, spaceId, 'staging', 'qa')).blocks).toEqual({
      catalog: 'unchanged',
      config: 'unchanged',
    });
    await expect(
      requestPromotion(ctx, admin, spaceId, { source: 'staging', target: 'qa' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('copies, and then matches, a narrowing equal to the code today', async () => {
    await pushBlockCatalog(ctx, admin, staging, { blocks: BLOCKS, targets: TARGETS });
    await pushBlockCatalog(ctx, admin, qa, { blocks: BLOCKS, targets: TARGETS });
    // The code allows hero and grid at the top already: no rule moves, but a push adding a block
    // would leave staging's page at these two and qa's open to the new one.
    await setBlockConfig(ctx, admin, staging, {
      expectedVersion: 0,
      targets: [{ contentTypeApiId: 'page', field: 'body', blocks: ['hero', 'grid'] }],
      blocks: [],
    });
    expect((await compareEnvironments(ctx, spaceId, 'staging', 'qa')).blocks?.config).toBe('added');
    const p = await requestPromotion(ctx, admin, spaceId, { source: 'staging', target: 'qa' });
    expect(p).toMatchObject({ status: 'completed', risk: { requiresApproval: false } });
    expect(p.result?.blocks).toEqual({ catalog: false, config: true });
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

describe('judging two configs as a promotion does', () => {
  const wide = checkBlockCatalog({
    blocks: BLOCKS,
    targets: [
      { contentTypeApiId: 'page', field: 'body' },
      { contentTypeApiId: 'page', field: 'aside' },
    ],
  });
  const catalog = {
    version: 1,
    hash: 'h',
    ...wide,
    changes: { added: [], changed: [], removed: [], renamed: [] },
    pushedAt: '2026-11-09T10:00:00.000Z',
    pushedBy: null,
  };
  const config = (over: Partial<BlockConfig>): BlockConfig => ({
    version: 1,
    targets: [],
    blocks: [],
    updatedAt: null,
    updatedBy: null,
    ...over,
  });
  const body = { contentTypeApiId: 'page', field: 'body', blocks: ['grid'] };
  const aside = { contentTypeApiId: 'page', field: 'aside', locked: true };

  it('reads a config stored in another order, or with a former id, as the same', () => {
    expect(
      blockConfigChange(
        catalog,
        config({ targets: [body, aside] }),
        catalog,
        config({ targets: [aside, body], version: 4 }),
      ),
    ).toBe('unchanged');
  });

  it('keeps added and removed for a config on one side only, and empty for neither', () => {
    expect(blockConfigChange(catalog, config({ targets: [body] }), catalog, null)).toBe('added');
    expect(blockConfigChange(catalog, null, catalog, config({ targets: [body] }))).toBe('removed');
    expect(blockConfigChange(catalog, config({}), catalog, null)).toBe('unchanged');
    expect(blockConfigChange(catalog, config({}), catalog, config({ targets: [body] }))).toBe(
      'changed',
    );
  });
});
