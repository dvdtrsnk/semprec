-- Issue #1448, step 2 of 2: validate the foreign key that 0105 added NOT VALID. VALIDATE
-- CONSTRAINT scans agent_runs under SHARE UPDATE EXCLUSIVE, which does not block reads or writes.
ALTER TABLE agent_runs VALIDATE CONSTRAINT agent_runs_retry_of_run_id_fkey;
