-- 0045_ai_projects: AI projects (`AiProject` in @contentworker/domain), the record of reading a
-- reference's text for one, and the project an AI action or an agent schedule stores. Mirrors
-- `aiProjects`, `aiReferenceExtractions`, `aiActions.projectId` and `agentSchedules.projectId` in
-- packages/db/src/schema.ts.
--
-- Two new tables, which the code already deployed never reads or writes, and two nullable columns
-- it never names: existing AI actions and schedules read as "the environment's default project",
-- which is none until someone sets one, so they run as before. Nothing is backfilled.
-- Environment-scoped, like `ai_actions` and the assets the references name (the environment purge
-- clears them; snapshots and clones carry projects).

-- One row per project, rewritten whole at each write: `version` counts up from 1 and is the
-- compare-and-set every write rides with. `name_key` is the name case-folded, which the name is
-- unique by. `writer` and `reader` are `{ name, description }` JSON or NULL; `references` is a JSON
-- list of `{ assetId, version }` pins (at most AI_PROJECT_MAX_REFERENCES). Instructions are at
-- most AI_PROJECT_INSTRUCTIONS_MAX characters.
CREATE TABLE `ai_projects` (
	`space_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`id` text NOT NULL,
	`name` text NOT NULL,
	`name_key` text NOT NULL,
	`description` text,
	`instructions` text,
	`writer` text,
	`reader` text,
	`references` text NOT NULL,
	`is_default` integer DEFAULT 0 NOT NULL,
	`version` integer NOT NULL,
	`created_at` integer NOT NULL,
	`created_by` text,
	`updated_at` integer NOT NULL,
	`updated_by` text,
	PRIMARY KEY(`space_id`, `environment_id`, `id`)
);
-- One project per name in the environment, and the list by name.
CREATE UNIQUE INDEX `ai_projects_by_name` ON `ai_projects` (`space_id`, `environment_id`, `name_key`);
-- At most one default per environment: a second default set at once fails its commit.
CREATE UNIQUE INDEX `ai_projects_default` ON `ai_projects` (`space_id`, `environment_id`) WHERE `is_default` = 1;

-- One row per asset file version whose text a project asked for (amendment C): `pending` while the
-- ingest rerun reads it, then `done`, or `skipped` with `reason` (`media_off`, `budget`, `failed`,
-- `too_large`, `unsupported`). `triggered_by` names whose call found the reference without text.
-- A claim inserts and loses to another on the primary key, so a second call starts nothing. Rows
-- go with the asset's derived files.
CREATE TABLE `ai_reference_extractions` (
	`space_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`asset_id` text NOT NULL,
	`file_version` integer NOT NULL,
	`status` text NOT NULL,
	`reason` text,
	`triggered_by` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`space_id`, `environment_id`, `asset_id`, `file_version`)
);

-- The project a run takes; NULL is the environment's default at run time.
ALTER TABLE `ai_actions` ADD COLUMN `project_id` text;
ALTER TABLE `agent_schedules` ADD COLUMN `project_id` text;
