import {
  type BlockConfigIssue,
  ConflictError,
  type EntryFields,
  type FieldDefinition,
  type Principal,
  SCOPES,
  ValidationError,
} from '@contentworker/domain';
import type { ImportSource } from '@contentworker/ports';
import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@contentworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  checkEntryBlocks,
  createChangeLog,
  createContentType,
  createEntry,
  createSpace,
  entryFieldsChunkRunner,
  executeImport,
  getBlockConfig,
  getEffectiveBlockRules,
  patchEntryBlocks,
  publishContentType,
  pushBlockCatalog,
  SYSTEM_CALLER,
  setBlockConfig,
  setEntrySeo,
  startSetFieldsJob,
  updateEntry,
  updateImportedEntry,
  validateEntry,
  withChanges,
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
          field({ apiId: 'seo', type: 'Seo', position: 2 }),
          field({ apiId: 'note', type: 'Symbol', position: 3 }),
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

  it('does not judge a copy of data the environment held, but judges an import', async () => {
    await set();
    const fields = body([{ _type: 'hero', heading: 'Hi' }]);
    // A duplicate, a restore, a clone: data the space already held.
    await expect(
      createEntry(ctx, scope, { contentTypeApiId: 'page', fields }, { copy: true }),
    ).resolves.toBeDefined();
    // An import is new content from the caller.
    expect(
      await refusal(
        createEntry(
          ctx,
          scope,
          { contentTypeApiId: 'page', fields },
          { copy: true, imported: true },
        ),
      ),
    ).toMatchObject([{ code: 'block_not_allowed_here' }]);
  });

  describe('imports', () => {
    const source = (values: Record<string, unknown>[]): ImportSource => ({
      id: 'fake',
      name: 'Fake',
      async read() {
        return {
          records: values.map((v, i) => ({ externalId: `r${i + 1}`, values: v })),
          fields: ['name', 'blocks'],
          warnings: [],
        };
      },
    });
    const mapping = {
      payload: '',
      mapping: {
        contentTypeApiId: 'page',
        fields: { title: 'name', body: 'blocks' },
        identityField: 'title',
      },
    };
    const importer: Principal = { spaceId: '*', kind: 'admin', scopes: Object.values(SCOPES) };

    it('reports a record that creates an entry with a forbidden block, and writes nothing', async () => {
      await set();
      const run = await executeImport(
        ctx,
        importer,
        scope,
        source([{ name: 'New', blocks: [{ _type: 'hero', heading: 'Hi' }] }]),
        mapping,
      );
      expect(run).toMatchObject({ created: 0, skipped: 1, analysis: { invalid: 1 } });
      expect(run.analysis.issues[0]?.messages[0]).toMatch(/^body\[0\]: "Hero" can't go here/);
    });

    it('reports a record that changes a locked slot, and an update that leaves it saves', async () => {
      const made = await createEntry(ctx, scope, {
        contentTypeApiId: 'page',
        fields: body([{ _type: 'grid', items: [{ _type: 'card', title: 'One' }] }]),
      });
      await set({
        targets: [{ contentTypeApiId: 'page', field: 'body', locked: true }],
        blocks: [],
      });
      const [grid] = blocksOf(made.fields);
      const extra = { _type: 'grid', items: [{ _type: 'card', title: 'Two' }] };
      const locked = await executeImport(
        ctx,
        importer,
        scope,
        source([{ name: 'Home', blocks: [grid, extra] }]),
        mapping,
        { conflicts: 'update' },
      );
      expect(locked).toMatchObject({ updated: 0, skipped: 1, analysis: { invalid: 1 } });
      expect(locked.analysis.issues[0]?.messages[0]).toMatch(/^body: This slot is locked/);
      // The run's own save refuses it too, should the config change after planning.
      expect(
        await refusal(updateImportedEntry(ctx, scope, made.entry.id, body([grid, extra]), [])),
      ).toMatchObject([{ code: 'slot_locked' }]);
      const kept = await executeImport(
        ctx,
        importer,
        scope,
        source([{ name: 'Home', blocks: [grid] }]),
        mapping,
        { conflicts: 'update' },
      );
      expect(kept).toMatchObject({ updated: 1, failed: [] });
    });
  });

  it('lets SEO and bulk field saves through on an entry holding what the config now forbids', async () => {
    const made = await createEntry(ctx, scope, {
      contentTypeApiId: 'page',
      fields: body([{ _type: 'hero', heading: 'Hi' }]),
    });
    await set();
    const seo = await setEntrySeo(ctx, scope, made.entry.id, { title: 'Home page' });
    expect(seo.entry.currentVersion).toBe(2);
    const job = await startSetFieldsJob(ctx, scope, {
      contentTypeApiId: 'page',
      entryIds: [made.entry.id],
      fields: { note: { 'en-US': 'bulk' } },
    });
    const [chunk] = await store.bulkJobs.listChunks(scope, job.id);
    const stored = await store.bulkJobs.getJob(scope, job.id);
    if (!chunk || !stored) throw new Error('no job');
    expect(await entryFieldsChunkRunner(ctx)(scope, stored, chunk)).toEqual({
      succeeded: 1,
      failures: [],
    });
    expect((await store.entries.get(scope, made.entry.id))?.entry.currentVersion).toBe(3);
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

  it('reads nothing for a type with no blocks field, and the config with its catalog once', async () => {
    let reads = 0;
    const inForce = store.blockConfigs.inForce.bind(store.blockConfigs);
    store.blockConfigs.inForce = async (s) => {
      reads += 1;
      return inForce(s);
    };
    await createEntry(ctx, scope, {
      contentTypeApiId: 'note',
      fields: { title: { 'en-US': 'n' } },
    });
    expect(reads).toBe(0);
    await createEntry(ctx, scope, { contentTypeApiId: 'page', fields: body([]) });
    expect(reads).toBe(1);
  });

  it('notes what a set changed for the audit row, and nothing for a set that changes nothing', async () => {
    const changes = createChangeLog();
    const noting = withChanges(ctx, changes);
    await setBlockConfig(noting, admin, scope, {
      expectedVersion: 0,
      targets: [{ contentTypeApiId: 'page', field: 'body', locked: true }],
      blocks: NARROWING.blocks,
    });
    expect(changes.detail()).toEqual({
      entries: [],
      blockConfig: {
        from: 0,
        to: 1,
        added: ['targets[page.body]', 'blocks[grid].slots.items'],
        removed: [],
        loosened: [],
        unlocked: [],
      },
    });
    changes.clear();
    await setBlockConfig(noting, admin, scope, {
      expectedVersion: 1,
      targets: [],
      blocks: NARROWING.blocks,
    });
    expect(changes.detail()?.blockConfig).toMatchObject({
      from: 1,
      to: 2,
      removed: ['targets[page.body]'],
      unlocked: ['targets[page.body]'],
    });
    changes.clear();
    await setBlockConfig(noting, admin, scope, {
      expectedVersion: 2,
      targets: [],
      blocks: NARROWING.blocks,
    });
    expect(changes.detail()).toBeUndefined();
  });
});
