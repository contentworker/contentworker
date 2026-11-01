import { DomainError } from '../errors.js';
import type { RolePreset } from './team.js';

/** The kind of API key — the CMA/CDA/CPA (management/delivery/preview) split. */
export type ApiKeyKind = 'cma' | 'cda' | 'cpa';

/** Permission scopes. A principal's scopes are checked per operation. */
export const SCOPES = {
  contentWrite: 'content:write',
  contentPublish: 'content:publish',
  contentManage: 'content:manage', // content type definitions
  deliveryRead: 'delivery:read', // published content
  previewRead: 'preview:read', // draft/current content
  searchRead: 'search:read',
  spaceAdmin: 'space:admin', // manage API keys
  /** Decide workflow approvals (the Approver preset and up). */
  workflowApprove: 'workflow:approve',
} as const;
export type PermissionScope = (typeof SCOPES)[keyof typeof SCOPES];

/** Default scope set granted to each key kind. */
export function scopesForKind(kind: ApiKeyKind): PermissionScope[] {
  switch (kind) {
    case 'cma':
      return [
        SCOPES.contentWrite,
        SCOPES.contentPublish,
        SCOPES.contentManage,
        SCOPES.deliveryRead,
        SCOPES.previewRead,
        SCOPES.searchRead,
        SCOPES.spaceAdmin,
        SCOPES.workflowApprove,
      ];
    case 'cda':
      return [SCOPES.deliveryRead, SCOPES.searchRead];
    case 'cpa':
      return [SCOPES.previewRead, SCOPES.deliveryRead, SCOPES.searchRead];
  }
}

/** Content-level actions a role can grant per content type. */
export type ContentAction = 'read' | 'write' | 'publish';

/**
 * Per-content-type grant inside a role. `contentTypeApiId: '*'` matches any
 * type; an exact apiId wins over the wildcard. Field rules refine access:
 * denied fields are masked on read and rejected on write; read-only fields
 * are readable but rejected on write.
 */
export interface ContentTypeGrant {
  readonly contentTypeApiId: string;
  readonly actions: readonly ContentAction[];
  readonly deniedFields?: readonly string[];
  readonly readOnlyFields?: readonly string[];
}

/**
 * A named, space-scoped permission set assignable to API keys. Roles are the
 * live source of truth: a key with a role resolves the role's scopes and
 * content grants on every request, so editing a role updates every key.
 */
export interface Role {
  readonly id: string;
  readonly spaceId: string;
  readonly name: string;
  readonly description?: string;
  readonly scopes: readonly string[];
  readonly contentGrants: readonly ContentTypeGrant[];
  /**
   * Set on the built-in roles seeded into every space (`viewer` … `admin`, see
   * `ROLE_PRESETS`). A preset role is edited like any other but can't be deleted; a clone of
   * one is an ordinary custom role.
   */
  readonly preset?: RolePreset;
}

/**
 * How a token was issued. All are stored, authenticated and revoked
 * identically — this only records provenance, so the admin can tell an
 * operator-minted key from one an OAuth client obtained. `setup` is the
 * administrator credential first-run setup (or a recovery code) created for a
 * person; it stops authenticating while the space requires SSO sign-in.
 */
export type TokenIssuance = 'key' | 'oauth' | 'pat' | 'setup';

/** A stored API key. The raw token is never persisted — only its hash. */
export interface ApiKey {
  readonly id: string;
  readonly spaceId: string;
  readonly kind: ApiKeyKind;
  /** Optional human-readable label. */
  readonly name?: string;
  readonly hashedToken: string;
  readonly scopes: readonly string[];
  readonly revoked: boolean;
  /** When set, the key's permissions come from this role (live-resolved). */
  readonly roleId?: string;
  /** ISO timestamp of the last successful authentication (optional). */
  readonly lastUsedAt?: string;
  /** ISO timestamp after which the key no longer authenticates (optional). */
  readonly expiresAt?: string;
  /** How this token came into existence. Defaults to `key` when absent. */
  readonly issuance?: TokenIssuance;
  /**
   * The human this token acts for (OIDC subject / PAT owner). Its presence is
   * what makes the resolved principal a `user` rather than a bare key.
   */
  readonly subject?: string;
  /** The OAuth client that obtained this token, when `issuance` is `oauth`. */
  readonly clientId?: string;
}

/** The resolved identity of a request. `spaceId === '*'` is the admin/root scope. */
export interface Principal {
  readonly spaceId: string;
  readonly kind: ApiKeyKind | 'admin' | 'user';
  readonly scopes: readonly string[];
  /**
   * Content-level grants from the principal's role. `undefined` means
   * unrestricted (kind-based keys and the admin token) — every content type
   * and field is allowed at the coarse-scope level.
   */
  readonly contentGrants?: readonly ContentTypeGrant[];
  /** Human identity (OIDC subject or email) when kind is `user`. */
  readonly subject?: string;
  /** Session id for revocation when kind is `user`. */
  readonly sessionId?: string;
  /** The OAuth client acting on the subject's behalf, for audit attribution. */
  readonly clientId?: string;
}

export class UnauthorizedError extends DomainError {
  constructor(message = 'Invalid or missing credentials') {
    super('unauthorized', message);
  }
}

export class ForbiddenError extends DomainError {
  constructor(scope: string) {
    super('forbidden', `Missing required scope "${scope}"`);
  }
}

/** True if the principal may act in `targetSpace`. Admin (`*`) may act anywhere. */
export function inScope(principal: Principal, targetSpaceId: string): boolean {
  return principal.spaceId === '*' || principal.spaceId === targetSpaceId;
}

/**
 * Enforces that the principal holds `scope` and is acting within its space.
 * Throws ForbiddenError otherwise. The single authorization decision point.
 */
export function authorize(
  principal: Principal,
  scope: PermissionScope,
  targetSpaceId: string,
): void {
  if (!inScope(principal, targetSpaceId) || !principal.scopes.includes(scope)) {
    throw new ForbiddenError(scope);
  }
}

/** The grant governing `contentTypeApiId` — an exact match wins over `'*'`. */
export function grantFor(
  principal: Principal,
  contentTypeApiId: string,
): ContentTypeGrant | undefined {
  const grants = principal.contentGrants;
  if (!grants) return undefined;
  return (
    grants.find((g) => g.contentTypeApiId === contentTypeApiId) ??
    grants.find((g) => g.contentTypeApiId === '*')
  );
}

/** True when the principal may perform `action` on the content type. */
export function canAccessContentType(
  principal: Principal,
  action: ContentAction,
  contentTypeApiId: string,
): boolean {
  if (!principal.contentGrants) return true; // unrestricted principal
  const grant = grantFor(principal, contentTypeApiId);
  return !!grant && grant.actions.includes(action);
}

/**
 * Enforces a content-level grant on top of the coarse scopes. Unrestricted
 * principals (no role) always pass — coarse `authorize` already ran.
 */
export function authorizeContent(
  principal: Principal,
  action: ContentAction,
  contentTypeApiId: string,
): void {
  if (!canAccessContentType(principal, action, contentTypeApiId)) {
    throw new ForbiddenError(`content:${action}:${contentTypeApiId}`);
  }
}

/**
 * Strips the fields this principal may not read from an entry's field map.
 * Returns the input unchanged for unrestricted principals.
 */
export function maskDeniedFields<T>(
  principal: Principal,
  contentTypeApiId: string,
  fields: Record<string, T>,
): Record<string, T> {
  const denied = grantFor(principal, contentTypeApiId)?.deniedFields;
  if (!principal.contentGrants || !denied?.length) return fields;
  return Object.fromEntries(Object.entries(fields).filter(([apiId]) => !denied.includes(apiId)));
}

/**
 * Enforces field-level write rules: writing a denied or read-only field
 * throws ForbiddenError. No-op for unrestricted principals.
 */
export function assertWritableFields(
  principal: Principal,
  contentTypeApiId: string,
  fields: Record<string, unknown>,
): void {
  if (!principal.contentGrants) return;
  const grant = grantFor(principal, contentTypeApiId);
  const blocked = new Set([...(grant?.deniedFields ?? []), ...(grant?.readOnlyFields ?? [])]);
  for (const apiId of Object.keys(fields)) {
    if (blocked.has(apiId)) {
      throw new ForbiddenError(`content:write:${contentTypeApiId}.${apiId}`);
    }
  }
}

/**
 * Authorizes deciding an approval whose node asks for `requiredScope`, and returns the content
 * action the decider's role must also grant on the entry's type: `read` for `workflow:approve`
 * (an approver decides what they can see), `publish` for `content:publish`, else `write`.
 */
export function authorizeApproval(
  principal: Principal,
  requiredScope: PermissionScope,
  targetSpaceId: string,
): ContentAction {
  authorize(principal, requiredScope, targetSpaceId);
  if (requiredScope === SCOPES.workflowApprove) return 'read';
  return requiredScope === SCOPES.contentPublish ? 'publish' : 'write';
}
