-- Adds resolve/dedupe capability to the existing minimal `notifications` stub (issue #112)
-- so a heartbeat check can publish a "finding" that auto-resolves once repaired, and so
-- concurrent runs of the same check can never create two active findings for the same
-- drift. Purely additive: both columns are nullable, so every existing writer
-- (scheduler/sweep.ts's 'heartbeat_error', manifest/driftCheck.ts's 'agent_manifest_drift')
-- keeps inserting rows with both columns NULL, unaffected by this migration.

ALTER TABLE notifications ADD COLUMN IF NOT EXISTS dedupe_key text;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS resolved_at timestamptz;

-- At most one *active* (unresolved) finding per (kind, dedupe_key): two concurrent checks
-- reporting the same drift race on this index, and only one of them inserts a row — the
-- other's `ON CONFLICT ... DO NOTHING` (see notifications/findings.ts) is a no-op. Rows with
-- no dedupe_key (the pre-existing plain notification writers above) are never constrained
-- by this index at all.
CREATE UNIQUE INDEX IF NOT EXISTS notifications_active_finding_idx
  ON notifications (kind, dedupe_key)
  WHERE resolved_at IS NULL AND dedupe_key IS NOT NULL;
