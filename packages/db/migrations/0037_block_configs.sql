-- 0037_block_configs: the block config, what an environment's admins allow of the blocks the
-- catalog (0036_block_catalogs) provides: narrower lists, tighter counts and locked slots, per
-- target and per slot. Mirrors `block_configs` in packages/db/src/schema.ts.
--
-- A new table, so the code already deployed never reads or writes it, and nothing is backfilled.
-- Environment-scoped (the environment purge clears it).

-- One row per environment, rewritten whole at each set: `version` counts up from 1 and is the
-- compare-and-set a set rides with (the first set inserts, colliding on the primary key when
-- another got there first; each later one updates where the version is still the one it read).
-- `document` is the config as one JSON document, `{ targets, blocks }` (at most
-- BLOCK_CONFIG_LIMITS.bytes characters). No row is version 0, the empty config.
CREATE TABLE `block_configs` (
	`space_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`version` integer NOT NULL,
	`document` text NOT NULL,
	`updated_by` text,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`space_id`, `environment_id`)
);
