-- 0041_role_versions: a version on every role (`Role.version`), bumped on each save and the
-- compare-and-set a save rides with, so two concurrent `PUT /roles/:id` can't both win and a
-- client can send the version it read (`expectedVersion`). Mirrors `roles` in
-- packages/db/src/schema.ts.
--
-- A constant default, no backfill: every existing role reads as version 1. Code deployed before
-- this migration never names the column, so its upsert leaves it as it is; a role it creates
-- starts at 1, and one it replaces keeps the version it had, which the next versioned save
-- compares against as usual.
ALTER TABLE `roles` ADD `version` integer DEFAULT 1 NOT NULL;
