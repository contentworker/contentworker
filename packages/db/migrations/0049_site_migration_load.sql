-- 0049_site_migration_load: what loading a site migration's pages keeps. Mirrors
-- `migrationPages.unresolvedLinks` and `migrationAssets` in packages/db/src/schema.ts.
--
-- Expand-only. The new column has a default, so code deployed before it (which never names it)
-- writes rows that read as 0: no links waiting. The new table is read and written only by the
-- load. Environment-scoped: the environment purge clears it with the other migration tables.

-- Links in a loaded page's entry to pages of the run that had no entry yet, which the relink pass
-- looks for.
ALTER TABLE `migration_pages` ADD `unresolved_links` integer DEFAULT 0 NOT NULL;

-- The assets a run created from URLs, one per URL: a file the run has brought in is not downloaded
-- again for another page or a second load.
CREATE TABLE `migration_assets` (
	`space_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`run_id` text NOT NULL,
	`url` text NOT NULL,
	`asset_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`space_id`, `environment_id`, `run_id`, `url`)
);
