-- Issue #216: the retained history model. `doc_snapshot_history` checkpoints previously
-- carried no boundary into `doc_updates`, so a checkpoint plus "whatever doc_updates rows
-- happen to still exist" could go silently stale the moment a later compaction deleted the
-- rows a reconstruction needed (docHistory.ts's ValidationError guard existed precisely
-- because of this gap). This migration adds the mirrored, append-only `doc_history_updates`
-- log (never touched by compaction) plus explicit checkpoint-boundary columns, so any
-- timestamp inside the retention window can always be reconstructed regardless of how many
-- compactions have run since.

-- Mirrored copy of every appended `doc_updates` row (same id/bytes/attribution/timestamp),
-- retained independently of `doc_updates`/compaction until its own expiry. Cleanup of
-- expired rows here is out of scope for this issue (#86).
CREATE TABLE doc_history_updates (
  update_id bigint PRIMARY KEY,
  doc_id uuid NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
  update bytea NOT NULL,
  created_by text NOT NULL CHECK (created_by IN ('user', 'ai_agent', 'system')),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL
);

-- Supports openDocVersionAt's replay query: update_id > checkpoint boundary, ordered by
-- (created_at, update_id) through the queried timestamp.
CREATE INDEX doc_history_updates_doc_id_created_at_update_id_idx
  ON doc_history_updates (doc_id, created_at, update_id);
CREATE INDEX doc_history_updates_expires_at_idx ON doc_history_updates (expires_at);

-- New checkpoint-boundary columns. Added nullable here: plain SQL cannot merge Yjs binary
-- updates, so the populated-upgrade backfill that installs a value for every existing row
-- (and only then tightens these to NOT NULL) runs as application code immediately after this
-- migration — see docHistoryCutoverMigration.ts, invoked from runMigrationsCli.ts and
-- testSupport/globalSetup.ts. This is the same "destructive only for already-unusable
-- pre-cutover history" populated-upgrade the issue's Task explicitly calls for: existing
-- `doc_snapshot_history` rows carry no through_update_id boundary and are therefore not
-- safely resumable under the new selection contract, so the backfill discards them and
-- installs one valid cutover baseline per doc instead of trying to retrofit old rows.
ALTER TABLE doc_snapshot_history ADD COLUMN through_update_id bigint;
ALTER TABLE doc_snapshot_history ADD COLUMN represented_at timestamptz;

-- Rolling (never-expiring) baseline checkpoints — the new-doc baseline and the populated-
-- upgrade cutover baseline — use NULL expiry; only ordinary compaction checkpoints expire.
ALTER TABLE doc_snapshot_history ALTER COLUMN expires_at DROP NOT NULL;

CREATE INDEX doc_snapshot_history_doc_id_represented_at_idx
  ON doc_snapshot_history (doc_id, represented_at);

-- Set by the new-doc baseline write (docsStore.ts) and by the populated-upgrade backfill for
-- pre-existing docs. A timestamp before this (or before the configured retention cutoff)
-- returns 410 history_not_retained from openDocVersionAt.
ALTER TABLE docs ADD COLUMN history_available_from timestamptz;
