import type { Scope } from '@contentworker/domain';
import type { AssetGate, AssetGateEntry, PublishedAsset } from '@contentworker/ports';
import { assetFileKey } from './assets';
import type { AppContext } from './context';

/**
 * The gate entry for a published snapshot, or `null` when the media origin has nothing to serve
 * (a hosted video plays from its host). The media Worker builds the same entry from a D1 replica
 * when the gate has none yet, so both read paths agree.
 */
export function assetGateEntry(scope: Scope, snapshot: PublishedAsset): AssetGateEntry | null {
  if (snapshot.file.video) return null;
  const focal = snapshot.metadata.focalPoint;
  const expiresAt = snapshot.rights?.expiresAt;
  return {
    v: snapshot.version ?? 1,
    r2Key: assetFileKey(scope, {
      id: snapshot.assetId,
      file: snapshot.file,
      ...(snapshot.r2Key ? { r2Key: snapshot.r2Key } : {}),
    }),
    contentType: snapshot.file.contentType,
    fileName: snapshot.file.fileName,
    ...(focal ? { focal } : {}),
    ...(expiresAt ? { expiresAt } : {}),
  };
}

/**
 * Brings the asset's gate entry in line with what is published now: written while a published
 * snapshot exists, removed when there is none. It reads the current state rather than trusting
 * the event, so a redelivered or out-of-order event converges on the same entry. The engine runs
 * it for every asset event; nothing on a request path writes the gate.
 */
export async function syncAssetGate(
  ctx: AppContext,
  gate: AssetGate,
  scope: Scope,
  assetId: string,
): Promise<'written' | 'removed'> {
  const snapshot = await ctx.store.assets.getPublished(scope, assetId);
  const entry = snapshot ? assetGateEntry(scope, snapshot) : null;
  if (entry) {
    await gate.put(scope, assetId, entry);
    return 'written';
  }
  await gate.delete(scope, assetId);
  return 'removed';
}
