-- Issue #1497: per-mailbox facts about mail sync health. `last_activity_at` moves on failures as well,
-- so it cannot answer "when did this mailbox last sync successfully"; these columns can. All stay NULL
-- until the sync job records them.
--
-- Backfill: an account with `last_error IS NULL` and a `last_activity_at` last synced successfully and
-- finished its first pass then; an account failing now gets `failing_since` from `last_activity_at` and
-- the failure kind `other` (the kind was never stored).
--
-- Additive and rollback-safe: four nullable columns the previous release never reads or writes. The
-- runtime role already holds table-level privileges on `mail_account_sync_state`.
ALTER TABLE mail_account_sync_state
  ADD COLUMN last_successful_sync_at timestamptz,
  ADD COLUMN failing_since timestamptz,
  ADD COLUMN initial_sync_completed_at timestamptz,
  ADD COLUMN last_failure_kind text,
  ADD CONSTRAINT mail_account_sync_state_last_failure_kind_check
    CHECK (last_failure_kind IN ('reauthorization', 'connectionLimit', 'other'));

UPDATE mail_account_sync_state
SET last_successful_sync_at = last_activity_at,
    initial_sync_completed_at = last_activity_at
WHERE last_error IS NULL AND last_activity_at IS NOT NULL;

UPDATE mail_account_sync_state
SET failing_since = last_activity_at,
    last_failure_kind = 'other'
WHERE last_error IS NOT NULL AND last_activity_at IS NOT NULL;
