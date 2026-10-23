-- Pending approval requests for MCP tool invocations that require human sign-off
-- (issue #130). This is the baseline table only: decision execution, sandboxing,
-- expiry, and notification delivery are explicitly out of scope for this issue and
-- land separately.
--
-- `risk_class` is a snapshot of `mcp_tool_registrations.risk_class` at request time,
-- not a live reference to it: the request must keep describing the risk a deciding
-- user actually saw, even if the registration is reclassified afterwards.
--
-- `payload` is the exact deferred invocation (the resolved target's identifying
-- fields plus the model-supplied arguments) — enough for a later issue to execute
-- the call unchanged once approved, without re-deriving it from `agent_run_id` and
-- guesswork.
CREATE TABLE approval_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_run_id uuid NOT NULL REFERENCES agent_runs(id),
  tool_name text NOT NULL,
  risk_class text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  decided_by uuid REFERENCES users(id)
);

CREATE INDEX approval_requests_agent_run_idx ON approval_requests (agent_run_id);
CREATE INDEX approval_requests_status_idx ON approval_requests (status);
