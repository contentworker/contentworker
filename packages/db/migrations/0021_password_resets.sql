-- 0021_password_resets: self-service password reset codes for the admin's people. Mirrors
-- `passwordResets` in packages/db/src/auth-schema.ts.
--
-- A new table only, so the code already deployed never reads or writes it, and nothing is
-- backfilled. The web Worker writes a row when someone asks for a code (apps/web/app/lib/
-- password-reset.server.ts) and emails the code; only `code_hash` is kept (HMAC-SHA256 with
-- PASSWORD_PEPPER over the row id and the code). A code works once (`used_at`), until
-- `expires_at` (15 minutes), for at most a few tries: every try is counted in `attempts` before
-- the code is compared, with a conditional update, so racing requests can't share a try. Issuing a new code deletes the person's older rows, and a
-- finished reset deletes them all.
CREATE TABLE `password_resets` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL REFERENCES `users`(`id`),
	`code_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`used_at` integer
);
-- A typed code is checked against the person's newest live row.
CREATE INDEX `password_resets_user` ON `password_resets` (`user_id`, `created_at`);
-- Finished rows are swept by expiry when a new code is issued.
CREATE INDEX `password_resets_expires` ON `password_resets` (`expires_at`);
