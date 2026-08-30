-- Persisted deliveredToAddress + DSN/bounce classification (issue #93), and per-item
-- migration-state tracking for the legacy-Emails backfill job (issue #93, mirrors the
-- per-property `migrationStatus` vocabulary already established for property-type
-- migrations — see chokePoint/propertiesStore.ts's MIGRATION_STATUSES). Additive only:
-- every new column here is nullable or carries a DEFAULT, per the expand/contract
-- discipline — no existing row needs a backfill for this migration itself to apply cleanly.

ALTER TABLE mail_message_meta
  ADD COLUMN delivered_to_address text,
  ADD COLUMN message_kind text NOT NULL DEFAULT 'message' CHECK (message_kind IN ('message', 'dsn')),
  ADD COLUMN dsn_original_message_id text,
  ADD COLUMN migration_status text NOT NULL DEFAULT 'stable' CHECK (migration_status IN ('stable', 'partial', 'done'));

-- A DSN's own References/In-Reply-To already threads it correctly (threading.ts is generic
-- over both), so this is only the fast-path "which outgoing message does this DSN report on"
-- lookup, not the threading mechanism itself.
CREATE INDEX mail_message_meta_dsn_original_message_id_idx
  ON mail_message_meta (dsn_original_message_id) WHERE dsn_original_message_id IS NOT NULL;
