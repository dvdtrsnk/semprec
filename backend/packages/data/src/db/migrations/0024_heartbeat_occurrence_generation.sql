-- `generation` (issue #84): supersedes #213's plain `{ heartbeatId, occurrenceId }` job
-- payload/key. Reactivating a cancelled occurrence, or replacing a still-queued occurrence's
-- stale rule_snapshot, increments this column and the fire job is enqueued keyed on the new
-- generation. This is what lets an old handler — still finishing (or about to start) against the
-- occurrence it was enqueued for — tell that its own generation was superseded and become a
-- no-op, instead of racing a reactivated occurrence for the same row.
ALTER TABLE heartbeat_occurrences ADD COLUMN generation integer NOT NULL DEFAULT 1;
