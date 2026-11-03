-- 0023_trash_retention: how long a space keeps trashed entries. Mirrors `spaces` and `entries` in
-- packages/db/src/schema.ts.
--
-- A nullable column: existing spaces get NULL, which means off (trashed entries are kept until
-- someone deletes them), so the code already deployed and every existing space are unaffected and
-- nothing is backfilled.
ALTER TABLE `spaces` ADD `trash_retention_days` integer;
-- The engine's hourly retention sweep: per environment, its trashed entries oldest first. An
-- archived entry's `updated_at` is when it was trashed (a trashed entry takes no new version, and
-- trashing it again writes nothing). Partial, so it holds the trash only.
CREATE INDEX IF NOT EXISTS `entries_trashed` ON `entries` (`space_id`,`environment_id`,`updated_at`,`id`) WHERE `status` = 'archived';
