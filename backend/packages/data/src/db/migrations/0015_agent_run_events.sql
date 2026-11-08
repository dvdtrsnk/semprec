CREATE TABLE agent_run_events (
  id bigserial PRIMARY KEY,                 -- monotonic cursor: resume and Entry[] reconstruction ordering
  agent_run_id uuid NOT NULL REFERENCES agent_runs(id),
  kind text NOT NULL CHECK (kind IN ('turn_start', 'message', 'tool_use', 'tool_result', 'turn_end', 'run_status')),
  payload jsonb NOT NULL,                   -- full message (AgentMessage shape) -- source for reconstruction, not just display
  at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX agent_run_events_run_idx ON agent_run_events (agent_run_id, id);
