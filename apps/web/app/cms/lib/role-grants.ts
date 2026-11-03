/**
 * The role editor's content grants: which of the five actions a grant holds, and the grant that
 * holding a different set means. The API keeps `delete` and `unpublish` implied (by `write` or
 * `publish`, and by `publish`) unless a grant withholds them, so a box ticked here is either a
 * listed action or the absence of a withhold.
 */
import {
  type ContentAction,
  type ContentTypeGrant,
  grantedActions,
  type ImpliedContentAction,
  type ListedContentAction,
} from '@contentworker/domain';

export { CONTENT_ACTIONS } from '@contentworker/domain';

/** Each action as the editor names it, with what it lets someone do. */
export const CONTENT_ACTION_LABELS: Record<ContentAction, { label: string; hint: string }> = {
  read: { label: 'Read', hint: 'See drafts and history' },
  write: { label: 'Write', hint: 'Create and edit drafts' },
  publish: { label: 'Publish', hint: 'Make changes live' },
  delete: { label: 'Delete', hint: 'Move to the trash, and purge with Publish' },
  unpublish: { label: 'Unpublish', hint: 'Take live entries down' },
};

const isImplied = (a: ContentAction): a is ImpliedContentAction =>
  a === 'delete' || a === 'unpublish';

/** Every action the grant holds, resolved as the API resolves it. */
export const heldActions = (grant: ContentTypeGrant): ReadonlySet<ContentAction> =>
  grantedActions(grant);

/** Whether `action` can be held next to `held`: `delete` needs write or publish, `unpublish` publish. */
export function actionAvailable(held: ReadonlySet<ContentAction>, action: ContentAction): boolean {
  if (action === 'delete') return held.has('write') || held.has('publish');
  if (action === 'unpublish') return held.has('publish');
  return true;
}

/**
 * The grant with `action` turned on or off. A listed action comes and goes from `actions`, bringing
 * the finer actions it implies unless they were withheld; a finer one turned off is withheld and
 * turned on is no longer withheld. A withhold with nothing left to withhold from is dropped.
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
  const listed = new Set<ContentAction>(actions);
  denied = denied.filter((a) => actionAvailable(listed, a));
  const next: ContentTypeGrant = { ...grant, actions };
  if (denied.length) return { ...next, deniedActions: denied };
  delete (next as { deniedActions?: unknown }).deniedActions;
  return next;
}

/** A short line for the roles table: each grant's type and what it holds. */
export function describeGrants(grants: readonly ContentTypeGrant[]): string {
  if (grants.length === 0) return 'No content';
  return grants
    .map((g) => {
      const held = [...heldActions(g)].map((a) => CONTENT_ACTION_LABELS[a].label.toLowerCase());
      const type = g.contentTypeApiId === '*' ? 'Every type' : g.contentTypeApiId;
      return `${type}: ${held.length ? held.join(', ') : 'nothing'}`;
    })
    .join(' · ');
}
