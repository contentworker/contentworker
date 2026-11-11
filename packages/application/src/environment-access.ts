import {
  authorize,
  authorizeEveryContentType,
  type ContentAction,
  ForbiddenError,
  type PermissionScope,
  type Principal,
} from '@contentworker/domain';
import { SYSTEM_CALLER } from './content-types';

/**
 * Who runs an operation over a whole environment (a snapshot export or import, a clone, a merge
 * of entries, a space export import): the request's principal, or {@link SYSTEM_CALLER} for work
 * already authorized as a whole (a clone's own export and import, a job's later chunks). Required,
 * so a new surface can't reach one of these without naming who it acts for.
 */
export type EnvironmentCaller = Principal | typeof SYSTEM_CALLER;

/**
 * Refuses anything that is neither {@link SYSTEM_CALLER} nor shaped as a principal: a caller the
 * type system was talked out of (`as never`, an argument in the wrong place) fails closed.
 */
export function assertEnvironmentCaller(caller: EnvironmentCaller): void {
  if (caller === SYSTEM_CALLER) return;
  const shaped =
    typeof caller === 'object' &&
    caller !== null &&
    typeof caller.kind === 'string' &&
    Array.isArray(caller.scopes);
  if (!shaped) {
    throw new ForbiddenError('An environment-wide operation runs for a principal or the system');
  }
}

/**
 * Holds `caller` to `actions` on every content type alike (`authorizeEveryContentType`): the
 * operation reads or writes every type and field there is, the ones it creates included, so a role
 * limited to some types or with field rules is refused before anything is read or written.
 */
export function authorizeEnvironmentWide(
  caller: EnvironmentCaller,
  actions: readonly ContentAction[],
): void {
  assertEnvironmentCaller(caller);
  if (caller === SYSTEM_CALLER) return;
  authorizeEveryContentType(caller, actions);
}

/**
 * Holds `caller` to a coarse scope in a space other than the one its request was authorized in
 * (a clone's target space): writing into a space the caller can't manage would be a tenancy hole.
 */
export function authorizeInSpace(
  caller: EnvironmentCaller,
  scope: PermissionScope,
  spaceId: string,
): void {
  assertEnvironmentCaller(caller);
  if (caller === SYSTEM_CALLER) return;
  authorize(caller, scope, spaceId);
}
