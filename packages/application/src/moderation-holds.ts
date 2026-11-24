import type { ModerationHold, Principal, Scope } from '@contentworker/domain';
import {
  agentActor,
  ConflictError,
  canAccessContentType,
  type Entry,
  NotFoundError,
} from '@contentworker/domain';
import { TransactionConflictError } from '@contentworker/ports';
import { recordAgentRun } from './agent-audit';
import { type AppContext, withActor } from './context';
import { publishEntryTx, unpublishEntryTx } from './publishing';

/**
 * Moderation holds: an entry the moderation agent took offline, waiting on a person. Moderation
 * runs after a publish (agents dispatch off `entry.published`), so a flagged entry was live for a
 * moment; the on-publish pass unpublishes it and opens a hold in the same unit of work, and
 * Approvals lists it until someone republishes it or keeps it unpublished.
 */

/** What the moderation pass did with a flagged entry. */
export type ModerationHoldOutcome =
  /** Unpublished, with a hold open (a new one, or the open one pointed at this version). */
  | 'held'
  /** Left live: the live version is one a person republished over moderation. */
  | 'overridden'
  /** Already out of delivery (someone unpublished it first): nothing to take down or decide. */
  | 'not_published'
  /** The entry is gone. */
  | 'gone';

/**
 * Takes a flagged entry out of delivery and opens its hold, as one unit of work: the unpublish,
 * its `entry.unpublished` outbox row and the hold commit together or not at all. Written as the
 * moderation agent. A redelivered or retried pass finds the entry already unpublished and does
 * nothing, so the step is safe to run twice; a lost race with a concurrent publish or edit
 * surfaces as `TransactionConflictError` for the durable step to retry.
 *
 * A flag on a version a person republished over moderation leaves it live: without that, their
 * override would be undone by the moderation pass its own republish starts.
 */
export async function holdEntryForModeration(
  ctx: AppContext,
  scope: Scope,
  entryId: string,
  input: { readonly flags: readonly string[] },
): Promise<ModerationHoldOutcome> {
  const acting = withActor(ctx, agentActor('moderate'));
  return ctx.store.withTransaction(async (tx) => {
    // Reads first: the unit commits one batch, and a read in it doesn't see its own writes.
    const found = await tx.entries.get(scope, entryId);
    if (!found) return 'gone';
    const { entry } = found;
    if (entry.publishedVersion === null) return 'not_published';
    const holds = await tx.moderationHolds.list(scope, { entryId, limit: 20 });
    const released = holds.find((h) => h.status === 'republished');
    if (released && released.entryVersion === entry.publishedVersion) return 'overridden';
    const open = holds.find((h) => h.status === 'open');

    await unpublishEntryTx(acting, tx, scope, entryId);
    const at = { entryVersion: entry.currentVersion, flags: [...input.flags] };
    if (open) {
      await tx.moderationHolds.refresh(scope, open.id, {
        ...at,
        contentTypeApiId: entry.contentTypeApiId,
      });
    } else {
      await tx.moderationHolds.create(scope, {
        id: ctx.ids.newId(),
        entryId,
        contentTypeApiId: entry.contentTypeApiId,
        ...at,
        status: 'open',
        createdAt: ctx.clock.now().toISOString(),
      });
    }
    return 'held';
  });
}

/**
 * Closes an entry's open hold once moderation passes a later published version: the content it
 * was held for is no longer what is live, so nobody is left to decide it. Returns whether one was
 * open. Run by the on-publish pass after a clean verdict; a retry finds nothing open.
 */
export async function clearModerationHold(
  ctx: AppContext,
  scope: Scope,
  entryId: string,
): Promise<boolean> {
  const [open] = await ctx.store.moderationHolds.list(scope, { entryId, status: 'open', limit: 1 });
  if (!open) return false;
  return ctx.store.moderationHolds.decide(scope, open.id, {
    status: 'cleared',
    decidedAt: ctx.clock.now().toISOString(),
    decidedBy: agentActor('moderate'),
  });
}

/**
 * Moderation holds, newest first (`status` narrows; Approvals asks for `open`). A role-bound
 * principal sees only holds on content types it may read. Without a principal nothing is filtered.
 */
export async function listModerationHolds(
  ctx: AppContext,
  scope: Scope,
  query: { status?: ModerationHold['status']; entryId?: string; limit?: number } = {},
  principal?: Principal,
): Promise<ModerationHold[]> {
  const holds = await ctx.store.moderationHolds.list(scope, query);
  if (!principal?.contentGrants) return holds;
  return holds.filter((h) => canAccessContentType(principal, 'read', h.contentTypeApiId));
}

export async function getModerationHold(
  ctx: AppContext,
  scope: Scope,
  id: string,
): Promise<ModerationHold> {
  const hold = await ctx.store.moderationHolds.get(scope, id);
  if (!hold) throw new NotFoundError('ModerationHold', id);
  return hold;
}

export interface ModerationDecisionInput {
  /** Who decided (`principalActorId`): kept on the hold and in the agent ledger. */
  readonly decidedBy: string;
  /** Why, in their words. */
  readonly note?: string;
}

export interface ModerationDecisionResult {
  readonly hold: ModerationHold;
  /** The entry as the decision left it; null when it is gone. */
  readonly entry: Entry | null;
  /** True when this decision published the entry (Republish on an entry that wasn't live). */
  readonly published: boolean;
}

const flagsText = (hold: ModerationHold) =>
  hold.flags.length ? hold.flags.join(', ') : 'policy violation';

/** An open hold, or 404 / 409 (already decided), read before the unit writes. */
function assertOpen(hold: ModerationHold | null, id: string): ModerationHold {
  if (!hold) throw new NotFoundError('ModerationHold', id);
  if (hold.status !== 'open') {
    throw new ConflictError(`This hold was already decided (${hold.status})`, {
      status: hold.status,
    });
  }
  return hold;
}

/**
 * Runs a decision's unit of work, turning a lost race into a 409: another person decided the hold
 * first, or the entry was edited or published while this one decided.
 */
async function deciding<T>(ctx: AppContext, scope: Scope, id: string, unit: () => Promise<T>) {
  try {
    return await unit();
  } catch (err) {
    if (!(err instanceof TransactionConflictError)) throw err;
    assertOpen(await ctx.store.moderationHolds.get(scope, id), id);
    throw new ConflictError('The entry changed while this was being decided. Read it again.');
  }
}

/**
 * Republish: a person overrides moderation and puts the held version back in delivery. The
 * publish (with its `entry.published` outbox row) and the hold's close commit as one unit, so the
 * entry is never live with its hold still open, nor the hold closed with the entry offline.
 *
 * Refused with 409 when the entry was edited since it was held: what moderation judged is no
 * longer what would go out, so the new version is published from the entry, where moderation reads
 * it. An entry someone already published again just closes its hold. A gated workflow covering
 * the type still refuses (`publish_gated`): overriding moderation is not bypassing review.
 * The decision and the agent's flags go in the agent ledger.
 */
export async function republishHeldEntry(
  ctx: AppContext,
  scope: Scope,
  id: string,
  input: ModerationDecisionInput,
): Promise<ModerationDecisionResult> {
  const decidedAt = ctx.clock.now().toISOString();
  const result = await deciding(ctx, scope, id, () =>
    ctx.store.withTransaction(async (tx) => {
      const hold = assertOpen(await tx.moderationHolds.get(scope, id), id);
      const found = await tx.entries.get(scope, hold.entryId);
      if (!found) throw new NotFoundError('Entry', hold.entryId);
      const { entry } = found;
      const live =
        entry.publishedVersion !== null && entry.publishedVersion === entry.currentVersion;
      if (!live && entry.currentVersion !== hold.entryVersion) {
        throw new ConflictError(
          `The entry was edited after moderation held it (version ${hold.entryVersion}, now ${entry.currentVersion}). Publish it from the entry so moderation reads the new version.`,
          { heldVersion: hold.entryVersion, currentVersion: entry.currentVersion },
        );
      }
      // The hold closes before the publish's writes, so its compare-and-set leads the batch.
      await tx.moderationHolds.decide(scope, id, {
        status: 'republished',
        decidedAt,
        decidedBy: input.decidedBy,
        ...(input.note ? { note: input.note } : {}),
      });
      const published = live
        ? null
        : await publishEntryTx(ctx, tx, scope, hold.entryId, {
            expectedVersion: hold.entryVersion,
          });
      return { hold, entry: published ?? entry, published: published !== null };
    }),
  );
  await recordAgentRun(ctx, scope, {
    workflow: 'moderate',
    entryId: result.hold.entryId,
    status: 'completed',
    decisions: [
      `republished by ${input.decidedBy} over moderation (flagged: ${flagsText(result.hold)})`,
      ...(input.note ? [`reason: ${input.note}`] : []),
    ],
    usage: { inputTokens: 0, outputTokens: 0 },
  });
  return {
    hold: {
      ...result.hold,
      status: 'republished',
      decidedAt,
      decidedBy: input.decidedBy,
      ...(input.note ? { note: input.note } : {}),
    },
    entry: result.entry,
    published: result.published,
  };
}

/**
 * Keep unpublished: a person agrees with moderation and closes the hold; the entry stays out of
 * delivery and can be fixed and published from the editor (where moderation reads it again).
 * Refused with 409 when the entry is live again (someone published it since): keeping it offline
 * would then mean unpublishing what they put out, which is the entry's own Unpublish to decide.
 */
export async function keepHeldEntryUnpublished(
  ctx: AppContext,
  scope: Scope,
  id: string,
  input: ModerationDecisionInput,
): Promise<ModerationDecisionResult> {
  const decidedAt = ctx.clock.now().toISOString();
  const result = await deciding(ctx, scope, id, () =>
    ctx.store.withTransaction(async (tx) => {
      const hold = assertOpen(await tx.moderationHolds.get(scope, id), id);
      const found = await tx.entries.get(scope, hold.entryId);
      if (found && found.entry.publishedVersion !== null) {
        throw new ConflictError(
          'The entry was published again after moderation held it. Unpublish it from the entry to take it offline.',
          { publishedVersion: found.entry.publishedVersion },
        );
      }
      await tx.moderationHolds.decide(scope, id, {
        status: 'kept',
        decidedAt,
        decidedBy: input.decidedBy,
        ...(input.note ? { note: input.note } : {}),
      });
      return { hold, entry: found?.entry ?? null };
    }),
  );
  await recordAgentRun(ctx, scope, {
    workflow: 'moderate',
    entryId: result.hold.entryId,
    status: 'held',
    decisions: [
      `kept unpublished by ${input.decidedBy} (flagged: ${flagsText(result.hold)})`,
      ...(input.note ? [`reason: ${input.note}`] : []),
    ],
    usage: { inputTokens: 0, outputTokens: 0 },
  });
  return {
    hold: {
      ...result.hold,
      status: 'kept',
      decidedAt,
      decidedBy: input.decidedBy,
      ...(input.note ? { note: input.note } : {}),
    },
    entry: result.entry,
    published: false,
  };
}
