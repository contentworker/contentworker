-- 0050_site_migration_authoring: what authoring a site migration's templates keeps. Mirrors
-- `migrationTemplates.proposal`, `migrationTemplates.lastTry` and `migrationPages.outputScript`
-- in packages/db/src/schema.ts.
--
-- Expand-only: three nullable columns, which the code deployed before them never names. Existing
-- templates read as having no proposal and no try; existing pages as never transformed by a
-- script version, so the next transform pass takes them again. Nothing is backfilled.

-- The content type a template's pages are proposed to become, as content type draft JSON, until
-- an approval creates it.
ALTER TABLE `migration_templates` ADD `proposal` text;
-- The last try of the template's script on its sample pages, as summary JSON.
ALTER TABLE `migration_templates` ADD `last_try` text;
-- SHA-256 of the script version the page's last transform ran.
ALTER TABLE `migration_pages` ADD `output_script` text;
