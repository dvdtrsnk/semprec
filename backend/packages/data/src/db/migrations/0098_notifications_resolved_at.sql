-- Issue #1463: a notification records that the thing it points at was handled (an approval
-- decided, a problem resolved), so clients can drop it without the user opening it.
--
-- Additive and rollback-safe: a nullable column without a default, which the previous release
-- neither reads nor writes, and a partial index over the rows that carry it (empty at creation).
ALTER TABLE notifications ADD COLUMN resolved_at timestamptz;

CREATE INDEX notifications_resolved_idx ON notifications (tenant_id, user_id, resolved_at)
  WHERE resolved_at IS NOT NULL;
