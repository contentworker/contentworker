import { createHash } from 'node:crypto';
import {
  DelegatedKeyMintError,
  DelegatedPeopleError,
  type Principal,
  SCOPES,
  scopesForKind,
} from '@contentworker/domain';
import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@contentworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  addMember,
  assignRolePreset,
  authenticate,
  cloneRole,
  createApiKey,
  createInvite,
  createPersonalAccessToken,
  createRole,
  createSpace,
  presetRoleId,
  removeMember,
  resendInvite,
  revokeInvite,
  setSsoOnly,
  updateMember,
  updateRole,
} from '../src/index';

const hasher = { hash: (v: string) => createHash('sha256').update(v).digest('hex') };
const SSO = { sso: true };
const S = 's1';

/** A person signed in to the admin, as the web Worker's signed `x-cw-principal` resolves. */
const session: Principal = {
  spaceId: S,
  kind: 'user',
  subject: 'usr_ada',
  scopes: [SCOPES.spaceAdmin],
};
/** The admin token (deployment-wide). */
const adminToken: Principal = { spaceId: '*', kind: 'admin', scopes: Object.values(SCOPES) };
/** An operator key with space:admin. */
const operator: Principal = { spaceId: S, kind: 'cma', scopes: [...scopesForKind('cma')] };

describe('a delegated bearer and the people on a team', () => {
  let ctx: AppContext;
  let pat: Principal;
  let oauth: Principal;
  /** Every caller that may still give access: a session, the admin token, an operator key. */
  let allowed: Principal[];

  beforeEach(async () => {
    ctx = {
      store: new InMemoryContentStore(),
      clock: new FixedClock(),
      ids: new SequenceIdGenerator('p'),
    };
    await createSpace(ctx, { spaceId: S, name: 'S', defaultLocale: 'en-US' });
    // Ada, an administrator who has signed in once, and a second admin to keep the last-admin
    // rule out of the way.
    const ada = await addMember(ctx, S, { email: 'ada@example.com', role: 'admin' }, 'system');
    await ctx.store.members.save({ ...ada, subject: session.subject });
    await addMember(ctx, S, { email: 'keeper@example.com', role: 'admin' }, 'system');
    // Her real personal access token, resolved as every request resolves it.
    const minted = await createPersonalAccessToken(ctx, hasher, {
      issuer: 'system',
      spaceId: S,
      subject: session.subject as string,
      name: 'cli',
      scopes: [SCOPES.spaceAdmin],
      expiresInDays: 7,
      issuerScopes: [SCOPES.spaceAdmin],
    });
    pat = await authenticate(ctx, hasher, minted.token);
    // What `authenticate` resolves for an OAuth app's `cwo_` token.
    oauth = { ...session, clientId: 'client-1', issuance: 'oauth' };
    allowed = [session, adminToken, operator];
  });

  it('resolves the personal access token as a space admin, so only delegation refuses it', () => {
    expect(pat).toMatchObject({ kind: 'user', issuance: 'pat', scopes: [SCOPES.spaceAdmin] });
  });

  it('refuses adding a person to the team, with a 403 that says to sign in', async () => {
    for (const actor of [pat, oauth]) {
      const refusal = addMember(ctx, S, { email: 'mallory@example.com', role: 'admin' }, actor);
      await expect(refusal).rejects.toBeInstanceOf(DelegatedPeopleError);
      await expect(refusal).rejects.toMatchObject({
        code: 'forbidden',
        details: { reason: 'delegated_bearer' },
        message: expect.stringMatching(
          /^A personal access token or OAuth token can't add a person to the team; sign in/,
        ),
      });
    }
    expect(await ctx.store.members.getByEmail(S, 'mallory@example.com')).toBeNull();
    for (const [i, actor] of allowed.entries()) {
      await expect(
        addMember(ctx, S, { email: `p${i}@example.com`, role: 'viewer' }, actor),
      ).resolves.toMatchObject({ email: `p${i}@example.com` });
    }
  });

  it("refuses changing a person's role either way, and lets the same role through", async () => {
    const grace = await addMember(ctx, S, { email: 'grace@example.com', role: 'editor' }, 'system');
    const editor = await presetRoleId(ctx, S, 'editor');
    for (const actor of [pat, oauth]) {
      for (const role of ['admin', 'viewer']) {
        await expect(updateMember(ctx, S, grace.id, { role }, SSO, actor)).rejects.toBeInstanceOf(
          DelegatedPeopleError,
        );
      }
      // The same role, as an editor that sends the whole row, is no change.
      await expect(
        updateMember(ctx, S, grace.id, { role: editor, name: 'Grace H' }, SSO, actor),
      ).resolves.toMatchObject({ roleId: editor, name: 'Grace H' });
    }
    expect((await ctx.store.members.get(S, grace.id))?.roleId).toBe(editor);
    for (const actor of allowed) {
      await expect(
        updateMember(ctx, S, grace.id, { role: 'manager' }, SSO, actor),
      ).resolves.toMatchObject({ roleId: await presetRoleId(ctx, S, 'manager') });
      await updateMember(ctx, S, grace.id, { role: 'editor' }, SSO, actor);
    }
  });

  it('refuses a preset given to a person through role_preset_assign’s use-case', async () => {
    const grace = await addMember(ctx, S, { email: 'grace@example.com', role: 'viewer' }, 'system');
    for (const actor of [pat, oauth]) {
      await expect(
        assignRolePreset(ctx, S, { memberId: grace.id }, 'admin', SSO, actor),
      ).rejects.toBeInstanceOf(DelegatedPeopleError);
    }
    await expect(
      assignRolePreset(ctx, S, { memberId: grace.id }, 'admin', SSO, session),
    ).resolves.toMatchObject({ roleId: await presetRoleId(ctx, S, 'admin') });
  });

  it('lets a token disable or remove someone, but not let them sign in again', async () => {
    const grace = await addMember(ctx, S, { email: 'grace@example.com', role: 'editor' }, 'system');
    await expect(
      updateMember(ctx, S, grace.id, { disabled: true }, SSO, pat),
    ).resolves.toMatchObject({ disabled: true });
    for (const actor of [pat, oauth]) {
      await expect(
        updateMember(ctx, S, grace.id, { disabled: false }, SSO, actor),
      ).rejects.toBeInstanceOf(DelegatedPeopleError);
    }
    expect((await ctx.store.members.get(S, grace.id))?.disabled).toBe(true);
    await expect(
      updateMember(ctx, S, grace.id, { disabled: false }, SSO, session),
    ).resolves.toMatchObject({ disabled: false });
    await removeMember(ctx, S, grace.id, SSO);
    expect(await ctx.store.members.get(S, grace.id)).toBeNull();
  });

  it('refuses widening a role someone holds, disabled or not; narrowing and unheld roles pass', async () => {
    const role = await createRole(ctx, S, { name: 'Writer', scopes: [SCOPES.previewRead] });
    const edit = (scopes: string[]) => ({ name: 'Writer', scopes });
    // Nobody holds it yet: a definition the bearer may shape.
    await expect(
      updateRole(ctx, S, role.id, edit([SCOPES.previewRead, SCOPES.contentWrite]), SSO, pat),
    ).resolves.toBeDefined();
    const grace = await addMember(ctx, S, { email: 'grace@example.com', role: role.id }, 'system');
    await updateMember(ctx, S, grace.id, { disabled: true }, SSO, 'system');
    for (const actor of [pat, oauth]) {
      await expect(
        updateRole(ctx, S, role.id, edit([SCOPES.previewRead, SCOPES.spaceAdmin]), SSO, actor),
      ).rejects.toThrow(/can't widen a role someone on the team holds/);
    }
    await expect(
      updateRole(ctx, S, role.id, edit([SCOPES.previewRead]), SSO, oauth),
    ).resolves.toMatchObject({ scopes: [SCOPES.previewRead] });
    await expect(
      updateRole(ctx, S, role.id, edit([SCOPES.previewRead, SCOPES.spaceAdmin]), SSO, session),
    ).resolves.toMatchObject({ scopes: [SCOPES.previewRead, SCOPES.spaceAdmin] });
    // A key holding it still answers with the key refusal, as before.
    const keyed = await createRole(ctx, S, { name: 'Build', scopes: [SCOPES.deliveryRead] });
    await createApiKey(ctx, hasher, {
      issuer: 'system',
      spaceId: S,
      kind: 'cda',
      roleId: keyed.id,
    });
    await expect(
      updateRole(ctx, S, keyed.id, { name: 'Build', scopes: [SCOPES.spaceAdmin] }, SSO, pat),
    ).rejects.toBeInstanceOf(DelegatedKeyMintError);
  });

  it('lets a token create and clone roles: holding one is checked when it is given', async () => {
    const role = await createRole(ctx, S, { name: 'Reader', scopes: [SCOPES.previewRead] });
    await expect(cloneRole(ctx, S, role.id, 'Reader 2')).resolves.toMatchObject({
      name: 'Reader 2',
    });
  });

  it("refuses widening a held role's content grants, as its scopes", async () => {
    const grants = [{ contentTypeApiId: 'post', actions: ['read' as const] }];
    const role = await createRole(ctx, S, {
      name: 'Reader',
      scopes: [SCOPES.previewRead],
      contentGrants: grants,
    });
    await addMember(ctx, S, { email: 'grace@example.com', role: role.id }, 'system');
    for (const contentGrants of [
      [{ contentTypeApiId: 'post', actions: ['read' as const, 'write' as const] }],
      [{ contentTypeApiId: '*', actions: ['read' as const] }],
      [], // no grants is unrestricted
    ]) {
      await expect(
        updateRole(
          ctx,
          S,
          role.id,
          { name: 'Reader', scopes: [SCOPES.previewRead], contentGrants },
          SSO,
          pat,
        ),
      ).rejects.toBeInstanceOf(DelegatedPeopleError);
    }
    expect((await ctx.store.roles.get(S, role.id))?.contentGrants).toEqual(grants);
  });

  it('refuses widening a role only an open invitation grants, pending or expired', async () => {
    const role = await createRole(ctx, S, { name: 'Contractor', scopes: [SCOPES.previewRead] });
    const widen = { name: 'Contractor', scopes: [SCOPES.previewRead, SCOPES.spaceAdmin] };
    const inviter: Principal = { ...adminToken };
    const issued = await createInvite(ctx, hasher, inviter, {
      email: 'grace@example.com',
      grants: [{ space: S, role: role.id }],
      expiresInDays: 1,
    });
    for (const actor of [pat, oauth]) {
      await expect(updateRole(ctx, S, role.id, widen, SSO, actor)).rejects.toThrow(
        /can't widen a role an open invitation grants/,
      );
    }
    // Expired, it can still be resent: still held.
    (ctx.clock as FixedClock).advance(2 * 86_400_000);
    await expect(updateRole(ctx, S, role.id, widen, SSO, pat)).rejects.toBeInstanceOf(
      DelegatedPeopleError,
    );
    // Revoked, it holds nothing.
    await revokeInvite(ctx, inviter, issued.invite.id);
    await expect(updateRole(ctx, S, role.id, widen, SSO, pat)).resolves.toMatchObject({
      scopes: widen.scopes,
    });
  });

  it('refuses turning SSO-only off, which brings the setup credential back; not turning it on', async () => {
    await expect(setSsoOnly(ctx, S, true, SSO, pat)).resolves.toEqual({ ssoOnly: true });
    for (const actor of [pat, oauth]) {
      await expect(setSsoOnly(ctx, S, false, SSO, actor)).rejects.toBeInstanceOf(
        DelegatedPeopleError,
      );
    }
    await expect(setSsoOnly(ctx, S, false, SSO, session)).resolves.toEqual({ ssoOnly: false });
  });
});

describe('a delegated bearer and invitations', () => {
  let ctx: AppContext;
  /** A deployment admin signed in to the admin. */
  const deploymentAdmin: Principal = {
    spaceId: '*',
    kind: 'user',
    subject: 'usr_ada',
    scopes: [...scopesForKind('cma')],
  };
  beforeEach(async () => {
    ctx = {
      store: new InMemoryContentStore(),
      clock: new FixedClock(),
      ids: new SequenceIdGenerator('i'),
    };
    await createSpace(ctx, { spaceId: S, name: 'S', defaultLocale: 'en-US' });
  });
  const invite = (by: Principal) =>
    createInvite(ctx, hasher, by, {
      email: 'grace@example.com',
      grants: [{ space: S, role: 'editor' }],
    });

  it('refuses creating and resending, even for a token that reached across the deployment', async () => {
    // Today a delegated token is bound to one space, so it never gets this far; the refusal holds
    // and says why should one ever reach further.
    const wide = [
      { ...deploymentAdmin, issuance: 'pat' as const },
      { ...deploymentAdmin, issuance: 'oauth' as const, clientId: 'client-1' },
    ];
    const narrow = { ...session, issuance: 'pat' as const };
    for (const actor of [...wide, narrow]) {
      await expect(invite(actor)).rejects.toMatchObject({
        code: 'forbidden',
        message: expect.stringMatching(/can't invite people; sign in/),
      });
    }
    const issued = await invite(deploymentAdmin);
    for (const actor of wide) {
      await expect(resendInvite(ctx, hasher, actor, issued.invite.id)).rejects.toBeInstanceOf(
        DelegatedPeopleError,
      );
    }
    await expect(
      resendInvite(ctx, hasher, deploymentAdmin, issued.invite.id),
    ).resolves.toBeDefined();
    // Revoking only takes a way in away.
    await expect(revokeInvite(ctx, adminToken, issued.invite.id)).resolves.toMatchObject({
      status: 'revoked',
    });
  });
});
