import {
  type AppContext,
  createRole,
  ensureRolePresets,
  getRole,
  updateRole,
} from '@contentworker/application';
import { ConflictError, type Role } from '@contentworker/domain';
import { TransactionConflictError } from '@contentworker/ports';
import { FixedClock } from '@contentworker/test-kit';
import { describe, expect, it } from 'vitest';
import { createD1Store } from '../src/store';
import { testDb } from './env';

/**
 * Role versions on D1 (0041_role_versions): a role is created at version 1 and each save writes
 * the next while the row is at the one before, failing a lost race directly and at commit inside
 * a unit; a row written before the column (or by code that never names it) reads as 1. Each test
 * makes its own space: the file shares one database.
 */
const store = createD1Store(testDb);
const uid = () => crypto.randomUUID();

const role = (spaceId: string, id: string, version: number, over: Partial<Role> = {}): Role => ({
  id,
  spaceId,
  name: `Role v${version}`,
  scopes: ['preview:read'],
  contentGrants: [],
  version,
  ...over,
});

function harness() {
  const ctx: AppContext = { store, clock: new FixedClock(), ids: { newId: uid } };
  return { ctx, spaceId: `roles-${uid()}`, id: uid() };
}

describe('role versions on D1', () => {
  it('creates at 1 and writes each next version over the one before', async () => {
    const { spaceId, id } = harness();
    await store.roles.save(role(spaceId, id, 1));
    expect(await store.roles.get(spaceId, id)).toEqual(role(spaceId, id, 1));
    await store.roles.save(role(spaceId, id, 2, { scopes: ['delivery:read'] }));
    expect(await store.roles.get(spaceId, id)).toEqual(
      role(spaceId, id, 2, { scopes: ['delivery:read'] }),
    );
    expect((await store.roles.list(spaceId)).map((r) => r.version)).toEqual([2]);
  });

  it('refuses a version not next to the stored one: directly, and at commit inside a unit', async () => {
    const { spaceId, id } = harness();
    await store.roles.save(role(spaceId, id, 1));
    // A second create loses on the primary key; a save from a stale read matches no row.
    await expect(store.roles.save(role(spaceId, id, 1))).rejects.toThrow(TransactionConflictError);
    await expect(store.roles.save(role(spaceId, id, 3))).rejects.toThrow(TransactionConflictError);
    await store.roles.save(role(spaceId, id, 2, { name: 'Theirs' }));
    await expect(
      store.withTransaction(async (tx) => {
        await tx.roles.save(role(spaceId, id, 2, { name: 'Loser' }));
      }),
    ).rejects.toThrow(TransactionConflictError);
    expect(await store.roles.get(spaceId, id)).toMatchObject({ name: 'Theirs', version: 2 });
    await store.withTransaction(async (tx) => {
      await tx.roles.save(role(spaceId, id, 3, { name: 'Winner' }));
    });
    expect(await store.roles.get(spaceId, id)).toMatchObject({ name: 'Winner', version: 3 });
  });

  it('refuses a second preset role in a space as a conflict, so a racing seed reads the winner', async () => {
    const { ctx, spaceId } = harness();
    const [viewer] = await ensureRolePresets(ctx, spaceId);
    await expect(store.roles.save({ ...(viewer as Role), id: uid(), version: 1 })).rejects.toThrow(
      TransactionConflictError,
    );
    expect((await ensureRolePresets(ctx, spaceId)).map((r) => r.version)).toEqual([1, 1, 1, 1, 1]);
  });

  it('reads a role written without the column as version 1, and saves over it', async () => {
    const { ctx, spaceId, id } = harness();
    // As the code deployed before 0041 writes it: no version named.
    await testDb
      .prepare(
        "INSERT INTO roles (space_id, id, name, scopes, content_grants) VALUES (?, ?, 'Old', '[]', '[]')",
      )
      .bind(spaceId, id)
      .run();
    expect(await getRole(ctx, spaceId, id)).toMatchObject({ name: 'Old', version: 1 });
    const saved = await updateRole(
      ctx,
      spaceId,
      id,
      {
        name: 'New',
        scopes: ['preview:read'],
        expectedVersion: 1,
      },
      { sso: false },
      'system',
    );
    expect(saved.version).toBe(2);
    expect(await getRole(ctx, spaceId, id)).toMatchObject({ name: 'New', version: 2 });
  });

  it('refuses a stale save through the use-case, writing nothing', async () => {
    const { ctx, spaceId } = harness();
    const made = await createRole(ctx, spaceId, { name: 'Writers', scopes: ['preview:read'] });
    await updateRole(
      ctx,
      spaceId,
      made.id,
      { name: 'Theirs', scopes: ['preview:read'] },
      { sso: false },
      'system',
    );
    await expect(
      updateRole(
        ctx,
        spaceId,
        made.id,
        {
          name: 'Mine',
          scopes: ['delivery:read'],
          expectedVersion: 1,
        },
        { sso: false },
        'system',
      ),
    ).rejects.toMatchObject({ code: 'conflict', details: { version: 2 } });
    await expect(
      updateRole(
        ctx,
        spaceId,
        made.id,
        { name: 'Mine', scopes: [], expectedVersion: 1 },
        { sso: false },
        'system',
      ),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(await getRole(ctx, spaceId, made.id)).toMatchObject({ name: 'Theirs', version: 2 });
  });
});
