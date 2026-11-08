import { createHash } from 'node:crypto';
import {
  type BlockCatalog,
  type BlockCatalogChanges,
  type BlockCatalogSummary,
  type BlockCatalogTarget,
  type BlockFieldChange,
  type BlockManifest,
  blocksUsed,
  ConflictError,
  type ContentType,
  canAccessContentType,
  canonicalJson,
  checkBlockCatalog,
  diffBlockCatalogs,
  NotFoundError,
  type Principal,
  planCatalogTypes,
  reviseContentType,
  type Scope,
  ValidationError,
} from '@contentworker/domain';
import { TransactionConflictError } from '@contentworker/ports';
import { auditActor } from './audit';
import {
  assertContentTypeCaller,
  type ContentTypeCaller,
  type ContentTypeWarning,
  describeRemovedInUse,
  prepareContentTypeSave,
  removedContentInUse,
  SYSTEM_CALLER,
  tightenedRulesInUse,
} from './content-types';
import type { AppContext } from './context';

/**
 * Blocks from code (see `@contentworker/domain`'s block-catalog module): a developer pushes the
 * manifests of the components their site renders, and the catalog becomes the variants of the
 * blocks fields it targets. Each push that changes anything is a new version, kept as history.
 *
 * A push goes through the content type update's own rules: each target type is revised with
 * `reviseContentType` (every field check), a variant or field some entry still holds is never
 * removed (there is no override: change those entries first, as for any revision), and the
 * revised definitions and the catalog version are written in one unit, so a push lands whole or
 * not at all. It needs `content:manage`, checked by the surfaces.
 */

/** What `pushBlockCatalog` takes. `blocks` and `targets` are checked here, whatever sent them. */
export interface PushBlockCatalogInput {
  readonly blocks: unknown;
  readonly targets: unknown;
  /** Work out and return the push, change nothing. */
  readonly dryRun?: boolean;
  /** The version the push was made against (0 before the first): another one is a conflict. */
  readonly expectedVersion?: number;
  /** Apply a push that removes blocks or block props (none an entry still holds). */
  readonly allowDestructive?: boolean;
  /** Publish each type it changes (default); false leaves each as a draft revision. */
  readonly publish?: boolean;
}

/** A content type a push changes. */
export interface PushedContentType {
  readonly contentTypeApiId: string;
  readonly fields: readonly BlockFieldChange[];
  /** Removes a variant or a field from the type. */
  readonly destructive: boolean;
  /** The type's version after the push (or after it, for a dry run). */
  readonly version: number;
  readonly published: boolean;
}

/** Something a push would remove that entries still hold. */
export interface BlocksInUse {
  readonly contentTypeApiId: string;
  /** A variant (`body: hero`, `body[grid].items: card`) or a field (`body[hero].kicker`). */
  readonly at: string;
  readonly kind: 'variant' | 'field';
  readonly entries: readonly string[];
}

/** What a push did, or would do. */
export interface BlockCatalogPush {
  readonly dryRun: boolean;
  /** True when it wrote a new version. */
  readonly applied: boolean;
  /** The catalog and its types already match: nothing to write. */
  readonly unchanged: boolean;
  /** The version before the push (0 before the first). */
  readonly previousVersion: number;
  /** The version in force after it: the new one, or the previous when nothing changed. */
  readonly version: number;
  readonly hash: string;
  readonly changes: BlockCatalogChanges;
  readonly contentTypes: readonly PushedContentType[];
  /** True when it removes blocks or block props from a type. */
  readonly destructive: boolean;
  /** What it would remove that entries hold: a push with any is refused. */
  readonly inUse: readonly BlocksInUse[];
  readonly warnings: readonly ContentTypeWarning[];
}

/** SHA-256 of the canonical catalog: what tells an unchanged push from a new version. */
export function blockCatalogHash(
  blocks: readonly BlockManifest[],
  targets: readonly BlockCatalogTarget[],
): string {
  return createHash('sha256').update(canonicalJson({ blocks, targets })).digest('hex');
}

/**
 * Checks a catalog, works out what it changes (blocks added, changed, removed and renamed since
 * the version in force; each target type's variants; the entries holding anything it removes)
 * and, unless `dryRun`, applies it: every changed type revised (and published, unless
 * `publish: false`) and the new version stored, in one unit. Pushing the catalog in force again
 * changes nothing and writes nothing.
 *
 * Refused (409) when `expectedVersion` isn't the version in force, when it would remove a variant
 * or field an entry still holds (its current version, the trash or its published snapshot), when
 * it removes anything at all without `allowDestructive`, and when another push or a change to a
 * target type commits first. `caller` is the request's principal (or {@link SYSTEM_CALLER}), as
 * every content type save takes.
 */
export async function pushBlockCatalog(
  ctx: AppContext,
  caller: ContentTypeCaller,
  scope: Scope,
  input: PushBlockCatalogInput,
): Promise<BlockCatalogPush> {
  assertContentTypeCaller(caller);
  const { blocks, targets } = checkBlockCatalog(input);
  const latest = await ctx.store.blockCatalogs.latest(scope);
  const previousVersion = latest?.version ?? 0;
  if (input.expectedVersion !== undefined && input.expectedVersion !== previousVersion) {
    throw new ConflictError(
      `The block catalog is at version ${previousVersion}, not ${input.expectedVersion}: ` +
        'someone pushed since. Review the change again and push over it.',
      { version: previousVersion },
    );
  }
  const changes = diffBlockCatalogs(latest?.blocks ?? null, blocks);
  await assertThumbnailAssets(ctx, scope, blocks);

  const types = new Map<string, ContentType>();
  for (const apiId of new Set(targets.map((t) => t.contentTypeApiId))) {
    const type = await ctx.store.contentTypes.get(scope, apiId);
    if (type) types.set(apiId, type);
  }
  const publish = input.publish !== false;
  const plans = planCatalogTypes(blocks, targets, types);
  const revisions = plans.map((plan) => {
    const current = types.get(plan.contentTypeApiId) as ContentType;
    const revised = reviseContentType(
      current,
      { fields: [...plan.fields] },
      { previewLoopback: ctx.previewLoopback === true },
    );
    return {
      plan,
      current,
      next: publish ? { ...revised, status: 'published' as const } : revised,
    };
  });

  const inUse: BlocksInUse[] = [];
  const warnings: ContentTypeWarning[] = [];
  for (const { current, next } of revisions) {
    const held = await removedContentInUse(ctx, scope, current, next);
    for (const v of held.variantsInUse) {
      inUse.push({
        contentTypeApiId: current.apiId,
        at: v.variant,
        kind: 'variant',
        entries: v.entries,
      });
    }
    for (const f of held.fieldsInUse) {
      inUse.push({
        contentTypeApiId: current.apiId,
        at: f.field,
        kind: 'field',
        entries: f.entries,
      });
    }
    warnings.push(...(await tightenedRulesInUse(ctx, scope, current, next)));
  }

  const hash = blockCatalogHash(blocks, targets);
  const unchanged = latest?.hash === hash && revisions.length === 0;
  const destructive = plans.some((p) => p.destructive);
  const result: BlockCatalogPush = {
    dryRun: input.dryRun === true,
    applied: false,
    unchanged,
    previousVersion,
    version: unchanged ? previousVersion : previousVersion + 1,
    hash,
    changes,
    contentTypes: revisions.map(({ plan, next }) => ({
      contentTypeApiId: plan.contentTypeApiId,
      fields: plan.changes,
      destructive: plan.destructive,
      version: next.version,
      published: next.status === 'published',
    })),
    destructive,
    inUse,
    warnings,
  };
  if (input.dryRun || unchanged) return result;

  if (inUse.length > 0) {
    const listed = inUse.map(
      (u) => `${u.contentTypeApiId}.${describeRemovedInUse(u.at, u.entries)}`,
    );
    throw new ConflictError(
      `The push removes blocks or block props that entries still hold: ${listed.join('; ')}. ` +
        'Change or clear those values first, or keep the old id in the new block’s aliases.',
      result,
    );
  }
  if (destructive && !input.allowDestructive) {
    throw new ConflictError(
      'The push removes blocks or block props from a content type. Review the dry run, then push ' +
        'again with allowDestructive.',
      result,
    );
  }

  const saves = await Promise.all(
    revisions.map(({ current, next }) => prepareContentTypeSave(ctx, scope, current, next)),
  );
  const catalog: BlockCatalog = {
    version: result.version,
    hash,
    blocks,
    targets,
    changes,
    pushedAt: ctx.clock.now().toISOString(),
    pushedBy: caller === SYSTEM_CALLER ? null : auditActor(caller),
  };
  try {
    await ctx.store.withTransaction(async (tx) => {
      for (const save of saves) await save.write(tx);
      await tx.blockCatalogs.save(scope, catalog);
    });
  } catch (err) {
    if (!(err instanceof TransactionConflictError)) throw err;
    throw new ConflictError(
      'The block catalog or one of its content types changed while it was being pushed; try again',
    );
  }
  return { ...result, applied: true };
}

/** A thumbnail naming an asset names one in the scope. */
async function assertThumbnailAssets(
  ctx: AppContext,
  scope: Scope,
  blocks: readonly BlockManifest[],
): Promise<void> {
  const wanted = new Map<string, string>();
  for (const b of blocks) {
    if (b.thumbnail && 'assetId' in b.thumbnail) wanted.set(b.thumbnail.assetId, b.id);
  }
  if (wanted.size === 0) return;
  const found = new Set(
    (await ctx.store.assets.getMany(scope, [...wanted.keys()])).map((a) => a.id),
  );
  const missing = [...wanted].filter(([id]) => !found.has(id));
  if (missing.length > 0) {
    throw new ValidationError(
      missing.map(([id, block]) => ({
        field: `blocks[${block}].thumbnail`,
        message: `No asset "${id}" in this environment`,
      })),
    );
  }
}

/** The catalog in force, or the given version of it. */
export async function getBlockCatalog(
  ctx: AppContext,
  scope: Scope,
  version?: number,
): Promise<BlockCatalog> {
  const catalog =
    version === undefined
      ? await ctx.store.blockCatalogs.latest(scope)
      : await ctx.store.blockCatalogs.get(scope, version);
  if (!catalog) {
    throw new NotFoundError('BlockCatalog', version === undefined ? 'latest' : String(version));
  }
  return catalog;
}

/** Versions listed per page, at most. */
export const MAX_BLOCK_CATALOG_VERSIONS_PAGE = 100;

/** The catalog's versions, newest first, without their blocks: `limit` of them, below `before`. */
export async function listBlockCatalogVersions(
  ctx: AppContext,
  scope: Scope,
  opts: { readonly limit?: number; readonly before?: number } = {},
): Promise<BlockCatalogSummary[]> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), MAX_BLOCK_CATALOG_VERSIONS_PAGE);
  return ctx.store.blockCatalogs.list(scope, {
    limit,
    ...(opts.before !== undefined ? { before: opts.before } : {}),
  });
}

/** How many entries use one block, in all and per content type. */
export interface BlockUsage {
  readonly id: string;
  readonly entries: number;
  readonly contentTypes: readonly { readonly contentTypeApiId: string; readonly entries: number }[];
}

export interface BlockCatalogUsage {
  /** The catalog version the blocks are from; null before the first push. */
  readonly version: number | null;
  /** Every block in the catalog, unused ones at 0. */
  readonly blocks: readonly BlockUsage[];
  /** Entries read. */
  readonly scanned: number;
  /** False when a type had more entries than the scan reads: the counts are a lower bound. */
  readonly complete: boolean;
}

/** Entries read per page, and at most per content type, while counting block usage. */
const USAGE_PAGE = 100;
export const MAX_BLOCK_USAGE_SCAN = 2000;

/**
 * How many entries use each block of the catalog in force, per target content type: the current
 * version of every entry outside the trash, counted once per entry however many times it uses
 * the block, a block stored under a former id counting as its block. Types `caller` may not read
 * are left out.
 *
 * Nothing indexes blocks inside field values, so this reads entries, a page at a time (one bounded
 * statement each), up to {@link MAX_BLOCK_USAGE_SCAN} per type; past that `complete` is false and
 * the counts are a lower bound. A read path: it writes nothing.
 */
export async function getBlockUsage(
  ctx: AppContext,
  caller: Principal,
  scope: Scope,
): Promise<BlockCatalogUsage> {
  const catalog = await ctx.store.blockCatalogs.latest(scope);
  if (!catalog) return { version: null, blocks: [], scanned: 0, complete: true };
  const counts = new Map<string, Map<string, number>>(catalog.blocks.map((b) => [b.id, new Map()]));
  let scanned = 0;
  let complete = true;
  const apiIds = [...new Set(catalog.targets.map((t) => t.contentTypeApiId))].filter((apiId) =>
    canAccessContentType(caller, 'read', apiId),
  );
  for (const apiId of apiIds) {
    const type = await ctx.store.contentTypes.get(scope, apiId);
    if (!type) continue;
    let read = 0;
    for (let after = ''; ; ) {
      const page = await ctx.store.entries.list(scope, {
        contentTypeApiId: apiId,
        archived: false,
        limit: USAGE_PAGE,
        afterEntryId: after,
      });
      for (const e of page) {
        for (const id of blocksUsed(type.fields, e.fields)) {
          const byType = counts.get(id);
          if (byType) byType.set(apiId, (byType.get(apiId) ?? 0) + 1);
        }
      }
      read += page.length;
      if (page.length < USAGE_PAGE) break;
      if (read >= MAX_BLOCK_USAGE_SCAN) {
        complete = false;
        break;
      }
      after = page[page.length - 1]?.entry.id ?? after;
    }
    scanned += read;
  }
  return {
    version: catalog.version,
    scanned,
    complete,
    blocks: catalog.blocks.map((b) => {
      const byType = counts.get(b.id) ?? new Map<string, number>();
      return {
        id: b.id,
        entries: [...byType.values()].reduce((n, c) => n + c, 0),
        contentTypes: [...byType].map(([contentTypeApiId, entries]) => ({
          contentTypeApiId,
          entries,
        })),
      };
    }),
  };
}
