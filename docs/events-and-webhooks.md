# Events, async backbone & webhooks

contentworker uses a **transactional outbox** so that domain events are emitted exactly when (and
only when) their state change commits. The api Worker relays new events onto Cloudflare Queues
right after each write; the engine Worker consumes them, sweeps the outbox every minute, and
tells the delivery Worker which cache tags to purge.

## The pipeline

```
  publishEntry / unpublishEntry / publishContentType / setEnvironmentAlias …
        │  (ONE store.withTransaction = ONE D1 batch)
        ├─ write the denormalized read model (entry_published / removePublished)
        └─ outbox.append(event)                ← event is durable iff the batch commits
                                   │
        api fetch():       after each mutating request, waitUntil(drainOutbox(...))
        engine scheduled(): every minute, a cron sweep drains what a nudge missed
        ├─ outbox.readPending(N)               (60 s lease claim)
        ├─ queue.enqueueMany(topic, events)    → contentworker-events
        │                                        (bulk.chunk_due → contentworker-bulk)
        └─ outbox.markRelayed(ids)
                                   │
        engine queue(): consumer on contentworker-events / contentworker-bulk
        ├─ consumeEvent(ctx, deps, event)
             ├─ dispatchEvent
             │    ├─ webhooks  — fan out to subscribers (HMAC-signed)
             │    ├─ functions — invoke user-defined HTTP hooks (FunctionInvoker)
             │    ├─ cache     — invalidate the entry's tag + reverse-reference tags (KV)
             │    ├─ rag       — re-index (published) or delete (unpublished) embeddings
             │    └─ search    — SearchShardDO index / remove
             ├─ bus.publish(event)  →  LiveHubDO  →  Live Content SSE subscribers
             ├─ on entry.published: on-publish agents, forwarded to contentworker-agents
             │  when that queue is bound, else run inline (runPublishAgents)
             └─ after the batch: ONE purge message with a tag per space:environment touched
                by a PURGING_EVENTS event  →  contentworker-purge
                                   │
        delivery queue(): consumer on contentworker-purge (concurrency 1)
        └─ purge cache tags, ≤ 100 per call, one call per 12 s (apps/delivery/src/purge.ts)
                                   │
        scheduled() (every minute): runDueScheduledActions, the outbox sweep,
        stalled-bulk-job recovery, runDueAgentSchedules (AGENTS_SCHEDULES=true);
        pruneEventHistory on the top-of-hour tick
```

`EVENTS_TOPIC` is `contentworker.events` and `BULK_TOPIC` is `contentworker.bulk`. The
`@contentworker/adapters/queue-cf` producer maps them onto the `EVENTS_QUEUE`
(`contentworker-events`) and `BULK_QUEUE` (`contentworker-bulk`) bindings. Without a
`BULK_QUEUE` binding, bulk chunks fall back to the events topic; the consumer handles both.

## Transactional outbox

The `OutboxRepo` port:

```ts
interface OutboxRepo {
  append(event: DomainEvent): Promise<void>; // same tx as the state change
  readPending(limit: number): Promise<DomainEvent[]>;
  markRelayed(eventIds: readonly string[]): Promise<void>;
}
```

In D1, the `outbox` table has a partial index on `occurred_at WHERE relayed_at IS NULL`, so
draining pending events is cheap. Because `append` is buffered into the same unit of work, and so
the same `db.batch()`, as the publish, there is **no window** where the read model is updated but
the event is lost, or vice versa.

`readPending` is a **lease claim** (`packages/db/src/store.ts`, `OUTBOX_LEASE_MS` = 60 s): one
`UPDATE … SET claimed_by, claimed_until … WHERE id IN (SELECT … pending AND (unclaimed OR lease
expired) ORDER BY occurred_at LIMIT n) RETURNING *`, executed immediately even inside a unit of
work. Concurrent relayers never receive the same row, and a relayer that dies before
`markRelayed` lets its lease lapse, so the rows become claimable again.

## Relay

`relayOutbox(ctx, queue, opts?)` (`events/relay.ts`) claims a batch of pending events (default
250), enqueues them grouped by topic, and marks them relayed. A crash between enqueue and
`markRelayed` re-sends the batch after the lease lapses, which is why consumers are idempotent. `drainOutbox` repeats that until the outbox is empty or `maxIterations` is hit.

`drainOutbox` runs from three places:

- **Post-commit nudge** (api) — after every `POST`/`PUT`/`PATCH`/`DELETE`, inside `waitUntil`, so
  events reach the queue sub-second without delaying the response.
- **Post-batch** (engine) — after a queue batch is consumed, so events appended during consumption
  (reindex continuation slices, moderation retractions) don't wait for the cron.
- **Cron sweeper** (engine) — every minute (`* * * * *`), capped at 20 iterations; it covers a nudge lost to
  a crash or isolate eviction.

Delivery is **at-least-once**, which is why dispatch is idempotent (keyed on `event.id`).

## Dispatch

`consumeEvent(ctx, deps, event)` (`events/consume.ts`) is the queue consumer's body. It calls
`dispatchEvent(ctx, deps, event)` (`events/dispatch.ts`), which fans out to:

1. **Webhook fan-out** — active subscribers for `event.type`, HMAC-signed POST, delivery log.
2. **User-defined functions** — `FunctionInvoker` POSTs to registered HTTP functions for matching
   event types (`packages/application/src/functions.ts`).
3. **Cache invalidation** (on `entry.published` / `entry.unpublished`) — tag set includes reverse
   references; `cache.invalidateTag` per tag. One tag set is shared per queue batch, so a burst of
   same-type publishes writes each tag once.
4. **RAG indexing** — `indexEntryEmbeddings` on publish, `removeEntryEmbeddings` on unpublish. The
   engine passes RAG deps only when `EMBEDDINGS_PROVIDER` is set.
5. **Lexical search index** (when `SEARCH` is bound) — the published entry's text is indexed into
   its `SearchShardDO` shard on publish and removed on unpublish.

Three event types are control messages rather than facts: `search.reindex_requested` runs one
bounded reindex slice, `bulk.chunk_due` runs one bulk-job chunk, and `entries.published_bulk`
replaces N per-entry fan-outs with one bulk-shaped fan-out.

`DispatchDeps` is `{ sender, cache?, rag?, invoker?, searchIndex?, blob?, invalidatedTags? }` —
optional deps degrade gracefully.

After dispatch, `consumeEvent` publishes the event to the scope's **`LiveHubDO`** Durable Object
(when `LIVE_HUB` is bound), which fans it out to Live Content SSE clients
(`GET /delivery/:space/:env/live`). A live-publish failure is logged and never blocks dispatch.

On `entry.published`, on-publish agents run when `AGENTS_ENRICH` / `AGENTS_MODERATE` are enabled.
With `AGENTS_QUEUE` bound, the consumer enqueues a job on `contentworker-agents` instead of running
them inline; that consumer starts durable `AgentWorkflow` instances. See
[AI, agents & search](./ai-agents-and-search.md).

Each message is acked or retried individually, so one poison message doesn't recycle a batch.
Malformed messages are dropped (acked) with a log line. After `max_retries` (5 on
`contentworker-events`), a message goes to `contentworker-events-dlq`, whose consumer logs it
loudly and acks it.

### Delivery cache purges

After each `contentworker-events` batch, the engine collects one `deliveryScopeTag` per
space:environment touched by any event in `PURGING_EVENTS` (`apps/engine/src/index.ts`):
`entry.published`, `entry.unpublished`, `entries.published_bulk`, `asset.published`,
`asset.unpublished`, `content_type.published`, `release.published`,
`environment_alias.changed`. It sends them as **one** message on `contentworker-purge`, so a burst
of publishes costs one tag, not one purge call per entry. An alias change carries the alias name as
`scope.environmentId`, so the alias's tag is purged; delivery responses are tagged with both the
path's environment and the one it resolves to. A failed enqueue is logged and not retried:
responses then go stale for their 60 s `max-age`.

The delivery Worker drains the queue at concurrency 1 (`apps/delivery/src/purge.ts`): up to 100
tags per purge call, a 12 s pause after each (Cloudflare allows 5 calls a minute), at most 40 calls
per batch; the rest, or a refused call, goes back with exponential backoff. After 10 retries a
message lands in `contentworker-purge-dlq`.

### Scheduled work

The engine's cron tick runs `runDueScheduledActions` (deferred publish/unpublish), so scheduled
publishing has **one-minute granularity**. Its outbox events are then picked up by the sweep in the
same tick.

When `AGENTS_SCHEDULES=true`, the tick also calls `runDueAgentSchedules` to execute recurring
agent jobs over entries published since each schedule's previous run. Firings are claimed via
compare-and-swap on the schedule's `nextRunAt`, so overlapping ticks never double-run one. See
[AI, agents & search](./ai-agents-and-search.md#agent-schedules).

On the top-of-hour tick, `pruneEventHistory` trims relayed outbox rows and webhook delivery records
older than `EVENT_RETENTION_HOURS` (default 168).

## Webhooks

Register a webhook through the Management API (`POST …/webhooks`, scope `space:admin`):

```jsonc
{
  "url": "https://example.com/hook",
  "topics": ["entry.published", "entry.unpublished"], // or ["*"] for all
  "secret": "whsec_...", // HMAC signing secret
  "active": true,
  "headers": { "X-Env": "prod" } // optional static headers
}
```

The `WebhookSender` (`createWebhookSender` in `@contentworker/adapters/http-effects`) signs
`<timestamp>.<body>` with HMAC-SHA256 using the webhook's `secret` and POSTs the JSON payload with
`x-contentworker-signature: sha256=<hex>`, `x-contentworker-timestamp`, and
`x-contentworker-event` headers. Redirects are not followed and each attempt times out after 10 s.
The `secret` and every header value are encrypted at rest under `DATA_KEY` (see
[Auth → Secrets at rest](./auth-and-rbac.md#secrets-at-rest)); the dispatcher reads them decrypted.
Each attempt is logged as a `webhook_deliveries` row for observability. A failed dispatch throws,
so Cloudflare Queues retries the message and finally dead-letters it.

### Event payloads

Domain events (`packages/domain/src/events.ts`):

| `type`                       | Payload (besides `id`, `scope`, `occurredAt`)                              |
| ---------------------------- | -------------------------------------------------------------------------- |
| `entry.published`            | `entryId`, `contentTypeApiId`, `version`, `fields`                         |
| `entry.unpublished`          | `entryId`, `contentTypeApiId`                                              |
| `entries.published_bulk`     | `jobId`, `chunkId`, `action` (`publish` / `unpublish`), `entryIds`         |
| `asset.published`            | `assetId`                                                                  |
| `asset.unpublished`          | `assetId`                                                                  |
| `content_type.published`     | `contentTypeApiId`, `version`                                              |
| `release.published`          | `releaseId`, `entryIds`                                                    |
| `environment_alias.changed`  | `targetEnvironmentId` (null when removed); `scope.environmentId` is the alias |
| `bulk.job_completed`         | `jobId`, `action`, `total`, `succeeded`, `failed`                          |
| `workflow_run.completed` / `.declined` / `.cancelled` / `.failed` / `.rolled_back` | `runId`, `workflowId`, `version`, `entryId`, `contentTypeApiId`, `reason` |
| `workflow.task_opened`       | `taskId`, `runId`, `nodeId`, …                                             |
| `workflow.webhook`           | `runId`, `nodeId`, `entryId`, `payload`                                    |
| `search.reindex_requested`   | `contentTypeApiId?` (control message)                                      |
| `bulk.chunk_due`             | `jobId`, `chunkId` (control message, routed to `contentworker-bulk`)       |

## Delivery cache

Delivery has two cache layers:

- **Workers Caching** in front of the delivery Worker's `Delivery` entrypoint, keyed by visibility
  profile and canonical URL, purged by tag as above (see
  [Architecture](./architecture.md#appsdelivery-the-public-cda)).
- **The KV `Cache` port** inside the delivery routes: a read-through cache with **tag-based
  invalidation**. The adapter (`@contentworker/adapters/cache-kv`, bound via `KV_CACHE`) uses
  tag-version keys: `invalidateTag` writes a new version under the tag, each cached render
  snapshots the versions of its tags, and a read whose snapshot no longer matches is a miss. Entry
  TTLs come from `DELIVERY_CACHE_TTL_SECONDS` (single-entry renders) and
  `DELIVERY_LIST_TTL_SECONDS` (list results); the TTL only bounds garbage collection. The engine
  invalidates tags after a publish, including for entries that _embed_ the changed one, thanks to
  the reverse-reference tag set. KV propagates writes to other locations eventually (about 60 s).

See [Consistency & guarantees](./consistency.md) for the combined staleness envelope.

## Queue adapter

`createCfQueueProducer` (`@contentworker/adapters/queue-cf`) implements the producer side of the
`Queue` port over Cloudflare Queues bindings, one binding per topic. Retries, backoff and
dead-lettering are queue configuration in `apps/engine/wrangler.jsonc` and
`apps/delivery/wrangler.jsonc` (`max_retries`, `retry_delay`, `dead_letter_queue`), not code.
Cloudflare Queues has no producer-side dedupe, so consumers stay idempotent on the event id.

| Queue                       | Producer      | Consumer | Batch / concurrency / retries |
| --------------------------- | ------------- | -------- | ----------------------------- |
| `contentworker-events`      | api, engine   | engine   | 25 / 10 / 5 → events DLQ      |
| `contentworker-bulk`        | api, engine   | engine   | 1 / 10 / 5 → events DLQ       |
| `contentworker-agents`      | api, engine   | engine   | 25 / 4 / 3 → events DLQ       |
| `contentworker-events-dlq`  | (queues)      | engine   | logged and acked              |
| `contentworker-purge`       | engine        | delivery | 100 / 1 / 10 → purge DLQ      |
