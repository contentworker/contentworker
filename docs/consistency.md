# Consistency & guarantees

contentworker keeps its system of record in D1 and serves public reads from cache. The
**invariants** below hold everywhere; the **timing and staleness envelopes** come from D1 read
replication, Workers Caching, KV, Queues and the one-minute cron. This page is the honest list.

## Invariants

- **A write is one D1 batch.** `ContentStore.withTransaction` is a **unit of work**, not an
  interactive transaction (D1 has none; its atomic primitive is `batch()`). A use-case reads
  everything first, then writes; writes are buffered and committed as one batch at the end
  (`packages/db/src/exec.ts`, `UnitOfWork`). A read inside the unit does not see its own
  buffered writes; the in-memory test-kit store enforces the same rule.
- **Optimistic concurrency is checked at commit.** A compare-and-set write (e.g. publish against
  an expected version) is followed by a guard statement,
  `INSERT INTO _guard SELECT changes() = n`, on a table with `CHECK (ok = 1)`. If another writer
  won, the guard fails, D1 rolls back the whole batch, and `withTransaction` throws
  `TransactionConflictError` (`@contentworker/ports`). Callers retry or treat the lost race as a
  no-op. A unique-constraint violation at commit throws `ConflictError`.
- **A stale write is refused with `expectedVersion`.** A publish, unpublish or version restore can
  carry the `currentVersion` the caller read (`?expectedVersion=N` on the Management route, the
  `{ expectedVersion }` option of `@contentworker/sdk-management`, `assertExpectedVersion` in
  `packages/application/src/publishing.ts`). If a draft was saved since, the write is a 409 that
  changes nothing; without it, the write acts on the entry as it is.
- **The outbox row rides in the same batch** as the state change it describes, so an event
  exists iff the commit happened (the transactional outbox).
- **Event delivery is at-least-once.** The relay claims outbox rows with a 60-second lease
  (`UPDATE … SET claimed_until … WHERE … claim expired RETURNING`, `OUTBOX_LEASE_MS`), so
  concurrent relayers never receive the same row and a crashed relayer's rows become claimable
  again. Queue retries can still redeliver: consumers are idempotent on the event id, and
  webhook receivers should dedupe on it.
- **Read-your-writes for editors.** The api returns the D1 Sessions API bookmark in
  `x-cw-bookmark`; a client that echoes it gets reads at least that fresh, even from a replica.
- **Authorization is never cached.** The delivery gateway authenticates every request before
  the cache; only the response body is shared, between readers with an identical visibility
  profile.
- **RBAC and AI budgets are enforced in the application layer**, identically for REST and MCP.
- **The read hot path writes nothing to D1.** `lastUsedAt` on an API key is written at most once
  per 5 minutes per key (`LAST_USED_RESOLUTION_MS`), so busy delivery keys do not serialize on
  D1's single writer.

## D1 sessions and replicas

Every Worker opens its D1 access through `env.DB.withSession(…)` (`wireEdge`):

| Caller                             | Session start                                                   |
| ---------------------------------- | --------------------------------------------------------------- |
| api, request with `x-cw-bookmark`  | That bookmark: at least as fresh as the client's last response  |
| api, `POST`/`PUT`/`PATCH`/`DELETE` | `first-primary`                                                 |
| api, other reads                   | `first-unconstrained` (any replica)                             |
| delivery (gateway and cache miss)  | `first-unconstrained`: delivery tolerates replica lag by design |
| engine (queues, cron)              | `first-primary` (the `wireEdge` default)                        |

The web Worker forwards `x-cw-bookmark` both ways untouched, so the admin gets read-your-writes
through the gateway. Read replication is turned on per database by `scripts/provision.sh`
(`read_replication.mode = auto`); writes always go to the primary.

## D1 limits as design inputs

- **100 bound parameters per statement.** `chunked` / `selectChunked` (`packages/db/src/exec.ts`)
  split id lists; JSON field filters bind their values as one JSON parameter read with
  `json_each` (`query-pushdown.ts`).
- **One writer per database.** No per-request writes on read paths; bulk, import and reindex
  work goes through queues in chunks; the lexical search index lives in `SearchShardDO`
  (its own SQLite per shard), not in D1.
- **10 GB per database.** Asset bytes, import staging, plugin bundles and dead letters live in
  R2; retention prunes relayed outbox rows and webhook deliveries hourly
  (`EVENT_RETENTION_HOURS`, default 168), and the same tick sweeps drafts whose upload never
  landed (older than 24 h, at most 50 per sweep). Superseded entry version bodies move to R2 too, once
  `VERSION_ARCHIVE=true` (off by default; see [Deployment](./deployment.md)). Saving a version
  queues the one it supersedes in `version_archive_queue`, due a day later. Each cron tick the
  engine claims due rows, 50 at a time and up to 200 (`archiveSupersededVersions`):
  - versions that are neither their entry's current nor its published version have their body
    written to `versions/<space>/<env>/<entry>/<v>.json`, then their `fields` emptied in D1 and
    `body_key` recorded;
  - versions that aren't archivable yet are put back a day.

  The cost of a tick is bounded by its batch, not by the size of the table. Only the history
  views read archived bodies, and the store fetches them back transparently, a few at a time. A
  missing object marks just that version `bodyUnavailable` in a history list. Three guards keep a
  live version's body in D1:
  - the day's delay;
  - the mark re-checks, in the same write, that the version is still superseded, unpublished and
    the same row;
  - should a lost update ever move an entry back onto an archived version, entry reads fetch its
    body from R2 instead of showing `{}`.

  The object is written before the row changes, so a crash between the two leaves the body in D1
  and a later tick retries. Deleting an entry for good
  (from the trash) removes its archived bodies too, and purging a deleted environment removes all
  of its own.

## Delivery cache

Delivery has two cache layers:

- **Workers Caching** in front of the delivery Worker's `Delivery` entrypoint, keyed by visibility
  profile and canonical URL, purged by tag (the purge path and its pacing are in
  [Events & webhooks](./events-and-webhooks.md#delivery-cache-purges); the layout in
  [Architecture](./architecture.md#appsdelivery-the-public-cda)).
- **The KV `Cache` port** inside the delivery routes: a read-through cache with **tag-based
  invalidation**. The adapter (`@contentworker/adapters/cache-kv`, bound via `KV_CACHE`) uses
  tag-version keys: `invalidateTag` writes a new version under the tag, each cached render
  snapshots the versions of its tags, and a read whose snapshot no longer matches is a miss. Entry
  TTLs come from `DELIVERY_CACHE_TTL_SECONDS` (single-entry renders) and
  `DELIVERY_LIST_TTL_SECONDS` (list results); the TTL only bounds garbage collection. The engine
  invalidates tags after a publish, including for entries that _embed_ the changed one, thanks to
  the reverse-reference tag set. A rendition change (`asset_renditions.changed`) bumps the scope epoch
  of every environment of the space, since every cached render that embeds an asset lists its
  renditions. KV propagates writes to other locations eventually (about 60 s).

## Durable state that is not derived

Most state can be rebuilt (see [Backup & restore](./backup-and-restore.md)). Two Durable Object
kinds hold state that cannot:

- **`EditorialWorkflow`** (Cloudflare Workflows, `EDITORIAL_WF`): a workflow run is one instance,
  with its id the run id (`${runId}-g${n}` after a continue-as-new). Each step is persisted and
  replayed after a crash; approval deadlines, event waits and `control.wait` timers are durable
  waits, with no cron behind them. Starting is idempotent on the instance id. Without the binding,
  run actions answer 501 while definitions and reads still work.
- **`AssistantAgent`** (one Durable Object per person): the Coworker conversation lives in the
  object's SQLite, and a reply keeps streaming if the tab goes away. A conversation untouched for
  30 days is deleted (`RETENTION_MS`, `packages/http/src/assistant/agent.ts`).

## Timing, staleness and failure behavior

| Behavior                                              | Guarantee                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Management/Preview read after your own write          | Fresh when the client echoes `x-cw-bookmark`; otherwise may come from a replica that lags the primary                                                                                                                                                                                                                                                                                                                       |
| Delivery read after publish                           | Eventually consistent. The engine enqueues one purge tag per space:environment per consumed batch; the delivery Worker drains them at the purge pacing described in [Events & webhooks](./events-and-webhooks.md#delivery-cache-purges). Until purged, responses are fresh for 60 s, then served stale while revalidating; a missed purge means a stale copy can be served for up to a day (`stale-while-revalidate=86400`) |
| Media file after unpublish, archive or delete        | The engine removes the asset's gate entry (KV) and enqueues its media tag on `contentworker-media-purge`, then once more 90 s later: a colo may read its cached gate entry (KV, 60 s) or a lagging replica until then and re-cache the file, which the second purge removes. Until purged, the immutable copy at the edge is served; browsers that cached it keep it |
| Media file after an environment is deleted           | The engine removes every gate entry of the environment at once and again when its rows are purged (before its id can be reused), enqueuing the environment's media tag each time and once more 90 s later. Until purged, the edge copy is served; nothing can re-cache it after the last purge |
| Asset ingest after upload                             | At least once: R2's object-create notification and the api's own upload message both go to `contentworker-asset-events`; each starts one `AssetIngestWorkflow` run under an id from the scope, asset, version and the bytes' etag, so a redelivery or the second trigger starts nothing (Workflows' duplicate-id code `10405`) and a second PUT of new bytes starts another. A message whose start fails otherwise is retried; after its retries it lands on `contentworker-asset-events-dlq`, logged and acked. `pending` is never written over a run in progress, and a finished status is put back when the run already exists |
| Delivery read after ingest                            | `asset.ingested` purges the environment's delivery tag only when it says `published: true` (search and the measured dimensions changed what Delivery serves); a draft's ingest purges nothing |
| Media file after publish                              | No wait: a gate miss falls back to a D1 replica, so a just-published asset is served before KV has the entry. A `404` is never cached                                                                                                        |
| Delivery read after an alias repoint                  | `environment_alias.changed` purges the alias's tag; responses are tagged with both the path's environment and the resolved one                                                                                                                                                                                                                                                                                              |
| Event latency (webhooks, cache, search) after a write | Sub-second (the api's post-commit `waitUntil` relay); worst case about a minute via the cron sweep after a crash                                                                                                                                                                                                                                                                                                            |
| Scheduled publish/unpublish at time T                 | Within about 60 s (one-minute cron)                                                                                                                                                                                                                                                                                                                                                                                         |
| Recurring agent schedule (`AGENTS_SCHEDULES=true`)    | Within about 60 s; each firing is claimed by compare-and-set on `nextRunAt`, so overlapping ticks never double-run one                                                                                                                                                                                                                                                                                                      |
| Lexical search after publish                          | Indexed by the events consumer into `SearchShardDO`; seconds. Version-checked, so a late older version is ignored                                                                                                                                                                                                                                                                                                           |
| Semantic search after publish                         | Vectorize indexes asynchronously: expect seconds of lag. Vectorize caps a query at `MAX_TOP_K` chunks                                                                                                                                                                                                                                                                                                                       |
| Revoked API key or changed role                       | The space's cached principals are dropped (`invalidateCachedPrincipals`); the next request re-authenticates                                                                                                                                                                                                                                                                                                                 |
| Live Content SSE                                      | `LiveHubDO` per space:environment; an object restart drops streams (clients reconnect)                                                                                                                                                                                                                                                                                                                                      |
| On-publish agents                                     | Started on `AgentWorkflow` from `contentworker-agents`, 25 entries per instance, fire-and-forget; a retry can start a duplicate pass (runs are recorded proposals; a duplicate moderation hold re-retracts)                                                                                                                                                                                                                 |
| Moderation coverage                                   | `AGENTS_MODERATE_BLOCKING=true` gates single-entry publish only (REST and MCP). Bulk, release and scheduled publishes rely on post-publish moderation                                                                                                                                                                                                                                                                       |
| Plugin execution                                      | One Worker Loader isolate per plugin, no network, capabilities passed per call; host timeout 2 s per call. Without `PLUGIN_LOADER`, installed plugins never execute                                                                                                                                                                                                                                                         |
| Import chunks                                         | Staged in R2 (`MEDIA_BUCKET`, `imports/`); without the bucket the chunks stay claimable and the job does not progress                                                                                                                                                                                                                                                                                                       |
| AI budget metering                                    | `CostGuardDO` per space; absent binding means unmetered                                                                                                                                                                                                                                                                                                                                                                     |
| Auth failure limiting                                 | `RateLimiterDO` per client IP; per-isolate fallback without the binding                                                                                                                                                                                                                                                                                                                                                     |
| Request-rate limiting                                 | Native `ratelimits` bindings: per Cloudflare location and approximate, an abuse guard rather than quota accounting                                                                                                                                                                                                                                                                                                          |
| Reindex cooldown                                      | KV-backed, approximate across locations (slices are idempotent)                                                                                                                                                                                                                                                                                                                                                             |
| Dead letters                                          | `contentworker-events-dlq` is logged and acked; `contentworker-purge-dlq` (purges that exhausted 10 retries) is logged, counted in `contentworker_purge_dead_letters_total` and dropped; those responses age out on their `max-age` plus stale-while-revalidate. `contentworker-media-purge-dlq` holds media purges that exhausted 10 retries (logged and acked); `contentworker-asset-events-dlq` holds ingest starts that exhausted theirs (logged and acked; `POST …/assets/reindex` sends what never ingested through again)                                                                                                                                                             |

## Choosing / tuning

- **Strict read-after-publish for a delivery client** is not what the CDA offers. Read the
  Preview API (served by the api, not the delivery cache) and send the `x-cw-bookmark` from the
  write when a client needs to see it immediately. `sdk-management` and a `preview: true`
  `sdk-core` client echo it by default and expose it as `client.bookmark` to hand between
  clients ([SDKs](./sdks.md#read-your-writes)).
- **Second-precision scheduled publishing** is not available; the cron fires once a minute.
- **Durable agents** are fire-and-observe: read the outcome from the agent ledger.

Related: [Events & webhooks](./events-and-webhooks.md), [Architecture](./architecture.md),
[Backup & restore](./backup-and-restore.md).
