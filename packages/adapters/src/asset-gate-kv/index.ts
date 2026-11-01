import type { Scope } from '@contentworker/domain';
import type { AssetGate, AssetGateEntry } from '@contentworker/ports';

/** The subset of a Workers KV namespace binding the gate uses. */
export interface KvGateBinding {
  get(key: string, options?: { cacheTtl?: number }): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * How long a colo may keep a gate read (KV's minimum). A removal reaches every colo within it,
 * which is why the engine purges a revoked asset's media a second time once it has passed.
 */
export const GATE_READ_TTL_SECONDS = 60;

/** The KV key of one published asset's gate entry. */
export const assetGateKey = (scope: Scope, assetId: string) =>
  `asset-gate:${scope.spaceId}:${scope.environmentId}:${assetId}`;

function parse(raw: string): AssetGateEntry | null {
  try {
    const e = JSON.parse(raw) as Partial<AssetGateEntry>;
    if (
      typeof e.v === 'number' &&
      typeof e.r2Key === 'string' &&
      typeof e.contentType === 'string' &&
      typeof e.fileName === 'string'
    ) {
      return e as AssetGateEntry;
    }
  } catch {
    // Falls through: an unreadable entry gates nothing.
  }
  return null;
}

/**
 * The published-asset gate in Workers KV. The engine writes and removes entries from the asset's
 * events; the media Worker only reads them, on a cache miss. Entries never expire on their own:
 * an asset leaves the gate when it leaves Delivery.
 */
export function createKvAssetGate(kv: KvGateBinding): AssetGate {
  return {
    async get(scope, assetId) {
      const raw = await kv.get(assetGateKey(scope, assetId), { cacheTtl: GATE_READ_TTL_SECONDS });
      return raw === null ? null : parse(raw);
    },
    async put(scope, assetId, entry) {
      await kv.put(assetGateKey(scope, assetId), JSON.stringify(entry));
    },
    async delete(scope, assetId) {
      await kv.delete(assetGateKey(scope, assetId));
    },
  };
}
