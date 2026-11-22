-- A multipart upload may stay active for days. Existing rows age from creation.
ALTER TABLE asset_uploads ADD COLUMN activity_at INTEGER;
CREATE INDEX asset_uploads_by_activity ON asset_uploads(COALESCE(activity_at, created_at));
