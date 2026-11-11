import {
  ConflictError,
  type ContentTypeGrant,
  DelegatedKeyMintError,
  DelegatedPeopleError,
  grantsAdmin,
  grantsNoWider,
  holdsScope,
  IMPLIED_CONTENT_ACTIONS,
  isDelegatedBearer,
  LISTED_CONTENT_ACTIONS,
  type MemberInvite,
  NotFoundError,
  type Principal,
  type Role,
  SCOPES,
  ValidationError,
} from '@contentworker/domain';
import { TransactionConflictError } from '@contentworker/ports';
import type { AppContext } from './context';
import { invalidateCachedPrincipals } from './principal-cache';
import { type AccessPolicy, assertKeepsAnAdmin } from './team';

export interface RoleInput {
  readonly name: string;
  readonly description?: string;
  readonly scopes: readonly string[];
  readonly contentGrants?: readonly ContentTypeGrant[];
}

/** What `updateRole` takes: the whole role, and optionally the version it was edited from. */
export interface RoleUpdateInput extends RoleInput {
  /** The version the edit was made from: another is a conflict. Absent: saved over whatever. */
  readonly expectedVersion?: number;
}

const KNOWN_SCOPES = new Set<string>(Object.values(SCOPES));
const LISTED = new Set<string>(LISTED_CONTENT_ACTIONS);
const IMPLIED = new Set<string>(IMPLIED_CONTENT_ACTIONS);

function validateRoleInput(input: RoleInput): void {
  const issues: { field: string; message: string }[] = [];
  if (!input.name?.trim()) issues.push({ field: 'name', message: 'Role name is required' });
  for (const scope of input.scopes ?? []) {
    if (!KNOWN_SCOPES.has(scope)) {
      issues.push({ field: 'scopes', message: `Unknown scope "${scope}"` });
    }
  }
  for (const grant of input.contentGrants ?? []) {
    if (!grant.contentTypeApiId?.trim()) {
      issues.push({ field: 'contentGrants', message: 'contentTypeApiId is required' });
    }
    // Read as strings: the input crossed a wire, and its type is what this proves.
    for (const action of (grant.actions ?? []) as readonly string[]) {
      if (IMPLIED.has(action)) {
        // One way to say it: `delete` and `unpublish` come with `write` and `publish`, so a grant
        // only ever names them to withhold them.
        issues.push({
          field: 'contentGrants',
          message: `"${action}" comes with ${action === 'delete' ? 'write or publish' : 'publish'}; list that, and withhold "${action}" with deniedActions`,
        });
      } else if (!LISTED.has(action)) {
        issues.push({ field: 'contentGrants', message: `Unknown action "${action}"` });
      }
    }
    for (const action of (grant.deniedActions ?? []) as readonly string[]) {
      if (!IMPLIED.has(action)) {
        issues.push({
          field: 'contentGrants',
          message: `deniedActions can withhold "delete" or "unpublish", not "${action}"`,
        });
      }
    }
  }
  if (issues.length > 0) throw new ValidationError(issues);
}

/** Creates a custom role (granular RBAC) in a space. */
export async function createRole(
  ctx: AppContext,
  spaceId: string,
  input: RoleInput,
): Promise<Role> {
  validateRoleInput(input);
  const role: Role = {
    id: ctx.ids.newId(),
    spaceId,
    name: input.name,
    description: input.description,
    scopes: [...input.scopes],
    contentGrants: [...(input.contentGrants ?? [])],
    version: 1,
  };
  await ctx.store.roles.save(role);
  await invalidateCachedPrincipals(ctx, spaceId);
  return role;
}

/**
 * A delegated bearer (an OAuth or personal access token) can't widen what a role's holders keep by
 * editing the role, as it can't by re-roling a key (`assignApiKeyRole`) or a person
 * (`updateMember`): new scopes, or content grants that aren't a narrowing of the held ones
 * (`grantsNoWider`), are refused while an active API key, anyone on the team or an open invitation
 * holds the role.
 * A disabled person counts: re-enabling them later shouldn't hand them a role a token widened.
 * Narrowing scopes or a grant's actions is not refused. A role nobody holds may change freely,
 * since giving it to anyone is checked on its own.
 */
async function refuseWideningHolders(ctx: AppContext, existing: Role, input: RoleInput) {
  const widens =
    input.scopes.some((s) => !holdsScope(existing.scopes, s)) ||
    !grantsNoWider(input.contentGrants, existing.contentGrants);
  if (!widens) return;
  const [keys, members] = await Promise.all([
    ctx.store.auth.list(existing.spaceId),
    ctx.store.members.list(existing.spaceId),
  ]);
  if (keys.some((k) => k.roleId === existing.id && !k.revoked)) throw new DelegatedKeyMintError();
  if (members.some((m) => m.roleId === existing.id)) {
    throw new DelegatedPeopleError('widen a role someone on the team holds');
  }
  // An open invitation (pending, or expired and still resendable) holds the role too: whoever
  // accepts joins with it as it reads then. Invitations are deployment-wide and listed at most
  // INVITE_SCAN at a time, so a list that may be cut short refuses rather than guesses.
  const now = ctx.clock.now();
  const open = await Promise.all(
    (['pending', 'expired'] as const).map((status) =>
      ctx.store.invites.list({ now, status, limit: INVITE_SCAN }),
    ),
  );
  const grantsIt = (i: MemberInvite) =>
    i.grants.some((g) => g.spaceId === existing.spaceId && g.roleId === existing.id);
  if (open.some((l) => l.length >= INVITE_SCAN) || open.flat().some(grantsIt)) {
    throw new DelegatedPeopleError('widen a role an open invitation grants');
  }
}

/** The most invitations one store list returns. */
const INVITE_SCAN = 500;

/**
 * Replaces a role's definition, as its next version. Keys and people holding it pick the change
 * up live. A preset role stays that preset. Refused with `LastAdminError` when dropping
 * `space:admin` would leave the space with no administrator. `editor` is the caller's principal
 * (the routes and tools), or `system` for the platform's own seeding: required, so no caller skips
 * the delegated-bearer check by leaving it out.
 *
 * Refused (409, naming the version in force) when `expectedVersion` isn't the stored version, or
 * when another save commits first: the version is the compare-and-set the write rides with, so of
 * two saves from the same read only one lands. The delegated-bearer and last-admin checks run
 * first, against the role as stored now, so a stale save is refused only when it would otherwise
 * be allowed, the same place a save that loses the race at commit is; nothing is written either way.
 */
export async function updateRole(
  ctx: AppContext,
  spaceId: string,
  id: string,
  input: RoleUpdateInput,
  policy: AccessPolicy,
  editor: Principal | 'system',
): Promise<Role> {
  validateRoleInput(input);
  const existing = await ctx.store.roles.get(spaceId, id);
  if (!existing) throw new NotFoundError('Role', id);
  if (editor !== 'system' && isDelegatedBearer(editor)) {
    await refuseWideningHolders(ctx, existing, input);
  }
  const role: Role = {
    id,
    spaceId,
    name: input.name,
    description: input.description,
    scopes: [...input.scopes],
    contentGrants: [...(input.contentGrants ?? [])],
    ...(existing.preset ? { preset: existing.preset } : {}),
    version: existing.version + 1,
  };
  if (grantsAdmin(existing.scopes) && !grantsAdmin(role.scopes)) {
    const roles = await ctx.store.roles.list(spaceId);
    await assertKeepsAnAdmin(ctx, spaceId, policy, {
      roles: roles.map((r) => (r.id === id ? role : r)),
    });
  }
  if (input.expectedVersion !== undefined && input.expectedVersion !== existing.version) {
    throw new ConflictError(
      `The role is at version ${existing.version}, not ${input.expectedVersion}: someone ` +
        'changed it since. Read it again and make the change over theirs.',
      { version: existing.version },
    );
  }
  try {
    await ctx.store.withTransaction(async (tx) => {
      await tx.roles.save(role);
    });
  } catch (err) {
    if (!(err instanceof TransactionConflictError)) throw err;
    // Another save landed between the read and the commit: name the version it left.
    const now = await ctx.store.roles.get(spaceId, id);
    if (!now) throw new NotFoundError('Role', id);
    throw new ConflictError('The role changed while it was being saved; read it again', {
      version: now.version,
    });
  }
  // Keys and people pick the change up on their next request, not when a cached principal expires.
  await invalidateCachedPrincipals(ctx, spaceId);
  return role;
}

export async function getRole(ctx: AppContext, spaceId: string, id: string): Promise<Role> {
  const role = await ctx.store.roles.get(spaceId, id);
  if (!role) throw new NotFoundError('Role', id);
  return role;
}

export async function listRoles(ctx: AppContext, spaceId: string): Promise<Role[]> {
  return ctx.store.roles.list(spaceId);
}

/**
 * Deletes a role. Refused for a built-in preset (edit or clone it instead), and while any active
 * API key or person still holds it.
 */
export async function deleteRole(ctx: AppContext, spaceId: string, id: string): Promise<void> {
  const role = await ctx.store.roles.get(spaceId, id);
  if (!role) throw new NotFoundError('Role', id);
  if (role.preset) {
    throw new ValidationError([
      { field: 'id', message: `“${role.name}” is a built-in role; edit or clone it instead` },
    ]);
  }
  const keys = await ctx.store.auth.list(spaceId);
  const holders = keys.filter((k) => k.roleId === id && !k.revoked);
  if (holders.length > 0) {
    throw new ValidationError([
      {
        field: 'id',
        message: `Role is assigned to ${holders.length} active API key(s); revoke them first`,
      },
    ]);
  }
  const people = (await ctx.store.members.list(spaceId)).filter((m) => m.roleId === id);
  if (people.length > 0) {
    throw new ValidationError([
      {
        field: 'id',
        message: `Role is held by ${people.length} person(s) on the team; change their role first`,
      },
    ]);
  }
  await ctx.store.roles.delete(spaceId, id);
  await invalidateCachedPrincipals(ctx, spaceId);
}
