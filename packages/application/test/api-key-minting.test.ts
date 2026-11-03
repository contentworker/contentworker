import { type Principal, SCOPES, scopesForKind } from '@contentworker/domain';
import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@contentworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  addMember,
  assignApiKeyRole,
  assignRolePreset,
  authenticate,
  createApiKey,
  createPersonalAccessToken,
  createSpace,
  presetRoleId,
} from '../src/index';

const hasher = { hash: (v: string) => `h:${v}` };
const NO_SSO = { sso: false };
const S = 's1';

/** A person signed in to the admin, as the web Worker's signed principal resolves. */
const person: Principal = {
  spaceId: S,
  kind: 'user',
  subject: 'ada@example.com',
  scopes: [SCOPES.spaceAdmin],
};
/** An operator key with space:admin. */
const operator: Principal = { spaceId: S, kind: 'cma', scopes: [...scopesForKind('cma')] };

describe('minting and widening API keys', () => {
  let ctx: AppContext;
  let pat: Principal;
  let oauth: Principal;
  beforeEach(async () => {
    ctx = {
      store: new InMemoryContentStore(),
      clock: new FixedClock(),
      ids: new SequenceIdGenerator('k'),
    };
    await createSpace(ctx, { spaceId: S, name: 'S', defaultLocale: 'en-US' });
    // Ada, signed in once (so her row is linked to her subject).
    const member = await addMember(ctx, S, { email: 'ada@example.com', role: 'admin' });
    await ctx.store.members.save({ ...member, subject: 'ada@example.com' });
    // A real personal access token, resolved as every request resolves it.
    const minted = await createPersonalAccessToken(ctx, hasher, {
      spaceId: S,
      subject: 'ada@example.com',
      name: 'ci',
      scopes: [SCOPES.spaceAdmin],
      expiresInDays: 30,
      issuerScopes: [SCOPES.spaceAdmin],
    });
    pat = await authenticate(ctx, hasher, minted.token);
    // An OAuth-issued principal: what `authenticate` resolves for a `cwo_` token.
    oauth = { ...person, clientId: 'client-1', issuance: 'oauth' };
  });

  it('resolves a personal access token as delegated', () => {
    expect(pat).toMatchObject({ kind: 'user', issuance: 'pat', scopes: [SCOPES.spaceAdmin] });
  });

  it('refuses a personal access token and an OAuth token, and lets a person or operator key mint', async () => {
    for (const issuer of [pat, oauth]) {
      await expect(createApiKey(ctx, hasher, { spaceId: S, kind: 'cma', issuer })).rejects.toThrow(
        /can't mint an API key/,
      );
    }
    for (const issuer of [person, operator]) {
      await expect(
        createApiKey(ctx, hasher, { spaceId: S, kind: 'cda', issuer }),
      ).resolves.toMatchObject({ apiKey: { kind: 'cda' } });
    }
    // Only the two keys minted by the person and the operator (and the PAT) exist.
    expect((await ctx.store.auth.list(S)).filter((k) => k.issuance === 'key')).toHaveLength(2);
  });

  it('lets a delegated bearer narrow a key, never widen one', async () => {
    const viewer = await presetRoleId(ctx, S, 'viewer');
    const key = (
      await createApiKey(ctx, hasher, {
        spaceId: S,
        kind: 'cma',
        roleId: await presetRoleId(ctx, S, 'manager'),
      })
    ).apiKey;
    // Narrower scopes, and the same grants: allowed.
    await expect(assignApiKeyRole(ctx, S, key.id, 'editor', NO_SSO, pat)).resolves.toBeDefined();
    // Other grants, even narrower ones, count as a change it may not make (grants aren't ordered).
    await expect(assignApiKeyRole(ctx, S, key.id, 'approver', NO_SSO, pat)).rejects.toThrow(
      /widen/,
    );
    // Wider scopes: refused, over either use-case.
    await expect(assignApiKeyRole(ctx, S, key.id, 'admin', NO_SSO, pat)).rejects.toThrow(/widen/);
    await expect(
      assignRolePreset(ctx, S, { keyId: key.id }, 'manager', NO_SSO, oauth),
    ).rejects.toThrow(/widen/);
    // Off its role, to the kind's unrestricted defaults: refused.
    await expect(assignApiKeyRole(ctx, S, key.id, null, NO_SSO, pat)).rejects.toThrow(/widen/);
    // The person may do any of it.
    await expect(assignApiKeyRole(ctx, S, key.id, viewer, NO_SSO, operator)).resolves.toBeDefined();
    await expect(assignApiKeyRole(ctx, S, key.id, 'admin', NO_SSO, person)).resolves.toBeDefined();
  });
});
