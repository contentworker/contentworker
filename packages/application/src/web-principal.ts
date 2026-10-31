import { ForbiddenError, type Principal, scopesForKind } from '@contentworker/domain';
import type { AppContext } from './context.js';
import { findMemberForSignIn } from './team.js';

/** A person signed in to the admin web app, as the web Worker vouches for them. */
export interface WebUser {
  /** Stable user id from the web app (`usr_…`). */
  readonly sub: string;
  readonly email: string;
  /** Deployment role: `admin` runs the deployment (people, SSO, spaces); `member` uses it. */
  readonly role: 'admin' | 'member';
}

/** What a person may do in one space: their role (bound live by grants) and its scopes. */
export interface WebUserAccess {
  readonly spaceId: string;
  /** The team role, when they are on the space's team; absent for a deployment admin who is not. */
  readonly roleId?: string;
  readonly scopes: readonly string[];
  readonly contentGrants?: Principal['contentGrants'];
}

/**
 * A person's access to one space: their team role when they are on its team (refused when
 * disabled), else the full management scope set for a deployment admin, else ForbiddenError.
 */
export async function webUserAccess(
  ctx: AppContext,
  spaceId: string,
  user: WebUser,
): Promise<WebUserAccess> {
  const member = await findMemberForSignIn(ctx, spaceId, user.sub, user.email);
  if (member?.disabled) throw new ForbiddenError(`Your access to space ${spaceId} is disabled`);
  if (member?.roleId) {
    const role = await ctx.store.roles.get(spaceId, member.roleId);
    if (role) {
      return {
        spaceId,
        roleId: role.id,
        scopes: role.scopes,
        ...(role.contentGrants ? { contentGrants: role.contentGrants } : {}),
      };
    }
  }
  if (user.role === 'admin') return { spaceId, scopes: [...scopesForKind('cma')] };
  throw new ForbiddenError(`You are not on the team for space ${spaceId}`);
}

/** The spaces a person can act in, for a picker (consent screens, switchers). */
export async function spacesForWebUser(ctx: AppContext, user: WebUser): Promise<string[]> {
  const spaces = await ctx.store.spaces.list();
  const out: string[] = [];
  for (const space of spaces) {
    try {
      await webUserAccess(ctx, space.spaceId, user);
      out.push(space.spaceId);
    } catch (err) {
      if (!(err instanceof ForbiddenError)) throw err;
    }
  }
  return out;
}

/**
 * The principal a signed-in person acts as in one space (or across the deployment when the route
 * names no space).
 *
 * Content permissions come from the person's team membership in that space: their role's scopes
 * and per-type/per-field grants, resolved live, exactly as for a delegated API token. A disabled
 * member is refused. A deployment admin who is not on a space's team still administers it, with
 * the full management scope set: someone has to be able to create the first space and add people
 * to it. Everyone else not on the team is refused.
 */
export async function principalForWebUser(
  ctx: AppContext,
  spaceId: string | undefined,
  user: WebUser,
): Promise<Principal> {
  if (!spaceId) {
    if (user.role !== 'admin') throw new ForbiddenError('Only deployment administrators can do that');
    return { spaceId: '*', kind: 'user', subject: user.sub, scopes: [...scopesForKind('cma')] };
  }
  const access = await webUserAccess(ctx, spaceId, user);
  return {
    spaceId,
    kind: 'user',
    subject: user.sub,
    scopes: access.scopes,
    ...(access.contentGrants ? { contentGrants: access.contentGrants } : {}),
  };
}
