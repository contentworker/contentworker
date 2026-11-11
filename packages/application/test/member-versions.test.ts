import {
  ConflictError,
  DelegatedPeopleError,
  ForbiddenError,
  LastAdminError,
  NotFoundError,
  type Principal,
  SCOPES,
  type SpaceMember,
} from '@contentworker/domain';
import type { MemberRepo } from '@contentworker/ports';
import {
  FixedClock,
  InMemoryCache,
  InMemoryContentStore,
  SequenceIdGenerator,
} from '@contentworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  addMember,
  assignRolePreset,
  createSpace,
  findMemberForSignIn,
  listTeam,
  NO_SSO,
  presetRoleId,
  principalForWebUser,
  removeMember,
  updateMember,
} from '../src/index';

/**
 * A change to a person held to their version: everyone starts at 1 and each save is the next, a
 * stale `expectedVersion` is refused (409, naming the version in force), and a change that read
 * the person before someone else's save can't put the old state back. Without a version a lost
 * race is read again and made over theirs; a removed person is never written back. An SSO first
 * sign-in that loses its link reads the team again and goes on with the person as they are now.
 */
const S = 's1';
const SSO = { sso: true };

describe('a change to a person held to their version', () => {
  let ctx: AppContext;
  let store: InMemoryContentStore;
  beforeEach(async () => {
    store = new InMemoryContentStore();
    ctx = { store, clock: new FixedClock(), ids: new SequenceIdGenerator('m') };
    await createSpace(ctx, { spaceId: S, name: 'S', defaultLocale: 'en-US' });
  });

  const add = (email = 'ada@example.com', role = 'editor') =>
    addMember(ctx, S, { email, name: 'Ada', role }, 'system');
  const stored = (id: string) => store.members.get(S, id);

  /**
   * Runs `between` once, right after the first call to the repo's `method` reads: the shape of a
   * concurrent request that saves after this one read and before it writes.
   */
  function raceAfter(method: 'get' | 'list', between: () => Promise<unknown>): void {
    const repo = store.members as { -readonly [K in keyof MemberRepo]: MemberRepo[K] };
    const original = repo[method] as (...args: unknown[]) => Promise<unknown>;
    let raced = false;
    (repo as Record<string, unknown>)[method] = async (...args: unknown[]) => {
      const read = await original(...args);
      if (!raced) {
        raced = true;
        (repo as Record<string, unknown>)[method] = original;
        await between();
      }
      return read;
    };
  }

  it('starts everyone at 1, makes each change the next version, and lists it', async () => {
    const ada = await add();
    expect(ada.version).toBe(1);
    const renamed = await updateMember(ctx, S, ada.id, { name: 'Ada L.' }, NO_SSO, 'system');
    expect(renamed.version).toBe(2);
    expect(await stored(ada.id)).toMatchObject({ name: 'Ada L.', version: 2 });
    expect((await listTeam(ctx, S, NO_SSO)).people[0]).toMatchObject({ id: ada.id, version: 2 });
  });

  it('refuses a stale expectedVersion with the version in force, writing nothing', async () => {
    const ada = await add();
    await updateMember(ctx, S, ada.id, { disabled: true }, NO_SSO, 'system');
    const stale = await updateMember(
      ctx,
      S,
      ada.id,
      { name: 'Mine', expectedVersion: 1 },
      NO_SSO,
      'system',
    ).catch((e: unknown) => e);
    expect(stale).toBeInstanceOf(ConflictError);
    expect(stale).toMatchObject({ code: 'conflict', details: { version: 2 } });
    expect(await stored(ada.id)).toMatchObject({ name: 'Ada', disabled: true, version: 2 });

    const matched = await updateMember(
      ctx,
      S,
      ada.id,
      { name: 'Mine', expectedVersion: 2 },
      NO_SSO,
      'system',
    );
    expect(matched).toMatchObject({ name: 'Mine', disabled: true, version: 3 });
  });

  it('keeps access turned off when a rename read before it lands after (rename vs disable)', async () => {
    const ada = await add();
    raceAfter('get', () => updateMember(ctx, S, ada.id, { disabled: true }, NO_SSO, 'system'));
    // The rename read Ada enabled; the disable committed first. Before versions the rename wrote
    // `disabled: false` back. Now it loses the compare-and-set, reads again, and renames only.
    const renamed = await updateMember(ctx, S, ada.id, { name: 'Ada L.' }, NO_SSO, 'system');
    expect(renamed).toMatchObject({ name: 'Ada L.', disabled: true, version: 3 });
    expect(await stored(ada.id)).toMatchObject({ name: 'Ada L.', disabled: true, version: 3 });
  });

  it('refuses the rename instead when it was made from the version before the disable', async () => {
    const ada = await add();
    raceAfter('get', () => updateMember(ctx, S, ada.id, { disabled: true }, NO_SSO, 'system'));
    const lost = await updateMember(
      ctx,
      S,
      ada.id,
      { name: 'Ada L.', expectedVersion: 1 },
      NO_SSO,
      'system',
    ).catch((e: unknown) => e);
    expect(lost).toBeInstanceOf(ConflictError);
    expect(lost).toMatchObject({ details: { version: 2 } });
    expect(await stored(ada.id)).toMatchObject({ name: 'Ada', disabled: true, version: 2 });
  });

  it('never brings back a person removed after a rename read them (rename vs remove)', async () => {
    const ada = await add();
    raceAfter('get', () => removeMember(ctx, S, ada.id, NO_SSO));
    await expect(
      updateMember(ctx, S, ada.id, { name: 'Ada L.' }, NO_SSO, 'system'),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(await stored(ada.id)).toBeNull();
    expect(await store.members.list(S)).toEqual([]);
  });

  it('lets only one of two role changes from the same version land', async () => {
    const ada = await add();
    raceAfter('get', () =>
      updateMember(ctx, S, ada.id, { role: 'viewer', expectedVersion: 1 }, NO_SSO, 'system'),
    );
    const lost = await updateMember(
      ctx,
      S,
      ada.id,
      { role: 'manager', expectedVersion: 1 },
      NO_SSO,
      'system',
    ).catch((e: unknown) => e);
    expect(lost).toBeInstanceOf(ConflictError);
    expect(await stored(ada.id)).toMatchObject({
      roleId: await presetRoleId(ctx, S, 'viewer'),
      version: 2,
    });

    // Without a version the later change is made over the earlier one, as if one after the other.
    raceAfter('get', () => updateMember(ctx, S, ada.id, { role: 'editor' }, NO_SSO, 'system'));
    const later = await updateMember(ctx, S, ada.id, { role: 'approver' }, NO_SSO, 'system');
    expect(later).toMatchObject({ roleId: await presetRoleId(ctx, S, 'approver'), version: 4 });
  });

  it('refuses a delegated bearer and the last admin before a stale version', async () => {
    const ada = await add('ada@example.com', 'admin');
    await updateMember(ctx, S, ada.id, { name: 'Ada L.' }, SSO, 'system');
    const oauth: Principal = {
      spaceId: S,
      kind: 'user',
      subject: 'usr_bot',
      scopes: [SCOPES.spaceAdmin],
      clientId: 'client-1',
      issuance: 'oauth',
    };
    // Stale and changing her role: the bearer refusal, judged against Ada as stored now.
    await expect(
      updateMember(ctx, S, ada.id, { role: 'viewer', expectedVersion: 1 }, SSO, oauth),
    ).rejects.toBeInstanceOf(DelegatedPeopleError);
    // Stale and turning off the last admin: the last-admin refusal.
    await expect(
      updateMember(ctx, S, ada.id, { disabled: true, expectedVersion: 1 }, SSO, 'system'),
    ).rejects.toBeInstanceOf(LastAdminError);
    // A delegated bearer may still rename at the version in force.
    expect(
      await updateMember(ctx, S, ada.id, { name: 'Ada', expectedVersion: 2 }, SSO, oauth),
    ).toMatchObject({ name: 'Ada', version: 3 });
  });

  describe('a delegated bearer’s change that loses the race, checked again on the retry', () => {
    const pat: Principal = {
      spaceId: S,
      kind: 'user',
      subject: 'usr_cli',
      scopes: [SCOPES.spaceAdmin],
      issuance: 'pat',
    };

    it('can’t turn back on someone disabled since it read them enabled', async () => {
      const bea = await add('bea@example.com', 'editor');
      // `disabled: false` over an enabled person is a no-op the bearer may make; after the
      // disable lands it would let them sign in again, which the retry refuses.
      raceAfter('get', () => updateMember(ctx, S, bea.id, { disabled: true }, NO_SSO, 'system'));
      await expect(
        updateMember(ctx, S, bea.id, { disabled: false }, NO_SSO, pat),
      ).rejects.toBeInstanceOf(DelegatedPeopleError);
      expect(await stored(bea.id)).toMatchObject({ disabled: true, version: 2 });
    });

    it('can’t put back a role changed since it read them', async () => {
      const bea = await add('bea@example.com', 'editor');
      // Naming the role she holds is no change; after the demotion it would give it back.
      raceAfter('get', () => updateMember(ctx, S, bea.id, { role: 'viewer' }, NO_SSO, 'system'));
      await expect(
        updateMember(ctx, S, bea.id, { role: 'editor' }, NO_SSO, pat),
      ).rejects.toBeInstanceOf(DelegatedPeopleError);
      expect(await stored(bea.id)).toMatchObject({
        roleId: await presetRoleId(ctx, S, 'viewer'),
        version: 2,
      });
    });
  });

  it('holds a preset given to a person to the version it names', async () => {
    const ada = await add();
    await updateMember(ctx, S, ada.id, { name: 'Ada L.' }, NO_SSO, 'system');
    await expect(
      assignRolePreset(
        ctx,
        S,
        { memberId: ada.id, expectedVersion: 1 },
        'viewer',
        NO_SSO,
        'system',
      ),
    ).rejects.toMatchObject({ code: 'conflict', details: { version: 2 } });
    const given = await assignRolePreset(
      ctx,
      S,
      { memberId: ada.id, expectedVersion: 2 },
      'viewer',
      NO_SSO,
      'system',
    );
    expect(given).toMatchObject({ roleId: await presetRoleId(ctx, S, 'viewer'), version: 3 });
  });

  it('checks the last admin again when a removal loses to a change', async () => {
    const ada = await add('ada@example.com', 'admin');
    const bea = await add('bea@example.com', 'admin');
    // Removing Bea read Ada an admin; meanwhile Bea was renamed, so the removal reads again.
    raceAfter('get', () => updateMember(ctx, S, bea.id, { name: 'Bea' }, SSO, 'system'));
    await removeMember(ctx, S, bea.id, SSO);
    expect(await stored(bea.id)).toBeNull();
    // Ada is the last admin now, so removing her is refused, however it races.
    raceAfter('get', () => updateMember(ctx, S, ada.id, { name: 'Ada L.' }, SSO, 'system'));
    await expect(removeMember(ctx, S, ada.id, SSO)).rejects.toBeInstanceOf(LastAdminError);
    expect(await stored(ada.id)).toMatchObject({ name: 'Ada L.', version: 2 });
  });

  it('refuses a second add of the same address that races the first', async () => {
    // The second add checks the address, then the first lands before it writes.
    const repo = store.members as { getByEmail: MemberRepo['getByEmail'] };
    const byEmail = repo.getByEmail;
    let raced = false;
    repo.getByEmail = async (spaceId, email) => {
      const read = await byEmail(spaceId, email);
      if (!raced) {
        raced = true;
        await addMember(ctx, S, { email: 'ada@example.com', role: 'viewer' }, 'system');
      }
      return read;
    };
    const lost = await add().catch((e: unknown) => e);
    expect(lost).toBeInstanceOf(ConflictError);
    expect((await store.members.list(S)).map((m) => m.roleId)).toEqual([
      await presetRoleId(ctx, S, 'viewer'),
    ]);
  });

  describe('an SSO first sign-in', () => {
    const ada = { sub: 'usr_ada', email: 'ada@example.com', role: 'member' as const };

    it('links the subject as the next version', async () => {
      const m = await add();
      const found = await findMemberForSignIn(ctx, S, ada.sub, ada.email);
      expect(found).toMatchObject({ id: m.id, subject: 'usr_ada', version: 2 });
      expect(await stored(m.id)).toMatchObject({ subject: 'usr_ada', version: 2 });
    });

    it('reads again and signs in when a rename lands during the link', async () => {
      const m = await add();
      raceAfter('list', () => updateMember(ctx, S, m.id, { name: 'Ada L.' }, NO_SSO, 'system'));
      const p = await principalForWebUser(ctx, S, ada);
      expect(p).toMatchObject({ spaceId: S, subject: 'usr_ada' });
      expect(await stored(m.id)).toMatchObject({
        name: 'Ada L.',
        subject: 'usr_ada',
        disabled: false,
        version: 3,
      });
    });

    it('keeps access turned off during the link, and refuses the sign-in', async () => {
      const m = await add();
      raceAfter('list', () => updateMember(ctx, S, m.id, { disabled: true }, NO_SSO, 'system'));
      await expect(principalForWebUser(ctx, S, ada)).rejects.toBeInstanceOf(ForbiddenError);
      expect(await stored(m.id)).toMatchObject({ disabled: true });
    });

    it('never brings back a person removed during the link', async () => {
      const m = await add();
      raceAfter('list', () => removeMember(ctx, S, m.id, NO_SSO));
      expect(await findMemberForSignIn(ctx, S, ada.sub, ada.email)).toBeNull();
      expect(await stored(m.id)).toBeNull();
    });

    it('does not take a row another subject linked first', async () => {
      const m = await add();
      raceAfter('list', () => findMemberForSignIn(ctx, S, 'usr_other', ada.email));
      expect(await findMemberForSignIn(ctx, S, ada.sub, ada.email)).toBeNull();
      expect(await stored(m.id)).toMatchObject({ subject: 'usr_other', version: 2 });
    });

    it('refuses the sign-in, unlinked, when every attempt loses', async () => {
      const m = await add();
      // Someone saves the person after each read, every time.
      const repo = store.members as { list: MemberRepo['list'] };
      const list = repo.list;
      let n = 0;
      let saving = false;
      repo.list = async (spaceId) => {
        const read = await list(spaceId);
        if (!saving) {
          // The other save lists the team too; it isn't raced itself.
          saving = true;
          await updateMember(ctx, S, m.id, { name: `Ada ${++n}` }, NO_SSO, 'system');
          saving = false;
        }
        return read;
      };
      await expect(principalForWebUser(ctx, S, ada)).rejects.toBeInstanceOf(ForbiddenError);
      repo.list = list;
      expect((await stored(m.id))?.subject).toBeUndefined();
    });
  });

  it('keeps people in one space out of another', async () => {
    await createSpace(ctx, { spaceId: 's2', name: 'S2', defaultLocale: 'en-US' });
    const ada = await add();
    await expect(
      updateMember(ctx, 's2', ada.id, { name: 'Elsewhere' }, NO_SSO, 'system'),
    ).rejects.toBeInstanceOf(NotFoundError);
    const stale: SpaceMember = { ...ada, spaceId: 's2', version: 2 };
    await expect(store.members.save(stale)).rejects.toThrow();
    expect(await store.members.list('s2')).toEqual([]);
  });
});

describe("a change to a person drops the space's cached principals", () => {
  it('on a role change, a disable and a removal', async () => {
    const cache = new InMemoryCache();
    const store = new InMemoryContentStore();
    const ctx: AppContext = {
      store,
      clock: new FixedClock(),
      ids: new SequenceIdGenerator('c'),
      cache,
    };
    await createSpace(ctx, { spaceId: S, name: 'S', defaultLocale: 'en-US' });
    const member = await addMember(
      ctx,
      S,
      { email: 'ada@example.com', name: 'Ada', role: 'editor' },
      'system',
    );
    // A principal authenticateCached would have stored for a token of this space.
    const cached = () =>
      cache.set('principal:h:token', '{}', { ttlSeconds: 60, tags: [`principals:${S}`] });

    await cached();
    await updateMember(ctx, S, member.id, { role: 'viewer' }, NO_SSO, 'system');
    expect(await cache.get('principal:h:token')).toBeNull();

    await cached();
    await updateMember(ctx, S, member.id, { disabled: true }, NO_SSO, 'system');
    expect(await cache.get('principal:h:token')).toBeNull();

    await cached();
    await removeMember(ctx, S, member.id, NO_SSO);
    expect(await cache.get('principal:h:token')).toBeNull();
  });
});
