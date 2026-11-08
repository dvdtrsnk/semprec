-- `heartbeat_occurrences` (issue #213): one row per sweep-driven fire attempt of a `dailyTime`,
-- `weekly`, `interval`, or `everyNDays` heartbeat, carrying the exact rule the sweep saw at
-- enqueue time (`rule_snapshot`). This is what lets the fire task tell a stale enqueue (the
-- heartbeat was disabled or its rule edited before the job ran) from a legitimate one via plain
-- `jsonb` equality against `project_heartbeats.rule`, and what lets a floating rule
-- (`interval`/`everyNDays`) compute its next occurrence from the first attempt's actual
-- `first_started_at` instead of from enqueue time. `onItemEvent` and manual (`triggeredByRunId`)
-- fires never create a row here.
--
-- `UNIQUE (heartbeat_id, scheduled_for)` is the idempotency guard: a second insert for the same
-- due occurrence (only reachable in edge cases outside the sweep's own `FOR UPDATE SKIP LOCKED`
-- guarantee) is a no-op conflict, never a second row and never a second job.
CREATE TABLE heartbeat_occurrences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  heartbeat_id uuid NOT NULL REFERENCES project_heartbeats(id) ON DELETE CASCADE,
  scheduled_for timestamptz NOT NULL,
  rule_snapshot jsonb NOT NULL,
  first_started_at timestamptz,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  last_error text,
  UNIQUE (heartbeat_id, scheduled_for)
);

CREATE INDEX heartbeat_occurrences_heartbeat_idx ON heartbeat_occurrences (heartbeat_id);
