/**
 * The deployment-level human roles (`member` < `admin`, from `@contentworker/security`), their
 * labels, and how long a session lasts. Client-safe: pages import it for `useCan`.
 *
 * - `member` signs in and uses the CMS, within the content permissions the api grants per space.
 * - `admin` also manages people, single sign-on, SCIM provisioning, setup and the audit log.
 */

import type { Role } from '@contentworker/security/roles';

export { atLeast, isRole, ROLES, type Role } from '@contentworker/security/roles';

export const ROLE_LABELS: Record<Role, string> = {
  member: 'Member',
  admin: 'Admin',
};

/**
 * Who is acting in the web app. `id` is stable (`usr_…`, or `local` for open local development
 * before anyone has signed up); `name` is what the audit trail shows.
 */
export type Principal = {
  kind: 'user' | 'open';
  id: string;
  name: string;
  email?: string;
  role: Role;
};

/** A session ends this long after sign-in, whatever happens. */
export const SESSION_MAX_MS = 30 * 86_400_000;
/** A session also ends after this long without a request. */
export const SESSION_IDLE_MS = 7 * 86_400_000;
/** An admin's, sooner: an admin's browser left signed in can change who has access. */
export const SESSION_IDLE_ADMIN_MS = 12 * 3_600_000;

/** How long a session of `role` may go without a request before it ends. */
export const sessionIdleMs = (role: Role) =>
  role === 'admin' ? SESSION_IDLE_ADMIN_MS : SESSION_IDLE_MS;
/** Activity is written back at most this often. */
export const SESSION_TOUCH_MS = 5 * 60_000;
