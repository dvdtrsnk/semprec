-- Issue #1387: an optional display name for the signed-in person. The profile screen composes the
-- initials from it and falls back to the e-mail address while it is NULL.
--
-- Expand-only and rollback-safe: a nullable column with no default and no backfill. Every account
-- written before this migration keeps NULL and nothing else changes. The previous release reads `users`
-- only through named columns, so the new column is invisible to it. The runtime role already holds
-- table-level privileges on `users` (0057), so no grant changes.
ALTER TABLE users ADD COLUMN display_name text NULL;
