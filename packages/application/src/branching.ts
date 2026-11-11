import {
  assertEntryFieldsValid,
  ConflictError,
  type ContentType,
  canAccessContentType,
  type Entry,
  type EntryFields,
  type EntryVersion,
  NotFoundError,
  type Principal,
  type Scope,
  SINGLETON_CLAIM_FIELD,
  stampChanged,
  stampCreated,
  type UniqueClaim,
  uniqueClaims,
  type ValidationContext,
  withoutStaleOverrides,
} from '@contentworker/domain';
import { TransactionConflictError } from '@contentworker/ports';
import { blockConfigChange } from './block-config';
import { type PreparedContentTypeSave, prepareContentTypeSave } from './content-types';
import { type AppContext, actorOf } from './context';
import {
  assertAssetMimeTypes,
  assertClaimsFree,
  assertSingletonFree,
  writeNewEntry,
} from './entries';
import {
  assertEnvironmentCaller,
  authorizeEnvironmentWide,
  type EnvironmentCaller,
} from './environment-access';
import { allPages } from './paging';
import { resolveEnvironment, resolveWritableEnvironment } from './spaces';
import { assertNothingStranded, replacedCopies } from './stranding';

/** How an item in the source environment relates to the target. */
export type ChangeKind = 'added' | 'removed' | 'changed' | 'unchanged';

export interface ContentTypeChange {
  readonly apiId: string;
  readonly kind: ChangeKind;
}

export interface EntryChange {
  readonly entryId: string;
  readonly contentTypeApiId: string;
  readonly kind: ChangeKind;
}

/** A diff of two environments (what merging source→target would change). */
export interface EnvironmentComparison {
  readonly spaceId: string;
  readonly source: string;
  readonly target: string;
  readonly contentTypes: readonly ContentTypeChange[];
  readonly entries: readonly EntryChange[];
  /**
   * How the block catalog in force (by hash) and the block config (as a promotion judges it,
   * `blockConfigChange`) differ, as the other kinds do: `added` only in the source, `removed` only
   * in the target. Reported only: a merge never copies them (a promotion does). Left out for a role
   * limited to some types, since the catalog's targets span them.
   */
  readonly blocks?: { readonly catalog: ChangeKind; readonly config: ChangeKind };
}

const scopeOf = (spaceId: string, environmentId: string): Scope => ({ spaceId, environmentId });
const eq = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Structural projection of a content type (ignores the volatile version counter). */
const ctShape = (ct: ContentType) => ({
  name: ct.name,
  displayField: ct.displayField,
  fields: ct.fields,
  urlPattern: ct.urlPattern,
  group: ct.group,
  description: ct.description,
  icon: ct.icon,
  agentInstructions: ct.agentInstructions,
  layout: ct.layout,
  preview: ct.preview,
  status: ct.status,
});

function classify<T>(
  sourceItems: Map<string, T>,
  targetItems: Map<string, T>,
  same: (a: T, b: T) => boolean,
): Map<string, ChangeKind> {
  const out = new Map<string, ChangeKind>();
  for (const [key, s] of sourceItems) {
    const t = targetItems.get(key);
    if (!t) out.set(key, 'added');
    else out.set(key, same(s, t) ? 'unchanged' : 'changed');
  }
  for (const key of targetItems.keys()) {
    if (!sourceItems.has(key)) out.set(key, 'removed');
  }
  return out;
}

/**
 * Diffs two environments in a space: which content types and entries differ,
 * framed as the change merging source→target would apply. `removed` means the
 * item exists only in the target (merging source would not delete it — merges
 * here are additive/overwriting, never destructive).
 */
export async function compareEnvironments(
  ctx: AppContext,
  spaceId: string,
  source: string,
  target: string,
): Promise<EnvironmentComparison> {
  // Resolved as an `:env` is: an alias names its target, and a deleted environment is not found.
  const src = scopeOf(spaceId, await resolveEnvironment(ctx, spaceId, source));
  const tgt = scopeOf(spaceId, await resolveEnvironment(ctx, spaceId, target));

  const [srcTypes, tgtTypes] = await Promise.all([
    ctx.store.contentTypes.list(src),
    ctx.store.contentTypes.list(tgt),
  ]);
  const ctChanges = classify(
    new Map(srcTypes.map((c) => [c.apiId, c])),
    new Map(tgtTypes.map((c) => [c.apiId, c])),
    (a, b) => eq(ctShape(a), ctShape(b)),
  );

  // Every entry on both sides: the store's default page (100 on D1) compared only the first.
  const [srcEntries, tgtEntries] = await Promise.all([
    allPages((skip, limit) => ctx.store.entries.list(src, { skip, limit })),
    allPages((skip, limit) => ctx.store.entries.list(tgt, { skip, limit })),
  ]);
  const [srcCatalog, tgtCatalog, srcConfig, tgtConfig] = await Promise.all([
    ctx.store.blockCatalogs.latest(src),
    ctx.store.blockCatalogs.latest(tgt),
    ctx.store.blockConfigs.get(src),
    ctx.store.blockConfigs.get(tgt),
  ]);
  const srcById = new Map(srcEntries.map((e) => [e.entry.id, e]));
  const tgtById = new Map(tgtEntries.map((e) => [e.entry.id, e]));
  const entryChanges = classify(srcById, tgtById, (a, b) => eq(a.fields, b.fields));

  return {
    spaceId,
    source,
    target,
    contentTypes: [...ctChanges].map(([apiId, kind]) => ({ apiId, kind })),
    entries: [...entryChanges].map(([entryId, kind]) => ({
      entryId,
      contentTypeApiId:
        srcById.get(entryId)?.entry.contentTypeApiId ??
        tgtById.get(entryId)?.entry.contentTypeApiId ??
        '',
      kind,
    })),
    blocks: {
      catalog: kindOf(srcCatalog?.hash ?? null, tgtCatalog?.hash ?? null),
      config: blockConfigChange(srcCatalog, srcConfig, tgtCatalog, tgtConfig),
    },
  };
}

/** One item's change, from its form on each side (null where it is absent). */
const kindOf = (source: string | null, target: string | null): ChangeKind =>
  source === null
    ? target === null
      ? 'unchanged'
      : 'removed'
    : target === null
      ? 'added'
      : source === target
        ? 'unchanged'
        : 'changed';

/**
 * A comparison as `principal` may see it: only the content types it can read, and their entries.
 * A comparison spans every type, so a role limited to some sees part of one.
 */
export function comparisonFor(
  principal: Principal,
  comparison: EnvironmentComparison,
): EnvironmentComparison {
  const readable = (apiId: string) => canAccessContentType(principal, 'read', apiId);
  const { blocks, ...rest } = comparison;
  return {
    ...rest,
    ...(blocks && !principal.contentGrants ? { blocks } : {}),
    contentTypes: comparison.contentTypes.filter((c) => readable(c.apiId)),
    entries: comparison.entries.filter((e) => readable(e.contentTypeApiId)),
  };
}

export interface MergeSelection {
  /** apiIds of content types to copy source→target. */
  readonly contentTypes?: readonly string[];
  /** entry ids to copy source→target. */
  readonly entries?: readonly string[];
}

export interface MergeResult {
  readonly mergedContentTypes: readonly string[];
  readonly mergedEntries: readonly string[];
}

async function targetValidationContext(ctx: AppContext, scope: Scope): Promise<ValidationContext> {
  const config = await ctx.store.spaces.getConfig(scope);
  if (!config) throw new NotFoundError('Space', scope.spaceId);
  return { defaultLocale: config.defaultLocale, locales: config.locales };
}

/**
 * Applies selected content types and entries from `source` into `target`.
 * Content types are copied wholesale; entries are copied as a NEW draft version
 * in the target (preserving the entry id, validated against the target's content
 * type as the merge leaves it). The merge is additive/overwriting — it never deletes target
 * content.
 *
 * Everything that can refuse it is read and judged before anything is written: the source's types
 * and entries, each entry against the type it will have, the unique values (`assertPlanFree`),
 * what the types would strand (`assertNothingStranded` in stranding.ts) and their singleton turns
 * (`prepareContentTypeSave`), and the order the entries can be written in (`applyOrder`). The
 * types are then saved together in one unit, and the entries after them, each in its own (as
 * `updateEntry` and `createEntry` write one): those the target already has first, each one giving
 * up a unique value before the one taking it and, within that, those whose copies the stranding
 * check let off first; then the new ones. Only a race after the reads can still stop it partway,
 * keeping the types and the entries already written.
 *
 * Entries are copied whole, of any type, every field (hidden ones included), so merging any takes
 * a `caller` holding `read` and `write` on every content type alike. The copy goes over the
 * target's locked regions without judging them, as a promotion's does, so it takes `lock` on every
 * type too, as a promotion carrying entries does; content types alone take only the request's
 * `content:manage`, as saving one does.
 */
export async function mergeEnvironments(
  ctx: AppContext,
  caller: EnvironmentCaller,
  spaceId: string,
  source: string,
  target: string,
  selection: MergeSelection,
): Promise<MergeResult> {
  assertEnvironmentCaller(caller);
  if (selection.entries?.length) authorizeEnvironmentWide(caller, ['read', 'write', 'lock']);
  // The source resolves as a read, the target as a write: it must exist (or be an alias of one).
  const src = scopeOf(spaceId, await resolveEnvironment(ctx, spaceId, source));
  const tgt = scopeOf(spaceId, await resolveWritableEnvironment(ctx, spaceId, target));

  // Each named once: a type saved twice in one unit would fail its own guard, and an entry
  // planned twice would clash with itself.
  const types: MergedType[] = [];
  for (const apiId of new Set(selection.contentTypes ?? [])) {
    const next = await ctx.store.contentTypes.get(src, apiId);
    if (!next) throw new NotFoundError('ContentType', `${source}/${apiId}`);
    types.push({ current: await ctx.store.contentTypes.get(tgt, apiId), next });
  }
  // What each type will be in the target once the merge's own are saved.
  const merging = new Map(types.map((t) => [t.next.apiId, t.next]));
  const typeAfter = async (apiId: string) =>
    merging.get(apiId) ?? (await ctx.store.contentTypes.get(tgt, apiId));

  const plan: PlannedEntry[] = [];
  let handOffs: HandOffs = new Map();
  if (selection.entries?.length) {
    const vctx = await targetValidationContext(ctx, tgt);
    for (const entryId of new Set(selection.entries)) {
      const found = await ctx.store.entries.get(src, entryId);
      if (!found) throw new NotFoundError('Entry', `${source}/${entryId}`);
      const targetCt = await typeAfter(found.entry.contentTypeApiId);
      if (!targetCt) {
        throw new NotFoundError(
          'ContentType',
          `${target}/${found.entry.contentTypeApiId} (include it in the merge)`,
        );
      }
      // Overrides the target's type doesn't take (its breakpoints or a block's responsive props
      // differ from the source's) are stale there: dropped, as a save there would drop them.
      const fields = withoutStaleOverrides(targetCt, found.fields);
      assertEntryFieldsValid(targetCt, fields, vctx);
      // Judged against the target's assets, as a save there would be.
      await assertAssetMimeTypes(ctx, tgt, targetCt, fields);
      const existing = (await ctx.store.entries.get(tgt, entryId))?.entry ?? null;
      // An entry the target holds in its trash stays there (as a promotion leaves it), so it
      // claims nothing: the trash released its values.
      const trashed = existing?.status === 'archived';
      plan.push({
        entryId,
        from: found.entry,
        contentType: targetCt,
        fields,
        existing,
        claims: trashed ? [] : uniqueClaims(targetCt, fields),
      });
    }
    handOffs = await assertPlanFree(ctx, tgt, plan);
  }
  // What the types would strand. A merge writes the source's version over a merged entry's copy
  // in the target, in its trash or not, so that copy doesn't count; it never publishes, so the
  // copy's published snapshot does.
  const replaced = replacedCopies(
    ctx,
    tgt,
    plan.filter((p) => p.existing).map((p) => p.entryId),
    { operation: 'merge', writesTrash: true, goesLive: () => false },
  );
  await assertNothingStranded(
    ctx,
    tgt,
    types.map((t) => t.next),
    replaced,
  );
  const order = applyOrder(plan, replaced.relied(), handOffs);
  const saves = await Promise.all(
    types.map(({ current, next }) => prepareContentTypeSave(ctx, tgt, current, next)),
  );

  if (saves.length > 0) {
    try {
      await ctx.store.withTransaction(async (tx) => {
        for (const save of saves) await save.write(tx);
      });
    } catch (err) {
      if (!(err instanceof TransactionConflictError)) throw err;
      throw new ConflictError(
        saves.length === 1
          ? (saves[0] as PreparedContentTypeSave).conflict
          : 'One of the merged content types changed while it was being saved; try again',
      );
    }
  }

  for (const p of order) await applyEntry(ctx, tgt, p);

  return {
    mergedContentTypes: types.map((t) => t.next.apiId),
    mergedEntries: plan.map((p) => p.entryId),
  };
}

/** A selected content type: the source's definition and the target's (null when it is new there). */
interface MergedType {
  readonly current: ContentType | null;
  readonly next: ContentType;
}

/** One selected entry of a merge: its source fields and what the target holds of it. */
interface PlannedEntry {
  readonly entryId: string;
  /** The source's aggregate, whose authorship a new entry keeps. */
  readonly from: Entry;
  readonly contentType: ContentType;
  readonly fields: EntryFields;
  /** The target's copy, or null when the merge creates it. */
  readonly existing: Entry | null;
  /** The unique values it holds in the target afterwards (none while it stays in the trash). */
  readonly claims: readonly UniqueClaim[];
}

/** Clashes a merge's refusal names; the details carry them all. */
const CLASHES_NAMED = 10;

/**
 * Refuses a merge, before anything is written, whose entries would take a unique value (the
 * singleton's claim included) that the target holds outside the merge, or that two of them claim
 * together, naming each source entry and its holder. A value held by an entry of the merge that
 * gives it up (a swap) is free, and returned as a hand-off for `applyOrder`. A new entry of a
 * singleton type is also refused while the target has another entry outside the trash, as
 * `createEntry` would refuse it.
 */
async function assertPlanFree(
  ctx: AppContext,
  tgt: Scope,
  plan: readonly PlannedEntry[],
): Promise<HandOffs> {
  const key = (c: Pick<UniqueClaim, 'contentTypeApiId' | 'fieldApiId' | 'locale' | 'value'>) =>
    `${c.contentTypeApiId}\u0000${c.fieldApiId}\u0000${c.locale}\u0000${c.value}`;
  const planned = new Set(plan.map((p) => p.entryId));
  const clashes: { entryId: string; field: string; value: string; heldBy: string }[] = [];
  const claimedBy = new Map<string, string>();
  const handOffs = new Map<string, Set<string>>();
  for (const p of plan) {
    for (const c of p.claims) {
      const other = claimedBy.get(key(c));
      if (other) {
        clashes.push({ entryId: p.entryId, field: c.fieldApiId, value: c.value, heldBy: other });
      } else claimedBy.set(key(c), p.entryId);
    }
    if (p.claims.length > 0) {
      for (const held of await ctx.store.entries.findUniqueConflicts(tgt, p.claims, p.entryId)) {
        // Held by an entry of the merge: free if it gives the value up, a clash above if not.
        if (planned.has(held.entryId)) {
          handOffs.set(p.entryId, (handOffs.get(p.entryId) ?? new Set()).add(held.entryId));
          continue;
        }
        clashes.push({
          entryId: p.entryId,
          field: held.fieldApiId,
          value: held.value,
          heldBy: held.entryId,
        });
      }
    }
    if (!p.existing && p.contentType.singleton) {
      const live = await ctx.store.entries.list(tgt, {
        contentTypeApiId: p.contentType.apiId,
        limit: plan.length + 1,
      });
      const other = live.find((e) => !planned.has(e.entry.id));
      if (other) {
        clashes.push({
          entryId: p.entryId,
          field: SINGLETON_CLAIM_FIELD,
          value: p.contentType.apiId,
          heldBy: other.entry.id,
        });
      }
    }
  }
  if (clashes.length === 0) return handOffs;
  const unique = [
    ...new Map(clashes.map((c) => [`${c.entryId}|${c.field}|${c.value}`, c])).values(),
  ];
  const named = unique
    .slice(0, CLASHES_NAMED)
    .map((c) =>
      c.field === SINGLETON_CLAIM_FIELD
        ? `entry ${c.entryId} would be a second entry of the singleton "${c.value}", whose entry is ${c.heldBy}`
        : `entry ${c.entryId} would take ${c.field} "${c.value}", which entry ${c.heldBy} holds`,
    );
  const more = unique.length > CLASHES_NAMED ? ` and ${unique.length - CLASHES_NAMED} more` : '';
  throw new ConflictError(
    `The merge would take unique values twice, so nothing was merged: ${named.join('; ')}${more}`,
    { conflicts: unique },
  );
}

/** Per entry of a merge, the entries of the merge holding a unique value in the target it takes. */
type HandOffs = ReadonlyMap<string, ReadonlySet<string>>;

/**
 * The order a merge writes its entries in, decided before anything is written. The entries the
 * target already has go first, each after every entry of the merge that gives up a unique value it
 * takes (`updateEntry` refuses a value another entry still holds), and, where that leaves a choice,
 * those whose copies the stranding check let off (`relied`) first, so what the types removed is
 * gone from them before anything else can stop the merge; otherwise in the selection's order. The
 * new ones go last, so every value an entry the target has gives up is free for them by then.
 *
 * Values handed round in a circle among entries the target already has (A takes B's, B takes A's)
 * can't be written in any order, one entry at a time, so that merge is refused (409) here, before
 * the types are saved.
 */
function applyOrder(
  plan: readonly PlannedEntry[],
  relied: ReadonlySet<string>,
  handOffs: HandOffs,
): PlannedEntry[] {
  const existing = plan.filter((p) => p.existing);
  const waiting = [
    ...existing.filter((p) => relied.has(p.entryId)),
    ...existing.filter((p) => !relied.has(p.entryId)),
  ];
  const done = new Set<string>();
  const order: PlannedEntry[] = [];
  while (waiting.length > 0) {
    const i = waiting.findIndex((p) =>
      [...(handOffs.get(p.entryId) ?? [])].every((giver) => done.has(giver)),
    );
    if (i < 0) {
      const ids = waiting.map((p) => p.entryId).sort();
      const named = ids.slice(0, CLASHES_NAMED).join(', ');
      const more = ids.length > CLASHES_NAMED ? ` and ${ids.length - CLASHES_NAMED} more` : '';
      throw new ConflictError(
        `The merge would hand unique values round in a circle between entries the target already has (${named}${more}), so nothing was merged. Give one of those values up in the target first.`,
        { entries: ids },
      );
    }
    const [next] = waiting.splice(i, 1) as [PlannedEntry];
    done.add(next.entryId);
    order.push(next);
  }
  return [...order, ...plan.filter((p) => !p.existing)];
}

/**
 * Creates the entry in the target (preserving id), or appends a new version to the target's copy
 * with its unique values claimed in the same unit, as `updateEntry` does. A copy in the target's
 * trash stays there, holding no claims. A new one is the source's, merged: like a promotion, it
 * keeps who created it, when, and when it was first published, and the merge's actor made its
 * latest change. One the target already has keeps its own.
 */
async function applyEntry(ctx: AppContext, tgt: Scope, p: PlannedEntry): Promise<void> {
  const { entryId, from, contentType, fields, existing } = p;
  const now = ctx.clock.now().toISOString();
  const actor = actorOf(ctx);
  if (!existing) {
    const entry = stampCreated(
      {
        id: entryId,
        contentTypeApiId: contentType.apiId,
        status: 'draft',
        currentVersion: 1,
        publishedVersion: null,
        ...(from.createdAt ? { createdAt: from.createdAt } : {}),
        ...(from.createdBy !== undefined ? { createdBy: from.createdBy } : {}),
        ...(from.firstPublishedAt ? { firstPublishedAt: from.firstPublishedAt } : {}),
      },
      actor,
      now,
    );
    const version: EntryVersion = { entryId, version: 1, fields, createdAt: now, createdBy: actor };
    // A singleton in the target already holding its entry takes no second one from the source,
    // and the new entry stakes its unique values (the singleton's claim among them) as a create
    // does, in the same guarded unit.
    if (contentType.singleton) await assertSingletonFree(ctx.store.entries, tgt, contentType);
    await writeNewEntry(ctx, tgt, contentType, entry, version, p.claims);
    return;
  }
  const nextVersion = existing.currentVersion + 1;
  const trashed = existing.status === 'archived';
  const entry = stampChanged(
    {
      ...existing,
      currentVersion: nextVersion,
      status: trashed ? 'archived' : existing.publishedVersion === null ? 'draft' : 'changed',
    },
    actor,
  );
  const version: EntryVersion = {
    entryId,
    version: nextVersion,
    fields,
    createdAt: now,
    createdBy: actor,
  };
  if (trashed) {
    await ctx.store.entries.saveVersion(tgt, entry, version);
    return;
  }
  await assertClaimsFree(ctx.store.entries, tgt, p.claims, entryId);
  await ctx.store.withTransaction(async (tx) => {
    await tx.entries.saveVersion(tgt, entry, version);
    // Replace rather than add: a value the source no longer holds is given back.
    await tx.entries.replaceUniqueClaims(tgt, entryId, p.claims);
  });
}
