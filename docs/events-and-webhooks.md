# Events, async backbone & webhooks

contentworker uses a **transactional outbox** so that domain events are emitted exactly when (and
only when) their state change commits. The api Worker relays new events onto Cloudflare Queues
right after each write; the engine Worker consumes them, sweeps the outbox every minute, keeps
the media Worker's gate in line with what is published, and tells the delivery and media Workers
which cache tags to purge.

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
        │                                        (bulk.chunk_due, environment.purge_due → contentworker-bulk)
        └─ outbox.markRelayed(ids)
                                   │
        engine queue(): consumer on contentworker-events / contentworker-bulk
        ├─ consumeEvent(ctx, deps, event)
             ├─ dispatchEvent
             │    ├─ webhooks  — fan out to subscribers (HMAC-signed)
             │    ├─ functions — invoke user-defined HTTP hooks (FunctionInvoker)
             │    ├─ cache     — invalidate the entry's tag + reverse-reference tags (KV)
             │    ├─ gate      — asset.*: write or remove asset-gate:<space>:<env>:<id> (KV)
             │    ├─ rag       — re-index (published) or delete (unpublished) embeddings
             │    └─ search    — SearchShardDO index / remove
             ├─ bus.publish(event)  →  LiveHubDO  →  Live Content SSE subscribers
             ├─ on entry.published: on-publish agents, forwarded to contentworker-agents
             │  when that queue is bound, else run inline (runPublishAgents)
             └─ after the batch (apps/engine/src/purges.ts): ONE purge message with a tag per
                space:environment touched by a PURGING_EVENTS event  →  contentworker-purge;
                ONE with the media tags (cwa:/cwr:/cwe:)  →  contentworker-media-purge, and
                what was revoked again 90 s later
                                   │
        delivery queue(): consumer on contentworker-purge (concurrency 1)
        media queue():    consumer on contentworker-media-purge (concurrency 1)
        └─ purge cache tags, ≤ 100 per call, one call per 12 s (@contentworker/platform/purge)
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
`markRelayed` re-sends the batch after the lease lapses, which is why consumers are idempotent.
`drainOutbox` repeats that until the outbox is empty or `maxIterations` is hit.

`drainOutbox` runs from three places:

- **Post-commit nudge** (api) — after every `POST`/`PUT`/`PATCH`/`DELETE`, inside `waitUntil`, so
  events reach the queue sub-second without delaying the response.
- **Post-batch** (engine) — after a queue batch is consumed, so events appended during consumption
  (reindex continuation slices, moderation retractions) don't wait for the cron.
- **Cron sweeper** (engine) — every minute (`* * * * *`), capped at 20 iterations; it covers a nudge lost to
  a crash or isolate eviction.

Delivery is **at-least-once**, which is why dispatch is idempotent (keyed on `event.id`).

## Dispatch

`consumeEvent(ctx, deps, event)` (`events/consume.ts`) is the queue consumer's body. The engine
runs a batch's events in lanes (`apps/engine/src/lanes.ts`): one lane per entry, so an entry's
publish and unpublish never overtake each other, and one per space:environment for every other
event; up to six lanes run at once, since each event spends most of its time waiting on D1, KV,
the search shard and the live hub (a batch of 25 went from ~2.2 s to ~0.35 s locally). It calls
`dispatchEvent(ctx, deps, event)` (`events/dispatch.ts`), which fans out to:

1. **Webhook fan-out** — active subscribers for `event.type` in the event's environment (its own
   hooks and the space-wide ones), HMAC-signed POST, delivery log.
2. **User-defined functions** — `FunctionInvoker` POSTs to registered HTTP functions for matching
   event types (`packages/application/src/functions.ts`).
3. **Cache invalidation** (on `entry.published` / `entry.unpublished`) — tag set includes reverse
   references; `cache.invalidateTag` per tag. One tag set is shared per queue batch, so a burst of
   same-type publishes writes each tag once.
4. **RAG indexing** — `indexEntryEmbeddings` on publish, `removeEntryEmbeddings` on unpublish. The
   engine passes RAG deps only when `EMBEDDINGS_PROVIDER` is set.
5. **Lexical search index** (when `SEARCH` is bound) — the published entry's text is indexed into
   its `SearchShardDO` shard on publish and removed on unpublish.

Four event types are control messages rather than facts: `search.reindex_requested` runs one
bounded reindex slice, `bulk.chunk_due` runs one bulk-job chunk, `environment.purge_due` runs a
deleted environment's next purge steps, and `entries.published_bulk` replaces N per-entry fan-outs
with one bulk-shaped fan-out.

`DispatchDeps` is `{ sender, cache?, rag?, invoker?, onWebhookDelivery?, scheduleWebhookRetry?,
searchIndex?, blob?, invalidatedTags? }`; optional deps degrade gracefully. `onWebhookDelivery`
observes each delivery outcome (the host's metrics); `scheduleWebhookRetry` queues the delayed
retry of one webhook, and without it a failed delivery is recorded and not retried.

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
space:environment touched by any event in `PURGING_EVENTS` (`apps/engine/src/purges.ts`):
`entry.published`, `entry.unpublished`, `entries.published_bulk`, `asset.published`,
`asset.unpublished`, `asset.deleted`, `asset.ingested` (Delivery's asset search ranks on what
ingest indexed), `content_type.published`, `release.published`,
`environment_alias.changed`, `environment.deleted`. It sends them as **one** message on `contentworker-purge`, so a burst
of publishes costs one tag, not one purge call per entry. An alias change carries the alias name as
`scope.environmentId`, so the alias's tag is purged; delivery responses are tagged with both the
path's environment and the one it resolves to. `asset_renditions.changed` adds the tag of every
environment of the space (presets belong to the space). A failed enqueue is logged, counted
(`contentworker_purge_enqueue_errors_total`) and not retried: responses then go stale for their
60 s `max-age`.

The delivery Worker drains the queue at concurrency 1 (`drain`, `@contentworker/platform/purge`): up to 100
tags per purge call, a 12 s pause after each (Cloudflare allows 5 calls a minute), at most 40 calls
per batch; the rest, or a refused call, goes back with exponential backoff. After 10 retries a
message lands in `contentworker-purge-dlq`, whose consumer (the delivery Worker) logs the tags,
counts `contentworker_purge_dead_letters_total` and drops it. Those responses age out on their
`max-age` plus stale-while-revalidate. The cache layers these purges feed are described in
[Consistency & guarantees](./consistency.md#delivery-cache).

### Media purges and the gate

Workers Caching is per Worker, so the media Worker's published files have their own queue. The
same batch plans them (`planPurges`): `asset.published` purges `cwa:<space>:<env>:<id>` (a
republish can move the focal point, and so a crop, under the same URL); `asset.unpublished` and
`asset.deleted` revoke that tag, `asset_renditions.changed` revokes `cwr:<space>:<name>`, and
`environment.deleted` revokes `cwe:<space>:<env>`. Everything goes in one message on
`contentworker-media-purge`; what was revoked goes again with `delaySeconds: 90`
(`REVOCATION_REPURGE_SECONDS`), once KV's 60 s read cache and replica lag have passed, so a colo
that re-cached a file from a stale gate read loses it too. The media Worker drains it with the same
`drain`; dead letters land in `contentworker-media-purge-dlq` and are logged
(`contentworker_media_purge_dead_letters_total`).

Before that, `dispatchEvent` runs `syncAssetGate` for `asset.published`, `asset.unpublished` and
`asset.deleted` when `assetGate` is bound: it reads the current published snapshot and writes
`asset-gate:<space>:<env>:<id>` (`{v, r2Key, contentType, fileName, focal, expiresAt}`) or removes
it, so a redelivered or out-of-order event converges. Nothing on a request path writes the gate.

## Scheduled work

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

Register a webhook through the Management API (`POST …/webhooks`, scope `space:admin`) or the
`webhook_create` MCP tool:

```jsonc
{
  "url": "https://example.com/hook",
  "topics": ["entry.published", "entry.unpublished"], // or ["*"] for all
  "secret": "whsec_...", // HMAC signing secret
  "active": true,
  "headers": { "X-Env": "prod" }, // optional static headers
  "allEnvironments": false // optional; true = every environment's events
}
```

A webhook belongs to a space and is scoped to **one environment or all of them**:
`Webhook.environmentId` (`webhooks.environment_id`, migration `0005_webhook_environments`) is the
environment's id, or `null` for space-wide. A hook created under `/environments/{env}` is scoped to
that (resolved) environment; `allEnvironments: true` makes it space-wide. On update,
`allEnvironments: true` sets `null`, `false` sets the route's environment, and omitting it keeps the
current scope (`updateWebhook`, `packages/application/src/webhooks.ts`). Rows from before 0005 are
`NULL`, so they stay space-wide.

A hook is never pinned to an alias's resolved target: after the alias was repointed it would stop
hearing the environment it was meant for, and the purge of the old target would delete it. Both
surfaces hand the use-case the environment name as given (`WebhookRequest.requestedEnvironment`:
the route's raw `:env`, or the MCP wrapper's pre-resolution `environment`, kept in a `WeakMap`
keyed by the resolved args); a name that differs from `scope.environmentId` was an alias (an alias
can't share an environment's name). Under an alias, create with `allEnvironments` omitted makes the
hook space-wide, and `allEnvironments: false` on create or update is a `ValidationError` (422)
asking for a concrete environment id or `allEnvironments: true`.

Every `WebhookRepo` read, update and delete sees the hooks the scope's environment covers:
`space_id = ? AND (environment_id IS NULL OR environment_id = ?)` (`webhookVisibleIn` in
`packages/db/src/store.ts`; `coversEnvironment` in the domain for the in-memory store). So the list
under an environment returns its hooks plus the space-wide ones, another environment's hook is a
404, and `listByTopic(event.scope, type)` delivers an event only to its environment's hooks and the
space-wide ones. A space-wide hook still gets every environment's events, so its receiver filters
on `scope.environmentId` if it cares; `environment_alias.changed` (whose scope names the alias)
reaches only space-wide hooks. A retry re-reads the hook through `listByTopic`, so one rescoped
away from the event's environment gets no further attempts. The environment purge deletes the hooks
scoped to the environment (`webhooks` is in `ENVIRONMENT_SCOPED_TABLES`; a `NULL` row never matches);
their delivery rows are left to the retention sweep. The environment's own `environment.deleted`
events race that purge, so a hook scoped to it may or may not receive them: they are reliably
delivered only to space-wide hooks.

Webhooks are not part of environment snapshots (export, import, clone): their secrets are
credentials.

`url` is screened on create and update with `assertSafeExternalUrl`
(`packages/application/src/url-safety.ts`, shared with function endpoints): `http`/`https` only,
and no loopback, link-local or private literal address, `localhost`, `*.local` or `*.internal`
(a `ValidationError`, 422). It is DNS-free, so the sender complements it by not following
redirects.

Routes and MCP tools (all scope `space:admin`; `packages/http/src/api/routes/management.ts` and
`packages/http/src/mcp/server.ts`, on the same use-cases and body schemas). Both return the hook
without its `secret` or `headers`; the secret is the caller's own and is never echoed:

| Operation  | Route                                                   | MCP tool             |
| ---------- | ------------------------------------------------------- | -------------------- |
| List       | `GET …/webhooks`                                        | `webhooks_list`      |
| Create     | `POST …/webhooks` (201)                                 | `webhook_create`     |
| Update     | `PUT …/webhooks/:id` (partial; omitted fields are kept) | `webhook_update`     |
| Delete     | `DELETE …/webhooks/:id` (204)                           | `webhook_delete`     |
| Deliveries | `GET …/webhooks/:id/deliveries?limit=`                  | `webhook_deliveries` |

The `WebhookSender` (`createWebhookSender` in `@contentworker/adapters/http-effects`) signs
`<timestamp>.<body>` with HMAC-SHA256 using the webhook's `secret` and POSTs the JSON payload with
`x-contentworker-signature: sha256=<hex>`, `x-contentworker-timestamp`, and
`x-contentworker-event` headers. Redirects are not followed and each attempt times out after 10 s.
The `secret` and every header value are encrypted at rest under `DATA_KEY` (see
[Auth → Secrets at rest](./auth-and-rbac.md#secrets-at-rest)); the dispatcher reads them decrypted.
Each attempt is logged as a `webhook_deliveries` row with its attempt number. A failed delivery
is retried **for that webhook alone**: dispatch hands it to `scheduleWebhookRetry`, and the engine
enqueues a `webhook.retry` message on the events queue with a delay, so a down receiver neither
loses the event nor re-drives the rest of the dispatch (cache purges, indexing, other webhooks).
The engine's consumer re-sends it (`redeliverWebhook`) with backoff of 30 s, 2 min, 8 min, 32 min,
~2 h, then 6 h, up to `WEBHOOK_MAX_ATTEMPTS` (8, about a day), after which the last failed row is
the record. A webhook deleted, deactivated or unsubscribed in the meantime gets nothing. Receivers
should dedupe on the event `id`, since a retry can follow a delivery whose response was lost.
A bulk publish's chunk is retried the same way. A per-entry subscriber gets one delivery row per
chunk, and a retry of **only the entries that failed**: the `webhook.retry` message carries the
`entries.published_bulk` event cut down to them, the retry re-reads their published snapshots
(skipping any unpublished since), sends each again with the same derived id
(`${jobId}:${chunkId}:${entryId}`), and narrows the next retry to what still fails. A subscriber
to `entries.published_bulk` itself gets the bulk event again.

### Event payloads

Domain events (`packages/domain/src/events.ts`):

| `type`                                                                             | Payload (besides `id`, `scope`, `occurredAt`)                                                                                                                              |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `entry.published`                                                                  | `entryId`, `contentTypeApiId`, `version`, `fields`                                                                                                                         |
| `entry.unpublished`                                                                | `entryId`, `contentTypeApiId`                                                                                                                                              |
| `entries.published_bulk`                                                           | `jobId`, `chunkId`, `action` (`publish` / `unpublish`), `entryIds`                                                                                                         |
| `asset.published`                                                                  | `assetId`                                                                                                                                                                  |
| `asset.unpublished`                                                                | `assetId` (also when a published asset is archived or deleted)                                                                                                             |
| `asset.deleted`                                                                    | `assetId`, `r2Key` or `videoId` (the engine removes those bytes)                                                                                                           |
| `asset.ingested`                                                                   | `assetId`, `version`, `contentHash`, `duplicateOf` (ingest finished a file version: hashed, measured, enriched where empty, indexed)                                       |
| `asset_renditions.changed`                                                         | `name` (a space's rendition preset was created, replaced or deleted; every environment of the space is purged; `scope` is the environment it was changed through, so other environments' scoped hooks don't hear it)                                                             |
| `content_type.published`                                                           | `contentTypeApiId`, `version`                                                                                                                                              |
| `release.published`                                                                | `releaseId`, `entryIds`                                                                                                                                                    |
| `environment_alias.changed`                                                        | `targetEnvironmentId` (null when removed); `scope.environmentId` is the alias                                                                                              |
| `environment.deleted`                                                              | `entryIds` (published entries whose search documents and vectors go; chunks of 500)                                                                                        |
| `promotion.awaiting_approval`                                                      | `promotionId`, `source`, `requestedBy`, `reasons` (`scope` is the target environment)                                                                                      |
| `environment.promoted`                                                             | `promotionId`, `source`, `contentTypes`, `entries` (counts; `scope` is the target environment)                                                                             |
| `bulk.job_completed`                                                               | `jobId`, `action` (`publish` / `unpublish` / `import`), `total`, `succeeded`, `failed`                                                                                     |
| `workflow_run.completed` / `.declined` / `.cancelled` / `.failed` / `.rolled_back` | `runId`, `workflowId`, `version`, `entryId`, `contentTypeApiId`, `reason`                                                                                                  |
| `workflow.task_opened`                                                             | `taskId`, `runId`, `nodeId`, `kind` (`approval` / `event` / `review`), `entryId`, `contentTypeApiId`, `title`, `assignee` (or null), `requiredScope` (or null), `deadline` |
| `workflow.webhook`                                                                 | `runId`, `nodeId`, `entryId`, `payload`                                                                                                                                    |
| `search.reindex_requested`                                                         | `contentTypeApiId?`, `afterEntryId?`, `entriesSoFar?` (control message; the last two only on self-enqueued continuation slices)                                            |
| `bulk.chunk_due`                                                                   | `jobId`, `chunkId` (control message, routed to `contentworker-bulk`)                                                                                                       |
| `environment.purge_due`                                                            | none: `scope` is the deleted environment (control message, routed to `contentworker-bulk`; runs its next purge steps)                                                      |

## Queue adapter

`createCfQueueProducer` (`@contentworker/adapters/queue-cf`) implements the producer side of the
`Queue` port over Cloudflare Queues bindings, one binding per topic. Retries, backoff and
dead-lettering are queue configuration in `apps/engine/wrangler.jsonc` and
`apps/delivery/wrangler.jsonc` and `apps/media/wrangler.jsonc` (`max_retries`, `retry_delay`, `dead_letter_queue`), not code.
Cloudflare Queues has no producer-side dedupe, so consumers stay idempotent on the event id.

| Queue                      | Producer    | Consumer | Batch / concurrency / retries |
| -------------------------- | ----------- | -------- | ----------------------------- |
| `contentworker-events`     | api, engine | engine   | 25 / 10 / 5 → events DLQ      |
| `contentworker-bulk`       | api, engine | engine   | 1 / 10 / 5 → events DLQ       |
| `contentworker-agents`     | api, engine | engine   | 25 / 4 / 3 → events DLQ       |
| `contentworker-events-dlq` | (queues)    | engine   | logged and acked              |
| `contentworker-purge`      | engine      | delivery | 100 / 1 / 10 → purge DLQ      |
| `contentworker-media-purge` | engine      | media    | 100 / 1 / 10 → media purge DLQ |
| `contentworker-purge-dlq`  | (queues)    | delivery | logged, counted and dropped   |
