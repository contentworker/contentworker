/**
 * The role editor's content grants: which of the six actions a grant holds, and the grant that
 * holding a different set means. The API keeps `delete` and `unpublish` implied (by `write` or
 * `publish`, and by `publish`) unless a grant withholds them, so a box ticked here is either a
 * listed action or the absence of a withhold.
 */
import {
  type ContentAction,
  type ContentTypeGrant,
  canHoldAction,
  grantedActions,
  IMPLIED_BY,
  type ImpliedContentAction,
  type ListedContentAction,
} from '@contentworker/domain';
import { ApiError, type RoleSummary, type RoleUpdate } from './management';

export { CONTENT_ACTIONS } from '@contentworker/domain';

/** Each action as the editor names it, with what it lets someone do. */
export const CONTENT_ACTION_LABELS: Record<ContentAction, { label: string; hint: string }> = {
  read: { label: 'Read', hint: 'See drafts and history' },
  write: { label: 'Write', hint: 'Create and edit drafts' },
  publish: { label: 'Publish', hint: 'Make changes live' },
  lock: { label: 'Lock', hint: 'Lock and unlock regions of an entry’s blocks' },
  delete: { label: 'Delete', hint: 'Move to the trash, and purge with Publish' },
  unpublish: { label: 'Unpublish', hint: 'Take live entries down' },
};

const isImplied = (a: ContentAction): a is ImpliedContentAction =>
  a === 'delete' || a === 'unpublish';

/** Every action the grant holds, resolved as the API resolves it. */
export const heldActions = (grant: ContentTypeGrant): ReadonlySet<ContentAction> =>
  grantedActions(grant);

/** Whether `action` can be held next to `held` (the domain's rule, {@link canHoldAction}). */
export const actionAvailable = (held: ReadonlySet<ContentAction>, action: ContentAction): boolean =>
  canHoldAction(held, action);

/** Why a finer action can't be ticked yet, in the editor's words: "Needs Write or Publish". */
export function actionNeeds(action: ContentAction): string | undefined {
  if (!isImplied(action)) return undefined;
  return `Needs ${IMPLIED_BY[action].map((a) => CONTENT_ACTION_LABELS[a].label).join(' or ')}`;
}

/** A content type's name for people: `*` is Every type, an unknown apiId shows as itself. */
export const contentTypeName = (apiId: string, names: ReadonlyMap<string, string>): string =>
  apiId === '*' ? 'Every type' : (names.get(apiId) ?? apiId);

/**
 * The grant with `action` turned on or off. A listed action comes and goes from `actions`, bringing
 * the finer actions it implies unless they were withheld; a finer one turned off is withheld and
 * turned on is no longer withheld. Every other withhold is kept as it was, even one the boxes can't
 * show: `unpublish` withheld on a write-only grant still stops it trashing a live entry, and
 * ticking Publish again must not hand back an Unpublish someone took away.
 */
export function setAction(
  grant: ContentTypeGrant,
  action: ContentAction,
  on: boolean,
): ContentTypeGrant {
  let actions = [...grant.actions];
  let denied = [...(grant.deniedActions ?? [])];
  if (isImplied(action)) {
    denied = on ? denied.filter((a) => a !== action) : [...new Set([...denied, action])];
  } else {
    actions = on
      ? [...new Set([...actions, action])]
      : actions.filter((a): a is ListedContentAction => a !== action);
  }
  const next: ContentTypeGrant = { ...grant, actions };
  if (denied.length) return { ...next, deniedActions: denied };
  delete (next as { deniedActions?: unknown }).deniedActions;
  return next;
}

/** A short line for the roles table: each grant's type and what it holds. */
export function describeGrants(
  grants: readonly ContentTypeGrant[],
  names: ReadonlyMap<string, string> = new Map(),
): string {
  if (grants.length === 0) return 'No content';
  return grants
    .map((g) => {
      const held = [...heldActions(g)].map((a) => CONTENT_ACTION_LABELS[a].label.toLowerCase());
      const type = contentTypeName(g.contentTypeApiId, names);
      return `${type}: ${held.length ? held.join(', ') : 'nothing'}`;
    })
    .join(' · ');
}

/** True when two grant lists say the same thing, in the same order. */
export const sameGrants = (a: readonly ContentTypeGrant[], b: readonly ContentTypeGrant[]) =>
  JSON.stringify(a) === JSON.stringify(b);

/**
 * Saves a role's content grants and nothing else. The API replaces a role whole, so the name,
 * description and scopes go back as the sheet loaded them, held to the version it loaded: if
 * anyone saved the role since, the API refuses (409) and writes nothing, rather than this save
 * silently undoing their change. {@link roleChanged} reads that refusal.
 */
export function saveRoleGrants(
  client: { updateRole(id: string, input: RoleUpdate): Promise<RoleSummary> },
  opened: RoleSummary,
  grants: readonly ContentTypeGrant[],
): Promise<RoleSummary> {
  return client.updateRole(opened.id, {
    name: opened.name,
    ...(opened.description ? { description: opened.description } : {}),
    scopes: opened.scopes,
    contentGrants: grants,
    expectedVersion: opened.version,
  });
}

/**
 * A role save refused because someone saved the role after it was loaded (409 `conflict`, from
 * `expectedVersion`): the version it is at now. Undefined for any other failure, a 409
 * `last_admin` among them.
 */
export function roleChanged(err: unknown): { readonly version: number } | undefined {
  if (!(err instanceof ApiError) || err.status !== 409 || err.code !== 'conflict') return undefined;
  const details = (err.body as { error?: { details?: { version?: unknown } } } | undefined)?.error
    ?.details;
  return typeof details?.version === 'number' ? { version: details.version } : undefined;
}
