-- Issue #1618: links an approval request to the model-runtime tool call (the step of the run) that
-- created it.
--
-- Expand-only and rollback-safe: one nullable column with no default that the previous release
-- neither reads nor writes (its `SELECT *` mapping ignores unknown columns). Existing rows and
-- requests created without a tool call id (any non-agent-session path) keep NULL.
ALTER TABLE approval_requests ADD COLUMN tool_call_id text NULL;

-- A redelivered tool call must not create a second request for the same step of the same run.
CREATE UNIQUE INDEX approval_requests_run_tool_call_unique
  ON approval_requests (tenant_id, agent_run_id, tool_call_id)
  WHERE tool_call_id IS NOT NULL;
