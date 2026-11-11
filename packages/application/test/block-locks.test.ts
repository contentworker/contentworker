import {
  type BlockConfigIssue,
  ConflictError,
  type EntryFields,
  type FieldDefinition,
  ForbiddenError,
  type Principal,
  SCOPES,
  ValidationError,
} from '@contentworker/domain';
import type { ImportSource } from '@contentworker/ports';
import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@contentworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  cloneEnvironment,
  createChangeLog,
  createContentType,
  createEntry,
  createSpace,
  duplicateEntry,
  executeImport,
  getEntryBlockLocks,
  patchEntryBlocks,
  publishContentType,
  restoreVersion,
  SYSTEM_CALLER,
  saveEntryDraft,
  setEntryBlockLocks,
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

const symbol = (apiId: string) => field({ apiId, type: 'Symbol' });

/** A page whose body takes heroes and grids, a grid's items cards: no block catalog or config. */
const PAGE_FIELDS = [
  symbol('title'),
  field({
    apiId: 'body',
    type: 'Array',
    position: 1,
    items: {
      type: 'Component',
      variants: [
        { apiId: 'hero', name: 'Hero', fields: [symbol('heading')] },
        {
          apiId: 'grid',
          name: 'Grid',
          fields: [
            field({
              apiId: 'items',
              type: 'Array',
              items: {
                type: 'Component',
                variants: [{ apiId: 'card', name: 'Card', fields: [symbol('title')] }],
              },
            }),
          ],
        },
      ],
    },
  }),
];

const person = (subject: string, actions?: readonly string[]): Principal => ({
  spaceId: 'site',
  kind: 'user',
  subject,
  scopes: [SCOPES.previewRead, SCOPES.contentWrite, SCOPES.contentPublish],
  ...(actions ? { contentGrants: [{ contentTypeApiId: '*', actions: actions as never }] } : {}),
});
const manager = person('manager@example.com', ['read', 'write', 'publish', 'lock']);
const other = person('other@example.com', ['read', 'write', 'publish', 'lock']);
const editor = person('editor@example.com', ['read', 'write', 'publish']);

type Block = Record<string, unknown>;
const hero = (key: string, heading = 'Hi'): Block => ({ _type: 'hero', _key: key, heading });
const card = (key: string): Block => ({ _type: 'card', _key: key, title: 'C' });
const grid = (key: string, items: Block[]): Block => ({ _type: 'grid', _key: key, items });
const body = (blocks: Block[]): EntryFields => ({
  title: { 'en-US': 'Home' },
  body: { 'en-US': blocks },
});
const STORED = [hero('h1'), hero('h2'), grid('g1', [card('c1')]), hero('h3')];

const failure = async <E>(p: Promise<unknown>, type: new (...a: never[]) => E): Promise<E> => {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  if (!(err instanceof type)) throw new Error(`expected ${type.name}, got ${String(err)}`);
  return err;
};
const codes = async (p: Promise<unknown>) =>
  ((await failure(p, ValidationError)).issues as BlockConfigIssue[]).map((i) =>
    `${i.code} ${i.field} ${i.key ?? ''}`.trim(),
  );

describe('locked regions', () => {
  let ctx: AppContext;
  let store: InMemoryContentStore;
  let id: string;

  beforeEach(async () => {
    store = new InMemoryContentStore();
    ctx = {
      store,
      clock: new FixedClock(new Date('2026-11-09T10:00:00.000Z')),
      ids: new SequenceIdGenerator('k'),
    };
    await createSpace(ctx, { spaceId: 'site', name: 'Site', defaultLocale: 'en-US' });
    store.seedSpace({
      spaceId: 'site',
      defaultLocale: 'en-US',
      locales: ['en-US'],
      environments: ['main', 'staging'],
    });
    await createContentType(ctx, SYSTEM_CALLER, scope, {
      apiId: 'page',
      name: 'Page',
      displayField: 'title',
      fields: PAGE_FIELDS,
    });
    await publishContentType(ctx, scope, 'page');
    id = (await createEntry(ctx, scope, { contentTypeApiId: 'page', fields: body(STORED) })).entry
      .id;
  });

  const lock = (locks: unknown, who: Principal = manager, expectedVersion?: number) =>
    setEntryBlockLocks(ctx, who, scope, id, {
      locks,
      ...(expectedVersion !== undefined ? { expectedVersion } : {}),
    });

  it('sets locks stamped with who and when, making no version', async () => {
    expect(await getEntryBlockLocks(ctx, manager, scope, id)).toMatchObject({
      version: 1,
      locks: [],
    });
    const set = await lock([{ field: 'body', keys: ['h1', 'h2'] }], manager, 1);
    expect(set).toMatchObject({
      unchanged: false,
      version: 1,
      stale: [],
      locks: [
        {
          field: 'body',
          keys: ['h1', 'h2'],
          depth: 'subtree',
          freeze: 'structure',
          lockedBy: 'manager@example.com',
          lockedAt: '2026-11-09T10:00:00.000Z',
        },
      ],
    });
    const stored = await store.entries.get(scope, id);
    expect(stored?.entry.currentVersion).toBe(1);
    expect(await store.entries.listVersions(scope, id)).toHaveLength(1);
    expect((await getEntryBlockLocks(ctx, manager, scope, id)).locks).toEqual(set.locks);
  });

  it('takes the lock action to lock and to unlock, whoever locked', async () => {
    const refused = await failure(lock([{ field: 'body', keys: ['h1'] }], editor), ForbiddenError);
    expect(refused.message).toContain('content:lock:page');
    // A grant naming the type without lock doesn't gain it from a `*` grant that has it.
    const narrow: Principal = {
      ...manager,
      contentGrants: [
        { contentTypeApiId: 'page', actions: ['read', 'write'] },
        { contentTypeApiId: '*', actions: ['read', 'write', 'lock'] },
      ],
    };
    await failure(lock([{ field: 'body', keys: ['h1'] }], narrow), ForbiddenError);
    await lock([{ field: 'body', keys: ['h1'] }]);
    await failure(lock([], editor), ForbiddenError);
    expect((await lock([], other)).locks).toEqual([]);
    // A principal with no grants at all is unrestricted.
    const unrestricted: Principal = { spaceId: '*', kind: 'admin', scopes: Object.values(SCOPES) };
    expect((await lock([{ field: 'body', keys: ['h3'] }], unrestricted)).locks).toHaveLength(1);
  });

  it('keeps locks on a field the grant denies or makes read-only out of the caller’s reach', async () => {
    await lock([{ field: 'body', keys: ['h1'] }]);
    const grant = { contentTypeApiId: '*', actions: ['read', 'write', 'lock'] as never };
    const readOnly: Principal = {
      ...manager,
      contentGrants: [{ ...grant, readOnlyFields: ['body'] }],
    };
    const denied: Principal = { ...manager, contentGrants: [{ ...grant, deniedFields: ['body'] }] };
    // A read-only field's lock is shown and may come back unchanged; a new one is refused.
    const shown = (await getEntryBlockLocks(ctx, readOnly, scope, id)).locks;
    expect(shown).toHaveLength(1);
    expect((await lock(shown, readOnly)).unchanged).toBe(true);
    const refused = await failure(
      lock([...shown, { field: 'body', keys: ['h3'] }], readOnly),
      ForbiddenError,
    );
    expect(refused.message).toContain('content:lock:page.body');
    // Leaving it out doesn't lift it.
    expect((await lock([], readOnly)).unchanged).toBe(true);
    // A denied field's locks aren't shown, and survive a set that can't name them.
    expect((await getEntryBlockLocks(ctx, denied, scope, id)).locks).toEqual([]);
    await lock([], denied);
    await failure(lock([{ field: 'body', keys: ['h3'] }], denied), ForbiddenError);
    expect((await getEntryBlockLocks(ctx, manager, scope, id)).locks).toEqual([
      expect.objectContaining({ keys: ['h1'] }),
    ]);
  });

  it('refuses a stale expectedVersion, and a set that loses its race at commit', async () => {
    await updateEntry(ctx, scope, id, body(STORED));
    await failure(lock([{ field: 'body', keys: ['h1'] }], manager, 1), ConflictError);
    const setBlockLocks = store.entries.setBlockLocks.bind(store.entries);
    store.entries.setBlockLocks = async (s, e, locks, guard) => {
      // Someone else's set lands between this one's read and its write.
      await setBlockLocks(s, e, [{ ...locks[0], keys: ['h3'] } as never], guard);
      return setBlockLocks(s, e, locks, guard);
    };
    await failure(lock([{ field: 'body', keys: ['h1'] }], manager, 2), ConflictError);
  });

  it('refuses overlapping regions and keys the entry does not hold', async () => {
    const overlap = await failure(
      lock([
        { field: 'body', keys: ['g1'] },
        { field: 'body', keys: ['c1'] },
      ]),
      ValidationError,
    );
    expect(overlap.issues).toMatchObject([{ code: 'lock_overlaps', field: 'locks[1].keys' }]);
    await failure(lock([{ field: 'body', keys: ['nope'] }]), ValidationError);
    expect((await getEntryBlockLocks(ctx, manager, scope, id)).locks).toEqual([]);
  });

  it('writes nothing and notes nothing for a set that changes nothing', async () => {
    await lock([{ field: 'body', keys: ['h1'] }]);
    const changes = createChangeLog();
    const again = await setEntryBlockLocks(withChanges(ctx, changes), other, scope, id, {
      locks: [{ field: 'body', keys: ['h1'], depth: 'subtree', freeze: 'structure' }],
    });
    expect(again.unchanged).toBe(true);
    // The stamp is the first locker's.
    expect(again.locks[0]?.lockedBy).toBe('manager@example.com');
    expect(changes.detail()).toBeUndefined();
  });

  it('notes every lock and unlock for the audit row', async () => {
    const changes = createChangeLog();
    const noting = withChanges(ctx, changes);
    await setEntryBlockLocks(noting, manager, scope, id, {
      locks: [{ field: 'body', keys: ['h1', 'h2'], freeze: 'all' }],
    });
    expect(changes.detail()?.blockLocks).toEqual({
      entryId: id,
      locked: [{ field: 'body', keys: ['h1', 'h2'], depth: 'subtree', freeze: 'all' }],
      unlocked: [],
    });
    changes.clear();
    await setEntryBlockLocks(noting, other, scope, id, { locks: [] });
    expect(changes.detail()?.blockLocks).toMatchObject({
      locked: [],
      unlocked: [{ keys: ['h1', 'h2'], freeze: 'all' }],
    });
  });

  describe('enforcement', () => {
    beforeEach(async () => {
      await lock([
        { field: 'body', keys: ['h1', 'h2'] },
        { field: 'body', keys: ['g1'], freeze: 'all' },
      ]);
    });

    it('refuses an edit that breaks a region, with no block config in force', async () => {
      expect(
        await codes(
          updateEntry(ctx, scope, id, body([hero('h2'), hero('h1'), grid('g1', [card('c1')])])),
        ),
      ).toEqual(['region_locked body h1']);
      expect(
        await codes(
          updateEntry(ctx, scope, id, body([hero('h1'), hero('h2'), grid('g1', []), hero('h3')])),
        ),
      ).toEqual(['region_locked body[2] g1']);
      expect(
        await codes(
          validateEntry(ctx, scope, {
            entryId: id,
            fields: body([hero('h1'), STORED[2] as Block, hero('h3')]),
          }),
        ),
      ).toEqual(['region_locked body h1']);
      // Outside the regions, and inside one locked only for structure, edits save.
      const saved = await updateEntry(
        ctx,
        scope,
        id,
        body([hero('h1', 'New'), hero('h2'), grid('g1', [card('c1')]), hero('h4')]),
      );
      expect(saved.entry.currentVersion).toBe(2);
      expect(saved.entry.blockLocks).toHaveLength(2);
    });

    it('refuses an edit to a frozen region’s content', async () => {
      const edited = grid('g1', [{ ...card('c1'), title: 'New' }]);
      expect(
        await codes(
          updateEntry(ctx, scope, id, body([hero('h1'), hero('h2'), edited, hero('h3')])),
        ),
      ).toEqual(['region_frozen body[2] g1']);
    });

    it('refuses a block patch with the same issue', async () => {
      const issues = await codes(
        patchEntryBlocks(ctx, scope, id, {
          expectedVersion: 1,
          ops: [{ op: 'remove', field: 'body', key: 'h2' }],
        }),
      );
      expect(issues).toEqual(['region_locked body h1']);
    });

    it('refuses an import that updates an entry holding locks', async () => {
      expect(
        await codes(
          updateImportedEntry(
            ctx,
            scope,
            id,
            body([hero('h1'), STORED[2] as Block, hero('h3')]),
            [],
          ),
        ),
      ).toEqual(['region_locked body h1']);
      const source: ImportSource = {
        id: 'fake',
        name: 'Fake',
        async read() {
          return {
            records: [
              { externalId: 'r1', values: { name: 'Home', blocks: [hero('h1'), STORED[2]] } },
            ],
            fields: ['name', 'blocks'],
            warnings: [],
          };
        },
      };
      const run = await executeImport(
        ctx,
        { spaceId: '*', kind: 'admin', scopes: Object.values(SCOPES) },
        scope,
        source,
        {
          payload: '',
          mapping: {
            contentTypeApiId: 'page',
            fields: { title: 'name', body: 'blocks' },
            identityField: 'title',
          },
        },
        { conflicts: 'update' },
      );
      expect(run).toMatchObject({ updated: 0, skipped: 1, analysis: { invalid: 1 } });
      expect(run.analysis.issues[0]?.messages[0]).toMatch(/^body: This region is locked/);
    });

    it('holds a version restore to the locks held now, unless the restorer holds lock', async () => {
      // v2 adds h4, which is then locked: v1, without it, would remove a locked block.
      await updateEntry(
        ctx,
        scope,
        id,
        body([hero('h1'), hero('h2'), STORED[2] as Block, hero('h4')]),
      );
      const held = (await getEntryBlockLocks(ctx, manager, scope, id)).locks;
      await lock([...held, { field: 'body', keys: ['h4'] }]);
      expect(await codes(restoreVersion(ctx, scope, id, 1, { restorer: editor }))).toEqual([
        'region_locked body h4',
      ]);
      // Nobody named: nobody vouches for lock.
      expect(await codes(restoreVersion(ctx, scope, id, 1))).toEqual(['region_locked body h4']);
      expect((await store.entries.get(scope, id))?.entry.currentVersion).toBe(2);
      // One who could lift the lock may restore through it; the locks held now stay.
      const restored = await restoreVersion(ctx, scope, id, 1, { restorer: manager });
      expect(restored.entry.currentVersion).toBe(3);
      expect(restored.entry.blockLocks).toHaveLength(3);
      expect((await getEntryBlockLocks(ctx, manager, scope, id)).stale).toEqual([
        expect.objectContaining({ keys: ['h4'] }),
      ]);
    });

    it('judges a restore by the regions only, not the block config', async () => {
      // A restore that leaves every region as it is goes through without lock.
      await updateEntry(ctx, scope, id, body([hero('h1'), hero('h2'), STORED[2] as Block]));
      const restored = await restoreVersion(ctx, scope, id, 1, { restorer: editor });
      expect(restored.entry.currentVersion).toBe(3);
    });

    it('does not judge other copies: a copy update and a duplicate', async () => {
      // A copy that drops a locked block is not refused; the lock is stale and blocks nothing.
      await updateEntry(ctx, scope, id, body([hero('h3')]), { copy: true });
      const read = await getEntryBlockLocks(ctx, manager, scope, id);
      expect(read.stale).toEqual(read.locks);
      await expect(updateEntry(ctx, scope, id, body([]))).resolves.toBeDefined();
      const copy = await duplicateEntry(ctx, scope, id);
      expect(copy.entry.blockLocks).toBeUndefined();
    });

    it('refuses a save judged before a lock set that committed first (409)', async () => {
      const read = await store.entries.get(scope, id);
      const type = await store.contentTypes.get(scope, 'page');
      if (!read || !type) throw new Error('no entry');
      await lock([{ field: 'body', keys: ['h3'] }]);
      await failure(
        saveEntryDraft(
          ctx,
          scope,
          read.entry,
          type,
          { defaultLocale: 'en-US', locales: ['en-US'], previous: read.fields },
          body([hero('h1'), hero('h2'), STORED[2] as Block]),
          read.fields,
        ),
        ConflictError,
      );
      expect((await store.entries.get(scope, id))?.entry.currentVersion).toBe(1);
    });

    it('carries the locks to a clone of the environment', async () => {
      await cloneEnvironment(ctx, SYSTEM_CALLER, scope, staging);
      const cloned = await store.entries.get(staging, id);
      expect(cloned?.entry.blockLocks).toEqual(
        (await store.entries.get(scope, id))?.entry.blockLocks,
      );
      expect(await codes(updateEntry(ctx, staging, id, body([hero('h2'), hero('h1')])))).toContain(
        'region_locked body h1',
      );
    });
  });
});
