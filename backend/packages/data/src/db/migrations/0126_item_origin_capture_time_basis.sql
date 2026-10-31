-- Existing timestamps cannot be distinguished from historical estimates.
ALTER TABLE item_origins ALTER COLUMN captured_at DROP NOT NULL;
ALTER TABLE item_origins ADD COLUMN capture_time_basis text NOT NULL DEFAULT 'legacyUnverified'
  CHECK (capture_time_basis IN ('inboxCapture', 'unknown', 'legacyUnverified'));
