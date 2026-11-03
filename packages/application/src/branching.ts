import {
  assertEntryFieldsValid,
  type ContentType,
  type Entry,
  type EntryFields,
  type EntryVersion,
  NotFoundError,
  type Scope,
  stampChanged,
  stampCreated,
  uniqueClaims,
  type ValidationContext,
} from '@contentworker/domain';
import { saveContentTypeOver } from './content-types';
import { type AppContext, actorOf } from './context';
import { assertSingletonFree, writeNewEntry } from './entries';
import { allPages } from './paging';
import { resolveEnvironment, resolveWritableEnvironment } from './spaces';

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
}

const scopeOf = (spaceId: string, environmentId: string): Scope => ({ spaceId, environmentId });
const eq = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Structural projection of a content type (ignores the volatile version counter). */
const ctShape = (ct: ContentType) => ({
  name: ct.name,
  displayField: ct.displayField,
  fields: ct.fields,
  urlPattern: ct.urlPattern,
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
 * type). The merge is additive/overwriting — it never deletes target content.
 */
export async function mergeEnvironments(
  ctx: AppContext,
  spaceId: string,
  source: string,
  target: string,
  selection: MergeSelection,
): Promise<MergeResult> {
  // The source resolves as a read, the target as a write: it must exist (or be an alias of one).
  const src = scopeOf(spaceId, await resolveEnvironment(ctx, spaceId, source));
  const tgt = scopeOf(spaceId, await resolveWritableEnvironment(ctx, spaceId, target));

  const mergedContentTypes: string[] = [];
  for (const apiId of selection.contentTypes ?? []) {
    const ct = await ctx.store.contentTypes.get(src, apiId);
    if (!ct) throw new NotFoundError('ContentType', `${source}/${apiId}`);
    await saveContentTypeOver(ctx, tgt, await ctx.store.contentTypes.get(tgt, apiId), ct);
    mergedContentTypes.push(apiId);
  }

  const mergedEntries: string[] = [];
  if (selection.entries?.length) {
    const vctx = await targetValidationContext(ctx, tgt);
    for (const entryId of selection.entries) {
      const found = await ctx.store.entries.get(src, entryId);
      if (!found) throw new NotFoundError('Entry', `${source}/${entryId}`);
      const targetCt = await ctx.store.contentTypes.get(tgt, found.entry.contentTypeApiId);
      if (!targetCt) {
        throw new NotFoundError(
          'ContentType',
          `${target}/${found.entry.contentTypeApiId} (include it in the merge)`,
        );
      }
      assertEntryFieldsValid(targetCt, found.fields, vctx);
      await applyEntry(ctx, tgt, found.entry, targetCt, found.fields);
      mergedEntries.push(entryId);
    }
  }

  return { mergedContentTypes, mergedEntries };
}

/**
 * Creates the entry in the target (preserving id) or appends a new version. A new one is the
 * source's, merged: like a promotion, it keeps who created it, when, and when it was first
 * published, and the merge's actor made its latest change. One the target already has keeps its own.
 */
async function applyEntry(
  ctx: AppContext,
  tgt: Scope,
  from: Entry,
  contentType: ContentType,
  fields: EntryFields,
): Promise<void> {
  const { id: entryId, contentTypeApiId } = from;
  const existing = await ctx.store.entries.get(tgt, entryId);
  const now = ctx.clock.now().toISOString();
  const actor = actorOf(ctx);
  if (!existing) {
    const entry = stampCreated(
      {
        id: entryId,
        contentTypeApiId,
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
    await writeNewEntry(ctx, tgt, contentType, entry, version, uniqueClaims(contentType, fields));
    return;
  }
  const nextVersion = existing.entry.currentVersion + 1;
  const entry = stampChanged(
    {
      ...existing.entry,
      currentVersion: nextVersion,
      status: existing.entry.publishedVersion === null ? 'draft' : 'changed',
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
  await ctx.store.entries.saveVersion(tgt, entry, version);
}
