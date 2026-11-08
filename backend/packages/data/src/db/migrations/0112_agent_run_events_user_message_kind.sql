-- Issue #1566: a user's turn (the wake text and every follow-up) is persisted as a
-- 'user_message' agent run event so a reconstructed conversation contains the questions as well
-- as the answers. Additive to the kind check (pattern of 0016): no existing row changes.
ALTER TABLE agent_run_events DROP CONSTRAINT agent_run_events_kind_check;
ALTER TABLE agent_run_events ADD CONSTRAINT agent_run_events_kind_check
  CHECK (kind IN ('turn_start', 'message', 'tool_use', 'tool_result', 'turn_end', 'run_status', 'compaction', 'user_message'));
