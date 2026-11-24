/**
 * An entry the moderation agent took offline, waiting on a person to decide. Moderation runs after
 * a publish, so a flagged entry was briefly live; the on-publish pass unpublishes it and opens one
 * of these, which Approvals lists. A person either republishes the held version (overriding the
 * agent) or keeps it unpublished. A later version that moderation passes on publish closes it as
 * `cleared`: the content it was held for is no longer what is live.
 *
 * One open hold per entry: a second flag while one is open refreshes it to the version judged.
 */

export type ModerationHoldStatus = 'open' | 'republished' | 'kept' | 'cleared';

export interface ModerationHold {
  readonly id: string;
  readonly entryId: string;
  /** The entry's type when it was held, so the hold is counted and filtered without the entry. */
  readonly contentTypeApiId: string;
  /** The entry's `currentVersion` moderation judged: what Republish publishes again. */
  readonly entryVersion: number;
  /** The categories the classifier flagged (`hate`, `house_rules`, …); empty for an unnamed violation. */
  readonly flags: readonly string[];
  readonly status: ModerationHoldStatus;
  readonly createdAt: string;
  readonly decidedAt?: string;
  /** Who decided it (`principalActorId`), or `moderate` when a later clean pass cleared it. */
  readonly decidedBy?: string;
  /** Why, in the decider's words, when they gave a reason. */
  readonly note?: string;
  /**
   * Set on a listed open hold whose entry is live again at a newer version than the held one: what
   * it was held for is no longer what is live, so a person only closes it (Republish's stale path).
   */
  readonly stale?: true;
}
