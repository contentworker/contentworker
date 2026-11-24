-- 0048_site_migrations: site migrations (`MigrationRun`, `MigrationTemplate`, `MigrationPage` in
-- @contentworker/domain). Mirrors `migrationRuns`, `migrationTemplates` and `migrationPages` in
-- packages/db/src/schema.ts.
--
-- Three new tables, which the code already deployed never reads or writes. Nothing is backfilled.
-- Environment-scoped (the environment purge clears them). Page HTML and script outputs are not
-- stored here: they are objects under `migrations/<space>/<environment>/<run>/` in the bucket, and
-- these rows hold their key, SHA-256 and size as `{ key, sha256, bytes }` JSON.

-- One row per run, rewritten whole at each write: `version` counts up from 1 and is the
-- compare-and-set every write rides with. `source` is `{ kind, url, include, exclude, maxPages }`
-- JSON; `inventory` is what the last inventory found, as JSON, or NULL before one.
CREATE TABLE `migration_runs` (
	`space_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`id` text NOT NULL,
	`name` text NOT NULL,
	`source` text NOT NULL,
	`status` text NOT NULL,
	`threshold` real NOT NULL,
	`inventory` text,
	`error` text,
	`version` integer NOT NULL,
	`created_at` integer NOT NULL,
	`created_by` text,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`space_id`, `environment_id`, `id`)
);

-- A run's templates, replaced together when its pages are clustered again. `sample_page_ids` and
-- `fingerprint` are JSON lists; `script` is the import script's artifact JSON, or NULL.
CREATE TABLE `migration_templates` (
	`space_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`run_id` text NOT NULL,
	`id` text NOT NULL,
	`label` text NOT NULL,
	`status` text NOT NULL,
	`page_count` integer NOT NULL,
	`sample_page_ids` text NOT NULL,
	`fingerprint` text NOT NULL,
	`content_type_id` text,
	`script` text,
	`version` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`space_id`, `environment_id`, `run_id`, `id`)
);

-- A run's pages, one per URL. `depth` is links from a crawl's start page (0 for a sitemap's pages):
-- a crawl's pages are its frontier, so it resumes from them. `html` and `output` are artifact JSON
-- or NULL; `fingerprint` a JSON list of structure shingles (at most 256 short hashes); `score` the
-- output's score JSON.
CREATE TABLE `migration_pages` (
	`space_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`run_id` text NOT NULL,
	`id` text NOT NULL,
	`url` text NOT NULL,
	`path` text NOT NULL,
	`depth` integer DEFAULT 0 NOT NULL,
	`stage` text NOT NULL,
	`template_id` text,
	`title` text,
	`last_modified` text,
	`http_status` integer,
	`html` text,
	`fingerprint` text,
	`output` text,
	`score` text,
	`entry_id` text,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`space_id`, `environment_id`, `run_id`, `id`)
);
-- One page per URL in a run: discovering it again adds nothing.
CREATE UNIQUE INDEX `migration_pages_by_url` ON `migration_pages` (`space_id`, `environment_id`, `run_id`, `url`);
-- A run's pages by stage (triage, the next step's work) and by template.
CREATE INDEX `migration_pages_by_stage` ON `migration_pages` (`space_id`, `environment_id`, `run_id`, `stage`);
CREATE INDEX `migration_pages_by_template` ON `migration_pages` (`space_id`, `environment_id`, `run_id`, `template_id`);
