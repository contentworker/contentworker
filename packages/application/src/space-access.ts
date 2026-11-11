import {
  type ContentActionsByType,
  contentActionsFor,
  type EntryBulkJobKind,
  entryBulkJobsFor,
  type FieldRulesByType,
  ForbiddenError,
  fieldRulesFor,
  inScope,
  type Principal,
} from '@contentworker/domain';

/**
 * Who a caller is in one space, and what its role there lets it do: what `GET
 * /spaces/:space/auth/me` and the `auth_me` tool answer alike. A person's role is per space, so a
 * client asks this before offering an action only some roles may take, or a field only some may
 * change. It names fields, never what they hold.
 */
export interface SpaceAccess {
  readonly spaceId: string;
  readonly kind: Principal['kind'];
  readonly scopes: readonly string[];
  readonly subject?: string;
  /** The role carries per-content-type grants. */
  readonly restricted: boolean;
  /** The bulk jobs over entries it may start here (`canRunEntryBulkJob`). */
  readonly bulkJobs: readonly EntryBulkJobKind[];
  /** The content actions its grants hold, per content type (`contentActionsFor`). */
  readonly contentActions: ContentActionsByType;
  /** The fields its grants hide or make read-only, per content type (`fieldRulesFor`). */
  readonly fieldRules: FieldRulesByType;
}

/**
 * The caller's access in `spaceId`. A key or person with no standing there is refused rather than
 * described (403).
 */
export function spaceAccessFor(principal: Principal, spaceId: string): SpaceAccess {
  if (!inScope(principal, spaceId)) throw new ForbiddenError('this space');
  return {
    spaceId: principal.spaceId,
    kind: principal.kind,
    scopes: principal.scopes,
    ...(principal.subject !== undefined ? { subject: principal.subject } : {}),
    restricted: principal.contentGrants !== undefined,
    bulkJobs: entryBulkJobsFor(principal),
    contentActions: contentActionsFor(principal),
    fieldRules: fieldRulesFor(principal),
  };
}
