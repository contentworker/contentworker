import {
  ConflictError,
  DelegatedKeyMintError,
  LastAdminError,
  type Principal,
  SCOPES,
} from '@contentworker/domain';
import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@contentworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  cloneRole,
  createApiKey,
  createRole,
  createSpace,
  ensureRolePresets,
  getRole,
  listRoles,
  presetRoleId,
  type RoleUpdateInput,
  updateRole,
} from '../src/index';

/**
 * A role save held to the version it was edited from: every role starts at 1 and each save is
 * the next, a stale `expectedVersion` is refused (409, naming the version in force) with nothing
 * written, an absent one saves as before, and two saves from one read can't both land. The
 * delegated-bearer and last-admin refusals still come first.
 */
const hasher = { hash: (v: string) => `h:${v}` };
const S = 's1';

describe('a role save held to its version', () => {
  let ctx: AppContext;
  beforeEach(async () => {
    ctx = {
      store: new InMemoryContentStore(),
      clock: new FixedClock(),
      ids: new SequenceIdGenerator('v'),
    };
    await createSpace(ctx, { spaceId: S, name: 'S', defaultLocale: 'en-US' });
  });

  const edit = (over: Partial<RoleUpdateInput> = {}): RoleUpdateInput => ({
    name: 'Writers',
    scopes: [SCOPES.previewRead, SCOPES.contentWrite],
    contentGrants: [{ contentTypeApiId: 'post', actions: ['read', 'write'] }],
    ...over,
  });

  it('starts every role at 1, and makes each save the next version', async () => {
    const role = await createRole(ctx, S, edit());
    expect(role.version).toBe(1);
    expect((await cloneRole(ctx, S, role.id)).version).toBe(1);
    expect((await ensureRolePresets(ctx, S)).every((r) => r.version === 1)).toBe(true);

    const saved = await updateRole(ctx, S, role.id, edit({ name: 'Authors' }));
    expect(saved.version).toBe(2);
    expect(await getRole(ctx, S, role.id)).toMatchObject({ name: 'Authors', version: 2 });
    expect((await listRoles(ctx, S)).find((r) => r.id === role.id)?.version).toBe(2);
  });

  it('refuses a stale expectedVersion with the version in force, writing nothing', async () => {
    const role = await createRole(ctx, S, edit());
    await updateRole(ctx, S, role.id, edit({ name: 'Theirs' }));

    const stale = await updateRole(
      ctx,
      S,
      role.id,
      edit({ name: 'Mine', scopes: [SCOPES.previewRead], expectedVersion: 1 }),
    ).catch((e: unknown) => e);
    expect(stale).toBeInstanceOf(ConflictError);
    expect(stale).toMatchObject({ code: 'conflict', details: { version: 2 } });
    expect(await getRole(ctx, S, role.id)).toMatchObject({
      name: 'Theirs',
      scopes: [SCOPES.previewRead, SCOPES.contentWrite],
      version: 2,
    });
  });

  it('saves with the version in force, and with none (a client that sends no version)', async () => {
    const role = await createRole(ctx, S, edit());
    const matched = await updateRole(ctx, S, role.id, edit({ name: 'Two', expectedVersion: 1 }));
    expect(matched.version).toBe(2);
    const unversioned = await updateRole(ctx, S, role.id, edit({ name: 'Three' }));
    expect(unversioned.version).toBe(3);
    expect(await getRole(ctx, S, role.id)).toMatchObject({ name: 'Three', version: 3 });
  });

  it('lets only one of two saves from the same read land', async () => {
    const role = await createRole(ctx, S, edit());
    // The second save reads the role, then the first commits before it does: its write rides
    // a compare-and-set on the version it read, so it loses at commit rather than undoing theirs.
    const store = ctx.store as InMemoryContentStore;
    const get = store.roles.get;
    let raced = false;
    (store.roles as { get: typeof get }).get = async (spaceId, id) => {
      const read = await get(spaceId, id);
      if (!raced) {
        raced = true;
        await updateRole(ctx, S, role.id, edit({ name: 'First' }));
      }
      return read;
    };
    const lost = await updateRole(ctx, S, role.id, edit({ name: 'Second' })).catch(
      (e: unknown) => e,
    );
    expect(lost).toBeInstanceOf(ConflictError);
    expect(lost).toMatchObject({ details: { version: 2 } });
    expect(await get(S, role.id)).toMatchObject({ name: 'First', version: 2 });
  });

  it('still refuses a delegated bearer widening a held role, and the last admin, first', async () => {
    const role = await createRole(ctx, S, edit());
    await createApiKey(ctx, hasher, { issuer: 'system', spaceId: S, kind: 'cma', roleId: role.id });
    await updateRole(ctx, S, role.id, edit({ name: 'Moved on' }));
    const oauth: Principal = {
      spaceId: S,
      kind: 'user',
      subject: 'ada@example.com',
      scopes: [SCOPES.spaceAdmin],
      clientId: 'client-1',
      issuance: 'oauth',
    };
    // Stale and widening: the bearer refusal, judged against the role as stored now.
    await expect(
      updateRole(
        ctx,
        S,
        role.id,
        edit({
          scopes: [SCOPES.previewRead, SCOPES.contentWrite, SCOPES.spaceAdmin],
          expectedVersion: 1,
        }),
        { sso: false },
        oauth,
      ),
    ).rejects.toBeInstanceOf(DelegatedKeyMintError);

    const adminRole = await presetRoleId(ctx, S, 'admin');
    await createApiKey(ctx, hasher, {
      issuer: 'system',
      spaceId: S,
      kind: 'cma',
      roleId: adminRole,
    });
    // Stale and demoting the last admin: the last-admin refusal.
    await expect(
      updateRole(ctx, S, adminRole, {
        name: 'Administrator',
        scopes: [SCOPES.previewRead],
        expectedVersion: 7,
      }),
    ).rejects.toBeInstanceOf(LastAdminError);
    expect((await getRole(ctx, S, adminRole)).version).toBe(1);
    expect((await getRole(ctx, S, role.id)).version).toBe(2);
  });
});
