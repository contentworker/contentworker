import type { Scope } from '@contentworker/domain';
import type {
  AssetGate,
  AssetGateEntry,
  ShareLinkGate,
  ShareLinkGateEntry,
} from '@contentworker/ports';

/** The subset of a Workers KV namespace binding the gate uses. */
export interface KvGateBinding {
  get(key: string, options?: { cacheTtl?: number }): Promise<string | null>;
  put(key: string, value: string, options?: { expiration?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  list(options: { prefix: string; cursor?: string; limit?: number }): Promise<{
    keys: readonly { name: string }[];
    list_complete: boolean;
    cursor?: string;
  }>;
}

/**
 * How long a colo may keep a gate read (KV's minimum). A removal reaches every colo within it,
 * which is why the engine purges a revoked asset's media a second time once it has passed.
 */
export const GATE_READ_TTL_SECONDS = 60;

/** The KV key prefix of one environment's gate entries. */
export const assetGatePrefix = (scope: Scope) =>
  `asset-gate:${scope.spaceId}:${scope.environmentId}:`;

/** The KV key of one published asset's gate entry. */
export const assetGateKey = (scope: Scope, assetId: string) =>
  `${assetGatePrefix(scope)}${assetId}`;

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
    async deleteScope(scope) {
      // A page at a time (KV lists at most 1000 keys), deleting as it goes; a retry after a
      // failure lists what is left. An environment id may hold ':' (`a` and `a:b` share a
      // prefix), and an asset id never does, so only keys with no ':' past the prefix are this
      // scope's.
      const prefix = assetGatePrefix(scope);
      let cursor: string | undefined;
      do {
        const page = await kv.list({ prefix, ...(cursor ? { cursor } : {}) });
        const own = page.keys.filter((k) => !k.name.slice(prefix.length).includes(':'));
        await Promise.all(own.map((k) => kv.delete(k.name)));
        cursor = page.list_complete ? undefined : page.cursor;
      } while (cursor);
    },
  };
}

/** The KV key of one share link's entry. */
export const shareLinkKey = (scope: Scope, linkId: string) =>
  `share-link:${scope.spaceId}:${scope.environmentId}:${linkId}`;

function parseLink(raw: string): ShareLinkGateEntry | null {
  try {
    const e = JSON.parse(raw) as Partial<ShareLinkGateEntry>;
    if (
      (e.targetType === 'asset' || e.targetType === 'collection') &&
      typeof e.targetId === 'string' &&
      typeof e.expiresAt === 'string' &&
      typeof e.allowDownload === 'boolean'
    ) {
      return e as ShareLinkGateEntry;
    }
  } catch {
    // Falls through: an unreadable entry opens nothing.
  }
  return null;
}

/**
 * Share links in Workers KV, beside the asset gate. The engine writes an entry when a link is
 * created and removes it when the link is revoked; KV drops it on its own when the link expires
 * (KV's expiry is at least a minute out, and the media Worker checks `expiresAt` itself anyway).
 */
export function createKvShareLinkGate(kv: KvGateBinding): ShareLinkGate {
  return {
    async get(scope, linkId) {
      const raw = await kv.get(shareLinkKey(scope, linkId), { cacheTtl: GATE_READ_TTL_SECONDS });
      return raw === null ? null : parseLink(raw);
    },
    async put(scope, linkId, entry) {
      const expiration = Math.floor(Date.parse(entry.expiresAt) / 1000);
      // KV refuses an expiry less than 60 seconds out: such a link is as good as expired.
      if (!(expiration - Date.now() / 1000 > 60)) {
        await kv.delete(shareLinkKey(scope, linkId));
        return;
      }
      await kv.put(shareLinkKey(scope, linkId), JSON.stringify(entry), { expiration });
    },
    async delete(scope, linkId) {
      await kv.delete(shareLinkKey(scope, linkId));
    },
  };
}
