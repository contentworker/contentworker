import {
  type ApiKeyKind,
  canAccessContentType,
  type FrontendEndpoints,
  frontendEndpoints,
  holdsScope,
  NotFoundError,
  type Principal,
  scopesForKind,
  ValidationError,
} from '@contentworker/domain';
import type { Hasher } from '@contentworker/ports';
import { createApiKey, type KeyIssuer } from './auth';
import type { AppContext } from './context';
import { resolveWritableEnvironment } from './spaces';

export interface ConnectFrontendInput {
  readonly spaceId: string;
  /** The environment (or alias) the frontend reads, as it should appear in its config. */
  readonly environment: string;
  /** Names the keys (`<name> (delivery)`, `<name> (preview)`); default `Frontend`. */
  readonly name?: string;
  /**
   * Bind the Delivery key to a role, so it reads only what the role's content grants allow. A
   * role-bound key takes the role's scopes, so the role may hold no scope a Delivery key lacks
   * (`delivery:read`, `search:read`): a role that also reads drafts or writes is refused.
   */
  readonly roleId?: string;
  /** The same for the Preview key, whose role may also hold `preview:read`. */
  readonly previewRoleId?: string;
  /** Also mint a preview key, for a frontend with a draft mode (it reads drafts, server-side). */
  readonly preview?: boolean;
  /** The admin's origin (the deployment's `OAUTH_ISSUER`), or undefined when it isn't known. */
  readonly adminOrigin?: string;
  readonly issuer: KeyIssuer;
}

/** A minted key: its id, to revoke it, and its token, returned this once. */
export interface FrontendKey {
  readonly id: string;
  readonly token: string;
}

/** Everything a frontend's config needs, keys included. */
export interface FrontendConnection {
  readonly space: string;
  readonly environment: string;
  readonly deliveryKey: FrontendKey;
  readonly previewKey?: FrontendKey;
  /** Absent when the deployment doesn't know its admin origin. */
  readonly endpoints?: FrontendEndpoints;
  /** Each content type's preview URL template (null: not set), for the types the caller reads. */
  readonly previewUrls: readonly {
    readonly contentType: string;
    readonly name: string;
    readonly urlTemplate: string | null;
  }[];
}

/** Longest key name a connection makes (the API key name limit, less the suffix). */
const MAX_NAME = 100;

/**
 * Connects a frontend: mints a Delivery key (and, with `preview`, a Preview key) for the space,
 * and answers them with the endpoints and preview URLs the frontend's config names. Both keys go
 * through `createApiKey`, so a delegated bearer is refused as it is there; the tokens are returned
 * once and only their hashes are stored. The environment must exist: a typo would print a config
 * that never reads anything. Two keys are two writes; if the second fails the first stays listed,
 * to revoke or use.
 */
export async function connectFrontend(
  ctx: AppContext,
  hasher: Hasher,
  input: ConnectFrontendInput,
): Promise<FrontendConnection> {
  const name = (input.name ?? '').trim() || 'Frontend';
  if (name.length > MAX_NAME) {
    throw new ValidationError([
      { field: 'name', message: `At most ${MAX_NAME} characters, got ${name.length}` },
    ]);
  }
  const environmentId = await resolveWritableEnvironment(ctx, input.spaceId, input.environment);
  // Every check before either key is minted, so a refusal mints nothing.
  await assertRoleFits(ctx, input.spaceId, 'roleId', input.roleId, 'cda');
  if (input.preview) {
    await assertRoleFits(ctx, input.spaceId, 'previewRoleId', input.previewRoleId, 'cpa');
  }
  const types = await ctx.store.contentTypes.list({ spaceId: input.spaceId, environmentId });
  const mint = (kind: 'cda' | 'cpa', suffix: string, roleId: string | undefined) =>
    createApiKey(ctx, hasher, {
      spaceId: input.spaceId,
      kind,
      name: `${name} (${suffix})`,
      ...(roleId ? { roleId } : {}),
      issuer: input.issuer,
    });
  const delivery = await mint('cda', 'delivery', input.roleId);
  const preview = input.preview ? await mint('cpa', 'preview', input.previewRoleId) : undefined;
  const endpoints = input.adminOrigin ? frontendEndpoints(input.adminOrigin) : undefined;
  // The system issuer reads every type; a caller only the ones its grants let it read.
  const reads = (apiId: string) =>
    input.issuer === 'system' || canAccessContentType(input.issuer as Principal, 'read', apiId);
  return {
    space: input.spaceId,
    environment: input.environment,
    deliveryKey: { id: delivery.apiKey.id, token: delivery.token },
    ...(preview ? { previewKey: { id: preview.apiKey.id, token: preview.token } } : {}),
    ...(endpoints ? { endpoints } : {}),
    previewUrls: types
      .filter((t) => reads(t.apiId))
      .map((t) => ({
        contentType: t.apiId,
        name: t.name,
        urlTemplate: t.preview?.urlTemplate ?? null,
      })),
  };
}

/**
 * A role a frontend's key may be bound to: one of the space's, holding no scope beyond the key
 * kind's own. `authenticate` gives a role-bound key the role's scopes whatever its kind, so binding
 * a Delivery key to Viewer would let it read drafts, and to Editor would make it a management key.
 */
async function assertRoleFits(
  ctx: AppContext,
  spaceId: string,
  field: 'roleId' | 'previewRoleId',
  roleId: string | undefined,
  kind: ApiKeyKind,
): Promise<void> {
  if (!roleId) return;
  const role = await ctx.store.roles.get(spaceId, roleId);
  if (!role) throw new NotFoundError('Role', roleId);
  const allowed = scopesForKind(kind);
  const beyond = role.scopes.filter((s) => !holdsScope(allowed, s));
  if (beyond.length > 0) {
    throw new ValidationError([
      {
        field,
        message:
          `The role “${role.name}” also grants ${beyond.join(', ')}, which a ` +
          `${kind === 'cda' ? 'Delivery' : 'Preview'} key mustn’t hold. Pick a role with only ` +
          `${[...allowed].join(', ')}.`,
      },
    ]);
  }
}
