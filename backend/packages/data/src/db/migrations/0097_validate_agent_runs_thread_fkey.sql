-- Issue #1452, step 2 of 2: validate the foreign key that 0096 added NOT VALID. VALIDATE
-- CONSTRAINT scans agent_runs under SHARE UPDATE EXCLUSIVE, which does not block reads or writes.
ALTER TABLE agent_runs VALIDATE CONSTRAINT agent_runs_thread_id_fkey;
