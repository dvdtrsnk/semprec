-- Issue #119: reconstructing a dormant conversation persists its compaction result (when one
-- ran) as a single checkpoint event, so a later restart replays that checkpoint instead of
-- re-deriving (and potentially re-compacting) the same full history again. 'compaction' is
-- never produced by `runAgentTurn`'s pi-agent-core message loop -- only by the reconstruction
-- path itself -- so it is additive to the kind check, not a change to any existing row.
ALTER TABLE agent_run_events DROP CONSTRAINT agent_run_events_kind_check;
ALTER TABLE agent_run_events ADD CONSTRAINT agent_run_events_kind_check
  CHECK (kind IN ('turn_start', 'message', 'tool_use', 'tool_result', 'turn_end', 'run_status', 'compaction'));
