-- 0020_content_type_published_url_pattern: a content type's URL pattern as it was when last
-- published, which Delivery's `GET …/routes` serves. Mirrors `contentTypes.publishedUrlPattern`
-- in packages/db/src/schema.ts.
--
-- One nullable column, so the code already deployed never reads it, and its upserts (which name
-- their columns) leave it as it is. A type published now has its current pattern published; a
-- draft has none yet (a revision of a published type can't be told apart from a type never
-- published, so it gets its route back on its next publish).
ALTER TABLE `content_types` ADD `published_url_pattern` text;

UPDATE `content_types`
SET `published_url_pattern` = `url_pattern`
WHERE `status` = 'published' AND `url_pattern` IS NOT NULL;
