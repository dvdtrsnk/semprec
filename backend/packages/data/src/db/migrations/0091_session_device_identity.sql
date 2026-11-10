-- Issue #1354: a session records which device it belongs to. All columns are nullable: sessions
-- created before this migration, and logins from a client that does not send device fields, keep
-- NULL. `sessions` is an identity table written only by `semprec_data` (0057), so no grant changes.
ALTER TABLE sessions
  ADD COLUMN device_id uuid,
  ADD COLUMN device_name text,
  ADD COLUMN device_kind text,
  ADD COLUMN os_version text,
  ADD COLUMN app_version text;

ALTER TABLE sessions
  ADD CONSTRAINT sessions_device_kind_check CHECK (device_kind IN ('iphone', 'ipad', 'mac', 'browser'));

CREATE INDEX sessions_user_device_active_idx ON sessions (user_id, device_id) WHERE revoked_at IS NULL;
