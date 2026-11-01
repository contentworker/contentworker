import { type Principal, SCOPES, type Scope, scopesForKind } from '@contentworker/domain';
import type { Hasher } from '@contentworker/ports';
import type { AppContext } from './context';
import { getEntry } from './entries';
import { randomSecret } from './token-crypto';

const DEFAULT_TTL_HOURS = 72;

export interface PreviewLink {
  readonly url: string;
  readonly token: string;
  readonly expiresAt: string;
}

export interface CreatePreviewLinkInput {
  readonly ttlHours?: number;
  /** Base URL for the preview API (e.g. https://cms.example.com). */
  readonly previewBaseUrl: string;
}

/**
 * Mints an expiring preview token for a single entry. The raw token is returned
 * once; only its hash is stored.
 */
export async function createPreviewLink(
  ctx: AppContext,
  hasher: Hasher,
  scope: Scope,
  entryId: string,
  input: CreatePreviewLinkInput,
): Promise<PreviewLink> {
  await getEntry(ctx, scope, entryId);

  const ttlHours = input.ttlHours ?? DEFAULT_TTL_HOURS;
  const expiresAt = new Date(ctx.clock.now());
  expiresAt.setHours(expiresAt.getHours() + ttlHours);

  const token = `pw_${randomSecret()}`;
  const id = ctx.ids.newId();

  await ctx.store.previewTokens.create({
    id,
    spaceId: scope.spaceId,
    environmentId: scope.environmentId,
    entryId,
    hashedToken: hasher.hash(token),
    expiresAt,
    revoked: false,
  });

  const base = input.previewBaseUrl.replace(/\/$/, '');
  const url = `${base}/preview/${scope.spaceId}/${scope.environmentId}/entries/${entryId}?preview_token=${token}`;
  return { url, token, expiresAt: expiresAt.toISOString() };
}

/** Resolves a preview link token to a read-only CPA principal for one entry. */
export async function principalFromPreviewToken(
  ctx: AppContext,
  hasher: Hasher,
  scope: Scope,
  entryId: string,
  token: string | undefined,
): Promise<Principal | null> {
  if (!token) return null;
  const record = await ctx.store.previewTokens.findByHash(hasher.hash(token));
  if (!record || record.revoked) return null;
  if (
    record.spaceId !== scope.spaceId ||
    record.environmentId !== scope.environmentId ||
    record.entryId !== entryId
  ) {
    return null;
  }
  if (record.expiresAt.getTime() <= ctx.clock.now().getTime()) return null;

  const view = await getEntry(ctx, scope, entryId);
  return {
    spaceId: scope.spaceId,
    kind: 'cpa',
    scopes: scopesForKind('cpa'),
    contentGrants: [
      {
        contentTypeApiId: view.entry.contentTypeApiId,
        actions: ['read'],
      },
    ],
  };
}

/** Builds a human OIDC principal from session claims and an assigned role. */
export function principalFromOidcUser(input: {
  readonly subject: string;
  readonly spaceId: string;
  readonly scopes: readonly string[];
  readonly contentGrants?: Principal['contentGrants'];
  readonly sessionId: string;
}): Principal {
  return {
    spaceId: input.spaceId,
    kind: 'user',
    scopes: input.scopes.length ? input.scopes : [SCOPES.previewRead, SCOPES.contentWrite],
    contentGrants: input.contentGrants,
    subject: input.subject,
    sessionId: input.sessionId,
  };
}
