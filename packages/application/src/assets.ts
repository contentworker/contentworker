import {
  type Asset,
  type AssetMetadata,
  applyAssetMetadata,
  emptyAssetMetadata,
  type LocalizedValue,
  NotFoundError,
  publishAsset as publishAssetState,
  type ReferenceEdge,
  type Scope,
  unpublishAsset as unpublishAssetState,
} from '@contentworker/domain';
import type { BlobStore, PublishedAsset } from '@contentworker/ports';
import type { AppContext } from './context.js';
import { runHook } from './hooks.js';

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
): Promise<CreatedAsset> {
  // Before the upload URL exists: a refused asset must not leave a signed URL
  // in the caller's hands, nor a key reserved in the bucket.
  const checked = await runHook(ctx, 'asset:beforeCreate', scope, input);

  const id = ctx.ids.newId();
  const key = `${scope.spaceId}/${scope.environmentId}/${id}/${safeObjectName(checked.fileName)}`;
  const upload = await blob.getUploadUrl(key, checked.contentType);
  const url = await blob.getDownloadUrl(key);
  const asset: Asset = {
    id,
    status: 'draft',
    file: { url, fileName: checked.fileName, contentType: checked.contentType },
    title: checked.title ?? {},
    description: checked.description ?? {},
    metadata: emptyAssetMetadata,
  };
  await ctx.store.assets.create(scope, asset);
  return { asset, upload };
}

export async function getAsset(ctx: AppContext, scope: Scope, id: string): Promise<Asset> {
  const asset = await ctx.store.assets.get(scope, id);
  if (!asset) throw new NotFoundError('Asset', id);
  return asset;
}

/** Lists all assets (draft + published) — the media library view. */
export async function listAssets(
  ctx: AppContext,
  scope: Scope,
  query: { limit?: number; skip?: number } = {},
): Promise<Asset[]> {
  return ctx.store.assets.list(scope, query);
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
