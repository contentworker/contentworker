-- 0040_block_catalog_breakpoints: the site's CSS breakpoints a block catalog version declares
-- (`BlockCatalog.breakpoints`, docs/specs/breakpoint-overrides.md), as a JSON list of
-- { id, name, minWidth }. Mirrors `block_catalogs` in packages/db/src/schema.ts.
--
-- Nullable, no backfill: a version pushed before this migration declares none, and is read as an
-- empty list. Code deployed before it never names the column, so it writes and reads versions as
-- it did; a version it writes declares none.
ALTER TABLE `block_catalogs` ADD `breakpoints` text;
