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

/** Most entries one promotion copies: it applies in one request. */
export const MAX_PROMOTION_ENTRIES = 200;
/** Most content types one promotion copies. */
export const MAX_PROMOTION_CONTENT_TYPES = 100;
