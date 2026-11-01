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

/** The fields `principal` may not read on `contentTypeApiId` (empty when unrestricted). */
export function deniedFieldsFor(principal: Principal, contentTypeApiId: string): readonly string[] {
  if (!principal.contentGrants) return [];
  return grantFor(principal, contentTypeApiId)?.deniedFields ?? [];
}

/** Every field name any of `principal`'s grants denies (for queries that name no type). */
function anyDeniedFields(principal: Principal): ReadonlySet<string> {
  return new Set((principal.contentGrants ?? []).flatMap((g) => g.deniedFields ?? []));
}

/**
 * Refuses a query that would reveal fields the principal may not read. Masking only hides values in
 * the response; a filter (`fields.salary[gt]=100000`), an ordering, a projection or a full-text
 * search evaluated over a hidden field still answers questions about it. So a query naming a
 * denied field is refused, and so is full-text search over a type with denied fields (the match
 * runs over every field and can't be masked per caller). `sys.*` fields are never field-restricted.
 * No-op for principals without field rules.
 */
export function assertQueryRespectsFieldRules(
  principal: Principal,
  query: {
    readonly contentTypeApiId?: string;
    readonly filters?: readonly { readonly field: string }[];
    readonly order?: readonly { readonly field: string }[];
    readonly select?: readonly string[];
    readonly search?: string;
  },
): void {
  if (!principal.contentGrants) return;
  const type = query.contentTypeApiId;
  const denied = type ? new Set(deniedFieldsFor(principal, type)) : anyDeniedFields(principal);
  if (denied.size === 0) return;
  const named = [
    ...(query.filters ?? []).map((f) => f.field),
    ...(query.order ?? []).map((o) => o.field),
    ...(query.select ?? []),
  ]
    .filter((f) => !f.startsWith('sys.'))
    .map((f) => f.replace(/^fields\./, '').split('.')[0] as string);
  const hit = named.find((f) => denied.has(f));
  if (hit) throw new ForbiddenError(`content:read:${type ?? '*'}.${hit}`);
  if (query.search) throw new ForbiddenError(`content:search:${type ?? '*'}`);
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
