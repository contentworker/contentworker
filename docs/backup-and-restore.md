# Backup, restore & disaster recovery

What holds state, what is derivable, and how to recover a deployment.

## What holds state

| Store                     | Holds                                                                                                                                                                                                                                                                                                                        | Recoverable from elsewhere?                                                                                                                                   |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **D1** (`DB`)             | The system of record: spaces, environments, content types, entries and versions, published read models, references, asset metadata, hashed API keys, roles, team, webhooks and deliveries, releases, schedules, workflows, taxonomy, audit, plugins, the outbox; and the web app's users, sessions, passkeys and admin audit | **No.** Protected by D1 Time Travel (below)                                                                                                                   |
| **R2** (`MEDIA_BUCKET`)   | Asset bytes, plugin bundles, staged import chunks (7-day lifecycle), dead letters (30-day lifecycle)                                                                                                                                                                                                                         | **No** for asset bytes and plugin bundles                                                                                                                     |
| **Vectorize**             | Embedding chunks for semantic search                                                                                                                                                                                                                                                                                         | Yes: `POST …/search/reindex` per space and environment                                                                                                        |
| **`SearchShardDO`**       | FTS5 lexical index                                                                                                                                                                                                                                                                                                           | Yes: the same reindex rebuilds it                                                                                                                             |
| **KV** (`KV_CACHE`)       | Delivery cache, cached principals, reindex cooldowns                                                                                                                                                                                                                                                                         | Yes: rebuilt on demand                                                                                                                                        |
| **Workers Caching**       | Delivery responses                                                                                                                                                                                                                                                                                                           | Yes                                                                                                                                                           |
| **`AssistantAgent`** (DO) | Coworker conversations, one object per person, in the object's SQLite; kept 30 days from the last activity (`packages/http/src/assistant/agent.ts`)                                                                                                                                                                          | **No.** Not in D1 or R2; losing it loses the conversations, not content                                                                                       |
| **Other Durable Objects** | Live SSE connections (`LiveHubDO`), auth-failure windows (`RateLimiterDO`), AI budget windows (`CostGuardDO`)                                                                                                                                                                                                                | Expendable by design                                                                                                                                          |
| **Queues**                | In-flight events                                                                                                                                                                                                                                                                                                             | Queues persist messages; lost events can be replayed from the outbox                                                                                          |
| **Workflows**             | `AgentWorkflow` instances (on-publish and scheduled agent runs, review watchers) and `EditorialWorkflow` instances (one per editorial workflow run, `EDITORIAL_WF`)                                                                                                                                                          | Agent runs are recorded proposals. Editorial runs have their records in D1 (`workflow_runs`), but the instance holds the execution and is not rebuilt from D1 |

Everything else (Worker code, `wrangler.jsonc` templates, `deployments/*.jsonc`, migrations) is
in git. Secrets live in each deployment's GitHub environment; `DATA_KEY`, `TOKEN_PEPPER` and
`PASSWORD_PEPPER` must be escrowed, because losing one makes what it protects unreadable
(sealed secrets, API key hashes, password hashes).

## D1 Time Travel

D1 keeps a point-in-time history of every database (the retention window depends on the plan).
Before each migration, the deploy job records a restore point:

```sh
wrangler d1 time-travel info DB --json --config wrangler.<id>.json   # → .bookmark
```

`wrangler.<id>.json` is the engine's rendered config (`node scripts/fleet.ts render <id>` writes
`apps/engine/wrangler.<id>.json`, see [Deployment](./deployment.md)). Run the `wrangler` commands
on this page inside `apps/engine`, or from the repo root as
`pnpm --filter @contentworker/engine exec wrangler …` (as CI does), so `--config` resolves.

The bookmark is written to the run's step summary and as a notice ("D1 bookmark for `<id>`
before this deploy"). A migration cannot be rolled back, but the database can be restored to
that bookmark.

## Environment snapshots

`GET …/export` produces portable JSON for one environment, `POST …/import` replays it, and
`POST …/clone` does both, including across spaces (`packages/application/src/snapshots.ts`).
Import and clone write the content model in the request and the entries and assets as bulk jobs
(`snapshot-jobs.ts`); follow them at `…/bulk/jobs/:id`.
Import replays domain operations (`createEntry`, `publishEntry`, …) rather than inserting rows,
so validation, references, read models, the outbox and the search index end up as they would
organically. A snapshot carries **no credentials and no asset bytes**; see the
[API reference](./environments-and-snapshots.md). Use snapshots to copy content
between environments or spaces, or to keep an off-platform copy of content; use Time Travel to
recover the database. The same operations are MCP tools (`environment_export`, `environment_import`,
`environment_clone`).

**Deleting an environment is irreversible.** `DELETE /spaces/:space/environments/:env?confirm=` (and the
`environment_delete` MCP tool) needs `confirm` to repeat the environment id and refuses `main` and
any environment an alias points at (409). Deleting removes the environment from the registry at
once, then purges its rows in bounded steps and deletes its R2 files under
`<space>/<environment>/` (`packages/application/src/environment-purge.ts`). Time Travel can
restore the rows but not the bytes. An `environment_export` taken first keeps the content model,
entries and taxonomy, but a snapshot carries no asset bytes either.

## Replaying events from the outbox

The relay sets `relayed_at` (epoch milliseconds) when it enqueues an event, and relayed rows are
kept for `EVENT_RETENTION_HOURS` (default 168). If events may have been lost around an
incident (a dead-lettered batch, a restored database whose queue state no longer matches),
mark them pending again. Run this by hand only through a reviewed change or an incident
procedure; never migrate or edit a remote database from an agent session.

```sql
-- Re-relay everything enqueued in the last hour (consumers are idempotent on the event id).
UPDATE outbox SET relayed_at = NULL
WHERE relayed_at > (unixepoch('subsec') * 1000) - 3600000;
```

The next mutating request's nudge, or the cron sweep within a minute, picks the rows up. For
search staleness alone, `POST …/search/reindex` rebuilds the index without touching the event
pipeline.

## Restore procedure

1. Find the bookmark: the deploy run's summary for a bad migration, or
   `wrangler d1 time-travel info DB --timestamp <unix or RFC3339> --config wrangler.<id>.json`
   for a point in time.
2. Restore D1: `wrangler d1 time-travel restore DB --bookmark <bookmark> --config wrangler.<id>.json`.
   The restore itself returns a bookmark from just before it, so it can be undone.
3. If the restored schema is older than the deployed code expects, roll the Workers back (CI's
   rollback order: engine, api, delivery, web) or fix forward with an expand-only migration.
   New code may read columns the restored schema does not have yet. The engine cannot be rolled
   back past a Durable Object migration (Cloudflare refuses); CI then leaves the other Workers on
   the new version to match it and fails for a person to decide (`.github/workflows/deploy.yml`),
   so fix forward.
4. Asset bytes in R2 are not rolled back with D1. Rows that reference objects created after the
   restore point are gone; objects deleted after it are not restored. That includes the files of a
   deleted environment: the purge deletes them from R2, so restoring the environment's rows leaves
   assets that point at bytes that no longer exist.
5. Rebuild derived indexes: `POST …/search/reindex` per space and environment (queued, in
   bounded slices).
6. Replay events from the outbox for the incident window if downstream systems may have missed
   them.

**RPO** for D1 is the Time Travel granularity (any minute within the retention window). **RTO**
is dominated by the restore itself; Workers redeploy or roll back in seconds.
