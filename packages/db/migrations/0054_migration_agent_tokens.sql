-- 0054_migration_agent_tokens: what a site migration run's template agents may spend, and have.
-- Mirrors `migrationRuns.agentTokenCap` and `migrationAgentTokens` in packages/db/src/schema.ts.
--
-- Expand-only: a nullable column and a new table, which the code deployed before them never names.
-- A run with no cap (created before this, or by that code) reads as having the default. Its agents'
-- lines start at the total each agent kept itself, as it takes its next turn. Nothing is backfilled.

-- The run's cap, written when it is created. Never part of the run's whole-row rewrite.
ALTER TABLE `migration_runs` ADD `agent_token_cap` integer;

-- One line per template agent. `spent` is the agent's own total (not an increment), `reserved` what
-- it holds for the call under way, `seq` its last reservation. Past `reserved_until` a reservation
-- still open counts as spent. Environment-scoped: the environment purge clears it with the runs.
CREATE TABLE `migration_agent_tokens` (
	`space_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`run_id` text NOT NULL,
	`template_id` text NOT NULL,
	`seq` integer NOT NULL,
	`spent` integer NOT NULL,
	`reserved` integer DEFAULT 0 NOT NULL,
	`reserved_until` integer,
	`capped` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`space_id`, `environment_id`, `run_id`, `template_id`)
);
