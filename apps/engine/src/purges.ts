/**
 * What a batch of events leaves stale at the edge, and the purge messages that say so. Workers
 * Caching is per Worker, so delivery and media each drain their own queue: delivery responses are
 * tagged by space:environment, media responses by asset, rendition and environment.
 */
import type { AppContext } from '@contentworker/application';
import type { DomainEvent } from '@contentworker/domain';
import {
  deliveryScopeTag,
  mediaAssetTag,
  mediaEnvironmentTag,
  mediaRenditionTag,
  type PurgeMessage,
} from '@contentworker/platform/messages';

/** Events after which a space:environment's delivery responses may be stale. */
export const PURGING_EVENTS = new Set<string>([
  'entry.published',
  'entry.unpublished',
  'entries.published_bulk',
  'asset.published',
  'asset.unpublished',
  'asset.deleted',
  'content_type.published',
  'release.published',
  'environment_alias.changed',
  'environment.deleted',
]);

/**
 * Seconds before a revoked asset's media is purged a second time. A colo may still read the gate
 * entry it cached (KV's 60 s read cache) or a lagging D1 replica just after the first purge, and
 * cache the bytes again; by now every colo sees the removal, so the second purge is the last.
 */
export const REVOCATION_REPURGE_SECONDS = 90;

export interface PurgePlan {
  readonly delivery: Set<string>;
  /** Purged now. */
  readonly media: Set<string>;
  /** Purged now and again after {@link REVOCATION_REPURGE_SECONDS}: what stopped being served. */
  readonly revoked: Set<string>;
}

export const newPurgePlan = (): PurgePlan => ({
  delivery: new Set(),
  media: new Set(),
  revoked: new Set(),
});

/** Adds what `event` makes stale to `plan`. */
export async function planPurges(
  ctx: Pick<AppContext, 'store'>,
  plan: PurgePlan,
  event: DomainEvent,
): Promise<void> {
  const { spaceId, environmentId } = event.scope;
  if (PURGING_EVENTS.has(event.type)) {
    plan.delivery.add(deliveryScopeTag(spaceId, environmentId));
  }
  switch (event.type) {
    case 'asset.published':
      // A republish can move the focal point (so a crop) under the same URL.
      plan.media.add(mediaAssetTag(spaceId, environmentId, event.assetId));
      break;
    case 'asset.unpublished':
    case 'asset.deleted':
      plan.revoked.add(mediaAssetTag(spaceId, environmentId, event.assetId));
      break;
    case 'asset_renditions.changed': {
      // Presets belong to the space: every environment lists them, and every environment's
      // images were made with them.
      plan.revoked.add(mediaRenditionTag(spaceId, event.name));
      for (const env of await ctx.store.spaces.listEnvironments(spaceId)) {
        plan.delivery.add(deliveryScopeTag(spaceId, env.id));
      }
      break;
    }
    case 'environment.deleted':
    // Each purge step too: the last one clears the gate again (an entry written back while the
    // rows were still there), so the environment's cached media is purged after it, now and once
    // more after the delay. Cheap: one tag, coalesced per batch.
    case 'environment.purge_due':
      plan.revoked.add(mediaEnvironmentTag(spaceId, environmentId));
      break;
    default:
      break;
  }
}

/** The producers the plan goes to; either may be unbound (that cache then ages out alone). */
export interface PurgeQueues {
  readonly PURGE_QUEUE?: Pick<Queue, 'send'>;
  readonly MEDIA_PURGE_QUEUE?: Pick<Queue, 'send'>;
}

/**
 * Sends the plan: one delivery message, one media message for everything stale now, and a delayed
 * one for what was revoked. A failed send is logged, not thrown: the events it came from are
 * already handled, and retrying them would re-run every effect for a cache that ages out anyway.
 */
export async function sendPurges(
  queues: PurgeQueues,
  plan: PurgePlan,
  onError: (what: string, err: unknown) => void,
): Promise<void> {
  const sends: Promise<unknown>[] = [];
  if (plan.delivery.size > 0 && queues.PURGE_QUEUE) {
    const message: PurgeMessage = { tags: [...plan.delivery] };
    sends.push(
      queues.PURGE_QUEUE.send(message).catch((err: unknown) => onError('delivery purge', err)),
    );
  }
  const media = [...new Set([...plan.media, ...plan.revoked])];
  if (media.length > 0 && queues.MEDIA_PURGE_QUEUE) {
    const now: PurgeMessage = { tags: media };
    sends.push(
      queues.MEDIA_PURGE_QUEUE.send(now).catch((err: unknown) => onError('media purge', err)),
    );
    if (plan.revoked.size > 0) {
      const again: PurgeMessage = { tags: [...plan.revoked] };
      sends.push(
        queues.MEDIA_PURGE_QUEUE.send(again, { delaySeconds: REVOCATION_REPURGE_SECONDS }).catch(
          (err: unknown) => onError('media re-purge', err),
        ),
      );
    }
  }
  await Promise.all(sends);
}
