# Backup, restore & disaster recovery

What holds state, what is derivable, and how to recover an install.

## What holds state

| Store                                  | Holds                                                                                                                                                                                                                                                                                                                                          | Recoverable from elsewhere?                                                                                                                                             |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The database** (`DB`)                | The system of record: spaces, environments, content types, entries and versions, published read models, references, asset metadata, hashed API keys, roles, team, webhooks and deliveries, releases, schedules, workflows, taxonomy, redirects, menus, audit, plugins, the outbox; and the web app's users, sessions, passkeys and admin audit | **No.** Protected by point-in-time recovery (below)                                                                                                                     |
| **Object storage** (`MEDIA_BUCKET`)    | Asset bytes, plugin bundles, superseded entry version bodies (`versions/`), staged import chunks (7-day lifecycle), dead letters (30-day lifecycle)                                                                                                                                                                                            | **No** for asset bytes and plugin bundles                                                                                                                               |
| **The vector index**                   | Embedding chunks for semantic search                                                                                                                                                                                                                                                                                                           | Yes: `POST …/search/reindex` per space and environment                                                                                                                  |
| **`SearchShardDO`**                    | FTS5 lexical index                                                                                                                                                                                                                                                                                                                             | Yes: the same reindex rebuilds it                                                                                                                                       |
| **`HotSetDO`**                         | The Delivery URLs readers ask for (warmed after a purge)                                                                                                                                                                                                                                                                                       | Not needed: reads record it again; until then a purge is not followed by warming                                                                                        |
| **Key-value cache** (`KV_CACHE`)       | Delivery cache, cached principals, reindex cooldowns                                                                                                                                                                                                                                                                                           | Yes: rebuilt on demand                                                                                                                                                  |
| **The edge cache**                     | Delivery responses                                                                                                                                                                                                                                                                                                                             | Yes                                                                                                                                                                     |
| **`AssistantAgent`** (stateful object) | Coworker conversations, one object per person, in the object's SQLite; kept 30 days from the last activity (`packages/http/src/assistant/agent.ts`)                                                                                                                                                                                            | **No.** Not in the database or object storage; losing it loses the conversations, not content                                                                           |
| **Other stateful objects**             | Live SSE connections (`LiveHubDO`), auth-failure windows (`RateLimiterDO`), AI budget windows (`CostGuardDO`)                                                                                                                                                                                                                                  | Expendable by design                                                                                                                                                    |
| **Queues**                             | In-flight events                                                                                                                                                                                                                                                                                                                               | Queues persist messages; lost events can be replayed from the outbox                                                                                                    |
| **Durable workflows**                  | `AgentWorkflow` instances (on-publish and scheduled agent runs, review watchers) and `EditorialWorkflow` instances (one per editorial workflow run, `EDITORIAL_WF`)                                                                                                                                                                            | Agent runs are recorded proposals. Editorial runs have their records in the database (`workflow_runs`), but the instance holds the execution and is not rebuilt from it |

Everything else (worker code, `wrangler.jsonc` templates, migrations) is in git. Your settings are
`.env`, and the install's secrets are `.secrets/secrets.env`: `DATA_KEY`, `TOKEN_PEPPER` and
`PASSWORD_PEPPER` must be backed up, because losing one makes what it protects unreadable (sealed
secrets, API key hashes, password hashes). See [Backing up secrets](#backing-up-secrets).

## Point-in-time recovery

The database keeps a point-in-time history (the retention window depends on the plan).
Before each migration, the deploy job records a restore point:

```sh
wrangler d1 time-travel info DB --json --config wrangler.deploy.json   # → .bookmark
```

`wrangler.deploy.json` is the engine's rendered config (`node scripts/install.ts render` writes
`apps/engine/wrangler.deploy.json`, `wrangler.deploy-<instance>.json` with `INSTANCE`; see
[Deployment](./deployment.md)). Run the `wrangler` commands on this page inside `apps/engine`, or
from the repo root as `pnpm --filter @contentworker/engine exec wrangler …` (as a deploy does), so
`--config` resolves.

The bookmark is printed in the deploy's log and, in CI, written to the run's step summary and as a
notice (`D1 bookmark before this deploy`). A migration cannot be rolled back, but the database can be restored to that
bookmark.

## Environment snapshots

`GET …/export` produces portable JSON for one environment, `POST …/import` replays it, and
`POST …/clone` does both, including across spaces (`packages/application/src/snapshots.ts`).
Import and clone write the content model (and the asset folders) in the request and the entries
and assets as bulk jobs
(`snapshot-jobs.ts`); follow them at `…/bulk/jobs/:id`.
Import replays domain operations (`createEntry`, `publishEntry`, …) rather than inserting rows,
so validation, references, read models, the outbox and the search index end up as they would
organically. A snapshot carries **no credentials and no asset bytes**; see the
[API reference](./environments-and-snapshots.md). Use snapshots to copy content
between environments or spaces, or to keep an off-platform copy of content; use point-in-time
recovery to recover the database. The same operations are MCP tools (`environment_export`,
`environment_import`, `environment_clone`).

**Deleting an environment is irreversible.** `DELETE /spaces/:space/environments/:env?confirm=` (and the
`environment_delete` MCP tool) needs `confirm` to repeat the environment id and refuses `main` and
any environment an alias points at (409). Deleting removes the environment from the registry at
once, then purges its rows in bounded steps and deletes its object storage files under
`<space>/<environment>/` (`packages/application/src/environment-purge.ts`). Point-in-time
recovery can restore the rows but not the bytes. An `environment_export` taken first keeps the
content model, entries and taxonomy, but a snapshot carries no asset bytes either.

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
   `wrangler d1 time-travel info DB --timestamp <unix or RFC3339> --config wrangler.deploy.json`
   for a point in time.
2. Restore the database: `wrangler d1 time-travel restore DB --bookmark <bookmark> --config wrangler.deploy.json`.
   The restore itself returns a bookmark from just before it, so it can be undone.
3. If the restored schema is older than the deployed code expects, roll the workers back (CI's
   rollback order: engine, api, delivery, web) or fix forward with an expand-only migration.
   New code may read columns the restored schema does not have yet. The engine cannot be rolled
   back past a stateful-object migration (the platform refuses); CI then leaves the other workers
   on the new version to match it and fails for a person to decide
   (`scripts/deploy.sh`), so fix forward.
4. Asset bytes in object storage are not rolled back with the database. Rows that reference
   objects created after the restore point are gone; objects deleted after it are not restored.
   That includes the files of a deleted environment: the purge deletes them from object storage,
   so restoring the environment's rows leaves assets that point at bytes that no longer exist.
5. Archived version bodies in object storage are not rolled back either. They are deleted only
   with their entry (deleting it for good from the trash) or their environment (a purge). A
   restore to before a version was archived simply finds its body back in the database. A restore
   that brings back an entry or environment deleted since brings back version rows whose archived
   bodies are gone: their history lists mark those versions unavailable, while the entries
   themselves read correctly.
6. Rebuild derived indexes: `POST …/search/reindex` per space and environment (queued, in
   bounded slices).
7. Replay events from the outbox for the incident window if downstream systems may have missed
   them.

## Backing up secrets

`pnpm cw:setup` generates the install's secrets into `.secrets/secrets.env` (or
`.secrets/secrets-<instance>.env`), mode 0600 and gitignored, and never prints them. That file is
the only copy outside the workers, which hold their secrets write-only. Copy the whole `.secrets/`
folder somewhere outside the machine (a password manager, an encrypted store) once after setup, and
again after any change to a secret. Keep every generation, dated, for at least the database's
recovery window: a restore to before a `DATA_KEY` rotation brings back values sealed under the old
key. During a rotation, copy it before removing `DATA_KEY_PREVIOUS`.

**To recover,** put the folder back at `.secrets/` and run the deploy again: it reads the secrets
file and sets each secret on the workers. `pnpm cw:setup` refuses to generate a new `DATA_KEY`,
`TOKEN_PEPPER` or `PASSWORD_PEPPER` while a worker holds one, so a lost file can't be replaced by
accident. If the folder leaks, rotate what can rotate (`DATA_KEY`, `PRINCIPAL_KEY`,
`MEDIA_SIGNING_SECRET`). `TOKEN_PEPPER` and `PASSWORD_PEPPER` can't rotate, so treat them as
exposed: hashes alone still need the database too.

## Recovery objectives

The targets each store is held to. **RPO** is how much recent data a recovery may lose; **RTO** is
how long the recovery may take. "Met" says whether the target can be reached today.

| Store                                         | RPO                                 | RTO                   | Met                                                                                  |
| --------------------------------------------- | ----------------------------------- | --------------------- | ------------------------------------------------------------------------------------ |
| The database                                  | 1 minute, within the 30-day window  | 1 hour, plus reindex  | Not proven: the procedure above has not been timed in a drill                        |
| Object storage: asset bytes and plugins       | 24 hours                            | 8 hours               | **No**: nothing holds a copy of the bytes                                            |
| Object storage: `versions/`                   | 24 hours                            | 8 hours               | **No**: nothing holds a copy of the bodies                                           |
| The vector index, `SearchShardDO`             | n/a (rebuildable)                   | 24 hours              | Not proven: a reindex runs per space and environment, by hand                        |
| Key-value cache, edge caches                  | n/a (rebuildable)                   | Minutes               | Yes: rebuilt on demand                                                               |
| `AssistantAgent`                              | Best effort, 30-day object recovery | 1 day                 | **No**: nothing calls the object's point-in-time recovery                            |
| Durable workflows                             | None                                | 1 day, re-run by hand | Not proven: instances are not rebuilt from their rows                                |
| Queues                                        | The outbox window (168 hours)       | 1 hour                | Domain events only: messages the outbox doesn't feed can't replay                    |
| `DATA_KEY`, `TOKEN_PEPPER`, `PASSWORD_PEPPER` | Zero                                | 1 hour                | Not proven: [backed up](#backing-up-secrets), but no restore has set the values back |

Workers redeploy or roll back in seconds, so a database restore's RTO is dominated by the restore
itself.
