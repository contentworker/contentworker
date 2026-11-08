import {
  type BlockConfigIssue,
  ConflictError,
  type EntryFields,
  type FieldDefinition,
  type Principal,
  ValidationError,
} from '@contentworker/domain';
import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@contentworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  checkEntryBlocks,
  createContentType,
  createEntry,
  createSpace,
  getBlockConfig,
  getEffectiveBlockRules,
  patchEntryBlocks,
  publishContentType,
  pushBlockCatalog,
  SYSTEM_CALLER,
  setBlockConfig,
  updateEntry,
  validateEntry,
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

const admin: Principal = {
  spaceId: 'site',
  kind: 'user',
  subject: 'admin@example.com',
  scopes: ['content:manage', 'content:publish', 'content:read'],
};

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

/** The top of a page takes only grids, a grid only cards and three of them at most. */
const NARROWING = {
  targets: [{ contentTypeApiId: 'page', field: 'body', blocks: ['grid'] }],
  blocks: [{ block: 'grid', slots: { items: { allowedChildren: ['card'], max: 3 } } }],
};

const refusal = async (p: Promise<unknown>): Promise<BlockConfigIssue[]> => {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  if (!(err instanceof ValidationError)) throw new Error(`expected a refusal, got ${String(err)}`);
  return err.issues as BlockConfigIssue[];
};
const conflict = async (p: Promise<unknown>): Promise<ConflictError> => {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  if (!(err instanceof ConflictError)) throw new Error(`expected a conflict, got ${String(err)}`);
  return err;
};

describe('the block config', () => {
  let ctx: AppContext;
  let store: InMemoryContentStore;

  beforeEach(async () => {
    store = new InMemoryContentStore();
    ctx = {
      store,
      clock: new FixedClock(new Date('2026-11-08T10:00:00.000Z')),
      ids: new SequenceIdGenerator('k'),
    };
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
                  apiId: 'hero',
                  name: 'Hero',
                  fields: [field({ apiId: 'heading', type: 'Symbol' })],
                },
              ],
            },
          }),
        ],
      });
      await publishContentType(ctx, s, 'page');
      await createContentType(ctx, SYSTEM_CALLER, s, {
        apiId: 'note',
        name: 'Note',
        displayField: 'title',
        fields: [field({ apiId: 'title', type: 'Symbol' })],
      });
      await publishContentType(ctx, s, 'note');
      await pushBlockCatalog(ctx, admin, s, {
        blocks: BLOCKS,
        targets: [{ contentTypeApiId: 'page', field: 'body' }],
      });
    }
  });

  const set = (input: Partial<Parameters<typeof setBlockConfig>[3]> = {}, s = scope) =>
    setBlockConfig(ctx, admin, s, { expectedVersion: 0, ...NARROWING, ...input });

  const blocksOf = (fields: EntryFields) =>
    (fields.body?.['en-US'] ?? []) as Record<string, unknown>[];

  const body = (blocks: Record<string, unknown>[]): EntryFields => ({
    title: { 'en-US': 'Home' },
    body: { 'en-US': blocks },
  });

  it('reads as version 0, empty, before the first set', async () => {
    expect(await getBlockConfig(ctx, scope)).toEqual({
      version: 0,
      targets: [],
      blocks: [],
      updatedAt: null,
      updatedBy: null,
    });
  });

  it('sets a new version at the expected one, naming who set it, in its own environment only', async () => {
    const { config, unchanged } = await set();
    expect(unchanged).toBe(false);
    expect(config).toEqual({
      version: 1,
      ...NARROWING,
      updatedAt: '2026-11-08T10:00:00.000Z',
      updatedBy: 'admin@example.com',
    });
    expect(await getBlockConfig(ctx, scope)).toEqual(config);
    expect((await getBlockConfig(ctx, staging)).version).toBe(0);
    const second = await set({ expectedVersion: 1, targets: [] });
    expect(second.config.version).toBe(2);
    expect(second.config.targets).toEqual([]);
  });

  it('refuses a stale expectedVersion, and treats a retry of the config in force as a no-op', async () => {
    await set();
    const err = await conflict(set({ expectedVersion: 0, targets: [] }));
    expect(err.message).toMatch(/at version 1, not 0/);
    expect(err.details).toEqual({ version: 1 });
    // The first try landed; the retry expects 0 again and changes nothing.
    const retry = await set();
    expect(retry).toMatchObject({ unchanged: true, config: { version: 1 } });
  });

  it('turns a set that loses the race to another at commit into a conflict', async () => {
    const get = store.blockConfigs.get.bind(store.blockConfigs);
    let raced = false;
    store.blockConfigs.get = async (s) => {
      const read = await get(s);
      if (!raced) {
        raced = true;
        await store.blockConfigs.save(s, {
          version: 1,
          targets: [],
          blocks: [],
          updatedAt: '2026-11-08T09:59:00.000Z',
          updatedBy: 'someone',
        });
      }
      return read;
    };
    const err = await conflict(set());
    expect(err.message).toMatch(/changed while it was being set/);
    store.blockConfigs.get = get;
    expect((await getBlockConfig(ctx, scope)).updatedBy).toBe('someone');
  });

  it('refuses a config that widens what the code allows, writing nothing', async () => {
    const issues = await refusal(
      set({ blocks: [{ block: 'grid', slots: { items: { allowedChildren: ['hero'], max: 9 } } }] }),
    );
    expect(issues.map((i) => i.field)).toEqual([
      'blocks[grid].slots.items.allowedChildren',
      'blocks[grid].slots.items.max',
    ]);
    expect((await getBlockConfig(ctx, scope)).version).toBe(0);
  });

  it('answers the rules in force, narrowed', async () => {
    await set();
    const rules = await getEffectiveBlockRules(ctx, scope);
    expect(rules).toMatchObject({
      catalogVersion: 1,
      configVersion: 1,
      targets: [{ contentTypeApiId: 'page', field: 'body', blocks: ['grid'], narrowed: true }],
      blocks: [{ block: 'grid', slots: { items: { allowedChildren: ['card'], max: 3 } } }],
      stale: [],
    });
  });

  it('refuses a save that places a block where the config does not take it, and allows one that fits', async () => {
    await set();
    const issues = await refusal(
      createEntry(ctx, scope, {
        contentTypeApiId: 'page',
        fields: body([{ _type: 'hero', heading: 'Hi' }]),
      }),
    );
    expect(issues).toMatchObject([
      { field: 'body[0]', locale: 'en-US', code: 'block_not_allowed_here' },
    ]);
    const made = await createEntry(ctx, scope, {
      contentTypeApiId: 'page',
      fields: body([{ _type: 'grid', items: [{ _type: 'card', title: 'One' }] }]),
    });
    const grid = blocksOf(made.fields)[0] as Record<string, unknown>;
    const items = grid.items as Record<string, unknown>[];
    // A quote is code-allowed in a grid, but not by the config.
    const withQuote = body([{ ...grid, items: [...items, { _type: 'quote', text: 'Q' }] }]);
    expect(await refusal(updateEntry(ctx, scope, made.entry.id, withQuote))).toMatchObject([
      { field: 'body[0].items[1]', code: 'block_not_allowed_here' },
    ]);
    expect(
      await refusal(validateEntry(ctx, scope, { entryId: made.entry.id, fields: withQuote })),
    ).toHaveLength(1);
    const withCard = body([{ ...grid, items: [...items, { _type: 'card', title: 'Two' }] }]);
    await expect(updateEntry(ctx, scope, made.entry.id, withCard)).resolves.toBeDefined();
  });

  it('keeps content stored before the config saveable while its slots are left alone', async () => {
    const made = await createEntry(ctx, scope, {
      contentTypeApiId: 'page',
      fields: body([{ _type: 'hero', heading: 'Hi' }]),
    });
    await set();
    const [hero] = blocksOf(made.fields);
    const edited = await updateEntry(
      ctx,
      scope,
      made.entry.id,
      body([{ ...hero, heading: 'Edited' }]),
    );
    expect(edited.entry.currentVersion).toBe(2);
  });

  it('does not judge a copy: an import carries what its source held', async () => {
    await set();
    await expect(
      createEntry(
        ctx,
        scope,
        { contentTypeApiId: 'page', fields: body([{ _type: 'hero', heading: 'Hi' }]) },
        { copy: true },
      ),
    ).resolves.toBeDefined();
  });

  it('refuses a block patch the config does not allow, naming the block, as a save would', async () => {
    const made = await createEntry(ctx, scope, {
      contentTypeApiId: 'page',
      fields: body([{ _type: 'grid', items: [{ _type: 'card', title: 'One' }] }]),
    });
    await set();
    const grid = blocksOf(made.fields)[0] as Record<string, unknown>;
    const input = {
      expectedVersion: made.entry.currentVersion,
      ops: [
        {
          op: 'insert' as const,
          field: 'body',
          parent: { key: grid._key as string, slot: 'items' },
          block: { _type: 'quote', _key: 'q1', text: 'Q' },
        },
      ],
    };
    const issues = await refusal(patchEntryBlocks(ctx, scope, made.entry.id, input));
    expect(issues).toMatchObject([
      {
        field: 'body[0].items[1]',
        code: 'block_not_allowed_here',
        key: 'q1',
        block: { key: 'q1', type: 'quote', path: '' },
      },
    ]);
    expect(await refusal(checkEntryBlocks(ctx, scope, made.entry.id, input))).toHaveLength(1);
  });

  it('reads nothing for a type with no blocks field, and only the config when none is set', async () => {
    let reads = 0;
    const get = store.blockConfigs.get.bind(store.blockConfigs);
    store.blockConfigs.get = async (s) => {
      reads += 1;
      return get(s);
    };
    await createEntry(ctx, scope, {
      contentTypeApiId: 'note',
      fields: { title: { 'en-US': 'n' } },
    });
    expect(reads).toBe(0);
    await createEntry(ctx, scope, { contentTypeApiId: 'page', fields: body([]) });
    expect(reads).toBe(1);
  });
});
