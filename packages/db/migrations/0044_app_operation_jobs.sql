-- 0044_app_operation_jobs: async plugin operations. A caller's request is accepted as a job here,
-- the engine's AppOperationWorkflow runs it and writes its outcome, and the caller reads the
-- output back until the job expires. Mirrors `appOperationJobs` in packages/db/src/schema.ts.
--
-- `caller` is the requesting principal's scopes and content grants (JSON), which the Workflow
-- narrows the plugin's grant to; `requires` is the scope the operation needed, which reading the job
-- needs too, even once the plugin is gone; `checksum` pins the plugin code accepted to run. A new table:
-- code deployed before this migration never reads it.
CREATE TABLE `app_operation_jobs` (
	`space_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`id` text NOT NULL,
	`plugin_id` text NOT NULL,
	`plugin_version` text NOT NULL,
	`checksum` text NOT NULL,
	`operation` text NOT NULL,
	`requires` text NOT NULL,
	`status` text NOT NULL,
	`input` text NOT NULL,
	`output` text,
	`error` text,
	`caller` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`completed_at` integer,
	`expires_at` integer NOT NULL,
	PRIMARY KEY(`space_id`, `environment_id`, `id`)
);
CREATE INDEX `app_operation_jobs_by_created` ON `app_operation_jobs` (`space_id`, `environment_id`, `created_at`);
-- The hourly sweep's read, across every space: jobs past their expiry.
CREATE INDEX `app_operation_jobs_by_expiry` ON `app_operation_jobs` (`expires_at`);
