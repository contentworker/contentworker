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

| Caller                         | Session start                                                                 |
| ------------------------------ | ----------------------------------------------------------------------------- |
| api, request with `x-cw-bookmark` | That bookmark: at least as fresh as the client's last response             |
| api, `POST`/`PUT`/`PATCH`/`DELETE` | `first-primary`                                                           |
| api, other reads               | `first-unconstrained` (any replica)                                           |
| delivery (gateway and cache miss) | `first-unconstrained`: delivery tolerates replica lag by design            |
| engine (queues, cron)          | `first-primary` (the `wireEdge` default)                                      |

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
  (`EVENT_RETENTION_HOURS`, default 168).

## Timing, staleness and failure behavior

| Behavior                                              | Guarantee                                                                                                                                                                                                                                       |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Management/Preview read after your own write          | Fresh when the client echoes `x-cw-bookmark`; otherwise may come from a replica that lags the primary                                                                                                                                           |
| Delivery read after publish                           | Eventually consistent. The engine enqueues one purge tag per space:environment per consumed batch; the delivery Worker purges at most 5 calls a minute (100 tags each). Until purged, responses are fresh for 60 s, then served stale while revalidating; a missed purge means a stale copy can be served for up to a day (`stale-while-revalidate=86400`) |
| Media file after unpublish, archive or delete        | The engine removes the asset's gate entry (KV) and enqueues its media tag on `contentworker-media-purge`, then once more 90 s later: a colo may read its cached gate entry (KV, 60 s) or a lagging replica until then and re-cache the file, which the second purge removes. Until purged, the immutable copy at the edge is served; browsers that cached it keep it |
| Media file after publish                              | No wait: a gate miss falls back to a D1 replica, so a just-published asset is served before KV has the entry. A `404` is never cached                                                                                                        |
| Delivery read after an alias repoint                  | `environment_alias.changed` purges the alias's tag; responses are tagged with both the path's environment and the resolved one                                                                                                                 |
| Event latency (webhooks, cache, search) after a write | Sub-second (the api's post-commit `waitUntil` relay); worst case about a minute via the cron sweep after a crash                                                                                                                               |
| Scheduled publish/unpublish at time T                 | Within about 60 s (one-minute cron)                                                                                                                                                                                                             |
| Recurring agent schedule (`AGENTS_SCHEDULES=true`)    | Within about 60 s; each firing is claimed by compare-and-set on `nextRunAt`, so overlapping ticks never double-run one                                                                                                                         |
| Lexical search after publish                          | Indexed by the events consumer into `SearchShardDO`; seconds. Version-checked, so a late older version is ignored                                                                                                                             |
| Semantic search after publish                         | Vectorize indexes asynchronously: expect seconds of lag. Vectorize caps a query at `MAX_TOP_K` chunks                                                                                                                                         |
| Revoked API key or changed role                       | The space's cached principals are dropped (`invalidateCachedPrincipals`); the next request re-authenticates                                                                                                                                   |
| Live Content SSE                                      | `LiveHubDO` per space:environment; an object restart drops streams (clients reconnect)                                                                                                                                                         |
| On-publish agents                                     | Started on `AgentWorkflow` from `contentworker-agents`, 25 entries per instance, fire-and-forget; a retry can start a duplicate pass (runs are recorded proposals; a duplicate moderation hold re-retracts)                                       |
| Moderation coverage                                   | `AGENTS_MODERATE_BLOCKING=true` gates single-entry publish only (REST and MCP). Bulk, release and scheduled publishes rely on post-publish moderation                                                                                          |
| Plugin execution                                      | One Worker Loader isolate per plugin, no network, capabilities passed per call; host timeout 2 s per call. Without `PLUGIN_LOADER`, installed plugins never execute                                                                            |
| Import chunks                                         | Staged in R2 (`MEDIA_BUCKET`, `imports/`); without the bucket the chunks stay claimable and the job does not progress                                                                                                                         |
| AI budget metering                                    | `CostGuardDO` per space; absent binding means unmetered                                                                                                                                                                                         |
| Auth failure limiting                                 | `RateLimiterDO` per client IP; per-isolate fallback without the binding                                                                                                                                                                         |
| Request-rate limiting                                 | Native `ratelimits` bindings: per Cloudflare location and approximate, an abuse guard rather than quota accounting                                                                                                                             |
| Reindex cooldown                                      | KV-backed, approximate across locations (slices are idempotent)                                                                                                                                                                                 |
| Dead letters                                          | `contentworker-events-dlq` is logged and acked; `contentworker-purge-dlq` and `contentworker-media-purge-dlq` hold purges that exhausted 10 retries (logged and acked)                                                                                                                              |

## Choosing / tuning

- **Strict read-after-publish for a delivery client** is not what the CDA offers. Read the
  Preview API (served by the api, not the delivery cache) and send the `x-cw-bookmark` from the
  write when a client needs to see it immediately.
- **Second-precision scheduled publishing** is not available; the cron fires once a minute.
- **Durable agents** are fire-and-observe: read the outcome from the agent ledger.

Related: [Events & webhooks](./events-and-webhooks.md), [Architecture](./architecture.md),
[Backup & restore](./backup-and-restore.md).
