-- 0053_site_migration_driver: what a site migration run records of its background driver. Mirrors
-- `migrationRuns.driver` and `migrationRuns.goAhead` in packages/db/src/schema.ts.
--
-- Expand-only: two nullable columns, which the code deployed before them never names (it writes a
-- run by its own columns, so it leaves them as they are). Nothing is backfilled: a run started
-- before them reads as not recorded, and its driver's state comes from Workflows.

-- Who started the run's driver and when, as JSON (`{ startedBy, startedAt }`).
ALTER TABLE `migration_runs` ADD `driver` text;
-- The go-ahead to publish, as JSON (`{ approvedBy, at, target, deliveredAt }`): set once.
ALTER TABLE `migration_runs` ADD `go_ahead` text;
