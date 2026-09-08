-- Issue #119 code review: `listSessionAgentRuns` ordered only by `started_at` (transaction time,
-- via `DEFAULT now()`), which is not distinct enough to guarantee a deterministic wake order --
-- two runs created in the same transaction or within the same millisecond share a timestamp, so
-- reconstruction could assemble a different (and potentially inconsistent) Entry[] chain across
-- restarts. `wake_seq` is a monotonically increasing tiebreaker that reflects true insertion
-- order regardless of clock resolution.
ALTER TABLE agent_runs ADD COLUMN wake_seq bigserial;

-- `ADD COLUMN ... bigserial` assigns its default `nextval()` to every pre-existing row in heap
-- scan order, not insertion order, so the guarantee above only holds for rows inserted after
-- this migration unless backfilled explicitly here. `started_at` (tie-broken by `id`, both
-- already indexed/queryable) is the best available approximation of true historical insertion
-- order for rows that predate `wake_seq`. `agent_runs` is small and code-managed relative to
-- per-item data (bounded by agent activity, not user content), so this runs inline as a DO-less
-- backfill rather than a queued job -- same reasoning `0014_relation_config_repair.sql` gives
-- for repairing another small system table synchronously during deploy.
WITH ordered AS (
  SELECT id, row_number() OVER (ORDER BY started_at ASC, id ASC) AS rn
  FROM agent_runs
)
UPDATE agent_runs
SET wake_seq = ordered.rn
FROM ordered
WHERE agent_runs.id = ordered.id;

-- The backfill above overwrote wake_seq values the bigserial's underlying sequence already
-- considers "used", so the sequence must be advanced past every backfilled value -- otherwise
-- the very next real insert could collide with (or fall behind) a backfilled row.
SELECT setval(pg_get_serial_sequence('agent_runs', 'wake_seq'), COALESCE((SELECT MAX(wake_seq) FROM agent_runs), 0) + 1, false);

-- Covers listSessionAgentRuns's exact filter (project_item_id, triggered_by, parent_run_id;
-- unit is always 'session' for this query) plus its wake_seq ORDER BY in one index scan,
-- instead of filtering via agent_runs_project_item_id_idx and filesorting the result.
CREATE INDEX agent_runs_session_wake_idx ON agent_runs (project_item_id, triggered_by, parent_run_id, wake_seq)
  WHERE unit = 'session';
