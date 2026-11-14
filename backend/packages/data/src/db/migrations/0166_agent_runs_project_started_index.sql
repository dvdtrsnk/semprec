-- Issue gh-1909: the project's list of recent agent runs (`GET /api/agent-runs?projectItemId=`) reads one
-- project's runs of one tenant newest first, `ORDER BY started_at DESC, id DESC LIMIT n`. The only indexes of
-- agent_runs that lead with the project are `agent_runs_project_item_id_idx` and `agent_runs_session_wake_idx`;
-- neither is ordered by `started_at`, so the read would sort every run of the project. This index keeps the order
-- of the read, so the newest rows are read first and the scan stops after the limit.
--
-- Additive: one index, so the previous release's code is unaffected and no existing statement changes. Not
-- CONCURRENTLY, because runMigrations wraps each file in BEGIN/COMMIT (the same reason as 0066); the statement
-- holds a SHARE lock on agent_runs while it builds. IF NOT EXISTS makes a second run a no-op.
CREATE INDEX IF NOT EXISTS agent_runs_tenant_project_started_idx
  ON agent_runs (tenant_id, project_item_id, started_at DESC, id DESC);
