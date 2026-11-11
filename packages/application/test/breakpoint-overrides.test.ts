import { createHash } from 'node:crypto';
import {
  canonicalJson,
  type FieldDefinition,
  type Principal,
  ValidationError,
} from '@contentworker/domain';
import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@contentworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
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
  patchEntryBlocks,
  publishContentType,
  pushBlockCatalog,
  restoreVersion,
  SYSTEM_CALLER,
  setEntryBlockLocks,
  updateEntry,
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
  scopes: ['content:manage', 'content:publish', 'content:read', 'content:lock'],
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
    const snapshot = await exportSnapshot(ctx, scope);
    expect(snapshot.blockCatalog?.breakpoints).toEqual(BREAKPOINTS);
    await importSnapshot(ctx, copy, JSON.parse(JSON.stringify(snapshot)));
    expect((await getBlockCatalog(ctx, copy)).breakpoints).toEqual(BREAKPOINTS);
    expect((await getEntry(ctx, copy, entry.id)).fields.body?.['en-US']).toEqual(held);
    const clone = { ...scope, environmentId: 'clone' };
    await cloneEnvironment(ctx, scope, clone);
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

    // The push removes lg: the stored override is stale. Stale only for the block that carried it:
    // the same override, new on another block, is a typo.
    await push({ breakpoints: BREAKPOINTS.slice(0, 1) });
    const typo = await refused(
      updateEntry(
        ctx,
        scope,
        entry.id,
        body(hero('a', { lg: { size: 'xl' } }), hero('b', { lg: { size: 'sm' } })),
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
});
