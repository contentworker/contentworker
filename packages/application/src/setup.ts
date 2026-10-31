/**
 * First-run setup and admin recovery.
 *
 * A deployment's setup code is the `SETUP_TOKEN` secret, handed to the customer's first admin.
 * Redeeming it creates an administrator once: the code's hash is recorded when it is used, so it
 * never works twice. With admins already in place, a new code (set by whoever runs the
 * deployment, `scripts/setup-code.sh`) is the recovery path when no admin can sign in, and it
 * turns SSO-only sign-in off, since recovering access is for when sign-in itself is broken.
 *
 * While no space has an administrator (other than the bootstrap ADMIN_TOKEN), the edge refuses
 * everything but setup ({@link deploymentNeedsSetup}).
 */
import {
  DomainError,
  isEmail,
  normalizeEmail,
  type SpaceMember,
  UnauthorizedError,
  ValidationError,
} from '@contentworker/domain';
import type { Hasher } from '@contentworker/ports';
import { recordAudit } from './audit.js';
import { createApiKey } from './auth.js';
import type { AppContext } from './context.js';
import { createSpace } from './spaces.js';
import {
  type AccessPolicy,
  adminHolders,
  presetRoleId,
  readAccessSettings,
  writeAccessSettings,
} from './team.js';
import { secureTokenEqual } from './token-crypto.js';

/** The deployment setting holding the setup state. */
const SETUP_KEY = 'setup';

interface SetupState {
  /** Hash of the last setup code redeemed; that code never works again. */
  readonly usedCodeHash?: string;
}

export interface SetupOptions {
  /** The deployment's `SETUP_TOKEN`; absent means no code can be redeemed. */
  readonly setupToken?: string;
  /** The space the first administrator administers (created when it doesn't exist yet). */
  readonly spaceId: string;
  /** Used only when the space has to be created. */
  readonly defaultLocale: string;
  readonly policy: AccessPolicy;
}

/** A setup code that can't be used: none is configured, or it was used already. */
export class SetupCodeError extends DomainError {
  constructor(message: string) {
    super('setup_code', message);
  }
}

async function readState(ctx: AppContext): Promise<{ state: SetupState; version: number | null }> {
  const stored = await ctx.store.settings.get(SETUP_KEY);
  return { state: (stored?.value ?? {}) as SetupState, version: stored?.version ?? null };
}

/**
 * Whether the deployment is waiting for an administrator: no space has one (setup, or a key the
 * bootstrap ADMIN_TOKEN minted with `space:admin`, both count).
 */
export async function deploymentNeedsSetup(
  ctx: AppContext,
  policy: AccessPolicy,
): Promise<boolean> {
  for (const space of await ctx.store.spaces.list()) {
    if ((await adminHolders(ctx, space.spaceId, policy)).length > 0) return false;
  }
  return true;
}

export interface SetupStatus {
  /** No administrator yet: everything but setup is refused. */
  readonly needsSetup: boolean;
  /** A setup code is configured and hasn't been used: `/setup` can create an admin now. */
  readonly open: boolean;
  /** Single sign-on is configured: the new admin signs in with it instead of a token. */
  readonly sso: boolean;
}

export async function setupStatus(
  ctx: AppContext,
  hasher: Hasher,
  opts: SetupOptions,
): Promise<SetupStatus> {
  const { state } = await readState(ctx);
  const open = !!opts.setupToken && state.usedCodeHash !== hasher.hash(opts.setupToken);
  return {
    needsSetup: await deploymentNeedsSetup(ctx, opts.policy),
    open,
    sso: opts.policy.sso,
  };
}

export interface RedeemSetupInput {
  readonly code: string;
  readonly email: string;
  readonly name?: string;
}

export interface RedeemedSetup {
  readonly spaceId: string;
  readonly member: SpaceMember;
  /** True when admins already existed: this was a recovery. */
  readonly recovery: boolean;
  /**
   * The new administrator's credential, shown once (only its hash is stored). Absent on a first
   * setup with SSO, where the person signs in with their provider instead.
   */
  readonly token?: string;
  readonly keyId?: string;
}

/**
 * Creates an administrator from the setup code. Throws `UnauthorizedError` for a wrong code
 * (the edge throttles these per address), `SetupCodeError` for a missing or spent one, and
 * `ValidationError` for a bad email. Every use and every wrong guess is audited.
 */
export async function redeemSetupCode(
  ctx: AppContext,
  hasher: Hasher,
  opts: SetupOptions,
  input: RedeemSetupInput,
): Promise<RedeemedSetup> {
  const email = normalizeEmail(input.email ?? '');
  if (!isEmail(email)) {
    throw new ValidationError([{ field: 'email', message: 'A valid email address is required' }]);
  }
  const code = opts.setupToken;
  if (!code) {
    throw new SetupCodeError(
      'This deployment has no setup code. Ask whoever runs it to set SETUP_TOKEN.',
    );
  }
  if (!secureTokenEqual((input.code ?? '').trim(), code)) {
    await recordAudit(ctx, {
      spaceId: opts.spaceId,
      actor: email,
      action: 'team.setup_refused',
      targetType: 'setup',
      status: 401,
    }).catch(() => {});
    throw new UnauthorizedError('That setup code is not right');
  }

  // Claim the code before creating anyone, so two submissions at once can't both use it.
  const hash = hasher.hash(code);
  const { state: before, version } = await readState(ctx);
  if (before.usedCodeHash === hash) {
    throw new SetupCodeError(
      'That setup code has been used. Ask whoever runs the deployment for a new one.',
    );
  }
  const claimed = await ctx.store.settings.put(
    SETUP_KEY,
    { ...before, usedCodeHash: hash },
    version,
  );
  if (!claimed) {
    throw new SetupCodeError(
      'That setup code has been used. Ask whoever runs the deployment for a new one.',
    );
  }

  const recovery = !(await deploymentNeedsSetup(ctx, opts.policy));
  let result: RedeemedSetup;
  try {
    result = await createAdministrator(ctx, hasher, opts, email, input.name, recovery);
  } catch (err) {
    // Nobody was created: give the code back so it still works.
    const { version: now } = await readState(ctx);
    await ctx.store.settings.put(SETUP_KEY, before, now).catch(() => false);
    throw err;
  }

  // Recovering access is for when sign-in is broken, an identity provider included: the new
  // admin's credential must work, so SSO-only goes off until an admin turns it on again.
  const access = await readAccessSettings(ctx, opts.spaceId);
  if (access.ssoOnly) await writeAccessSettings(ctx, opts.spaceId, { ...access, ssoOnly: false });

  await recordAudit(ctx, {
    spaceId: opts.spaceId,
    actor: email,
    action: recovery ? 'team.recovery_admin' : 'team.first_admin',
    targetType: 'member',
    targetId: result.member.id,
    status: 201,
  });
  return result;
}

async function createAdministrator(
  ctx: AppContext,
  hasher: Hasher,
  opts: SetupOptions,
  email: string,
  name: string | undefined,
  recovery: boolean,
): Promise<RedeemedSetup> {
  const { spaceId } = opts;
  if (!(await ctx.store.spaces.getConfig({ spaceId, environmentId: 'main' }))) {
    await createSpace(ctx, { spaceId, name: spaceId, defaultLocale: opts.defaultLocale });
  }
  const adminRoleId = await presetRoleId(ctx, spaceId, 'admin');
  const now = ctx.clock.now().toISOString();
  const existing = await ctx.store.members.getByEmail(spaceId, email);
  // Recovery may name someone already on the team: they become an enabled administrator.
  const member: SpaceMember = existing
    ? { ...existing, roleId: adminRoleId, disabled: false, updatedAt: now }
    : {
        id: ctx.ids.newId(),
        spaceId,
        email,
        ...(name?.trim() ? { name: name.trim() } : {}),
        roleId: adminRoleId,
        disabled: false,
        createdAt: now,
        updatedAt: now,
      };
  await ctx.store.members.save(member);
  // First setup with SSO: the person signs in with it. Recovery always mints a credential, since
  // it is for when sign-in itself (the identity provider included) is broken.
  if (opts.policy.sso && !recovery) return { spaceId, member, recovery };

  const { apiKey, token } = await createApiKey(ctx, hasher, {
    spaceId,
    kind: 'cma',
    name: `Administrator (${email})`,
    roleId: adminRoleId,
    issuance: 'setup',
    subject: email,
  });
  return { spaceId, member, recovery, token, keyId: apiKey.id };
}
