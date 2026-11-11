import type { ContentAction } from './auth/auth';
import { DomainError, type FieldIssue } from './errors';

/**
 * Promoting content from one environment to another (staging → main, say).
 *
 * A promotion pins each entry and content type it copies by version when it is requested (and the
 * block catalog and config, when it carries them), so nothing edited in the source afterwards is
 * swept in: a changed content type, catalog or config fails the apply. What is
 * live in the source goes live in the target (`publish`), and drafts go as drafts. A risk check
 * decides whether a person must approve it first; it is recorded so the approver sees why.
 */

/**
 * `applying` is held while a promotion is being applied: approving moves it there with a
 * compare-and-set, so a second approval (or a double click) finds it gone and applies nothing.
 */
export const PROMOTION_STATUSES = [
  'awaiting_approval',
  'applying',
  'completed',
  'rejected',
  'failed',
] as const;
export type PromotionStatus = (typeof PROMOTION_STATUSES)[number];

/** A content type a promotion copies, pinned by version: a changed source fails the apply. */
export interface PromotedContentType {
  readonly apiId: string;
  readonly version: number;
}

/** An entry a promotion copies: the source version pinned, and whether it goes live. */
export interface PromotedEntry {
  readonly entryId: string;
  readonly contentTypeApiId: string;
  readonly version: number;
  readonly publish: boolean;
}

/**
 * The block catalog and block config a promotion copies, pinned by the source's versions and the
 * target's: another push or set on either side fails the apply, as a changed content type does.
 */
export interface PromotedBlocks {
  /** The source catalog's version: the target gets its blocks and targets as a push of its own. */
  readonly catalogVersion: number;
  /** The source config's version; 0 (never set) leaves the target's config as it is. */
  readonly configVersion: number;
  /**
   * The target's catalog and config versions (0 for none) the risk check was made against: a push
   * or set there since fails the apply too, so nothing lands that the approver didn't see.
   */
  readonly targetCatalogVersion: number;
  readonly targetConfigVersion: number;
}

/** What a decision model made of the promotion (absent without one). */
export interface PromotionAssessment {
  /** Probability that a person should check it before it goes live. */
  readonly review: number;
  /** Probability that it removes or breaks content readers or integrations depend on. */
  readonly breaking: number;
  /** Routine (0) … High-risk (3), probability-weighted. */
  readonly risk: number;
  readonly source: 'model' | 'heuristic';
  /** Why the heuristic answered, when it did. */
  readonly fallback?: string;
}

/** The decision model's risk levels, `PromotionAssessment.risk` 0 … 3. */
export const PROMOTION_RISK_LEVELS = ['Routine', 'Minor', 'Significant', 'High-risk'] as const;

export interface PromotionRisk {
  /** The target is `main` or an alias points at it. */
  readonly protectedTarget: boolean;
  /** What the rules found, one line each; any of them requires approval. */
  readonly reasons: readonly string[];
  readonly assessment?: PromotionAssessment;
  readonly requiresApproval: boolean;
}

export interface PromotionResult {
  readonly contentTypes: readonly string[];
  readonly entries: readonly string[];
  readonly published: readonly string[];
  /** Entries whose fields in the target don't match the pinned version afterwards. */
  readonly mismatched: readonly string[];
  /**
   * Entries that were live in the source but went as drafts, because a workflow gates publishing
   * them in the target (its run publishes them, not a promotion).
   */
  readonly gated: readonly string[];
  /** Whether the target's block catalog and config changed: absent when it carried neither. */
  readonly blocks?: { readonly catalog: boolean; readonly config: boolean };
  /**
   * On a failed apply, why the target refused an entry: each issue with the entry and its type
   * (`error` names the entry alone). Only a principal that reads every field of the promotion's
   * types reads the record (`canReadPromotion`), so the issues need no hiding per reader.
   */
  readonly issues?: readonly PromotionIssue[];
}

/** A field issue the target raised against a promoted entry, as a failed apply records it. */
export interface PromotionIssue extends FieldIssue {
  readonly entryId: string;
  readonly contentTypeApiId: string;
}

/**
 * An apply that stopped after a write landed in the target: the promotion is `failed`, with its
 * `error` and what it wrote. Not a success (something is half-promoted), and not a refusal
 * (something changed): the error carries the record, so a caller can see what was written.
 */
export class PromotionFailedError extends DomainError {
  readonly promotion: Promotion;
  constructor(promotion: Promotion) {
    super(
      'promotion_failed',
      `Promotion ${promotion.id} stopped partway: ${promotion.error ?? 'it failed'}`,
    );
    this.promotion = promotion;
  }
}

export interface Promotion {
  readonly id: string;
  readonly spaceId: string;
  readonly source: string;
  readonly target: string;
  readonly contentTypes: readonly PromotedContentType[];
  readonly entries: readonly PromotedEntry[];
  /** The block catalog and config it copies; absent when it copies neither. */
  readonly blocks?: PromotedBlocks;
  readonly status: PromotionStatus;
  readonly risk: PromotionRisk;
  /** Who asked for it (their principal subject, or `admin-token`). */
  readonly requestedBy: string;
  readonly decidedBy?: string;
  readonly result?: PromotionResult;
  readonly error?: string;
  readonly createdAt: string;
  readonly decidedAt?: string;
  readonly completedAt?: string;
}

/**
 * What requesting or deciding a promotion asks of a role, on every content type alike with no
 * field rules (`holdsOnEveryContentType`): it copies entries whole, hidden and read-only fields
 * included, with content types and blocks, so a role limited to some types or fields would reach
 * what its grants forbid.
 */
export const PROMOTION_CONTENT_ACTIONS: readonly ContentAction[] = ['read', 'write', 'publish'];

/**
 * What requesting or approving `promotion` asks on every content type: {@link
 * PROMOTION_CONTENT_ACTIONS}, and `lock` when it carries entries. Applying copies each entry whole
 * over the target's, locked regions of its blocks included (the copy can't judge regions: the
 * apply may run for no one, from the stale sweep), as editing a locked region takes `lock`.
 * Rejecting someone else's asks only the first three.
 */
export function promotionContentActions(promotion: {
  readonly entries: readonly unknown[];
}): readonly ContentAction[] {
  return promotion.entries.length > 0
    ? [...PROMOTION_CONTENT_ACTIONS, 'lock']
    : PROMOTION_CONTENT_ACTIONS;
}

/**
 * Whether `promotion` changes the schema (content types or the block catalog), so deciding it
 * either way takes `content:manage`, as changing them directly would.
 */
export function promotionChangesSchema(
  promotion: Pick<Promotion, 'contentTypes' | 'blocks'>,
): boolean {
  return promotion.contentTypes.length > 0 || !!promotion.blocks;
}

/** Most entries one promotion copies: it applies in one request. */
export const MAX_PROMOTION_ENTRIES = 200;
/** Most content types one promotion copies. */
export const MAX_PROMOTION_CONTENT_TYPES = 100;
