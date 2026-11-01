import { SCOPES, UnauthorizedError, ValidationError } from '@contentworker/domain';
import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@contentworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  addMember,
  authenticate,
  createApiKey,
  deploymentNeedsSetup,
  readAccessSettings,
  redeemSetupCode,
  SetupCodeError,
  type SetupOptions,
  setSsoOnly,
  setupStatus,
} from '../src/index.js';

const hasher = { hash: (v: string) => `h:${v}` };

describe('first-run setup', () => {
  let ctx: AppContext;
  const opts = (over: Partial<SetupOptions> = {}): SetupOptions => ({
    setupToken: 'code-1',
    spaceId: 'main-space',
    defaultLocale: 'en-US',
    policy: { sso: false },
    ...over,
  });

  beforeEach(() => {
    ctx = {
      store: new InMemoryContentStore(),
      clock: new FixedClock(),
      ids: new SequenceIdGenerator('s'),
    };
  });

  it('needs setup until a space has an administrator', async () => {
    expect(await deploymentNeedsSetup(ctx, { sso: false })).toBe(true);
    expect(await setupStatus(ctx, hasher, opts())).toEqual({
      needsSetup: true,
      open: true,
      sso: false,
    });
    expect((await setupStatus(ctx, hasher, opts({ setupToken: undefined }))).open).toBe(false);
  });

  it('needs no setup once a key administers a space', async () => {
    await ctx.store.spaces.create({
      spaceId: 'provisioned',
      name: 'Provisioned',
      defaultLocale: 'en-US',
      locales: ['en-US'],
    });
    // A delivery key alone is no administrator.
    await createApiKey(ctx, hasher, { spaceId: 'provisioned', kind: 'cda' });
    expect(await deploymentNeedsSetup(ctx, { sso: false })).toBe(true);
    await createApiKey(ctx, hasher, { spaceId: 'provisioned', kind: 'cma' });
    expect(await deploymentNeedsSetup(ctx, { sso: false })).toBe(false);
  });

  it('creates the first administrator once, with a credential shown once', async () => {
    const done = await redeemSetupCode(ctx, hasher, opts(), {
      code: ' code-1 ',
      email: 'Ada@Example.com',
      name: 'Ada',
    });
    expect(done).toMatchObject({ spaceId: 'main-space', recovery: false });
    expect(done.member).toMatchObject({ email: 'ada@example.com', name: 'Ada' });
    expect(done.token?.startsWith('cwsetup_cma_')).toBe(true);
    // The space was created, with its presets.
    expect(
      await ctx.store.spaces.getConfig({ spaceId: 'main-space', environmentId: 'main' }),
    ).toBeTruthy();
    const principal = await authenticate(ctx, hasher, done.token);
    expect(principal).toMatchObject({ kind: 'user', subject: 'ada@example.com' });
    expect(principal.scopes).toContain(SCOPES.spaceAdmin);
    expect(await deploymentNeedsSetup(ctx, { sso: false })).toBe(false);
    expect((await setupStatus(ctx, hasher, opts())).open).toBe(false);

    // The same code never works twice.
    await expect(
      redeemSetupCode(ctx, hasher, opts(), { code: 'code-1', email: 'eve@example.com' }),
    ).rejects.toBeInstanceOf(SetupCodeError);
    const audit = await ctx.store.audit.list('main-space', {});
    expect(audit.map((a) => a.action)).toContain('team.first_admin');
  });

  it('refuses a wrong code (audited), a missing code and a bad email', async () => {
    await expect(
      redeemSetupCode(ctx, hasher, opts(), { code: 'nope', email: 'ada@example.com' }),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    expect((await ctx.store.audit.list('main-space', {})).map((a) => a.action)).toEqual([
      'team.setup_refused',
    ]);
    await expect(
      redeemSetupCode(ctx, hasher, opts({ setupToken: undefined }), {
        code: 'x',
        email: 'ada@example.com',
      }),
    ).rejects.toBeInstanceOf(SetupCodeError);
    await expect(
      redeemSetupCode(ctx, hasher, opts(), { code: 'code-1', email: 'not-an-email' }),
    ).rejects.toBeInstanceOf(ValidationError);
    // None of these spent the code.
    expect((await setupStatus(ctx, hasher, opts())).open).toBe(true);
  });

  it('with SSO, adds the admin as a person who signs in with SSO (no token)', async () => {
    const done = await redeemSetupCode(ctx, hasher, opts({ policy: { sso: true } }), {
      code: 'code-1',
      email: 'ada@example.com',
    });
    expect(done.token).toBeUndefined();
    expect(done.member.email).toBe('ada@example.com');
    expect(await deploymentNeedsSetup(ctx, { sso: true })).toBe(false);
  });

  it('recovers with a new code: a new admin, and SSO-only turned off', async () => {
    const sso = opts({ policy: { sso: true } });
    await redeemSetupCode(ctx, hasher, sso, { code: 'code-1', email: 'ada@example.com' });
    await addMember(ctx, 'main-space', { email: 'grace@example.com', role: 'admin' });
    await setSsoOnly(ctx, 'main-space', true, { sso: true });

    const recovered = await redeemSetupCode(
      ctx,
      hasher,
      { ...sso, setupToken: 'code-2' },
      { code: 'code-2', email: 'ops@example.com' },
    );
    expect(recovered.recovery).toBe(true);
    expect((await readAccessSettings(ctx, 'main-space')).ssoOnly).toBe(false);
    // The recovery credential works because SSO-only is off.
    await expect(authenticate(ctx, hasher, recovered.token)).resolves.toMatchObject({
      subject: 'ops@example.com',
    });
    const actions = (await ctx.store.audit.list('main-space', {})).map((a) => a.action);
    expect(actions).toContain('team.recovery_admin');
  });
});
