import { env } from 'cloudflare:workers';
import type { D1Migration } from '@cloudflare/vitest-plugin';
import {
  type AppContext,
  createContentType,
  createEntry,
  createSpace,
  getEntryBlockLocks,
  listPublishedEntries,
  publishContentType,
  publishEntry,
  restoreVersion,
  SYSTEM_CALLER,
  setEntryBlockLocks,
  updateEntry,
} from '@contentworker/application';
import type { BlockLock, FieldDefinition, Principal } from '@contentworker/domain';
import { TransactionConflictError } from '@contentworker/ports';
import { FixedClock } from '@contentworker/test-kit';
import { describe, expect, it } from 'vitest';
import { createD1Store } from '../src/store';
import { testDb } from './env';

/**
 * The storage behind locked regions (0038_entry_block_locks): `entries.block_locks`, written only
 * by a lock set under its compare-and-set and kept through every other write, never copied to
 * the published row; and the backfill that gives the Manager and Administrator presets `lock`.
 * Each test makes its own space: the file shares one database.
 */
const store = createD1Store(testDb);
const uid = () => crypto.randomUUID();
const manager: Principal = {
  spaceId: '*',
  kind: 'user',
  subject: 'manager@example.com',
  scopes: [],
};

const block = (key: string) => ({ _type: 'hero', _key: key, heading: 'Hi' });

async function harness() {
  const ctx: AppContext = { store, clock: new FixedClock(), ids: { newId: uid } };
  const spaceId = `locks-${uid()}`;
  await createSpace(ctx, { spaceId, name: 'Locks', defaultLocale: 'en-US' });
  const scope = { spaceId, environmentId: 'main' };
  await createContentType(ctx, SYSTEM_CALLER, scope, {
    apiId: 'page',
    name: 'Page',
    displayField: 'title',
    fields: [
      {
        apiId: 'title',
        name: 'Title',
        type: 'Symbol',
        localized: false,
        required: false,
        position: 0,
      },
      {
        apiId: 'body',
        name: 'Body',
        type: 'Array',
        localized: false,
        required: false,
        position: 1,
        items: {
          type: 'Component',
          variants: [
            {
              apiId: 'hero',
              name: 'Hero',
              fields: [
                {
                  apiId: 'heading',
                  name: 'Heading',
                  type: 'Symbol',
                  localized: false,
                  required: false,
                  position: 0,
                },
              ],
            },
          ],
        },
      },
    ] as FieldDefinition[],
  });
  await publishContentType(ctx, scope, 'page');
  const page = async (keys: string[]) =>
    (
      await createEntry(ctx, scope, {
        contentTypeApiId: 'page',
        fields: { title: { 'en-US': 'Home' }, body: { 'en-US': keys.map(block) } },
      })
    ).entry.id;
  const column = async (table: 'entries', id: string) =>
    (
      await testDb
        .prepare(
          `SELECT block_locks FROM ${table} WHERE space_id = ? AND environment_id = ? AND id = ?`,
        )
        .bind(spaceId, 'main', id)
        .first<{ block_locks: string | null }>()
    )?.block_locks;
  return { ctx, scope, page, column };
}

describe('entry block locks on D1', () => {
  it('starts with none, and stores a set as JSON without making a version', async () => {
    const h = await harness();
    const id = await h.page(['a', 'b']);
    expect(await h.column('entries', id)).toBeNull();
    expect((await store.entries.get(h.scope, id))?.entry.blockLocks).toBeUndefined();
    const set = await setEntryBlockLocks(h.ctx, manager, h.scope, id, {
      locks: [{ field: 'body', keys: ['a', 'b'] }],
      expectedVersion: 1,
    });
    expect(set.unchanged).toBe(false);
    const read = await store.entries.get(h.scope, id);
    expect(read?.entry.currentVersion).toBe(1);
    expect(read?.entry.blockLocks).toEqual(set.locks);
    expect((await store.entries.getMany(h.scope, [id]))[0]?.entry.blockLocks).toEqual(set.locks);
    expect(await store.entries.listVersions(h.scope, id)).toHaveLength(1);
    // Cleared, the column goes back to NULL.
    await setEntryBlockLocks(h.ctx, manager, h.scope, id, { locks: [] });
    expect(await h.column('entries', id)).toBeNull();
  });

  it('keeps the locks through a save, a publish and a version restore', async () => {
    const h = await harness();
    const id = await h.page(['a', 'b']);
    await updateEntry(h.ctx, h.scope, id, {
      title: { 'en-US': 'v2' },
      body: { 'en-US': [block('a'), block('b')] },
    });
    const { locks } = await setEntryBlockLocks(h.ctx, manager, h.scope, id, {
      locks: [{ field: 'body', keys: ['a'] }],
    });
    await publishEntry(h.ctx, h.scope, id);
    await restoreVersion(h.ctx, h.scope, id, 1);
    expect((await getEntryBlockLocks(h.ctx, manager, h.scope, id)).locks).toEqual(locks);
    // Delivery never sees one: the published row has no copy, and a delivered entry no lock.
    const [delivered] = (
      await listPublishedEntries(h.ctx, h.scope, { contentTypeApiId: 'page' })
    ).filter((e) => e.id === id);
    expect(JSON.stringify(delivered)).not.toContain('lockedBy');
  });

  it('refuses a set whose version or locks moved since they were read', async () => {
    const h = await harness();
    const id = await h.page(['a', 'b']);
    const lock: BlockLock = {
      field: 'body',
      keys: ['a'],
      depth: 'subtree',
      freeze: 'structure',
      lockedBy: 'x',
      lockedAt: '2026-11-09T00:00:00.000Z',
    };
    await expect(
      store.entries.setBlockLocks(h.scope, id, [lock], { currentVersion: 2, locks: [] }),
    ).rejects.toBeInstanceOf(TransactionConflictError);
    await store.entries.setBlockLocks(h.scope, id, [lock], { currentVersion: 1, locks: [] });
    // A second set made from the same read loses.
    await expect(
      store.entries.setBlockLocks(h.scope, id, [], { currentVersion: 1, locks: [] }),
    ).rejects.toBeInstanceOf(TransactionConflictError);
    await store.entries.setBlockLocks(h.scope, id, [], { currentVersion: 1, locks: [lock] });
    expect((await store.entries.get(h.scope, id))?.entry.blockLocks).toBeUndefined();
    // Another space's entry of the same id is out of reach.
    await expect(
      store.entries.setBlockLocks({ spaceId: 'elsewhere', environmentId: 'main' }, id, [lock], {
        currentVersion: 1,
        locks: [],
      }),
    ).rejects.toBeInstanceOf(TransactionConflictError);
  });

  it('reads a value that is not a list of locks as none, as a replica behind 0038 answers', async () => {
    const h = await harness();
    const id = await h.page(['a']);
    // A bare read of a column the replica doesn't have yet answers the column's own name.
    await testDb
      .prepare('UPDATE entries SET block_locks = ? WHERE space_id = ? AND id = ?')
      .bind('block_locks', h.scope.spaceId, id)
      .run();
    const read = await store.entries.get(h.scope, id);
    expect(read?.entry.currentVersion).toBe(1);
    expect(read?.entry.blockLocks).toBeUndefined();
  });

  it('gives the Manager and Administrator presets lock where their * grant writes', async () => {
    const spaceId = `roles-${uid()}`;
    const grants = (actions: string[], type = '*') =>
      JSON.stringify([{ contentTypeApiId: type, actions }]);
    // An admin preset edited down to one named type keeps what it was edited to.
    const rows: [string, string | null, string][] = [
      ['manager', 'manager', grants(['read', 'write', 'publish'])],
      ['named', 'admin', grants(['read', 'write'], 'post')],
      ['editor', 'editor', grants(['read', 'write', 'publish'])],
      ['custom', null, grants(['read', 'write', 'publish'])],
    ];
    for (const [id, preset, contentGrants] of rows) {
      await testDb
        .prepare(
          'INSERT INTO roles (space_id, id, name, scopes, content_grants, preset) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .bind(spaceId, id, id, '[]', contentGrants, preset)
        .run();
    }
    const migration = (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS.find(
      (m) => m.name.startsWith('0038_'),
    );
    const backfill = migration?.queries.find((q) => q.includes('UPDATE `roles`'));
    if (!backfill) throw new Error('0038 has no roles backfill');
    // Run twice: a re-run adds nothing.
    await testDb.prepare(backfill).run();
    await testDb.prepare(backfill).run();
    const roles = await store.roles.list(spaceId);
    const actions = Object.fromEntries(
      roles.map((r) => [r.id, r.contentGrants.map((g) => [g.contentTypeApiId, ...g.actions])]),
    );
    expect(actions).toEqual({
      manager: [['*', 'read', 'write', 'publish', 'lock']],
      editor: [['*', 'read', 'write', 'publish']],
      custom: [['*', 'read', 'write', 'publish']],
      named: [['post', 'read', 'write']],
    });
  });
});
