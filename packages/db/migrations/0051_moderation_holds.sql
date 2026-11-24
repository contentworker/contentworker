-- 0051_moderation_holds: entries the moderation agent took offline, waiting on a person to
-- republish them or keep them unpublished. Mirrors `moderationHolds` in packages/db/src/schema.ts.
--
-- Expand-only: a new table, read and written only by code that knows it. Code deployed before it
-- unpublishes a flagged entry without opening a hold, as it always has; no existing row is
-- backfilled (an entry it held stays unpublished, with its run in the agent ledger).
-- Environment-scoped: the environment purge clears it with the other agent tables.
CREATE TABLE `moderation_holds` (
	`space_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`id` text NOT NULL,
	`entry_id` text NOT NULL,
	`content_type_api_id` text NOT NULL,
	`entry_version` integer NOT NULL,
	`flags` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`decided_at` integer,
	`decided_by` text,
	`note` text,
	PRIMARY KEY(`space_id`, `environment_id`, `id`)
);

-- Approvals lists and counts open holds per scope, oldest first.
CREATE INDEX `moderation_holds_by_status` ON `moderation_holds` (`space_id`,`environment_id`,`status`,`created_at`);

-- At most one open hold per entry: a second flag refreshes the open one instead.
CREATE UNIQUE INDEX `moderation_holds_open_entry` ON `moderation_holds` (`space_id`,`environment_id`,`entry_id`) WHERE `status` = 'open';

-- An entry's holds, newest first: a flag on a version a person republished leaves it live.
CREATE INDEX `moderation_holds_by_entry` ON `moderation_holds` (`space_id`,`environment_id`,`entry_id`,`created_at`);
