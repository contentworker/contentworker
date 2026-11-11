import {
  type AppContext,
  addMember,
  NO_SSO,
  removeMember,
  updateMember,
} from '@contentworker/application';
import type { SpaceMember } from '@contentworker/domain';
import { TransactionConflictError } from '@contentworker/ports';
import { FixedClock } from '@contentworker/test-kit';
import { describe, expect, it } from 'vitest';
import { createD1Store } from '../src/store';
import { testDb } from './env';

/**
 * Person versions on D1 (0042_member_versions): a person is added at version 1, each save writes
 * the next while the row is at the one before (never inserting), and a removal only takes the
 * version it names, failing a lost race directly and at commit inside a unit. A row written
 * before the column (or by code that never names it) reads as 1. Each test makes its own space:
 * the file shares one database.
 */
const store = createD1Store(testDb);
const uid = () => crypto.randomUUID();
const AT = '2026-11-11T00:00:00.000Z';

const person = (
  spaceId: string,
  id: string,
  version: number,
  over: Partial<SpaceMember> = {},
): SpaceMember => ({
  id,
  spaceId,
  email: `p-${id}@example.com`,
  name: `Person v${version}`,
  roleId: 'r-editor',
  disabled: false,
  version,
  createdAt: AT,
  updatedAt: AT,
  ...over,
});

function harness() {
  const ctx: AppContext = { store, clock: new FixedClock(), ids: { newId: uid } };
  return { ctx, spaceId: `members-${uid()}`, id: uid() };
}

describe('person versions on D1', () => {
  it('adds at 1 and writes each next version over the one before', async () => {
    const { spaceId, id } = harness();
    await store.members.save(person(spaceId, id, 1));
    expect(await store.members.get(spaceId, id)).toEqual(person(spaceId, id, 1));
    await store.members.save(person(spaceId, id, 2, { disabled: true, subject: 'sub-1' }));
    expect(await store.members.get(spaceId, id)).toEqual(
      person(spaceId, id, 2, { disabled: true, subject: 'sub-1' }),
    );
    expect((await store.members.list(spaceId)).map((m) => m.version)).toEqual([2]);
  });

  it('refuses a version not next to the stored one: directly, and at commit inside a unit', async () => {
    const { spaceId, id } = harness();
    await store.members.save(person(spaceId, id, 1));
    // A second add loses on the primary key, another id on the (space, email) index; a save from
    // a stale read matches no row.
    await expect(store.members.save(person(spaceId, id, 1))).rejects.toThrow(
      TransactionConflictError,
    );
    await expect(
      store.members.save(person(spaceId, uid(), 1, { email: `p-${id}@example.com` })),
    ).rejects.toThrow(TransactionConflictError);
    await expect(store.members.save(person(spaceId, id, 3))).rejects.toThrow(
      TransactionConflictError,
    );
    await store.members.save(person(spaceId, id, 2, { name: 'Theirs', disabled: true }));
    await expect(
      store.withTransaction(async (tx) => {
        await tx.members.save(person(spaceId, id, 2, { name: 'Loser' }));
      }),
    ).rejects.toThrow(TransactionConflictError);
    expect(await store.members.get(spaceId, id)).toMatchObject({
      name: 'Theirs',
      disabled: true,
      version: 2,
    });
    await store.withTransaction(async (tx) => {
      await tx.members.save(person(spaceId, id, 3, { name: 'Winner', disabled: true }));
    });
    expect(await store.members.get(spaceId, id)).toMatchObject({ name: 'Winner', version: 3 });
    expect(await store.members.list(spaceId)).toHaveLength(1);
  });

  it('never writes a removed person back, and removes only the version named', async () => {
    const { spaceId, id } = harness();
    await store.members.save(person(spaceId, id, 1));
    await store.members.save(person(spaceId, id, 2));
    await expect(store.members.delete(spaceId, id, 1)).rejects.toThrow(TransactionConflictError);
    expect(await store.members.get(spaceId, id)).not.toBeNull();
    await store.members.delete(spaceId, id, 2);
    expect(await store.members.get(spaceId, id)).toBeNull();
    // A save read before the removal is an update that matches no row: nothing comes back.
    await expect(store.members.save(person(spaceId, id, 3))).rejects.toThrow(
      TransactionConflictError,
    );
    await expect(store.members.delete(spaceId, id, 2)).rejects.toThrow(TransactionConflictError);
    expect(await store.members.list(spaceId)).toEqual([]);
  });

  it('keeps a save in one space off the same id in another', async () => {
    const { spaceId, id } = harness();
    await store.members.save(person(spaceId, id, 1));
    await expect(store.members.save(person(`${spaceId}-b`, id, 2))).rejects.toThrow(
      TransactionConflictError,
    );
    await expect(store.members.delete(`${spaceId}-b`, id, 1)).rejects.toThrow(
      TransactionConflictError,
    );
    expect(await store.members.get(spaceId, id)).toMatchObject({ version: 1 });
  });

  it('reads a person written without the column as version 1, and saves over it', async () => {
    const { ctx, spaceId, id } = harness();
    // As the code deployed before 0042 writes it: no version named.
    await testDb
      .prepare(
        "INSERT INTO space_members (space_id, id, email, role_id) VALUES (?, ?, 'old@example.com', 'r-old')",
      )
      .bind(spaceId, id)
      .run();
    expect(await store.members.get(spaceId, id)).toMatchObject({
      email: 'old@example.com',
      version: 1,
    });
    const saved = await updateMember(
      ctx,
      spaceId,
      id,
      { name: 'Renamed', expectedVersion: 1 },
      NO_SSO,
      'system',
    );
    expect(saved.version).toBe(2);
    expect(await store.members.get(spaceId, id)).toMatchObject({ name: 'Renamed', version: 2 });
  });

  it('refuses a stale change through the use-case, and removes at the version read', async () => {
    const { ctx, spaceId } = harness();
    await ctx.store.roles.save({
      id: 'r-viewer',
      spaceId,
      name: 'Viewer',
      scopes: ['preview:read'],
      contentGrants: [],
      version: 1,
    });
    const ada = await addMember(
      ctx,
      spaceId,
      { email: 'ada@example.com', role: 'r-viewer' },
      'system',
    );
    expect(ada.version).toBe(1);
    await updateMember(ctx, spaceId, ada.id, { disabled: true }, NO_SSO, 'system');
    await expect(
      updateMember(ctx, spaceId, ada.id, { name: 'Mine', expectedVersion: 1 }, NO_SSO, 'system'),
    ).rejects.toMatchObject({ code: 'conflict', details: { version: 2 } });
    expect(await store.members.get(spaceId, ada.id)).toMatchObject({
      disabled: true,
      version: 2,
    });
    await removeMember(ctx, spaceId, ada.id, NO_SSO);
    expect(await store.members.get(spaceId, ada.id)).toBeNull();
  });
});
