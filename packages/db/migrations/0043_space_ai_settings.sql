-- 0043_space_ai_settings: a space's AI settings (`AiSettings` in @contentworker/domain): per AI
-- capability, whether it is on, the model tier it runs on, and the guidance its administrators add
-- to the built-in prompt. Mirrors `space_ai_settings` in packages/db/src/schema.ts.
--
-- A new table, so the code already deployed never reads or writes it, and nothing is backfilled:
-- a space with no row reads as every capability on, at its call sites' own tiers, with no guidance
-- (what every space did before this table existed). Space-scoped, not environment-scoped: it
-- governs what may be asked of the models, not content.

-- One row per space, rewritten whole at each set: `version` counts up from 1 and is the
-- compare-and-set a set rides with (the first set inserts, colliding on the primary key when
-- another got there first; each later one updates where the version is still the one it read).
-- `document` is `{ capabilities: { <id>: { enabled, tier, guidance } } }` as one JSON document;
-- guidance is at most AI_GUIDANCE_MAX_CHARS characters per capability.
CREATE TABLE `space_ai_settings` (
	`space_id` text PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	`document` text NOT NULL,
	`updated_by` text,
	`updated_at` integer NOT NULL
);
