-- 0042_member_versions: a version on every person on a team (`SpaceMember.version`), bumped on
-- each save and the compare-and-set a save rides with, so a request that read a person before an
-- admin disabled, demoted or removed them can't write the old state back (or the row back) after.
-- Mirrors `space_members` in packages/db/src/schema.ts.
--
-- A constant default, no backfill: every existing person reads as version 1. Code deployed before
-- this migration never names the column, so its upsert leaves it as it is; a person it adds
-- starts at 1, and one it replaces keeps the version it had, which the next versioned save
-- compares against as usual.
ALTER TABLE `space_members` ADD `version` integer DEFAULT 1 NOT NULL;
