import {
  type ContentAction,
  holdsOnEveryResolvedType,
  PROMOTION_CONTENT_ACTIONS,
  type Promotion,
  promotionChangesSchema,
  promotionContentActions,
  SCOPES,
} from '@contentworker/domain';
import type { PrincipalInfo } from './management';

/**
 * What the signed-in person may do with promotions, by the domain rules the api decides them with
 * (`PROMOTION_CONTENT_ACTIONS`, `promotionContentActions`, `promotionChangesSchema`), read over
 * their grants as the api resolves them (`contentActions` and `fieldRules` on the space's
 * `auth/me`). It only keeps a control out of the way of someone the api would refuse: the api
 * still decides, and refuses a role with two grants that this view can't tell from one.
 */

/** What the person lacks for a decision, when they lack something; said under the record. */
export type PromotionGap =
  /** Not a person, or no `content:publish`, or narrower than every content type. */
  | 'role'
  /** It carries content types or blocks, and the role lacks `content:manage`. */
  | 'manage'
  /** It carries entries, and the role lacks `lock` on every content type (approving only). */
  | 'lock';

export interface PromotionControls {
  /** Approve and promote… (never its requester). */
  readonly approve: boolean;
  /** Reject (never its requester: theirs is Withdraw). */
  readonly reject: boolean;
  /** Withdraw request: its requester's own rejection, which takes no decide rights. */
  readonly withdraw: boolean;
  /** Why Reject (and so Approve) isn't offered to someone other than the requester. */
  readonly rejectGap?: PromotionGap;
  /** Why Approve isn't offered when Reject is. */
  readonly approveGap?: PromotionGap;
}

const NONE: PromotionControls = { approve: false, reject: false, withdraw: false };

type Decided = Pick<Promotion, 'requestedBy' | 'contentTypes' | 'entries' | 'blocks'>;

/**
 * The decisions on `promotion` the api would take from `access`: nothing until it is read. Both
 * routes take `content:publish`, and a person (or the admin token) acting directly; an API key
 * never decides or withdraws.
 */
export function promotionControls(
  access: PrincipalInfo | undefined,
  promotion: Decided,
): PromotionControls {
  if (!access) return NONE;
  const person = access.kind === 'user' || access.kind === 'admin';
  const has = (scope: string) => access.scopes.includes(scope);
  const acting = person && has(SCOPES.contentPublish) && !!access.subject;
  if (access.subject === promotion.requestedBy) return { ...NONE, withdraw: acting };

  const rejectGap = rejectGapFor(access, promotion, acting);
  if (rejectGap) return { ...NONE, rejectGap };
  const approveGap = holdsEverywhere(access, promotionContentActions(promotion))
    ? undefined
    : 'lock';
  return approveGap
    ? { ...NONE, reject: true, approveGap }
    : { approve: true, reject: true, withdraw: false };
}

/** Deciding either way: the role on every type alike, then `content:manage` for a schema change. */
function rejectGapFor(
  access: PrincipalInfo,
  promotion: Decided,
  acting: boolean,
): PromotionGap | undefined {
  if (!acting || !holdsEverywhere(access, PROMOTION_CONTENT_ACTIONS)) return 'role';
  if (promotionChangesSchema(promotion) && !access.scopes.includes(SCOPES.contentManage)) {
    return 'manage';
  }
  return undefined;
}

/**
 * Whether `access` holds `actions` on every type alike with no field rules. Unknown grants (an
 * `auth/me` without them) hold nothing: the control stays hidden rather than meeting a 403.
 */
export function holdsEverywhere(access: PrincipalInfo, actions: readonly ContentAction[]): boolean {
  const { contentActions, fieldRules } = access;
  if (!contentActions || !fieldRules) return false;
  return holdsOnEveryResolvedType({ contentActions, fieldRules }, actions);
}
