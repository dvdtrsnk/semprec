-- Issue #119 code review: `listSessionAgentRuns` ordered only by `started_at` (transaction time,
-- via `DEFAULT now()`), which is not distinct enough to guarantee a deterministic wake order --
-- two runs created in the same transaction or within the same millisecond share a timestamp, so
-- reconstruction could assemble a different (and potentially inconsistent) Entry[] chain across
-- restarts. `wake_seq` is a monotonically increasing tiebreaker that reflects true insertion
-- order regardless of clock resolution.
ALTER TABLE agent_runs ADD COLUMN wake_seq bigserial;
