-- 0052_migration_clustering_hold: when a site migration run's background driver took its templates
-- on. Mirrors `migrationRuns.clusteringHeldAt` in packages/db/src/schema.ts.
--
-- Expand-only. Nullable, so code deployed before it (which names the columns it writes, and never
-- this one) writes rows that read as not held, and leaves a hold as it is when it rewrites a run.

-- From then on the run's pages aren't clustered again: its driver waits for these templates by id.
ALTER TABLE `migration_runs` ADD `clustering_held_at` integer;
