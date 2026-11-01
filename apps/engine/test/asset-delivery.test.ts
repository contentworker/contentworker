import { env } from 'cloudflare:workers';
import { assetGateKey, createKvAssetGate } from '@contentworker/adapters/asset-gate-kv';
import {
  type AppContext,
  consumeEvent,
  createAsset,
  createAssetRendition,
  createEnvironment,
  createSpace,
  createVideoAsset,
  publishAsset,
  refreshVideoAsset,
  unpublishAsset,
} from '@contentworker/application';
import { createD1Store } from '@contentworker/db';
import type { DomainEvent } from '@contentworker/domain';
import type { PurgeMessage } from '@contentworker/platform/messages';
import { FakeBlobStore, FakeVideoHost, RecordingWebhookSender } from '@contentworker/test-kit';
import { describe, expect, it } from 'vitest';
import {
  newPurgePlan,
  type PurgeQueues,
  planPurges,
  REVOCATION_REPURGE_SECONDS,
  sendPurges,
} from '../src/purges';

/**
 * What the events consumer does for published assets, on D1 and KV: it keeps the media origin's
 * gate in line with what is published, and asks both edge caches (delivery's and media's) to drop
 * what went stale, a revoked asset's media twice.
 */
const store = createD1Store(env.DB);
let seq = 0;
async function space(extra: Partial<AppContext> = {}) {
  const ctx: AppContext = {
    store,
    clock: { now: () => new Date() },
    ids: { newId: () => crypto.randomUUID() },
    ...extra,
  };
  const spaceId = `engine-assets-${++seq}`;
  await createSpace(ctx, { spaceId, name: 'Assets', defaultLocale: 'en-US' });
  return { ctx, scope: { spaceId, environmentId: 'main' } };
}

const gate = createKvAssetGate(env.KV_CACHE);

/** Fake producers that record what was sent, as the queue bindings would carry it. */
function queues() {
  const sent: { queue: string; body: PurgeMessage; delaySeconds?: number }[] = [];
  const producer = (queue: string) => ({
    async send(body: unknown, opts?: { delaySeconds?: number }) {
      sent.push({
        queue,
        body: body as PurgeMessage,
        ...(opts?.delaySeconds ? { delaySeconds: opts.delaySeconds } : {}),
      });
    },
  });
  const q: PurgeQueues = {
    PURGE_QUEUE: producer('purge') as never,
    MEDIA_PURGE_QUEUE: producer('media-purge') as never,
  };
  return { q, sent };
}

/** Consumes the scope's new outbox events as the engine does: effects, then one plan per batch. */
async function consume(ctx: AppContext, events: DomainEvent[]) {
  const plan = newPurgePlan();
  for (const e of events) {
    await consumeEvent(ctx, { sender: new RecordingWebhookSender(), assetGate: gate }, e);
    await planPurges(ctx, plan, e);
  }
  return plan;
}

async function eventsSince(scope: { spaceId: string }, since: number) {
  const rows = await env.DB.prepare(
    "select payload from outbox where json_extract(payload, '$.scope.spaceId') = ? and rowid > ? order by rowid",
  )
    .bind(scope.spaceId, since)
    .all<{ payload: string }>();
  return rows.results.map((r) => JSON.parse(r.payload) as DomainEvent);
}

async function lastRowid(): Promise<number> {
  const row = await env.DB.prepare('select ifnull(max(rowid), 0) as n from outbox').first<{
    n: number;
  }>();
  return row?.n ?? 0;
}

describe('asset events in the engine', () => {
  it('write the gate on publish and remove it on unpublish, purging both caches', async () => {
    const { ctx, scope } = await space();
    const { asset } = await createAsset(ctx, new FakeBlobStore(), scope, {
      fileName: 'a.png',
      contentType: 'image/png',
    });
    let mark = await lastRowid();
    await publishAsset(ctx, scope, asset.id);
    const published = await consume(ctx, await eventsSince(scope, mark));
    const raw = await env.KV_CACHE.get(assetGateKey(scope, asset.id));
    expect(JSON.parse(raw as string)).toEqual({
      v: 1,
      r2Key: asset.r2Key,
      contentType: 'image/png',
      fileName: 'a.png',
    });
    const { q, sent } = queues();
    await sendPurges(q, published, () => {});
    expect(sent).toEqual([
      { queue: 'purge', body: { tags: [`cw:${scope.spaceId}:main`] } },
      { queue: 'media-purge', body: { tags: [`cwa:${scope.spaceId}:main:${asset.id}`] } },
    ]);

    mark = await lastRowid();
    await unpublishAsset(ctx, scope, asset.id);
    const events = await eventsSince(scope, mark);
    const revoked = await consume(ctx, events);
    expect(await env.KV_CACHE.get(assetGateKey(scope, asset.id))).toBeNull();
    const second = queues();
    await sendPurges(second.q, revoked, () => {});
    const tag = `cwa:${scope.spaceId}:main:${asset.id}`;
    // Now, and again once every colo's cached gate read has lapsed.
    expect(second.sent.filter((s) => s.queue === 'media-purge')).toEqual([
      { queue: 'media-purge', body: { tags: [tag] } },
      { queue: 'media-purge', body: { tags: [tag] }, delaySeconds: REVOCATION_REPURGE_SECONDS },
    ]);

    // Redelivered: the gate stays removed, and nothing throws.
    await consume(ctx, events);
    expect(await env.KV_CACHE.get(assetGateKey(scope, asset.id))).toBeNull();
  });

  it('purge every environment’s delivery and the preset’s media when a rendition changes', async () => {
    const { ctx, scope } = await space();
    await createEnvironment(ctx, scope.spaceId, 'staging', 'Staging');
    const mark = await lastRowid();
    await createAssetRendition(ctx, scope, { name: 'thumb', width: 200 });
    const plan = await consume(ctx, await eventsSince(scope, mark));
    expect([...plan.delivery].sort()).toEqual([
      `cw:${scope.spaceId}:main`,
      `cw:${scope.spaceId}:staging`,
    ]);
    expect([...plan.revoked]).toEqual([`cwr:${scope.spaceId}:thumb`]);
  });

  it('send nothing to a queue that isn’t bound, and survive a failed send', async () => {
    const plan = newPurgePlan();
    plan.delivery.add('cw:s:e');
    plan.revoked.add('cwa:s:e:a');
    await sendPurges({}, plan, () => {});
    const failures: string[] = [];
    await sendPurges(
      {
        PURGE_QUEUE: { send: async () => Promise.reject(new Error('down')) } as never,
        MEDIA_PURGE_QUEUE: { send: async () => Promise.reject(new Error('down')) } as never,
      },
      plan,
      (what) => failures.push(what),
    );
    expect(failures.sort()).toEqual(['delivery purge', 'media purge', 'media re-purge']);
  });

  it('update a published video’s snapshot when Stream finishes, on D1', async () => {
    const host = new FakeVideoHost();
    const { ctx, scope } = await space({ video: host });
    const { asset } = await createVideoAsset(ctx, scope, {
      fileName: 'c.mp4',
      contentType: 'video/mp4',
    });
    await publishAsset(ctx, scope, asset.id);
    host.setVideo(asset.file.video?.videoId as string, {
      status: 'ready',
      hlsUrl: 'https://s/v.m3u8',
    });
    const mark = await lastRowid();
    await refreshVideoAsset(ctx, scope, asset.id);
    const snapshot = await store.assets.getPublished(scope, asset.id);
    expect(snapshot?.file.video).toMatchObject({ status: 'ready', hlsUrl: 'https://s/v.m3u8' });
    const events = await eventsSince(scope, mark);
    expect(events.map((e) => e.type)).toEqual(['asset.published']);
    // A hosted video is never gated: it plays from its host.
    await consume(ctx, events);
    expect(await env.KV_CACHE.get(assetGateKey(scope, asset.id))).toBeNull();
  });
});
