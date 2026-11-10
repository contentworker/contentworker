-- 0039_promotion_blocks: the block catalog and block config a promotion copies, pinned by the
-- source's versions when it was requested, and the target's (`PromotedBlocks`).
-- Mirrors `environment_promotions` in packages/db/src/schema.ts.
--
-- Nullable, no backfill: a promotion requested before this migration (or one that copies no
-- blocks) has none, and code deployed before it never names the column, so its promotions are
-- written and read as they were.
ALTER TABLE `environment_promotions` ADD `blocks` text;
