-- 0038_entry_block_locks: the locked regions of an entry's blocks (docs/specs/locked-regions.md),
-- and the `lock` content action for the roles that should hold it. Mirrors `entries` in
-- packages/db/src/schema.ts.
--
-- `block_locks` is entry state, not content: a JSON list of locks ({ field, keys, depth, freeze,
-- lockedBy, lockedAt }), NULL when the entry holds none. Only a lock set writes it (a compare-and-set
-- on the entry's current version and the locks as read); no save, publish or restore names the
-- column, so a version restore keeps the locks held now and code deployed before this migration,
-- which never names it either, leaves it as it is. Nullable, no backfill: every entry starts
-- with no locks. `entry_published` gets no copy: Delivery and Preview never see a lock.
ALTER TABLE `entries` ADD `block_locks` text;

-- The Manager and Administrator presets now grant `lock` on every content type. A space's preset
-- roles were seeded from the definitions as they were, so each one whose `*` grant still writes
-- gains `lock` there. A grant on one named type, a custom role, and a preset edited to stop
-- writing gain nothing: `lock` is never implied, only listed.
UPDATE `roles`
SET `content_grants` = (
  SELECT json_group_array(
    json(
      CASE
        WHEN json_extract(g.value, '$.contentTypeApiId') = '*'
          AND EXISTS (SELECT 1 FROM json_each(g.value, '$.actions') a WHERE a.value = 'write')
          AND NOT EXISTS (SELECT 1 FROM json_each(g.value, '$.actions') a WHERE a.value = 'lock')
        THEN json_insert(g.value, '$.actions[#]', 'lock')
        ELSE g.value
      END
    )
  )
  FROM json_each(`roles`.`content_grants`) g
)
WHERE `preset` IN ('manager', 'admin') AND json_array_length(`content_grants`) > 0;
