import {
  type Asset,
  AssetInUseError,
  type AssetMetadata,
  type AssetUsage,
  applyAssetMetadata,
  archiveAsset as archiveAssetState,
  emptyAssetMetadata,
  type LocalizedValue,
  MAX_ASSET_USAGE_SHOWN,
  NotFoundError,
  publishAsset as publishAssetState,
  type ReferenceEdge,
  restoreAsset as restoreAssetState,
  type Scope,
  unpublishAsset as unpublishAssetState,
  ValidationError,
} from '@contentworker/domain';
import {
  type AssetListQuery,
  type AssetPage,
  type BlobStore,
  type PublishedAsset,
  TransactionConflictError,
} from '@contentworker/ports';
import type { AppContext } from './context';
import { runHook } from './hooks';

export interface CreateAssetInput {
  readonly fileName: string;
  readonly contentType: string;
  readonly title?: LocalizedValue;
  readonly description?: LocalizedValue;
}

export interface CreatedAsset {
  readonly asset: Asset;
  /** Presigned upload target — the client PUTs the bytes here directly. */
  readonly upload: { url: string; headers: Record<string, string> };
}

/**
 * Reduces a client-supplied file name to a safe object-key segment: the final
 * path component only, with separators, traversal, and control characters
 * stripped. This prevents a crafted `fileName` (e.g. `../../otherspace/...`)
 * from escaping the scope's `spaceId/environmentId/id/` key prefix and reading
 * or overwriting another space's objects. Falls back to `file` when nothing
 * printable remains; the unique `id` in the prefix keeps keys collision-free.
 */
function safeObjectName(fileName: string): string {
  const last = fileName.split(/[/\\]/).pop() ?? '';
  let base = '';
  for (const ch of last) {
    const code = ch.codePointAt(0) ?? 0;
    if (code > 0x1f && code !== 0x7f) base += ch;
  }
  if (base === '' || base === '.' || base === '..') return 'file';
  return base.slice(0, 200);
}

/** Where an asset's bytes live in blob storage. */
export function assetObjectKey(scope: Scope, assetId: string, fileName: string): string {
  return `${scope.spaceId}/${scope.environmentId}/${assetId}/${safeObjectName(fileName)}`;
}

/**
 * Creates a draft asset and returns a presigned upload URL. The client uploads
 * the bytes straight to blob storage (they never transit the API), then
 * publishes the asset to make it deliverable.
 */
export async function createAsset(
  ctx: AppContext,
  blob: BlobStore,
  scope: Scope,
  input: CreateAssetInput,
  opts: { readonly createdBy?: string; readonly folderId?: string } = {},
): Promise<CreatedAsset> {
  // Before the upload URL exists: a refused asset must not leave a signed URL
  // in the caller's hands, nor a key reserved in the bucket.
  const checked = await runHook(ctx, 'asset:beforeCreate', scope, input);

  if (opts.folderId) await getAssetFolderOrThrow(ctx, scope, opts.folderId);
  const id = ctx.ids.newId();
  const key = assetObjectKey(scope, id, checked.fileName);
  const upload = await blob.getUploadUrl(key, checked.contentType);
  const url = await blob.getDownloadUrl(key);
  const asset: Asset = {
    id,
    status: 'draft',
    file: { url, fileName: checked.fileName, contentType: checked.contentType },
    title: checked.title ?? {},
    description: checked.description ?? {},
    metadata: emptyAssetMetadata,
    version: 1,
    r2Key: key,
    createdAt: ctx.clock.now().toISOString(),
    ...(opts.createdBy ? { createdBy: opts.createdBy } : {}),
    ...(opts.folderId ? { folderId: opts.folderId } : {}),
  };
  try {
    await ctx.store.assets.create(scope, asset);
  } catch (err) {
    // The folder was deleted after the check: report it like the check would have.
    if (err instanceof TransactionConflictError && opts.folderId) {
      throw new NotFoundError('AssetFolder', opts.folderId);
    }
    throw err;
  }
  return { asset, upload };
}

export async function getAsset(ctx: AppContext, scope: Scope, id: string): Promise<Asset> {
  const asset = await ctx.store.assets.get(scope, id);
  if (!asset) throw new NotFoundError('Asset', id);
  return asset;
}

/**
 * One page of the asset library, filtered and sorted; pass `nextCursor` back for the next.
 * Archived assets are left out unless `filters.status` asks for them.
 */
export async function listAssets(
  ctx: AppContext,
  scope: Scope,
  query: AssetListQuery = {},
): Promise<AssetPage> {
  return ctx.store.assets.list(scope, query);
}

/**
 * Every asset in the scope, whatever its status, page by page: for work that must see the whole
 * library (an export, the files another environment still uses).
 */
export async function allAssets(ctx: AppContext, scope: Scope): Promise<Asset[]> {
  const out: Asset[] = [];
  let cursor: string | undefined;
  do {
    const page = await ctx.store.assets.list(scope, {
      limit: 500,
      filters: { status: 'all' },
      ...(cursor ? { cursor } : {}),
    });
    out.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return out;
}

/** Publishes an asset — writes the denormalized snapshot served by Delivery. */
export async function publishAsset(ctx: AppContext, scope: Scope, id: string): Promise<Asset> {
  return ctx.store.withTransaction(async (tx) => {
    const asset = await tx.assets.get(scope, id);
    if (!asset) throw new NotFoundError('Asset', id);
    const published = publishAssetState(asset);
    await tx.assets.save(scope, published);
    await tx.assets.putPublished(scope, {
      assetId: published.id,
      file: published.file,
      title: published.title,
      description: published.description,
      metadata: published.metadata,
      publishedAt: ctx.clock.now().toISOString(),
    });
    // Same transaction as the write: delivery renders embed this asset's
    // file/title/description into linking entries, so the invalidation event
    // must be enqueued iff the publish commits.
    await tx.outbox.append({
      id: ctx.ids.newId(),
      type: 'asset.published',
      scope,
      occurredAt: ctx.clock.now().toISOString(),
      assetId: published.id,
    });
    return published;
  });
}

export async function unpublishAsset(ctx: AppContext, scope: Scope, id: string): Promise<Asset> {
  return ctx.store.withTransaction(async (tx) => {
    const asset = await tx.assets.get(scope, id);
    if (!asset) throw new NotFoundError('Asset', id);
    const updated = unpublishAssetState(asset);
    await tx.assets.save(scope, updated);
    await tx.assets.removePublished(scope, id);
    await tx.outbox.append({
      id: ctx.ids.newId(),
      type: 'asset.unpublished',
      scope,
      occurredAt: ctx.clock.now().toISOString(),
      assetId: id,
    });
    return updated;
  });
}

export async function getPublishedAsset(
  ctx: AppContext,
  scope: Scope,
  id: string,
): Promise<PublishedAsset> {
  const snapshot = await ctx.store.assets.getPublished(scope, id);
  if (!snapshot) throw new NotFoundError('PublishedAsset', id);
  return snapshot;
}

export async function listPublishedAssets(
  ctx: AppContext,
  scope: Scope,
  query: { limit?: number; skip?: number } = {},
): Promise<PublishedAsset[]> {
  return ctx.store.assets.listPublished(scope, query);
}

/** A metadata patch — any subset of the editable "Aspects" of an asset. */
export type AssetMetadataPatch = Partial<AssetMetadata>;

/**
 * Updates an asset's editorial metadata (alt text, focal point, tags, custom
 * fields), validating the focal point in the domain. Re-publishing carries the
 * new metadata into the delivered snapshot; this only touches the draft.
 */
export async function setAssetMetadata(
  ctx: AppContext,
  scope: Scope,
  id: string,
  patch: AssetMetadataPatch,
): Promise<Asset> {
  const asset = await ctx.store.assets.get(scope, id);
  if (!asset) throw new NotFoundError('Asset', id);
  const updated = applyAssetMetadata(asset, patch);
  await ctx.store.assets.save(scope, updated);
  return updated;
}

/**
 * Lists the entries that reference an asset — its usage across the space. Reuses
 * the reverse-reference index that already tracks entry→asset links.
 */
export async function getAssetUsage(
  ctx: AppContext,
  scope: Scope,
  id: string,
): Promise<ReferenceEdge[]> {
  return ctx.store.references.findReverse(scope, id);
}

/**
 * Archives an asset: it stops being delivered at once (the published snapshot goes, in the same
 * unit as the `asset.unpublished` event that purges delivery caches) and can't be published until
 * restored. Archiving an archived asset changes nothing, so a retried request is harmless.
 *
 * The snapshot is removed and the event sent whatever status the read saw: the unit's read is not
 * a lock, so a publish that commits between it and this commit would otherwise leave an archived
 * asset delivered. For an asset that was never published both are no-ops downstream.
 */
export async function archiveAsset(ctx: AppContext, scope: Scope, id: string): Promise<Asset> {
  return ctx.store.withTransaction(async (tx) => {
    const asset = await tx.assets.get(scope, id);
    if (!asset) throw new NotFoundError('Asset', id);
    if (asset.status === 'archived') return asset;
    const archived = archiveAssetState(asset, ctx.clock.now().toISOString());
    await tx.assets.save(scope, archived);
    await tx.assets.removePublished(scope, id);
    await tx.outbox.append({
      id: ctx.ids.newId(),
      type: 'asset.unpublished',
      scope,
      occurredAt: ctx.clock.now().toISOString(),
      assetId: id,
    });
    return archived;
  });
}

/**
 * Restores an archived asset as a draft. Republishing is a separate, deliberate step, as for the
 * entry trash. Restoring one that isn't archived changes nothing.
 */
export async function restoreAsset(ctx: AppContext, scope: Scope, id: string): Promise<Asset> {
  const asset = await ctx.store.assets.get(scope, id);
  if (!asset) throw new NotFoundError('Asset', id);
  if (asset.status !== 'archived') return asset;
  const restored = restoreAssetState(asset);
  await ctx.store.assets.save(scope, restored);
  return restored;
}

/**
 * Deletes an asset for good. Refused with {@link AssetInUseError} while any entry links to it
 * (archive it instead, or remove the links first); the store re-checks at commit, so a link made
 * in between refuses it too.
 *
 * The row, its published snapshot and its versions go in one unit with an `asset.deleted` event;
 * the engine removes the bytes (blob storage, and the video host for a hosted video) when it
 * handles the event, so a failed removal is retried rather than lost. A published asset also
 * emits `asset.unpublished`, as it leaves Delivery.
 */
export async function deleteAsset(ctx: AppContext, scope: Scope, id: string): Promise<void> {
  const asset = await ctx.store.assets.get(scope, id);
  if (!asset) throw new NotFoundError('Asset', id);
  const usage = await getAssetUsage(ctx, scope, id);
  if (usage.length > 0) throw await assetInUse(ctx, scope, id, usage);
  const now = ctx.clock.now().toISOString();
  const videoId = asset.file.video?.videoId;
  try {
    await ctx.store.withTransaction(async (tx) => {
      await tx.assets.delete(scope, id);
      if (asset.status === 'published') {
        await tx.outbox.append({
          id: ctx.ids.newId(),
          type: 'asset.unpublished',
          scope,
          occurredAt: now,
          assetId: id,
        });
      }
      await tx.outbox.append({
        id: ctx.ids.newId(),
        type: 'asset.deleted',
        scope,
        occurredAt: now,
        assetId: id,
        ...(videoId
          ? { videoId }
          : { r2Key: asset.r2Key ?? assetObjectKey(scope, id, asset.file.fileName) }),
      });
    });
  } catch (err) {
    // A link was made after the check: report it like the check would have.
    if (err instanceof TransactionConflictError) {
      throw await assetInUse(ctx, scope, id, await getAssetUsage(ctx, scope, id));
    }
    throw err;
  }
}

/**
 * The refusal for an asset still linked from entries, each link named the way a person recognises
 * it (content type and display title in the default locale), so a client shows the list without a
 * read per entry. Only the links the error carries are looked up.
 */
async function assetInUse(
  ctx: AppContext,
  scope: Scope,
  id: string,
  edges: readonly ReferenceEdge[],
): Promise<AssetInUseError> {
  const shown = edges.slice(0, MAX_ASSET_USAGE_SHOWN);
  const [entries, types, config] = await Promise.all([
    ctx.store.entries.getMany(scope, [...new Set(shown.map((e) => e.fromEntryId))]),
    ctx.store.contentTypes.list(scope),
    ctx.store.spaces.getConfig(scope),
  ]);
  const byId = new Map(entries.map((e) => [e.entry.id, e]));
  const displayField = new Map(types.map((t) => [t.apiId, t.displayField]));
  const usage = shown.map((edge): AssetUsage => {
    const found = byId.get(edge.fromEntryId);
    if (!found) return edge;
    const field = displayField.get(found.entry.contentTypeApiId);
    const value = field ? found.fields[field]?.[config?.defaultLocale ?? ''] : undefined;
    return {
      ...edge,
      contentTypeApiId: found.entry.contentTypeApiId,
      ...(typeof value === 'string' && value ? { entryTitle: value } : {}),
    };
  });
  return new AssetInUseError(id, usage, edges.length);
}

/**
 * Removes a deleted asset's bytes (the engine runs it for `asset.deleted`). Everything under the
 * asset's key prefix goes, so older versions' files go with the current one; but nothing goes
 * while another environment of the space still has an asset with this id, because an environment
 * import keeps asset ids and shares their files. Idempotent: a redelivered event finds nothing.
 */
export async function deleteAssetFiles(
  ctx: AppContext,
  deps: { readonly blob?: BlobStore },
  event: {
    readonly scope: Scope;
    readonly assetId: string;
    readonly r2Key?: string;
    readonly videoId?: string;
  },
): Promise<void> {
  const { scope, assetId } = event;
  for (const env of await ctx.store.spaces.listEnvironments(scope.spaceId)) {
    if (env.id === scope.environmentId) continue;
    const other = { spaceId: scope.spaceId, environmentId: env.id };
    if (await ctx.store.assets.get(other, assetId)) return;
  }
  if (event.videoId) await ctx.video?.delete(event.videoId);
  if (event.r2Key && deps.blob) {
    // `space/environment/assetId/…`: the prefix of the environment the bytes were uploaded in,
    // which for an imported asset is its source's.
    const prefix = event.r2Key.split('/').slice(0, 3).join('/');
    // Never outside this space, whatever the key says.
    if (!prefix.startsWith(`${scope.spaceId}/`)) return;
    if (deps.blob.deletePrefix && prefix.split('/').length === 3) {
      await deps.blob.deletePrefix(`${prefix}/`, () => false);
    } else {
      await deps.blob.delete(event.r2Key);
    }
  }
}

/** Most assets one move takes. The ids ride as one JSON parameter, so this bounds the request,
 *  not D1's parameter cap. */
export const MAX_ASSET_MOVE = 500;

/**
 * Files assets in a folder (`folderId: null` takes them out to the root). One statement whatever
 * the count; ids that aren't assets here are skipped. A folder deleted meanwhile refuses the move.
 */
export async function moveAssets(
  ctx: AppContext,
  scope: Scope,
  input: { readonly ids: readonly string[]; readonly folderId: string | null },
): Promise<{ readonly moved: number }> {
  const ids = [...new Set(input.ids)];
  if (ids.length === 0 || ids.length > MAX_ASSET_MOVE) {
    throw new ValidationError([
      { field: 'ids', message: `Move between 1 and ${MAX_ASSET_MOVE} assets at a time` },
    ]);
  }
  if (input.folderId !== null) await getAssetFolderOrThrow(ctx, scope, input.folderId);
  const found = await ctx.store.assets.getMany(scope, ids);
  try {
    await ctx.store.withTransaction((tx) => tx.assets.moveToFolder(scope, ids, input.folderId));
  } catch (err) {
    if (err instanceof TransactionConflictError && input.folderId !== null) {
      throw new NotFoundError('AssetFolder', input.folderId);
    }
    throw err;
  }
  return { moved: found.length };
}

async function getAssetFolderOrThrow(ctx: AppContext, scope: Scope, id: string) {
  const folder = await ctx.store.assetFolders.get(scope, id);
  if (!folder) throw new NotFoundError('AssetFolder', id);
  return folder;
}
