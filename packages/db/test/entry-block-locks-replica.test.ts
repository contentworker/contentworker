import {
  type AppContext,
  createContentType,
  createEntry,
  createSpace,
  publishContentType,
  SYSTEM_CALLER,
} from '@contentworker/application';
import type { FieldDefinition } from '@contentworker/domain';
import { FixedClock } from '@contentworker/test-kit';
import { describe, expect, it } from 'vitest';
import { createD1Store } from '../src/store';
import { testDb } from './env';

/**
 * Entry reads on a replica behind 0038_entry_block_locks: the column isn't there yet. This file
 * has its own database (each file starts from freshly applied migrations), so it drops the column
 * to stand in for one. Every entry read must still answer, with no locks: single-table reads and
 * the joined `withFields` read both name the column unqualified, which SQLite reads as the
 * column's own name when it can't find it. Nothing here writes after the drop: writes go to the
 * primary, which is migrated first.
 */
const store = createD1Store(testDb);
const uid = () => crypto.randomUUID();

describe('entry reads on a replica behind 0038', () => {
  it('answers get, getMany and list with no locks rather than failing', async () => {
    const ctx: AppContext = { store, clock: new FixedClock(), ids: { newId: uid } };
    const spaceId = `replica-${uid()}`;
    await createSpace(ctx, { spaceId, name: 'Replica', defaultLocale: 'en-US' });
    const scope = { spaceId, environmentId: 'main' };
    await createContentType(ctx, SYSTEM_CALLER, scope, {
      apiId: 'note',
      name: 'Note',
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
      ] as FieldDefinition[],
    });
    await publishContentType(ctx, scope, 'note');
    const { entry } = await createEntry(ctx, scope, {
      contentTypeApiId: 'note',
      fields: { title: { 'en-US': 'Hi' } },
    });
    await testDb.prepare('ALTER TABLE entries DROP COLUMN block_locks').run();

    const got = await store.entries.get(scope, entry.id);
    expect(got?.fields).toEqual({ title: { 'en-US': 'Hi' } });
    expect(got?.entry.blockLocks).toBeUndefined();
    const [many] = await store.entries.getMany(scope, [entry.id]);
    expect(many?.entry.blockLocks).toBeUndefined();
    const listed = await store.entries.list(scope, { contentTypeApiId: 'note', limit: 10 });
    expect(listed.map((r) => r.entry.id)).toEqual([entry.id]);
    expect(listed[0]?.entry.blockLocks).toBeUndefined();
  });
});
