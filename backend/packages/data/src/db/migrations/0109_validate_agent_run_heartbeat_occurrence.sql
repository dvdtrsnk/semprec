-- Issue #1458, step 2 of 2: validate the foreign key that 0108 added NOT VALID. VALIDATE
-- CONSTRAINT scans agent_runs under SHARE UPDATE EXCLUSIVE, which does not block reads or writes.
ALTER TABLE agent_runs VALIDATE CONSTRAINT agent_runs_heartbeat_occurrence_id_fkey;
