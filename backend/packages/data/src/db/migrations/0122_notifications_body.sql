-- Issue #1773: a notification may carry a rendered body beside its title. An approval request's body
-- states the action it asks about and whether that action can be undone.
--
-- Expand-only and rollback-safe: a nullable column with no default and no backfill. Every notification
-- written before this migration, and every notification of a kind that has no body, keeps NULL. The
-- previous release names its columns explicitly in every read and write, so it keeps working after a
-- rollback.
ALTER TABLE notifications ADD COLUMN body text;
