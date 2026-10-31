import type { DomainEvent, EntriesPublishedBulkEvent, Webhook } from '@contentworker/domain';
import type {
  BlobStore,
  Cache,
  FunctionInvoker,
  SearchIndex,
  WebhookSender,
} from '@contentworker/ports';
import { runBulkChunk } from '../bulk-jobs.js';
import type { AppContext } from '../context.js';
import { invokeFunctionsForEvent } from '../functions.js';
import { importChunkRunner } from '../import-jobs.js';
import {
  extractTextByLocale,
  indexEntryEmbeddings,
  type RagDeps,
  removeEntryEmbeddings,
  runReindexJob,
} from '../rag.js';

/** Reverse-reference walk bound: embed chains deeper than this stay stale
 *  until their own next publish (cycle-safe either way via the visited set). */
export const MAX_INVALIDATION_DEPTH = 5;
/** Hard ceiling on entries invalidated per event (pathological fan-in guard). */
export const MAX_INVALIDATION_ENTRIES = 500;

export interface DispatchDeps {
  readonly sender: WebhookSender;
  /** Optional — when present, delivery cache tags are invalidated. */
  readonly cache?: Cache;
  /** Optional — when present, entries are embedded on publish (RAG). */
  readonly rag?: RagDeps;
  /** Optional — when present, matching user functions are invoked on each event. */
  readonly invoker?: FunctionInvoker;
  /** Optional observer for webhook delivery outcomes (host-side metrics). */
  readonly onWebhookDelivery?: (result: { delivered: boolean }) => void;
  /**
   * Optional lexical index (the FTS5 SearchShard Durable Objects), kept fresh on
   * publish/unpublish. Independent of `rag` so lexical-at-scale works without
   * embeddings configured.
   */
  readonly searchIndex?: SearchIndex;
  /**
   * Object storage, needed only to run import chunks — their work is staged
   * there rather than being a list of entry ids. A consumer without it leaves
   * import chunks claimable rather than reporting an import that did not run.
   */
  readonly blob?: BlobStore;
  /**
   * Tags already invalidated during this consumer invocation. A queue batch of
   * same-type publishes (a release, a burst of scheduled publishes) would
   * otherwise write the SAME `ct:` tag once per event — and a cache backend
   * like Workers KV rate-limits writes to a single key (~1/s), so the
   * redundant writes can 429 and re-drive the whole event. Hosts pass one Set
   * per batch; dispatch skips any tag already written under it.
   */
  readonly invalidatedTags?: Set<string>;
}

/**
 * Handles a single relayed domain event: fans it out to subscribed webhooks
 * (signed + recorded) and invalidates the delivery cache for the affected entry
 * AND every entry that embeds it (via the reverse-reference graph), so embedded
 * copies refresh on the next read. Idempotent on the event id.
 */
export async function dispatchEvent(
  ctx: AppContext,
  deps: DispatchDeps,
  event: DomainEvent,
): Promise<void> {
  const scope = event.scope;

  // Background reindex job: run one bounded slice here on the consumer; the
  // remainder (if any) is re-enqueued as a continuation event via the outbox.
  // Runs lexical-only when a SearchIndex is bound without embeddings, so a
  // reindex request never silently no-ops. Nothing else applies to this event.
  if (event.type === 'search.reindex_requested') {
    const searchIndex = deps.searchIndex ?? deps.rag?.searchIndex;
    if (deps.rag || searchIndex) {
      await runReindexJob(deps.rag, ctx, event, { searchIndex });
    }
    return;
  }

  // Bulk-job control event: claim and run one chunk. Not a state-change fact
  // — no webhooks/cache/RAG apply. (Normally routed to the dedicated bulk
  // topic; handled here too so a single-topic deployment still works.)
  if (event.type === 'bulk.chunk_due') {
    await runBulkChunk(ctx, event, {
      ...(deps.blob ? { importChunk: importChunkRunner(ctx, deps.blob) } : {}),
    });
    return;
  }

  // Coalesced bulk fact: the bulk-shaped fan-out replaces N per-entry events.
  if (event.type === 'entries.published_bulk') {
    await dispatchBulkPublished(ctx, deps, event);
    return;
  }

  // 1. Webhook fan-out.
  const webhooks = await ctx.store.webhooks.listByTopic(scope, event.type);
  for (const webhook of webhooks) {
    const result = await deps.sender.send(webhook, event);
    deps.onWebhookDelivery?.({ delivered: result.delivered });
    await ctx.store.webhooks.recordDelivery(scope, {
      webhookId: webhook.id,
      eventId: event.id,
      status: result.delivered ? 'success' : 'failed',
      statusCode: result.statusCode,
      attempts: 1,
      error: result.error,
    });
  }

  // 2. Cache invalidation for entry events: the entry itself plus every entry
  // that transitively embeds it (A embeds B embeds C → publishing C refreshes
  // A and B). One bounded reverse-closure query, one batched invalidation.
  if (deps.cache && (event.type === 'entry.published' || event.type === 'entry.unpublished')) {
    const embedders = await ctx.store.references.findReverseClosure(scope, [event.entryId], {
      maxDepth: MAX_INVALIDATION_DEPTH,
      maxEntries: MAX_INVALIDATION_ENTRIES,
    });
    const tags = [
      ...[event.entryId, ...embedders].map((id) => cacheTag(scope, id)),
      // Cached LIST results are tagged by content type, not by member id — a
      // new or withdrawn entry changes which rows a list returns even though
      // no cached member entry changed, so the type's tag must bump too.
      contentTypeTag(scope, event.contentTypeApiId),
    ];
    // Coalesce across the batch: re-writing a tag another event in this same
    // invocation already bumped adds no invalidation, only write pressure on
    // a single hot key.
    const fresh = deps.invalidatedTags ? tags.filter((t) => !deps.invalidatedTags?.has(t)) : tags;
    if (fresh.length > 0) {
      await deps.cache.invalidateTags(fresh);
      for (const t of fresh) deps.invalidatedTags?.add(t);
    }
  }

  // 2b. Asset events: delivery renders EMBED an asset's file/title/description
  // into every entry that links it, so an asset change must invalidate those
  // entries — nothing else would. The reference graph already stores asset
  // edges, so the same bounded reverse closure finds the embedders (including
  // transitively, e.g. page -> card -> asset).
  if (deps.cache && (event.type === 'asset.published' || event.type === 'asset.unpublished')) {
    const embedders = await ctx.store.references.findReverseClosure(scope, [event.assetId], {
      maxDepth: MAX_INVALIDATION_DEPTH,
      maxEntries: MAX_INVALIDATION_ENTRIES,
    });
    if (embedders.length > 0) {
      // Per-entry tags cover cached single-entry renders. Cached LISTS carry
      // no tag for a resolved member, so the embedders' content types are
      // needed too — one batched read, bounded by the closure cap.
      const snapshots = await ctx.store.entries.getPublishedMany(scope, embedders);
      const types = new Set(snapshots.map((e) => e.contentTypeApiId));
      const tags = [
        ...embedders.map((id) => cacheTag(scope, id)),
        ...[...types].map((t) => contentTypeTag(scope, t)),
      ];
      const fresh = deps.invalidatedTags ? tags.filter((t) => !deps.invalidatedTags?.has(t)) : tags;
      if (fresh.length > 0) {
        await deps.cache.invalidateTags(fresh);
        for (const t of fresh) deps.invalidatedTags?.add(t);
      }
    }
  }

  // Terminal bulk-job fact: the unconditional scope-epoch bump — the
  // correctness backstop for any bump missed while the job ran. (Webhook
  // fan-out above already delivered the job summary to subscribers.)
  if (deps.cache && event.type === 'bulk.job_completed') {
    await deps.cache.invalidateTag(epochTag(scope));
  }

  // 3. RAG: (re)embed on publish, drop vectors on unpublish.
  if (deps.rag) {
    if (event.type === 'entry.published') {
      await indexEntryEmbeddings(deps.rag, scope, {
        entryId: event.entryId,
        fields: event.fields,
        entryVersion: event.version,
      });
    } else if (event.type === 'entry.unpublished') {
      await removeEntryEmbeddings(deps.rag, scope, event.entryId);
    }
  }

  // 3b. External lexical index (when bound): mirror the publish lifecycle.
  const searchIndex = deps.searchIndex ?? deps.rag?.searchIndex;
  if (searchIndex) {
    if (event.type === 'entry.published') {
      await searchIndex.index(scope, {
        entryId: event.entryId,
        contentTypeApiId: event.contentTypeApiId,
        textByLocale: extractTextByLocale(event.fields),
        entryVersion: event.version,
      });
    } else if (event.type === 'entry.unpublished') {
      await searchIndex.remove(scope, event.entryId);
    }
  }

  // 4. User-defined functions matching this event type.
  if (deps.invoker) {
    await invokeFunctionsForEvent(ctx, deps.invoker, event);
  }
}

/** Concurrent webhook POSTs per bulk event (bounds subrequest burst). */
const BULK_WEBHOOK_CONCURRENCY = 5;

/**
 * Fan-out for one coalesced `entries.published_bulk` chunk event.
 *
 * - Cache: ONE scope-epoch bump instead of up to `entryIds.length × 500`
 *   per-entry tag writes — a bulk chunk has changed enough of the scope that
 *   precise invalidation is worse than a scope-wide lazy refresh. Every
 *   delivery envelope carries the epoch tag, so readers re-render on next
 *   read. (Physically forced too: per-entry closure walks and KV writes at
 *   bulk scale would blow the per-invocation subrequest budget.)
 * - Webhooks: receivers keep the per-entry payload contract — each entry is
 *   sent as a synthesized `entry.published`/`entry.unpublished` event with
 *   the deterministic derived id `${event.id}:${entryId}`, so redelivered
 *   chunks dedupe receiver-side. One delivery record per webhook summarizes
 *   the batch.
 * - RAG/search: batch-read snapshots once, then index per entry.
 */
async function dispatchBulkPublished(
  ctx: AppContext,
  deps: DispatchDeps,
  event: EntriesPublishedBulkEvent,
): Promise<void> {
  const scope = event.scope;
  const isPublish = event.action === 'publish';
  const perEntryType = isPublish ? ('entry.published' as const) : ('entry.unpublished' as const);

  // Snapshots for webhook payloads + indexing (publish only; unpublished
  // entries have left the read model and need ids only).
  const snapshots = isPublish
    ? await ctx.store.entries.getPublishedMany(scope, event.entryIds)
    : [];
  const snapshotById = new Map(snapshots.map((s) => [s.entryId, s]));

  // Publish sends only entries whose snapshot still exists — one re-unpublished
  // between chunk commit and dispatch gets no degraded empty-fields payload
  // (its own unpublish event tells the receiver what happened instead).
  const webhookIds = isPublish
    ? event.entryIds.filter((id) => snapshotById.has(id))
    : [...event.entryIds];

  // 1. Webhooks: subscribers to the per-entry topics get synthesized
  // per-entry events; subscribers to the bulk topic get the bulk event.
  const perEntryWebhooks = await ctx.store.webhooks.listByTopic(scope, perEntryType);
  for (const webhook of perEntryWebhooks) {
    let failed = 0;
    let lastError: string | undefined;
    const sendOne = async (entryId: string) => {
      const snapshot = snapshotById.get(entryId);
      // Derived id from STABLE coordinates (jobId, chunkId, entryId) — a
      // chunk re-run mints a fresh event id, but the receiver's dedupe key
      // must not change with it.
      const derivedId = `${event.jobId}:${event.chunkId}:${entryId}`;
      const perEntryEvent: DomainEvent =
        isPublish && snapshot
          ? {
              id: derivedId,
              type: 'entry.published',
              scope,
              occurredAt: event.occurredAt,
              entryId,
              contentTypeApiId: snapshot.contentTypeApiId,
              version: snapshot.version,
              fields: snapshot.fields,
            }
          : {
              id: derivedId,
              type: 'entry.unpublished',
              scope,
              occurredAt: event.occurredAt,
              entryId,
              contentTypeApiId: '',
            };
      const result = await deps.sender.send(webhook, perEntryEvent);
      deps.onWebhookDelivery?.({ delivered: result.delivered });
      if (!result.delivered) {
        failed += 1;
        lastError = result.error ?? `HTTP ${result.statusCode}`;
      }
    };
    // Per-endpoint failures are recorded, never thrown: the retry unit stays
    // the receiver's dedupe on derived ids, not this whole chunk event.
    for (let at = 0; at < webhookIds.length; at += BULK_WEBHOOK_CONCURRENCY) {
      await Promise.all(
        webhookIds.slice(at, at + BULK_WEBHOOK_CONCURRENCY).map((id) => sendOne(id)),
      );
    }
    await ctx.store.webhooks.recordDelivery(scope, {
      webhookId: webhook.id,
      eventId: event.id,
      status: failed === 0 ? 'success' : 'failed',
      attempts: 1,
      error:
        failed === 0 ? undefined : `${failed}/${webhookIds.length} deliveries failed: ${lastError}`,
    });
  }
  const bulkWebhooks = (await ctx.store.webhooks.listByTopic(scope, event.type)).filter(
    (w: Webhook) => !perEntryWebhooks.some((p) => p.id === w.id),
  );
  for (const webhook of bulkWebhooks) {
    const result = await deps.sender.send(webhook, event);
    deps.onWebhookDelivery?.({ delivered: result.delivered });
    await ctx.store.webhooks.recordDelivery(scope, {
      webhookId: webhook.id,
      eventId: event.id,
      status: result.delivered ? 'success' : 'failed',
      statusCode: result.statusCode,
      attempts: 1,
      error: result.error,
    });
  }

  // 2. Cache: one epoch bump for the whole chunk.
  if (deps.cache) {
    await deps.cache.invalidateTag(epochTag(scope));
  }

  // 3. RAG + lexical index, from the batch-read snapshots.
  if (deps.rag) {
    if (isPublish) {
      for (const s of snapshots) {
        await indexEntryEmbeddings(deps.rag, scope, {
          entryId: s.entryId,
          fields: s.fields,
          entryVersion: s.version,
        });
      }
    } else {
      for (const id of event.entryIds) {
        await removeEntryEmbeddings(deps.rag, scope, id);
      }
    }
  }
  const searchIndex = deps.searchIndex ?? deps.rag?.searchIndex;
  if (searchIndex) {
    if (isPublish) {
      for (const s of snapshots) {
        // refresh: false — bulk writes defer to the engine's refresh cycle.
        await searchIndex.index(
          scope,
          {
            entryId: s.entryId,
            contentTypeApiId: s.contentTypeApiId,
            textByLocale: extractTextByLocale(s.fields),
            entryVersion: s.version,
          },
          { refresh: false },
        );
      }
    } else {
      for (const id of event.entryIds) {
        await searchIndex.remove(scope, id);
      }
    }
  }

  // 4. User functions see the bulk event itself (one invocation per function,
  // not one per entry).
  if (deps.invoker) {
    await invokeFunctionsForEvent(ctx, deps.invoker, event);
  }
}

/** Cache tag for a delivered entry, scoped to its space + environment. */
export function cacheTag(
  scope: { spaceId: string; environmentId: string },
  entryId: string,
): string {
  return `entry:${scope.spaceId}:${scope.environmentId}:${entryId}`;
}

/**
 * Scope-wide epoch tag. Every delivery cache envelope carries it, so bumping
 * this ONE version key lazily evicts the whole scope — the bulk-operation
 * invalidation path (one KV write instead of one per affected entry).
 */
export function epochTag(scope: { spaceId: string; environmentId: string }): string {
  return `epoch:${scope.spaceId}:${scope.environmentId}`;
}

/**
 * Cache tag for every cached LIST result over a content type. Lists can't be
 * tagged by member id alone: publishing a NEW entry changes which rows a list
 * returns without touching any entry already in it, so a per-entry tag set
 * would never evict it. Bumped on every publish/unpublish of the type.
 */
export function contentTypeTag(
  scope: { spaceId: string; environmentId: string },
  contentTypeApiId: string,
): string {
  return `ct:${scope.spaceId}:${scope.environmentId}:${contentTypeApiId}`;
}
