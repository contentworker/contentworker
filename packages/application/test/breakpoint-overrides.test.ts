import { createHash } from 'node:crypto';
import {
  type BlockOp,
  canonicalJson,
  type FieldDefinition,
  type Principal,
  ValidationError,
} from '@contentworker/domain';
import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@contentworker/test-kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type AppContext,
  analyzeImport,
  blockCatalogHash,
  cloneEnvironment,
  createContentType,
  createEntry,
  createEnvironment,
  createSpace,
  exportSnapshot,
  getBlockCatalog,
  getContentType,
  getEntry,
  importSnapshot,
  mergeEnvironments,
  patchEntryBlocks,
  publishContentType,
  pushBlockCatalog,
  restoreVersion,
  SYSTEM_CALLER,
  setEntryBlockLocks,
  updateContentType,
  updateEntry,
  validateEntry,
} from '../src/index';

/**
 * Per-breakpoint overrides through the use-cases: the push stores breakpoints with the version and
 * writes them onto its targets, reports the overrides it makes stale without refusing, the next
 * save drops them, and a frozen region refuses an override change a structure lock lets through.
 */

const scope = { spaceId: 'site', environmentId: 'main' };

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
  scopes: ['content:manage', 'content:publish', 'content:read', 'content:lock', 'content:write'],
};

const HERO = {
  id: 'hero',
  name: 'Hero',
  responsive: ['size', 'hidden'],
  fields: [
    { apiId: 'heading', name: 'Heading', type: 'Symbol' },
    { apiId: 'size', name: 'Size', type: 'Symbol', validations: { in: ['sm', 'md', 'xl'] } },
    { apiId: 'hidden', name: 'Hidden', type: 'Boolean' },
  ],
};
const TARGETS = [{ contentTypeApiId: 'page', field: 'body' }];
const BREAKPOINTS = [
  { id: 'md', name: 'Tablet', minWidth: 768 },
  { id: 'lg', name: 'Desktop', minWidth: 1280 },
];

const hero = (key: string, overrides?: Record<string, Record<string, unknown>>) => ({
  _type: 'hero',
  _key: key,
  size: 'md',
  ...(overrides ? { _responsive: overrides } : {}),
});
const body = (...blocks: unknown[]) => ({
  title: { 'en-US': 'Home' },
  body: { 'en-US': blocks },
});

describe('per-breakpoint overrides', () => {
  let ctx: AppContext;

  beforeEach(async () => {
    const store = new InMemoryContentStore();
    ctx = {
      store,
      clock: new FixedClock(new Date('2026-11-10T10:00:00.000Z')),
      ids: new SequenceIdGenerator('b'),
    };
    await createSpace(ctx, {
      spaceId: 'site',
      name: 'Site',
      defaultLocale: 'en-US',
      locales: ['en-US'],
    });
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
    await publishContentType(ctx, scope, 'page');
  });

  const push = (input: Partial<Parameters<typeof pushBlockCatalog>[3]> = {}) =>
    pushBlockCatalog(ctx, developer, scope, {
      blocks: [HERO],
      targets: TARGETS,
      breakpoints: BREAKPOINTS,
      allowDestructive: true,
      ...input,
    });

  it('hashes breakpoints only when there are some, so an older catalog keeps its hash', async () => {
    const plain = await push({ breakpoints: undefined });
    const checked = await getBlockCatalog(ctx, scope);
    expect(plain.hash).toBe(
      createHash('sha256')
        .update(canonicalJson({ blocks: checked.blocks, targets: checked.targets }))
        .digest('hex'),
    );
    expect(checked.breakpoints).toEqual([]);
    const withBreakpoints = await push();
    expect(withBreakpoints.hash).not.toBe(plain.hash);
    expect(withBreakpoints.hash).toBe(
      blockCatalogHash(checked.blocks, checked.targets, BREAKPOINTS),
    );
    expect(withBreakpoints.changes).toEqual({
      added: [],
      changed: [],
      removed: [],
      renamed: [],
      breakpoints: true,
    });
    expect(withBreakpoints.contentTypes).toMatchObject([
      { contentTypeApiId: 'page', fields: [{ field: 'body', breakpoints: true }] },
    ]);
    // The same catalog again changes nothing.
    expect(await push()).toMatchObject({ unchanged: true, applied: false, version: 2 });
  });

  it('stores breakpoints with the version and on the target field', async () => {
    await push();
    expect((await getBlockCatalog(ctx, scope)).breakpoints).toEqual(BREAKPOINTS);
    const page = await getContentType(ctx, scope, 'page');
    expect(page.fields[1]?.items?.breakpoints).toEqual(BREAKPOINTS);
    expect(page.fields[1]?.items?.variants?.[0]?.responsive).toEqual(['size', 'hidden']);
  });

  it('reports the overrides a push strands, by breakpoint and prop, and the next save drops them', async () => {
    await push();
    const { entry } = await createEntry(ctx, scope, {
      contentTypeApiId: 'page',
      fields: body(
        hero('a', { lg: { size: 'xl' }, md: { hidden: true } }),
        hero('b', { lg: { size: 'sm', hidden: false } }),
      ),
    });
    const narrowed = { breakpoints: BREAKPOINTS.slice(0, 1) };
    const dry = await push({ ...narrowed, dryRun: true });
    const expected = [
      {
        contentTypeApiId: 'page',
        block: 'hero',
        breakpoint: 'lg',
        prop: 'size',
        blocks: 2,
        entries: 1,
        complete: true,
      },
      {
        contentTypeApiId: 'page',
        block: 'hero',
        breakpoint: 'lg',
        prop: 'hidden',
        blocks: 1,
        entries: 1,
        complete: true,
      },
    ];
    expect(dry.staleOverrides).toEqual(expected);
    // Reported, not refused.
    const done = await push(narrowed);
    expect(done).toMatchObject({ applied: true, staleOverrides: expected });
    // Served as stored until the entry's next save, which drops them.
    const stored = await getEntry(ctx, scope, entry.id);
    expect(stored.fields.body?.['en-US']?.[1]).toMatchObject({ _responsive: { lg: {} } });
    const saved = await updateEntry(ctx, scope, entry.id, stored.fields);
    expect(saved.fields.body?.['en-US']).toEqual([hero('a', { md: { hidden: true } }), hero('b')]);
    // A push that narrows nothing counts nothing.
    expect((await push({ ...narrowed, dryRun: true })).staleOverrides).toEqual([]);
  });

  it('refuses an override change in a frozen region, and lets one through a structure lock', async () => {
    await push();
    const { entry } = await createEntry(ctx, scope, {
      contentTypeApiId: 'page',
      fields: body(hero('a', { lg: { size: 'xl' } }), hero('b')),
    });
    const lock = (freeze: 'all' | 'structure') =>
      setEntryBlockLocks(ctx, developer, scope, entry.id, {
        locks: [{ field: 'body', keys: ['a'], depth: 'subtree', freeze }],
      });
    await lock('all');
    const edit = body(hero('a', { lg: { size: 'sm' } }), hero('b'));
    const err = await updateEntry(ctx, scope, entry.id, edit).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).issues).toMatchObject([{ code: 'region_frozen', key: 'a' }]);
    await lock('structure');
    const saved = await updateEntry(ctx, scope, entry.id, edit);
    expect(saved.fields.body?.['en-US']?.[0]).toEqual(hero('a', { lg: { size: 'sm' } }));
  });

  it('carries overrides with the block through a snapshot, a clone and a version restore', async () => {
    await push();
    const { entry } = await createEntry(ctx, scope, {
      contentTypeApiId: 'page',
      fields: body(hero('a', { lg: { size: 'xl' } })),
    });
    const held = [hero('a', { lg: { size: 'xl' } })];
    for (const env of ['copy', 'clone']) await createEnvironment(ctx, 'site', env);
    const copy = { ...scope, environmentId: 'copy' };
    const snapshot = await exportSnapshot(ctx, SYSTEM_CALLER, scope);
    expect(snapshot.blockCatalog?.breakpoints).toEqual(BREAKPOINTS);
    await importSnapshot(ctx, SYSTEM_CALLER, copy, JSON.parse(JSON.stringify(snapshot)));
    expect((await getBlockCatalog(ctx, copy)).breakpoints).toEqual(BREAKPOINTS);
    expect((await getEntry(ctx, copy, entry.id)).fields.body?.['en-US']).toEqual(held);
    const clone = { ...scope, environmentId: 'clone' };
    await cloneEnvironment(ctx, SYSTEM_CALLER, scope, clone);
    expect((await getBlockCatalog(ctx, clone)).breakpoints).toEqual(BREAKPOINTS);
    expect((await getEntry(ctx, clone, entry.id)).fields.body?.['en-US']).toEqual(held);

    await updateEntry(ctx, scope, entry.id, body(hero('a')));
    const restored = await restoreVersion(ctx, scope, entry.id, 1);
    expect(restored.fields.body?.['en-US']).toEqual(held);
  });

  it('refuses an undeclared override in a new edit, and saves one the block already carried', async () => {
    await push();
    const refused = async (p: Promise<unknown>) => {
      const err = await p.then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(ValidationError);
      return (err as ValidationError).issues;
    };
    // A typo'd breakpoint, and a prop that isn't responsive, on a create.
    expect(
      await refused(
        createEntry(ctx, scope, {
          contentTypeApiId: 'page',
          fields: body(hero('a', { xl: { size: 'xl' }, lg: { heading: 'x', size: 'sm' } })),
        }),
      ),
    ).toMatchObject([
      { field: 'body[0]._responsive.xl', code: 'override_undeclared', key: 'a' },
      { field: 'body[0]._responsive.lg', code: 'override_undeclared', key: 'a' },
    ]);
    // A new override of a declared breakpoint and prop passes.
    const { entry } = await createEntry(ctx, scope, {
      contentTypeApiId: 'page',
      fields: body(hero('a', { lg: { size: 'xl' } }), hero('b')),
    });

    // The push removes lg: the stored override is stale. A new prop at lg is still a typo.
    await push({ breakpoints: BREAKPOINTS.slice(0, 1) });
    const typo = await refused(
      updateEntry(
        ctx,
        scope,
        entry.id,
        body(hero('a', { lg: { size: 'xl' } }), hero('b', { lg: { hidden: true } })),
      ),
    );
    expect(typo).toMatchObject([
      { field: 'body[1]._responsive.lg', code: 'override_undeclared', key: 'b' },
    ]);
    // Carried over by the next edit, it saves and is dropped.
    const stored = await getEntry(ctx, scope, entry.id);
    const saved = await updateEntry(ctx, scope, entry.id, {
      ...stored.fields,
      title: { 'en-US': 'Edited' },
    });
    expect(saved.fields.body?.['en-US']).toEqual([hero('a'), hero('b')]);

    // In a block patch too.
    const current = await getEntry(ctx, scope, entry.id);
    const patch = await refused(
      patchEntryBlocks(ctx, scope, entry.id, {
        expectedVersion: current.entry.currentVersion,
        ops: [
          {
            op: 'update',
            field: 'body',
            locale: 'en-US',
            key: 'b',
            set: { _responsive: { md: { size: 'sm' }, xl: { size: 'sm' } } },
          },
        ],
      }),
    );
    expect(patch).toMatchObject([{ field: 'body[1]._responsive.xl', code: 'override_undeclared' }]);
    const declared = await patchEntryBlocks(ctx, scope, entry.id, {
      expectedVersion: current.entry.currentVersion,
      ops: [
        {
          op: 'update',
          field: 'body',
          locale: 'en-US',
          key: 'b',
          set: { _responsive: { md: { size: 'sm' } } },
        },
      ],
    });
    expect(declared.fields.body?.['en-US']?.[1]).toEqual(hero('b', { md: { size: 'sm' } }));
  });

  it('saves an undo that spans a save, its stale overrides carried by the version before', async () => {
    await push();
    const { entry } = await createEntry(ctx, scope, {
      contentTypeApiId: 'page',
      fields: body(hero('a', { lg: { size: 'xl' } }), hero('b')),
    });
    // The canvas removes the block and saves (v2), a push makes lg stale, then the canvas's undo
    // puts the block back as it was and saves again.
    await updateEntry(ctx, scope, entry.id, body(hero('b')));
    await push({ breakpoints: BREAKPOINTS.slice(0, 1) });
    const saved = await updateEntry(
      ctx,
      scope,
      entry.id,
      body(hero('a', { lg: { size: 'xl' } }), hero('b')),
    );
    expect(saved.fields.body?.['en-US']).toEqual([hero('a'), hero('b')]);
    expect(saved.entry.currentVersion).toBe(3);

    // Only the version just before counts: two saves back is a new edit again, and refused.
    await updateEntry(ctx, scope, entry.id, body(hero('b')));
    await updateEntry(ctx, scope, entry.id, body(hero('b'), hero('c')));
    const err = await updateEntry(
      ctx,
      scope,
      entry.id,
      body(hero('a', { lg: { size: 'xl' } }), hero('b')),
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).issues).toMatchObject([
      { field: 'body[0]._responsive.lg', code: 'override_undeclared', key: 'a' },
    ]);
  });

  it('reads the version before only when the override check would refuse', async () => {
    await push();
    const { entry } = await createEntry(ctx, scope, {
      contentTypeApiId: 'page',
      fields: body(hero('a', { lg: { size: 'xl' } }), hero('b')),
    });
    const reads = vi.spyOn(ctx.store.entries, 'getVersion');
    // Declared overrides, and stale ones the stored version holds: nothing refused, nothing read.
    await updateEntry(ctx, scope, entry.id, body(hero('a', { md: { size: 'sm' } }), hero('b')));
    await push({ breakpoints: BREAKPOINTS.slice(0, 1) });
    await updateEntry(ctx, scope, entry.id, {
      ...body(hero('a', { md: { size: 'sm' } }), hero('b')),
      title: { 'en-US': 'Edited' },
    });
    expect(reads).not.toHaveBeenCalled();
    // One the stored version lacks: read once.
    await updateEntry(ctx, scope, entry.id, body(hero('a', { lg: { size: 'xl' } }))).catch(
      () => null,
    );
    expect(reads).toHaveBeenCalledTimes(1);
  });

  it('judges a dry run of an undo that spans a save as the save does', async () => {
    await push();
    const { entry } = await createEntry(ctx, scope, {
      contentTypeApiId: 'page',
      fields: body(hero('a', { lg: { size: 'xl' } }), hero('b')),
    });
    await updateEntry(ctx, scope, entry.id, body(hero('b')));
    await push({ breakpoints: BREAKPOINTS.slice(0, 1) });
    const undo = body(hero('a', { lg: { size: 'xl' } }), hero('b'));
    const dry = await validateEntry(ctx, scope, { entryId: entry.id, fields: undo });
    expect(dry).toMatchObject({ valid: true });
    expect(dry.fields.body?.['en-US']).toEqual([hero('a'), hero('b')]);
    // Nothing was written.
    expect((await getEntry(ctx, scope, entry.id)).entry.currentVersion).toBe(2);
    // A new edit's typo is still refused in the dry run.
    await expect(
      validateEntry(ctx, scope, {
        entryId: entry.id,
        fields: body(hero('a'), hero('b', { xl: { size: 'sm' } })),
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('refuses a new non-map value at an undeclared breakpoint or `base`, never dropping it unsaid', async () => {
    await push();
    const err = await createEntry(ctx, scope, {
      contentTypeApiId: 'page',
      fields: body(hero('a', { xl: 'lg', base: 'lg' } as never)),
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).issues).toMatchObject([
      { field: 'body[0]._responsive.xl', code: 'override_undeclared', key: 'a' },
      { field: 'body[0]._responsive.base', code: 'override_undeclared', key: 'a' },
    ]);
  });

  it('takes no new override on a field without breakpoints, but carries a stored one over', async () => {
    await push({ breakpoints: undefined });
    const issues = await createEntry(ctx, scope, {
      contentTypeApiId: 'page',
      fields: body(hero('a', { lg: { size: 'xl' } })),
    }).then(
      () => [],
      (e: ValidationError) => e.issues,
    );
    expect(issues).toMatchObject([
      { field: 'body[0]._responsive.lg', code: 'override_undeclared', key: 'a' },
    ]);
    // Stored while the field had breakpoints, then carried over by an edit once it has none.
    await push();
    const { entry } = await createEntry(ctx, scope, {
      contentTypeApiId: 'page',
      fields: body(hero('a', { lg: { size: 'xl' } })),
    });
    await push({ breakpoints: undefined });
    const saved = await updateEntry(ctx, scope, entry.id, body(hero('a', { lg: { size: 'xl' } })));
    expect(saved.fields.body?.['en-US']).toEqual([hero('a')]);
  });
  it('warns, as a push reports, when a type edit makes overrides stale', async () => {
    await push();
    await createEntry(ctx, scope, {
      contentTypeApiId: 'page',
      fields: body(hero('a', { lg: { size: 'xl' } })),
    });
    const page = await getContentType(ctx, scope, 'page');
    const saved = await updateContentType(ctx, SYSTEM_CALLER, scope, 'page', {
      fields: page.fields.map((f) =>
        f.apiId === 'body' && f.items
          ? { ...f, items: { ...f.items, breakpoints: BREAKPOINTS.slice(0, 1) } }
          : f,
      ),
    });
    expect(saved.warnings).toEqual([
      {
        field: 'hero._responsive.lg.size',
        entries: 1,
        message: expect.stringContaining('1 block overrides hero.size at lg'),
      },
    ]);
  });

  it('reports an undeclared override in an import’s analysis, as the save would refuse it', async () => {
    await push();
    const source = {
      id: 'fake',
      name: 'Fake',
      async read() {
        return {
          records: [
            {
              externalId: 'ok',
              values: { name: 'Fine', body: [hero('a', { lg: { size: 'xl' } })] },
            },
            {
              externalId: 'typo',
              values: { name: 'Typo', body: [hero('b', { xl: { size: 'xl' } })] },
            },
          ],
          fields: ['name', 'body'],
          warnings: [],
        };
      },
    };
    const analysis = await analyzeImport(ctx, developer, scope, source, {
      payload: '',
      mapping: { contentTypeApiId: 'page', fields: { title: 'name', body: 'body' } },
    });
    expect(analysis.issues).toEqual([
      { externalId: 'typo', messages: [expect.stringContaining('body[0]._responsive.xl')] },
    ]);
  });

  it('stores a merged entry without the overrides the target’s type doesn’t take', async () => {
    await push();
    await createEnvironment(ctx, 'site', 'staging');
    const staging = { ...scope, environmentId: 'staging' };
    await cloneEnvironment(ctx, SYSTEM_CALLER, scope, staging);
    // Main drops lg and narrows size; staging keeps both.
    await push({
      breakpoints: BREAKPOINTS.slice(0, 1),
      blocks: [
        {
          ...HERO,
          fields: HERO.fields.map((f) =>
            f.apiId === 'size' ? { ...f, validations: { in: ['sm', 'md'] } } : f,
          ),
        },
      ],
    });
    const { entry } = await createEntry(ctx, staging, {
      contentTypeApiId: 'page',
      fields: body(hero('a', { lg: { size: 'xl' }, md: { size: 'xl', hidden: true } })),
    });
    await mergeEnvironments(ctx, SYSTEM_CALLER, 'site', 'staging', 'main', { entries: [entry.id] });
    const merged = await getEntry(ctx, scope, entry.id);
    expect(merged.fields.body?.['en-US']).toEqual([hero('a', { md: { hidden: true } })]);
  });
});

describe('a stale override carried elsewhere in the entry', () => {
  let ctx: AppContext;
  const two = { spaceId: 'two', environmentId: 'main' };

  beforeEach(async () => {
    ctx = {
      store: new InMemoryContentStore(),
      clock: new FixedClock(new Date('2026-11-10T10:00:00.000Z')),
      ids: new SequenceIdGenerator('c'),
    };
    await createSpace(ctx, {
      spaceId: 'two',
      name: 'Two',
      defaultLocale: 'en-US',
      locales: ['en-US', 'de-DE'],
    });
    const blocksField = (apiId: string, position: number) =>
      field({
        apiId,
        type: 'Array',
        position,
        localized: true,
        items: {
          type: 'Component',
          variants: [
            { apiId: 'hero', name: 'Hero', fields: [field({ apiId: 'x', type: 'Symbol' })] },
          ],
        },
      });
    await createContentType(ctx, SYSTEM_CALLER, two, {
      apiId: 'page',
      name: 'Page',
      displayField: 'title',
      fields: [
        field({ apiId: 'title', type: 'Symbol' }),
        blocksField('body', 1),
        blocksField('aside', 2),
      ],
    });
    await publishContentType(ctx, two, 'page');
  });

  const pushTo = (breakpoints: typeof BREAKPOINTS) =>
    pushBlockCatalog(ctx, SYSTEM_CALLER, two, {
      blocks: [HERO],
      targets: [
        { contentTypeApiId: 'page', field: 'body' },
        { contentTypeApiId: 'page', field: 'aside' },
      ],
      breakpoints,
      allowDestructive: true,
    });

  /** An entry whose hero `a` holds an lg override, then a push that drops lg: it is stale. */
  async function staleEntry() {
    await pushTo(BREAKPOINTS);
    const { entry } = await createEntry(ctx, two, {
      contentTypeApiId: 'page',
      fields: {
        title: { 'en-US': 'Home' },
        body: { 'en-US': [hero('a', { lg: { size: 'xl' } })] },
      },
    });
    await pushTo(BREAKPOINTS.slice(0, 1));
    return entry.id;
  }
  const op = { field: 'body', locale: 'en-US' } as const;
  const patch = async (id: string, ops: BlockOp[]) =>
    patchEntryBlocks(ctx, two, id, {
      expectedVersion: (await getEntry(ctx, two, id)).entry.currentVersion,
      ops,
    });

  it('saves a duplicate of the block, dropping it from both', async () => {
    const id = await staleEntry();
    const done = await patch(id, [{ op: 'duplicate', ...op, key: 'a' }]);
    expect(done.fields.body?.['en-US']).toEqual([
      hero('a'),
      expect.objectContaining({ size: 'md' }),
    ]);
    expect(done.fields.body?.['en-US']?.[1]).not.toHaveProperty('_responsive');
  });

  it('saves the undo of a remove in the same patch, which re-inserts the block as it was', async () => {
    const id = await staleEntry();
    const before = await getEntry(ctx, two, id);
    // The canvas's undo: the block as stored, its stale override included, put back.
    const undo = await patch(id, [
      { op: 'remove', ...op, key: 'a' },
      { op: 'insert', ...op, index: 0, block: before.fields.body?.['en-US']?.[0] as never },
    ]);
    expect(undo.fields.body?.['en-US']).toEqual([hero('a')]);
  });

  it('saves a move to another blocks field', async () => {
    const id = await staleEntry();
    const stored = await getEntry(ctx, two, id);
    const block = stored.fields.body?.['en-US']?.[0];
    const moved = await updateEntry(ctx, two, id, {
      ...stored.fields,
      body: { 'en-US': [] },
      aside: { 'en-US': [block] },
    });
    expect(moved.fields.aside?.['en-US']).toEqual([hero('a')]);
  });

  it('saves a copy of the block into another locale', async () => {
    const id = await staleEntry();
    const stored = await getEntry(ctx, two, id);
    const copied = await updateEntry(ctx, two, id, {
      ...stored.fields,
      body: { ...stored.fields.body, 'de-DE': stored.fields.body?.['en-US'] ?? [] },
    });
    expect(copied.fields.body?.['de-DE']).toEqual([hero('a')]);
  });
});
