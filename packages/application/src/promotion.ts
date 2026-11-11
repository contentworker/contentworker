import {
  type BlockCatalog,
  type BlockConfig,
  blockRuleChanges,
  type CarriedBlockConfig,
  ConflictError,
  type ContentType,
  diffBlockCatalogs,
  EMPTY_BLOCK_CONFIG,
  type EntryFields,
  effectiveBlockConfig,
  effectiveBlockRules,
  extractReferences,
  ForbiddenError,
  InvalidStateError,
  MAX_PROMOTION_CONTENT_TYPES,
  MAX_PROMOTION_ENTRIES,
  NotFoundError,
  type Principal,
  type PromotedBlocks,
  type PromotedContentType,
  type PromotedEntry,
  type Promotion,
  type PromotionAssessment,
  type PromotionResult,
  type PromotionRisk,
  type PromotionStatus,
  planCatalogTypes,
  removedFields,
  removedVariants,
  SCOPES,
  type Scope,
  staleOverrideUses,
  ValidationError,
} from '@contentworker/domain';
import type { DecisionAnswer } from '@contentworker/ports';
import { decide } from './ai-decide';
import { wrapUntrusted } from './ai-prompt';
import { isUncheckedFallback } from './ai-provenance';
import { auditActor } from './audit';
import { assertThumbnailAssets, pushBlockCatalog } from './block-catalog';
import { blockConfigChange, setBlockConfig } from './block-config';
import { compareEnvironments } from './branching';
import {
  describeRemovedInUse,
  type RemovedContentInUse,
  removedContentInUse,
  SYSTEM_CALLER,
  saveContentTypeOver,
  staleOverridesOf,
} from './content-types';
import { type AppContext, withActor } from './context';
import { createEntry, updateEntry } from './entries';
import { loadPublishGuard } from './publish-gate';
import { publishEntry } from './publishing';
import { resolveEnvironment, resolveWritableEnvironment } from './spaces';
import {
  addHeld,
  assertNothingStranded,
  emptyHeld,
  type ReplacedCopies,
  replacedCopies,
  toRemovedInUse,
} from './stranding';

/**
 * Promoting content between environments, with a risk check and, when it calls for one, a
 * person's approval.
 *
 * Requesting pins what to copy: each entry by version (what is live in the source goes live in the
 * target, a draft goes as a draft), and each content type by apiId. The risk check runs then:
 * rules that always require approval (the target is `main` or an alias points at it; a content
 * type would lose a field at any depth or a block variant, change a field's type, or make one
 * required), and, with a decision model, its view of the change, which can only add a
 * requirement, never remove one. A promotion that needs no approval is applied at once; one that
 * does waits as `awaiting_approval` for someone other than the requester. One whose content types
 * remove a field or variant the target's entries still hold is refused outright, approved or not
 * (`assertNothingStranded`).
 *
 * Applying goes through the use-cases (`createEntry` / `updateEntry` / `publishEntry`, and the
 * content-type equivalents), so validation, references, events and the delivery cache all happen
 * as they would for a person's edits, then checks that the target holds what was pinned.
 */

export interface RequestPromotionInput {
  readonly source: string;
  readonly target: string;
  /** Content types to copy; omitted with `entries`, everything that differs. */
  readonly contentTypes?: readonly string[];
  /** Entries to copy; omitted with `contentTypes`, everything that differs. */
  readonly entries?: readonly string[];
  /**
   * Copy the source's block catalog and block config when they differ from the target's. By
   * default only when `contentTypes` and `entries` are both omitted (everything that differs).
   */
  readonly blocks?: boolean;
}

/** The probability at which the decision model's `review` asks for a person. */
const REVIEW_THRESHOLD = 0.5;
/** The `risk` score (0 Routine … 3 High-risk) at which it asks for one. */
const RISK_THRESHOLD = 2;
const RISK_LEVELS = ['Routine', 'Minor', 'Significant', 'High-risk'] as const;

export async function requestPromotion(
  ctx: AppContext,
  principal: Principal,
  spaceId: string,
  input: RequestPromotionInput,
): Promise<Promotion> {
  assertUnrestricted(principal);
  const sourceId = await resolveEnvironment(ctx, spaceId, input.source);
  const targetId = await resolveWritableEnvironment(ctx, spaceId, input.target);
  if (sourceId === targetId) {
    throw new ValidationError([{ field: 'target', message: 'Promote to a different environment' }]);
  }
  const source: Scope = { spaceId, environmentId: sourceId };
  const target: Scope = { spaceId, environmentId: targetId };

  // What to copy: the caller's selection, or everything that differs.
  let typeIds = input.contentTypes ? [...new Set(input.contentTypes)] : undefined;
  let entryIds = input.entries ? [...new Set(input.entries)] : undefined;
  const blocks =
    (input.blocks ?? (!typeIds && !entryIds))
      ? await planPromotedBlocks(ctx, source, target)
      : null;
  if (!typeIds && !entryIds) {
    const diff = await compareEnvironments(ctx, spaceId, sourceId, targetId);
    typeIds = diff.contentTypes
      .filter((c) => c.kind !== 'removed' && c.kind !== 'unchanged')
      .map((c) => c.apiId);
    entryIds = diff.entries
      .filter((e) => e.kind !== 'removed' && e.kind !== 'unchanged')
      .map((e) => e.entryId);
  }
  typeIds ??= [];
  entryIds ??= [];
  if (typeIds.length === 0 && entryIds.length === 0 && !blocks) {
    throw new ValidationError([
      { field: 'entries', message: 'Nothing to promote: the environments match' },
    ]);
  }
  if (typeIds.length > MAX_PROMOTION_CONTENT_TYPES) {
    throw new ValidationError([
      {
        field: 'contentTypes',
        message: `A promotion copies at most ${MAX_PROMOTION_CONTENT_TYPES} content types; this one has ${typeIds.length}`,
      },
    ]);
  }
  if (entryIds.length > MAX_PROMOTION_ENTRIES) {
    throw new ValidationError([
      {
        field: 'entries',
        message: `A promotion copies at most ${MAX_PROMOTION_ENTRIES} entries; this one has ${entryIds.length}. Promote it in parts`,
      },
    ]);
  }

  const types: ContentType[] = [];
  for (const apiId of typeIds) {
    const ct = await ctx.store.contentTypes.get(source, apiId);
    if (!ct) throw new NotFoundError('ContentType', `${sourceId}/${apiId}`);
    types.push(ct);
  }
  const entries: PromotedEntry[] = [];
  for (const entryId of entryIds) {
    const found = await ctx.store.entries.get(source, entryId);
    if (!found) throw new NotFoundError('Entry', `${sourceId}/${entryId}`);
    const live = found.entry.publishedVersion;
    // What is live goes live; a draft goes as a draft.
    entries.push({
      entryId,
      contentTypeApiId: found.entry.contentTypeApiId,
      version: live ?? found.entry.currentVersion,
      publish: live !== null,
    });
  }

  await assertSingletonsHold(ctx, target, types, entries);

  // A workflow that gates publishing an entry in the target publishes it there, not a promotion:
  // such an entry goes as a draft, and the record says why.
  const gate = await loadPublishGuard(ctx.store.workflowGraphs, target);
  const gatedNotes: string[] = [];
  for (const [i, e] of entries.entries()) {
    const refused = e.publish ? gate.refusal(e.entryId, e.contentTypeApiId) : null;
    if (!refused) continue;
    entries[i] = { ...e, publish: false };
    gatedNotes.push(
      `Entry ${e.entryId} goes as a draft: ${refused.workflows.map((w) => `"${w.name}"`).join(', ')} gates publishing it in ${targetId}`,
    );
  }
  const replaced = promotionCopies(ctx, target, entries, (e) => e.publish);
  await assertNothingStranded(ctx, target, types, replaced);
  const assessed = await assessPromotion(ctx, source, target, types, entries, blocks, replaced);
  const risk: PromotionRisk = { ...assessed, reasons: [...assessed.reasons, ...gatedNotes] };
  const now = ctx.clock.now().toISOString();
  const promotion: Promotion = {
    id: ctx.ids.newId(),
    spaceId,
    source: sourceId,
    target: targetId,
    contentTypes: types.map((t): PromotedContentType => ({ apiId: t.apiId, version: t.version })),
    entries,
    ...(blocks ? { blocks: blocks.pinned } : {}),
    status: risk.requiresApproval ? 'awaiting_approval' : 'applying',
    risk,
    requestedBy: auditActor(principal),
    createdAt: now,
  };
  await ctx.store.withTransaction(async (tx) => {
    await tx.promotions.create(promotion);
    if (risk.requiresApproval) {
      await tx.outbox.append({
        id: ctx.ids.newId(),
        type: 'promotion.awaiting_approval',
        scope: target,
        occurredAt: now,
        promotionId: promotion.id,
        source: sourceId,
        requestedBy: promotion.requestedBy,
        reasons: risk.reasons,
      });
    }
  });
  await ctx.store.audit.append(
    auditRow(ctx, promotion, promotion.requestedBy, 'promotion.requested'),
  );
  if (risk.requiresApproval) return promotion;
  return applyPromotion(ctx, promotion);
}

/**
 * Approves a waiting promotion and applies it. Not by whoever requested it: the point of the gate
 * is a second person. Exactly one approval applies (the record leaves `awaiting_approval` with a
 * compare-and-set); a later one finds it already decided.
 */
export async function approvePromotion(
  ctx: AppContext,
  principal: Principal,
  spaceId: string,
  id: string,
): Promise<Promotion> {
  assertDecider(principal);
  const found = await getPromotion(ctx, spaceId, id);
  const actor = auditActor(principal);
  if (found.requestedBy === actor) {
    throw new ForbiddenError('A promotion is approved by someone other than whoever requested it');
  }
  // Content types and the block catalog change the schema: approving that takes what changing
  // them directly would.
  if (
    (found.contentTypes.length > 0 || found.blocks) &&
    !principal.scopes.includes(SCOPES.contentManage)
  ) {
    throw new ForbiddenError(
      `Approving a promotion with content types or blocks takes ${SCOPES.contentManage}`,
    );
  }
  // Both environments must still be there: a deleted target would collect rows no environment owns.
  await resolveEnvironment(ctx, spaceId, found.source);
  await resolveWritableEnvironment(ctx, spaceId, found.target);
  const claimed = await ctx.store.promotions.transition(spaceId, id, 'awaiting_approval', {
    status: 'applying',
    decidedBy: actor,
    decidedAt: ctx.clock.now().toISOString(),
  });
  if (!claimed) {
    throw new ConflictError(`Promotion ${id} is ${found.status}, not awaiting approval`);
  }
  await ctx.store.audit.append(auditRow(ctx, claimed, actor, 'promotion.approved'));
  return applyPromotion(ctx, claimed);
}

/** Rejects a waiting promotion; nothing is copied. */
export async function rejectPromotion(
  ctx: AppContext,
  principal: Principal,
  spaceId: string,
  id: string,
): Promise<Promotion> {
  assertDecider(principal);
  const found = await getPromotion(ctx, spaceId, id);
  const rejected = await ctx.store.promotions.transition(spaceId, id, 'awaiting_approval', {
    status: 'rejected',
    decidedBy: auditActor(principal),
    decidedAt: ctx.clock.now().toISOString(),
  });
  if (!rejected) {
    throw new ConflictError(`Promotion ${id} is ${found.status}, not awaiting approval`);
  }
  await ctx.store.audit.append(
    auditRow(ctx, rejected, rejected.decidedBy ?? auditActor(principal), 'promotion.rejected'),
  );
  return rejected;
}

/**
 * Deciding a promotion takes a person (signed in, or through their own token) or the deployment
 * admin token. API keys can request promotions (CI does) but not decide them: they carry no
 * identity beyond their kind, so "someone other than the requester" couldn't be told apart.
 */
function assertDecider(principal: Principal): void {
  if (principal.kind !== 'user' && principal.kind !== 'admin') {
    throw new ForbiddenError(
      'Approving or rejecting a promotion takes a person or the deployment admin token, not an API key',
    );
  }
  // Not an application acting for the person (an MCP or OAuth client, an agent): content it reads
  // could steer it into approving. People decide in the admin or with their own token.
  if (principal.clientId) {
    throw new ForbiddenError(
      'An application acting for you can request a promotion but not decide one; decide it yourself',
    );
  }
  assertUnrestricted(principal);
}

/**
 * Promotions write and publish whole entries across content types, so a principal whose role
 * limits it to some types or fields can't use them: that would reach what its grants forbid.
 */
function assertUnrestricted(principal: Principal): void {
  if (principal.contentGrants) {
    throw new ForbiddenError('Promotions take a role without content-type or field restrictions');
  }
}

/** An audit row for a promotion's request, decision or outcome. */
function auditRow(ctx: AppContext, promotion: Promotion, actor: string, action: string) {
  return {
    id: ctx.ids.newId(),
    spaceId: promotion.spaceId,
    environmentId: promotion.target,
    actor,
    action,
    targetType: 'promotion',
    targetId: promotion.id,
    status: 200,
    at: ctx.clock.now().toISOString(),
  };
}

export async function getPromotion(
  ctx: AppContext,
  spaceId: string,
  id: string,
): Promise<Promotion> {
  const found = await ctx.store.promotions.get(spaceId, id);
  if (!found) throw new NotFoundError('Promotion', id);
  return found;
}

export async function listPromotions(
  ctx: AppContext,
  spaceId: string,
  opts: { readonly status?: PromotionStatus; readonly limit?: number } = {},
): Promise<Promotion[]> {
  return ctx.store.promotions.list(spaceId, opts);
}

/**
 * How long a promotion may stay `applying` before the sweep fails it. An apply runs inside the
 * request that requested or approved it and moves the record on itself when it ends, either way;
 * one still `applying` this long after has died partway (the Worker evicted, or the record's
 * own write lost), and nothing else would ever move it. Far past any real apply (at most
 * `MAX_PROMOTION_ENTRIES` entries, which take seconds), so the sweep never races a live one.
 */
export const PROMOTION_APPLY_TIMEOUT_MS = 60 * 60 * 1000;

/** What `failStalePromotions` did: how many it failed. */
export interface StalePromotionSweepResult {
  readonly failed: number;
}

/**
 * Fails each promotion left `applying` longer than `PROMOTION_APPLY_TIMEOUT_MS`, in every space:
 * the cron's backstop for an apply that died before it could say how it ended. What it wrote
 * before it stopped stays, as for any failed apply; the record says so and asks for a new
 * request. The move is a compare-and-set out of `applying`, so an apply that finishes in the
 * meantime keeps its own outcome and the sweep leaves it alone.
 */
export async function failStalePromotions(ctx: AppContext): Promise<StalePromotionSweepResult> {
  const now = ctx.clock.now();
  const before = now.getTime() - PROMOTION_APPLY_TIMEOUT_MS;
  let failed = 0;
  for (const space of await ctx.store.spaces.list()) {
    const applying = await ctx.store.promotions.list(space.spaceId, {
      status: 'applying',
      limit: 200,
    });
    for (const promotion of applying) {
      // It started applying when it was approved, or when it was requested if it needed no one.
      if (Date.parse(promotion.decidedAt ?? promotion.createdAt) > before) continue;
      const moved = await ctx.store.promotions.transition(
        promotion.spaceId,
        promotion.id,
        'applying',
        {
          status: 'failed',
          error:
            'The apply stopped before it finished and was failed after an hour; what it wrote ' +
            'before it stopped stays. Compare the environments and request a new promotion',
          completedAt: now.toISOString(),
        },
      );
      // Moved on since it was listed: whatever moved it (the apply itself) has the last word.
      if (!moved) continue;
      await ctx.store.audit.append({
        ...auditRow(ctx, moved, moved.decidedBy ?? moved.requestedBy, 'promotion.failed'),
        status: 500,
      });
      failed++;
    }
  }
  return { failed };
}

/**
 * Applies a claimed (`applying`) promotion: content types first (entries are validated against
 * them), then each entry's pinned version, published when it was live in the source. Then checks
 * the target holds what was pinned. Any failure marks it `failed`, naming the cause; what was
 * applied before the failure stays, like any other edits.
 */
async function applyPromotion(base: AppContext, promotion: Promotion): Promise<Promotion> {
  if (promotion.status !== 'applying') {
    throw new InvalidStateError(`Promotion ${promotion.id} is ${promotion.status}`);
  }
  // Written as whoever approved it, whether the approval's request or a later sweep applies it.
  const ctx = withActor(base, promotion.decidedBy ?? promotion.requestedBy);
  const source: Scope = { spaceId: promotion.spaceId, environmentId: promotion.source };
  const target: Scope = { spaceId: promotion.spaceId, environmentId: promotion.target };
  const result: {
    contentTypes: string[];
    entries: string[];
    published: string[];
    gated: string[];
    blocks?: PromotionResult['blocks'];
  } = { contentTypes: [], entries: [], published: [], gated: [] };
  const finish = async (patch: {
    status: 'completed' | 'failed';
    result: PromotionResult;
    error?: string;
  }) => {
    const done = await ctx.store.promotions.transition(
      promotion.spaceId,
      promotion.id,
      'applying',
      {
        ...patch,
        completedAt: ctx.clock.now().toISOString(),
      },
    );
    await ctx.store.audit.append({
      ...auditRow(
        ctx,
        promotion,
        promotion.decidedBy ?? promotion.requestedBy,
        `promotion.${patch.status}`,
      ),
      status: patch.status === 'completed' ? 200 : 500,
    });
    return done;
  };
  try {
    // Every pin is checked before anything is written: what was checked (and approved) is what is
    // copied, so a type, catalog or config changed since fails the apply with nothing changed.
    const types: ContentType[] = [];
    for (const pinned of promotion.contentTypes) {
      const ct = await ctx.store.contentTypes.get(source, pinned.apiId);
      if (!ct) throw new NotFoundError('ContentType', `${promotion.source}/${pinned.apiId}`);
      if (ct.version !== pinned.version) {
        throw new ConflictError(
          `The content type "${pinned.apiId}" changed in ${promotion.source} after the promotion was requested; request a new one`,
        );
      }
      types.push(ct);
    }
    // The pinned versions too: one gone from the source fails here, not with half the entries
    // written.
    const pinned = new Map<string, EntryFields>();
    for (const e of promotion.entries) {
      const version = await ctx.store.entries.getVersion(source, e.entryId, e.version);
      if (!version) throw new NotFoundError('Entry version', `${e.entryId}@${e.version}`);
      pinned.set(e.entryId, version.fields);
    }
    const blocks = promotion.blocks
      ? await readPromotedBlocks(ctx, source, target, promotion)
      : null;
    // A gate added since the request: that entry stays a draft (below), so its published snapshot
    // in the target stays too, and counts for what the types and the catalog would strand.
    const gate = await loadPublishGuard(ctx.store.workflowGraphs, target);
    const goesLive = (e: PromotedEntry) =>
      e.publish && !gate.refusal(e.entryId, e.contentTypeApiId);
    const replaced = promotionCopies(ctx, target, promotion.entries, goesLive);
    // And again what the request refused, over the target as it is now (always: the request's own
    // check was before the risk check and the record's write): an entry written there while the
    // promotion waited with a removed field or variant fails the apply here, before any type is
    // saved.
    await assertNothingStranded(ctx, target, types, replaced);
    // And what the push would refuse, judged over the types as this apply leaves them: refused
    // here rather than after the types are written. (A race after these reads can still stop the
    // apply partway, as it can any promotion; what was applied stays, as for any edits.)
    if (blocks) await checkPromotedCatalog(ctx, target, types, blocks, replaced);
    for (const ct of types) {
      await saveContentTypeOver(
        ctx,
        target,
        await ctx.store.contentTypes.get(target, ct.apiId),
        ct,
      );
      // A published definition is saved as published, and the save announces it
      // (`content_type.published`, once): no separate publish.
      result.contentTypes.push(ct.apiId);
    }
    // After the types (a catalog push revises its targets, and finds the promoted ones already
    // matching), before the entries (which may hold blocks only the new catalog adds).
    if (blocks) {
      await applyPromotedBlocks(ctx, target, blocks, replaced, (done) => (result.blocks = done));
    }
    // The entries the checks let off go first, and the live ones among them are published as soon
    // as they can be: what the types and the catalog removed is then gone from them before anything
    // else can fail the apply (another entry's claim or field rule, another publish). One linking
    // to a promoted entry the target doesn't have yet waits for the rest, since a link must resolve.
    const relied = replaced.relied();
    const first = promotion.entries.filter((e) => relied.has(e.entryId));
    const rest = promotion.entries.filter((e) => !relied.has(e.entryId));
    const write = async (e: PromotedEntry) => {
      const fields = pinned.get(e.entryId) as EntryFields;
      // The source's pinned version, copied whole (see `EntryWriteOptions.copy`).
      if (await ctx.store.entries.get(target, e.entryId)) {
        await updateEntry(ctx, target, e.entryId, fields, { copy: true });
      } else {
        // A new entry in the target is the source's, promoted: it keeps who created it and when.
        const from = (await ctx.store.entries.get(source, e.entryId))?.entry;
        await createEntry(
          ctx,
          target,
          {
            contentTypeApiId: e.contentTypeApiId,
            fields,
            id: e.entryId,
            ...(from
              ? {
                  authorship: {
                    createdAt: from.createdAt ?? null,
                    createdBy: from.createdBy ?? null,
                    firstPublishedAt: from.firstPublishedAt ?? null,
                  },
                }
              : {}),
          },
          { copy: true },
        );
      }
      result.entries.push(e.entryId);
    };
    // A gate added since the request: that entry stays a draft, listed, rather than failing the rest.
    const publish = async (e: PromotedEntry) => {
      if (gate.refusal(e.entryId, e.contentTypeApiId)) {
        result.gated.push(e.entryId);
        return;
      }
      await publishEntry(ctx, target, e.entryId);
      result.published.push(e.entryId);
    };
    for (const e of first) await write(e);
    const waiting: PromotedEntry[] = [];
    for (const e of first) {
      if (!e.publish) continue;
      if (await linksResolve(ctx, target, e)) await publish(e);
      else waiting.push(e);
    }
    for (const e of rest) await write(e);
    // Published after every entry exists: a link between promoted entries resolves either way.
    for (const e of [...waiting, ...rest]) if (e.publish) await publish(e);
    const mismatched: string[] = [];
    for (const [entryId, fields] of pinned) {
      const now = await ctx.store.entries.get(target, entryId);
      if (JSON.stringify(now?.fields ?? null) !== JSON.stringify(fields)) mismatched.push(entryId);
    }
    const done: PromotionResult = { ...result, mismatched };
    // Announced once applied; the record then moves to completed.
    await ctx.store.withTransaction(async (tx) => {
      await tx.outbox.append({
        id: ctx.ids.newId(),
        type: 'environment.promoted',
        scope: target,
        occurredAt: ctx.clock.now().toISOString(),
        promotionId: promotion.id,
        source: promotion.source,
        contentTypes: result.contentTypes.length,
        entries: result.entries.length,
        ...(result.blocks ? { blocks: result.blocks } : {}),
      });
    });
    return (await finish({ status: 'completed', result: done })) ?? promotion;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await finish({ status: 'failed', result: { ...result, mismatched: [] }, error });
    throw err;
  }
}

/** Whether every entry an entry links to is in the target already, so publishing it now holds. */
async function linksResolve(ctx: AppContext, target: Scope, e: PromotedEntry): Promise<boolean> {
  const [found, type] = await Promise.all([
    ctx.store.entries.get(target, e.entryId),
    ctx.store.contentTypes.get(target, e.contentTypeApiId),
  ]);
  if (!found || !type) return false;
  const linked = [
    ...new Set(
      extractReferences(e.entryId, found.fields, type)
        .filter((edge) => edge.toType === 'Entry')
        .map((edge) => edge.toId),
    ),
  ];
  if (linked.length === 0) return true;
  return (await ctx.store.entries.getMany(target, linked)).length === linked.length;
}

/** Entry ids a singleton refusal names; the details carry them all. */
const SINGLETON_NAMED = 10;

/**
 * Refuses, when it is requested, a promotion that the apply would refuse for a singleton: one that
 * leaves a type that is a singleton in the target (as promoted, or as the target has it) with more
 * than one entry outside the trash, counting the target's entries and the promoted ones together.
 * The apply still holds the rule (the claim, `saveContentTypeOver`); this says so before anyone
 * approves it.
 */
async function assertSingletonsHold(
  ctx: AppContext,
  target: Scope,
  types: readonly ContentType[],
  entries: readonly PromotedEntry[],
): Promise<void> {
  const incoming = new Map(types.map((t) => [t.apiId, t]));
  const promoted = new Map<string, string[]>();
  for (const e of entries) {
    promoted.set(e.contentTypeApiId, [...(promoted.get(e.contentTypeApiId) ?? []), e.entryId]);
  }
  for (const apiId of new Set([...incoming.keys(), ...promoted.keys()])) {
    const singleton = incoming.has(apiId)
      ? incoming.get(apiId)?.singleton === true
      : (await ctx.store.contentTypes.get(target, apiId))?.singleton === true;
    if (!singleton) continue;
    const ids = promoted.get(apiId) ?? [];
    const [live, there] = await Promise.all([
      ctx.store.entries.list(target, { contentTypeApiId: apiId, limit: ids.length + 2 }),
      ids.length ? ctx.store.entries.getMany(target, ids) : Promise.resolve([]),
    ]);
    // A promoted entry the target holds in its trash stays there; any other is outside it after.
    const trashed = new Set(
      there.filter((e) => e.entry.status === 'archived').map((e) => e.entry.id),
    );
    const after = [
      ...new Set([...live.map((e) => e.entry.id), ...ids.filter((id) => !trashed.has(id))]),
    ];
    if (after.length <= 1) continue;
    const more =
      after.length > SINGLETON_NAMED ? ` and ${after.length - SINGLETON_NAMED} more` : '';
    throw new ConflictError(
      `"${apiId}" is a singleton type in ${target.environmentId}, and the promotion would leave it ` +
        `more than one entry outside the trash (${after.slice(0, SINGLETON_NAMED).join(', ')}${more}). ` +
        'Promote one entry, or move the others to the trash first.',
      { singleton: apiId, entries: after },
    );
  }
}

/**
 * The copies of the target's entries a promotion replaces (`replacedCopies` in stranding.ts): a
 * promoted entry's current version, and its published snapshot when it goes live (`goesLive`).
 * One in the target's trash counts whole, since the apply refuses to write over it, and is refused
 * as in the trash. The same rule for what a content type removes (`assertNothingStranded`, run
 * when the promotion is requested and always again by the apply before it writes anything) and
 * what the block catalog push removes (`checkPromotedCatalog`, and the push itself in the apply).
 * One the apply relied on that fails even so (its own claim or field rule, a gate added in that
 * moment) fails the promotion with that copy still holding what was removed, as any promotion
 * failing partway keeps what it applied.
 */
const promotionCopies = (
  ctx: AppContext,
  target: Scope,
  entries: readonly PromotedEntry[],
  goesLive: (e: PromotedEntry) => boolean,
): ReplacedCopies => {
  const byId = new Map(entries.map((e) => [e.entryId, e]));
  return replacedCopies(ctx, target, [...byId.keys()], {
    operation: 'promotion',
    writesTrash: false,
    goesLive: (id) => goesLive(byId.get(id) as PromotedEntry),
  });
};

/** The risk check: the rules, then the decision model's view, which can only add to them. */
async function assessPromotion(
  ctx: AppContext,
  source: Scope,
  target: Scope,
  types: readonly ContentType[],
  entries: readonly PromotedEntry[],
  blocks: PlannedBlocks | null,
  replaced: ReplacedCopies,
): Promise<PromotionRisk> {
  const reasons: string[] = [];
  const aliases = (await ctx.store.spaces.listAliases(target.spaceId)).filter(
    (a) => a.targetEnvironmentId === target.environmentId,
  );
  const protectedTarget = target.environmentId === 'main' || aliases.length > 0;
  if (target.environmentId === 'main') reasons.push('The target is main');
  for (const a of aliases) reasons.push(`The alias "${a.alias}" points at the target`);

  const kept = await ctx.store.contentTypes.publishedDefinitions(target);
  const typeChanges: Record<string, string[]> = {};
  for (const ct of types) {
    const current = await ctx.store.contentTypes.get(target, ct.apiId);
    if (!current) {
      // A new type changes no field the target has, but agents read its instructions as guidance.
      const adds = [
        ...(ct.agentInstructions ? ['adds agent instructions'] : []),
        ...(ct.preview ? ['adds a preview URL'] : []),
      ];
      if (adds.length) {
        typeChanges[ct.apiId] = adds;
        for (const a of adds) reasons.push(`The content type "${ct.apiId}" ${a}`);
      }
      continue;
    }
    const changes = new Set<string>();
    const incoming = new Map(ct.fields.map((f) => [f.apiId, f]));
    // Against the target's working definition and, when a published definition replaces it, what
    // the target serves: its own draft may have dropped a field Delivery still has. A draft
    // arriving changes nothing served, so only the working definition matters then.
    const live = ct.status === 'published' ? kept.get(ct.apiId) : undefined;
    for (const before of live ? [current, { ...current, fields: live.fields }] : [current]) {
      for (const f of before.fields) {
        const next = incoming.get(f.apiId);
        if (!next) continue;
        if (next.type !== f.type) {
          changes.add(`changes "${f.apiId}" from ${f.type} to ${next.type}`);
        } else if (next.required && !f.required) changes.add(`makes "${f.apiId}" required`);
      }
      // Removals at any depth. One the target's entries still hold never gets this far: the
      // request refuses it (`assertNothingStranded`).
      for (const at of removedFields(before.fields, ct.fields)) {
        changes.add(`removes the field "${at}"`);
      }
      for (const [at, variants] of removedVariants(before.fields, ct.fields)) {
        for (const v of variants) changes.add(`removes the block variant "${v}" from "${at}"`);
      }
    }
    // Agents read these as guidance, so an approver sees a change to them even with no field moved.
    if ((ct.agentInstructions ?? '') !== (current.agentInstructions ?? '')) {
      changes.add('changes its agent instructions');
    }
    // Where preview links send their tokens: an approver sees the frontend move.
    if ((ct.preview?.urlTemplate ?? '') !== (current.preview?.urlTemplate ?? '')) {
      changes.add('changes its preview URL');
    }
    if (changes.size) {
      typeChanges[ct.apiId] = [...changes];
      for (const c of changes) reasons.push(`The content type "${ct.apiId}" ${c}`);
    }
  }

  const blockChanges = blocks
    ? await assessPromotedBlocks(ctx, target, types, blocks, replaced)
    : [];
  reasons.push(...blockChanges);
  const staleLines = await staleOverrideLines(
    ctx,
    source,
    target,
    types,
    entries,
    blocks?.catalog ?? null,
    replaced,
  );
  reasons.push(...staleLines);

  let assessment: PromotionAssessment | undefined;
  let aiRequires = false;
  if (ctx.decisions) {
    const state = wrapUntrusted(
      JSON.stringify({
        source: source.environmentId,
        target: target.environmentId,
        targetIsProtected: protectedTarget,
        contentTypes: types.map((t) => ({ apiId: t.apiId, changes: typeChanges[t.apiId] ?? [] })),
        ...(blocks ? { blocks: blockChanges } : {}),
        entries: {
          total: entries.length,
          goingLive: entries.filter((e) => e.publish).length,
          sample: await sampleChanges(ctx, source, target, entries.slice(0, 25)),
        },
      }).slice(0, 20_000),
    );
    const r = await decide(
      ctx,
      ctx.decisions,
      target,
      {
        state,
        tier: 'flagship',
        questions: {
          review: {
            type: 'noul',
            instructions:
              'Should a person check this promotion of content between environments before it goes live?',
          },
          breaking: {
            type: 'noul',
            instructions:
              'Would it remove or break content that readers or integrations depend on?',
          },
          risk: {
            type: 'score',
            instructions: 'How risky is this promotion?',
            levels: [...RISK_LEVELS],
          },
        },
      },
      {
        prompt: 'promotion.risk',
        fallback: () => ({
          review: { type: 'noul', probability: 0 },
          breaking: { type: 'noul', probability: 0 },
          risk: { type: 'score', score: 0, probabilities: [1, 0, 0, 0] },
        }),
      },
    );
    const p = (a: DecisionAnswer | undefined) => (a?.type === 'noul' ? a.probability : 0);
    const score = r.answers.risk?.type === 'score' ? r.answers.risk.score : 0;
    assessment = {
      review: p(r.answers.review),
      breaking: p(r.answers.breaking),
      risk: score,
      source: r.source,
      // The reason category only: a provider's error text has no place in a stored record.
      ...(r.fallback !== undefined ? { fallback: fallbackReason(r.fallback) } : {}),
    };
    if (isUncheckedFallback(r)) {
      // The model should have answered and couldn't: a person checks instead, never a pass.
      aiRequires = true;
      reasons.push('The risk check could not run, so a person checks it');
    } else if (r.source === 'model') {
      if (assessment.review >= REVIEW_THRESHOLD) {
        aiRequires = true;
        reasons.push(`The risk check suggests review (${Math.round(assessment.review * 100)}%)`);
      }
      if (score >= RISK_THRESHOLD) {
        aiRequires = true;
        reasons.push(`The risk check rates it ${RISK_LEVELS[Math.round(score)] ?? 'risky'}`);
      }
    }
  }

  const ruled =
    protectedTarget ||
    Object.keys(typeChanges).length > 0 ||
    blockChanges.length > 0 ||
    staleLines.length > 0;
  return {
    protectedTarget,
    reasons,
    ...(assessment ? { assessment } : {}),
    requiresApproval: ruled || aiRequires,
  };
}

/** What a promotion's blocks part read when it was requested: the source's, and the target's. */
interface PlannedBlocks {
  readonly pinned: PromotedBlocks;
  readonly catalog: BlockCatalog;
  readonly targetCatalog: BlockCatalog | null;
  /** The source's config as the target gets it; null when the source never set one. */
  readonly config: CarriedBlockConfig | null;
  /** What changes for editors in the target (`blockRuleChanges`). */
  readonly ruleChanges: readonly string[];
}

/**
 * The source's block catalog and config, when copying them would change the target: a catalog
 * other than the target's (by hash), a config that gives the target other rules, or one that
 * differs as `blockConfigChange` judges it (a narrowing equal to the code's today, which a later
 * push would make bite). Null when the source has no catalog (a promotion adds and overwrites,
 * never deletes) or nothing would change. A source config never set leaves the target's in place;
 * one set back to nothing is carried, and clears the target's.
 */
async function planPromotedBlocks(
  ctx: AppContext,
  source: Scope,
  target: Scope,
): Promise<PlannedBlocks | null> {
  const [catalog, sourceConfig, targetCatalog, targetConfig] = await Promise.all([
    ctx.store.blockCatalogs.latest(source),
    ctx.store.blockConfigs.get(source),
    ctx.store.blockCatalogs.latest(target),
    ctx.store.blockConfigs.get(target),
  ]);
  if (!catalog) return null;
  let config: CarriedBlockConfig | null = null;
  try {
    // A source config set back to nothing is carried too: it clears the target's narrowing.
    if (sourceConfig && sourceConfig.version > 0) {
      config = effectiveBlockConfig(catalog, sourceConfig);
    }
  } catch (err) {
    if (!(err instanceof ValidationError)) throw err;
    throw cantGo(target, err.issues);
  }
  const before = effectiveBlockRules(targetCatalog, targetConfig ?? EMPTY_BLOCK_CONFIG);
  const after = effectiveBlockRules(
    catalog,
    config ? { version: 0, ...config } : (targetConfig ?? EMPTY_BLOCK_CONFIG),
  );
  const ruleChanges = blockRuleChanges(before, after);
  // As `compareEnvironments` judges them, so a promotion copies what a comparison says differs, and
  // a comparison after it says nothing does.
  const configMoves =
    config !== null &&
    ['added', 'changed'].includes(
      blockConfigChange(catalog, sourceConfig, targetCatalog, targetConfig),
    );
  if (targetCatalog?.hash === catalog.hash && ruleChanges.length === 0 && !configMoves) return null;
  return {
    pinned: {
      catalogVersion: catalog.version,
      configVersion: sourceConfig?.version ?? 0,
      targetCatalogVersion: targetCatalog?.version ?? 0,
      targetConfigVersion: targetConfig?.version ?? 0,
    },
    catalog,
    targetCatalog,
    config,
    ruleChanges,
  };
}

/**
 * The risk check's lines for the blocks a promotion copies, each of which requires approval:
 * every change to what editors may place where (counts and locks included), and what the catalog
 * check finds (`checkPromotedCatalog`). A catalog change that leaves the rules as they are and
 * removes nothing adds no line.
 */
async function assessPromotedBlocks(
  ctx: AppContext,
  target: Scope,
  promoted: readonly ContentType[],
  blocks: PlannedBlocks,
  replaced: ReplacedCopies,
): Promise<string[]> {
  // Whatever the hashes: a push of the same catalog still revises a target type (copied or the
  // target's own) whose blocks field has drifted from it.
  const checked = await checkPromotedCatalog(ctx, target, promoted, blocks, replaced);
  const lines: string[] = [...checked.lines];
  if (lines.length > 0 || blocks.ruleChanges.length > 0) {
    const { changes } = checked;
    const said = [
      ...(changes.added.length ? [`adds ${quotedIds(changes.added)}`] : []),
      ...(changes.removed.length ? [`removes ${quotedIds(changes.removed)}`] : []),
      ...(changes.changed.length ? [`changes ${quotedIds(changes.changed)}`] : []),
      ...changes.renamed.map((r) => `renames "${r.from}" to "${r.to}"`),
      ...(changes.breakpoints ? ['changes the breakpoints'] : []),
    ];
    if (said.length > 0) lines.unshift(`The block catalog ${said.join('; ')}`);
  }
  for (const change of blocks.ruleChanges) lines.push(`The block rules change: ${change}`);
  return lines;
}

/**
 * What pushing `catalog` into the target would do, judged over its types as the promotion leaves
 * them (each type it copies in place of the target's, since the push runs after them): the
 * blocks and props it removes from a type, including one the promotion copies whose blocks field
 * has drifted from the source's catalog, and a draft it would publish (a push publishes the types
 * it revises), as reason lines. Refuses (422) what the push would refuse: a target type the target
 * neither has nor gets, a thumbnail naming an asset it lacks, a block or block prop entries there
 * still hold (the push never removes those, approved or not), as `assertSingletonsHold` does for
 * singletons. What entries hold is judged as `assertNothingStranded` judges it: a copy the
 * promotion replaces doesn't count (`replacedCopies`), so a removal only the promoted entries
 * hold goes through. Run when the promotion is requested, and again by the apply before it writes.
 */
async function checkPromotedCatalog(
  ctx: AppContext,
  target: Scope,
  promoted: readonly ContentType[],
  { catalog, targetCatalog }: Pick<PlannedBlocks, 'catalog' | 'targetCatalog'>,
  replaced: ReplacedCopies,
): Promise<{ lines: string[]; changes: ReturnType<typeof diffBlockCatalogs> }> {
  const copied = new Map(promoted.map((t) => [t.apiId, t]));
  const types = new Map<string, ContentType>();
  for (const apiId of new Set(catalog.targets.map((t) => t.contentTypeApiId))) {
    const type = copied.get(apiId) ?? (await ctx.store.contentTypes.get(target, apiId));
    if (type) types.set(apiId, type);
  }
  let plans: ReturnType<typeof planCatalogTypes>;
  let changes: ReturnType<typeof diffBlockCatalogs>;
  try {
    changes = diffBlockCatalogs(targetCatalog?.blocks ?? null, catalog.blocks, {
      before: targetCatalog?.breakpoints ?? [],
      after: catalog.breakpoints,
    });
    plans = planCatalogTypes(catalog.blocks, catalog.targets, types, catalog.breakpoints);
    await assertThumbnailAssets(ctx, target, catalog.blocks);
  } catch (err) {
    if (!(err instanceof ValidationError)) throw err;
    throw cantGo(target, err.issues);
  }
  const lines: string[] = [];
  const held: string[] = [];
  for (const plan of plans) {
    const current = types.get(plan.contentTypeApiId) as ContentType;
    const whose = copied.has(current.apiId) ? 'the copied' : "the target's";
    if (current.status !== 'published') {
      lines.push(
        `The block catalog publishes ${whose} draft of the content type "${current.apiId}"`,
      );
    }
    if (!plan.destructive) continue;
    lines.push(
      `The block catalog removes blocks or block props from ${whose} content type "${current.apiId}"`,
    );
    const inUse = await heldPastPromotion(ctx, target, replaced, current, {
      fields: [...plan.fields],
    });
    for (const { variant, entries } of inUse.variantsInUse) {
      held.push(`${current.apiId}.${describeRemovedInUse(variant, entries)}`);
    }
    for (const { field, entries } of inUse.fieldsInUse) {
      held.push(`${current.apiId}.${describeRemovedInUse(field, entries)}`);
    }
  }
  const trashed = await replaced.trashed();
  if (held.length > 0 || trashed.length > 0) {
    const refused = cantGo(
      target,
      held.map((at) => ({
        field: '',
        message: `it removes what entries there still hold (${at}); change those entries first`,
      })),
    );
    throw new ValidationError([...refused.issues, ...trashed]);
  }
  return { lines, changes };
}

/**
 * The risk lines for the overrides the promotion makes stale in the target: per type the target
 * holds, from its stored definition to the one the promotion leaves (the copied type, else its
 * own, each revised by the catalog push when the catalog is copied too), over the target's
 * entries the promotion doesn't replace. Stale overrides never block a save, but each entry drops
 * them on its next one, which changes what its pages render: that is the approver's to accept.
 * Checked whether or not the catalog is copied, since a copied type alone can strand them.
 */
async function staleOverrideLines(
  ctx: AppContext,
  source: Scope,
  target: Scope,
  promoted: readonly ContentType[],
  entries: readonly PromotedEntry[],
  catalog: BlockCatalog | null,
  replaced: ReplacedCopies,
): Promise<string[]> {
  const copied = new Map(promoted.map((t) => [t.apiId, t]));
  const apiIds = new Set([
    ...copied.keys(),
    ...(catalog?.targets.map((t) => t.contentTypeApiId) ?? []),
    ...entries.map((e) => e.contentTypeApiId),
  ]);
  const stored = new Map<string, ContentType>();
  const leaves = new Map<string, ContentType>();
  for (const apiId of apiIds) {
    const held = await ctx.store.contentTypes.get(target, apiId);
    if (held) stored.set(apiId, held);
    const left = copied.get(apiId) ?? held;
    if (left) leaves.set(apiId, left);
  }
  let plans: ReturnType<typeof planCatalogTypes> = [];
  if (catalog) {
    try {
      plans = planCatalogTypes(catalog.blocks, catalog.targets, leaves, catalog.breakpoints);
    } catch (err) {
      // A catalog the target can't take is refused by its own check.
      if (!(err instanceof ValidationError)) throw err;
    }
  }
  const lines: string[] = [];
  for (const [apiId, before] of stored) {
    const left = leaves.get(apiId) as ContentType;
    const fields = plans.find((p) => p.contentTypeApiId === apiId)?.fields ?? left.fields;
    const stale = await staleOverridesOf(
      ctx,
      target,
      before,
      { ...left, fields: [...fields] },
      { skip: replaced.replaces },
    );
    if (stale.blocks > 0) lines.push(describeStale(apiId, stale));
  }
  // The promoted copies themselves: overrides their source type declares that the type the target
  // is left with doesn't, which the copy's save there drops.
  const carried = new Map<string, { blocks: number; where: Map<string, Set<string>> }>();
  const sourceTypes = new Map<string, ContentType | null>();
  for (const e of entries) {
    const left = leaves.get(e.contentTypeApiId);
    if (!left) continue;
    if (!sourceTypes.has(e.contentTypeApiId)) {
      sourceTypes.set(
        e.contentTypeApiId,
        await ctx.store.contentTypes.get(source, e.contentTypeApiId),
      );
    }
    const from = sourceTypes.get(e.contentTypeApiId);
    const version = from ? await ctx.store.entries.getVersion(source, e.entryId, e.version) : null;
    if (!from || !version) continue;
    const fields =
      plans.find((p) => p.contentTypeApiId === e.contentTypeApiId)?.fields ?? left.fields;
    const uses = staleOverrideUses(from.fields, fields, version.fields);
    if (uses.length === 0) continue;
    const held = carried.get(e.contentTypeApiId) ?? { blocks: 0, where: new Map() };
    held.blocks += new Set(uses.map((u) => u.site)).size;
    for (const u of uses) {
      held.where.set(u.breakpoint, (held.where.get(u.breakpoint) ?? new Set()).add(u.prop));
    }
    carried.set(e.contentTypeApiId, held);
  }
  for (const [apiId, { blocks, where }] of carried) {
    const listed = [...where].map(([bp, props]) => `${bp}: ${[...props].join(', ')}`);
    lines.push(
      `The promoted entries carry ${blocks} ${blocks === 1 ? "block's" : "blocks'"} overrides ` +
        `the target's content type "${apiId}" doesn't declare (${listed.join('; ')})`,
    );
  }
  return lines;
}

/**
 * `The block catalog makes 3 blocks' overrides stale in the target's content type "page" (lg:
 * size, hidden; md: size)`: a block counted once however many of its overrides go stale. The
 * entries are the target's, whichever type definition strands them.
 */
function describeStale(
  apiId: string,
  { overrides, blocks }: Awaited<ReturnType<typeof staleOverridesOf>>,
): string {
  const byBreakpoint = new Map<string, string[]>();
  for (const s of overrides) {
    byBreakpoint.set(s.breakpoint, [...(byBreakpoint.get(s.breakpoint) ?? []), s.prop]);
  }
  const where = [...byBreakpoint].map(([bp, props]) => `${bp}: ${[...new Set(props)].join(', ')}`);
  const atLeast = overrides.some((s) => !s.complete) ? 'at least ' : '';
  return (
    `The block catalog makes ${atLeast}${blocks} ${blocks === 1 ? "block's" : "blocks'"} overrides ` +
    `stale in the target's content type "${apiId}" (${where.join('; ')})`
  );
}

/**
 * What `next` removes from `current` that the target's entries still hold once the promotion has
 * replaced its own copies (`replacedCopies`): the catalog check's view, and the push's in the
 * apply, so the two agree.
 */
async function heldPastPromotion(
  ctx: AppContext,
  target: Scope,
  replaced: ReplacedCopies,
  current: ContentType,
  next: Pick<ContentType, 'fields'>,
): Promise<RemovedContentInUse> {
  const held = emptyHeld();
  addHeld(held, await removedContentInUse(ctx, target, current, next));
  await replaced.letOff(held, [current], next);
  return toRemovedInUse(held);
}

/** A catalog the target can't take, refused when requested, with the way round it. */
const cantGo = (target: Scope, issues: readonly { field: string; message: string }[]) =>
  new ValidationError(
    issues.map((i) => ({
      field: 'blocks',
      message: `The block catalog can't go to ${target.environmentId}: ${i.field ? `${i.field}: ` : ''}${i.message}. Request with blocks: false to promote the rest`,
    })),
  );

const quotedIds = (ids: readonly string[]) =>
  ids.length > 10
    ? `${ids
        .slice(0, 10)
        .map((id) => `"${id}"`)
        .join(', ')} and ${ids.length - 10} more`
    : ids.map((id) => `"${id}"`).join(', ');

/** The source's catalog and config a promotion copies, read and checked against its pins. */
interface PinnedBlocks {
  readonly pinned: PromotedBlocks;
  readonly catalog: BlockCatalog;
  readonly config: BlockConfig | null;
  readonly targetCatalog: BlockCatalog | null;
}

/**
 * Reads the source's catalog and config and holds them, and the target's, to the versions pinned
 * when the promotion was requested: a push or set on either side since fails the apply (`409`)
 * before anything is written, so the approver's risk check is about what lands.
 */
async function readPromotedBlocks(
  ctx: AppContext,
  source: Scope,
  target: Scope,
  promotion: Promotion,
): Promise<PinnedBlocks> {
  const pinned = promotion.blocks as PromotedBlocks;
  const [catalog, config, targetCatalog, targetConfig] = await Promise.all([
    ctx.store.blockCatalogs.latest(source),
    ctx.store.blockConfigs.get(source),
    ctx.store.blockCatalogs.latest(target),
    ctx.store.blockConfigs.get(target),
  ]);
  if (
    !catalog ||
    catalog.version !== pinned.catalogVersion ||
    (config?.version ?? 0) !== pinned.configVersion
  ) {
    throw new ConflictError(
      `The block catalog or block config changed in ${promotion.source} after the promotion was requested; request a new one`,
    );
  }
  if (
    (targetCatalog?.version ?? 0) !== pinned.targetCatalogVersion ||
    (targetConfig?.version ?? 0) !== pinned.targetConfigVersion
  ) {
    throw new ConflictError(
      `The block catalog or block config changed in ${promotion.target} after the promotion was requested; request a new one`,
    );
  }
  return { pinned, catalog, config, targetCatalog };
}

/**
 * Copies the pinned catalog and config into the target: the catalog as a push of the target's own
 * (its target types revised and published, in one unit), then the config as a set over the
 * target's, each at the target version pinned with the request, so a push or set there since
 * loses with a `409`. Two units: `record` hears that the catalog landed as soon as it has, so a
 * promotion that fails on the config says so.
 */
async function applyPromotedBlocks(
  ctx: AppContext,
  target: Scope,
  { pinned, catalog, config }: PinnedBlocks,
  replaced: ReplacedCopies,
  record: (done: { catalog: boolean; config: boolean }) => void,
): Promise<void> {
  // The removals the risk check named, which the approver saw; one an entry holds was refused then.
  // The push runs before the entries are copied, so it judges what they hold as the check did:
  // a copy the promotion replaces next doesn't count.
  const push = await pushBlockCatalog(
    ctx,
    SYSTEM_CALLER,
    target,
    {
      blocks: catalog.blocks,
      targets: catalog.targets,
      breakpoints: catalog.breakpoints,
      allowDestructive: true,
      expectedVersion: pinned.targetCatalogVersion,
    },
    { inUse: (current, next) => heldPastPromotion(ctx, target, replaced, current, next) },
  );
  record({ catalog: push.applied, config: false });
  if (!config || config.version === 0) return;
  const carried = effectiveBlockConfig(catalog, config);
  const set = await setBlockConfig(ctx, SYSTEM_CALLER, target, {
    expectedVersion: pinned.targetConfigVersion,
    targets: carried.targets,
    blocks: carried.blocks,
  });
  record({ catalog: push.applied, config: !set.unchanged });
}

/** For the risk check: which top-level fields each sampled entry changes in the target. */
async function sampleChanges(
  ctx: AppContext,
  source: Scope,
  target: Scope,
  entries: readonly PromotedEntry[],
): Promise<{ entryId: string; contentType: string; new: boolean; changedFields: string[] }[]> {
  const out = [];
  for (const e of entries) {
    const incoming =
      (await ctx.store.entries.getVersion(source, e.entryId, e.version))?.fields ?? {};
    const current = (await ctx.store.entries.get(target, e.entryId))?.fields;
    const changedFields = current
      ? [...new Set([...Object.keys(incoming), ...Object.keys(current)])].filter(
          (f) => JSON.stringify(incoming[f] ?? null) !== JSON.stringify(current[f] ?? null),
        )
      : Object.keys(incoming);
    out.push({ entryId: e.entryId, contentType: e.contentTypeApiId, new: !current, changedFields });
  }
  return out;
}

/** A stored fallback reason: its category, never a provider's error text. */
function fallbackReason(fallback: string): string {
  if (fallback === 'mock') return 'mock';
  return fallback.startsWith('budget') ? 'budget' : 'unavailable';
}
