-- 0036_block_catalogs: blocks from code, the component manifests a developer pushes as the
-- variants of an environment's blocks fields. Mirrors `block_catalogs` in packages/db/src/schema.ts.
--
-- A new table, so the code already deployed never reads or writes it, and nothing is backfilled.
-- Environment-scoped (the environment purge clears it).

-- One row per pushed version, kept as history: `version` counts up from 1 per environment and is
-- the compare-and-set a push rides with (a second push of the same version collides on the
-- primary key and loses). `blocks` is the catalog as one JSON document (at most
-- BLOCK_CATALOG_LIMITS.bytes characters); `targets` the blocks fields it provides; `changes` what
-- the version changed from the one before it (block ids added, changed, removed, renamed);
-- `hash` the SHA-256 of the canonical blocks and targets, so a push of the same catalog is a
-- no-op. `block_count` lets the history list without reading the documents.
CREATE TABLE `block_catalogs` (
	`space_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`version` integer NOT NULL,
	`hash` text NOT NULL,
	`blocks` text NOT NULL,
	`block_count` integer NOT NULL,
	`targets` text NOT NULL,
	`changes` text NOT NULL,
	`pushed_by` text,
	`pushed_at` integer NOT NULL,
	PRIMARY KEY(`space_id`, `environment_id`, `version`)
);
