---
name: d1-migration
description: Add a D1 schema change to ContentWorker safely. Picks the next migration number, writes a hand-written expand-only SQL migration in packages/db/migrations that works with the code already deployed, mirrors it in packages/db/src/schema.ts (or auth-schema.ts), applies it to the local D1 and tests it in workerd. Use for any new table, column, index or backfill, and when planning a rename or drop as expand-then-contract.
argument-hint: "[short_snake_name]"
---

# Adding a D1 migration

Migrations are `packages/db/migrations/NNNN_name.sql`, hand-written SQL. The Drizzle schema in
`packages/db/src/schema.ts` (content) and `packages/db/src/auth-schema.ts` (the admin's people,
sessions and sign-in) mirrors them column for column and index for index; it describes the
database to the query code and changes no database on its own. There is one D1 per deployment
(binding `DB`, database `contentworker`, `migrations_dir: ../../packages/db/migrations` in the
apps' `wrangler.jsonc`).

## Why it's careful

CI's deploy job (`.github/workflows/deploy.yml`) records a D1 bookmark, applies migrations with
`wrangler d1 migrations apply DB --remote`, _then_ deploys engine, api, delivery and web, and on a
failure rolls the Workers back but **not** D1. So every migration runs against the code already
deployed, for at least the length of a deploy and indefinitely after a rollback. An applied
migration (anything on `origin/main`) is never edited; the `guard-invariants` hook denies it, and
asks before a new one that drops or renames.

## Steps

1. **Number.** `ls packages/db/migrations | tail -1`, then the next four-digit number. Name it
   `$ARGUMENTS` or a short snake_case description: `0003_entry_tags.sql`. If another open PR took
   the number, the later one renumbers before merge.
2. **Write it expand-only.** Start with a `--` comment saying what it's for and what existing rows
   get (see `0002_auth.sql`). Timestamps are epoch milliseconds (`INTEGER`), booleans `INTEGER`
   0/1, ids `TEXT` (UUIDv7 from `ctx.ids.newId()`). Tenant data carries `space_id` and
   `environment_id` and leads its indexes with them. Allowed now:
   - `CREATE TABLE`, `CREATE INDEX` (`IF NOT EXISTS` where a re-run is possible);
   - `ALTER TABLE … ADD COLUMN` that is nullable or has a constant default;
   - backfills (`UPDATE`) the old code tolerates, in statements small enough for one D1 batch.
   Not in the same change as the code that stops using it: `DROP TABLE`, `DROP COLUMN`,
   `RENAME`, a `NOT NULL` column without a default, a tightened `CHECK`, a table rebuild. Those are
   a **contract** step: a later PR, after a deploy where nothing reads or writes the old shape.
3. **Mirror it** in `schema.ts` / `auth-schema.ts` (same names, types, defaults, indexes). If a
   port or the store changes, keep the in-memory store in `packages/test-kit` in step.
4. **Apply locally** to the D1 `pnpm dev` uses: `pnpm db:migrate:local`
   (`wrangler d1 migrations apply contentworker --local` in apps/web). Never `--remote` or
   `db:migrate:remote`; the `guard-bash` hook denies both.
5. **Test.**
   - `pnpm --filter @contentworker/db test` applies every migration to a fresh Miniflare D1
     (`packages/db/test/setup.ts`), proving it applies cleanly after the others.
   - New store behaviour gets a contract test in `packages/db/test/` (respect the 100-parameter
     cap: a list query is tested with more than 100 items).
   - A backfill gets a case that seeds rows in the older shape and checks them after.
6. **Docs.** The schema reference in `docs/development.md` (and `docs/domain-model.md` for a new
   concept); the `docs-impact` hook names them. Update in the same change, then
   `pnpm --filter @contentworker/docs generate`.

## Rename or drop: expand, then contract

1. PR 1 (expand): add the new column or table; write both; read the new one with a fallback to the
   old; backfill.
2. Let CI deploy it to every ring.
3. PR 2 (contract): stop writing the old one, then drop it in a new migration (the hook asks; say
   yes knowingly).

Say in PR 1's description that a contract PR follows, and what it will drop.
