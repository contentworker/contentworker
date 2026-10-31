/**
 * The deployment-level human roles, ordered: each can do everything the ones before it can.
 *
 * - `member` signs in to the admin and uses the CMS, within the content permissions the api
 *   grants them per space (roles, scopes, field grants: resolved by the api, not here).
 * - `admin` also manages people, single sign-on, SCIM provisioning, setup and the audit log.
 */

export const ROLES = ['member', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export const isRole = (v: unknown): v is Role => ROLES.includes(v as Role);

/** True when `role` is at least `min`. */
export function atLeast(role: Role | null | undefined, min: Role): boolean {
  return !!role && ROLES.indexOf(role) >= ROLES.indexOf(min);
}
