-- Issue #1452, step 1 of 2: link an agent run to the Semp thread it belongs to. Additive only:
-- a nullable column, a tenant-composite foreign key and the one index every thread-scoped read of
-- runs uses. A run with no thread (an MCP run, every pre-existing run) keeps thread_id NULL.
--
-- ON DELETE SET NULL (thread_id) is the column-list form (Postgres 16): deleting a thread clears
-- only thread_id and never nulls the NOT NULL tenant_id. The key is NOT VALID so adding it takes
-- no initial foreign-key scan; 0097 validates it. The ADD COLUMN lock persists through this
-- file's index build until the migration transaction commits.
ALTER TABLE agent_runs ADD COLUMN thread_id uuid NULL;

ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_thread_id_fkey
  FOREIGN KEY (tenant_id, thread_id) REFERENCES semp_threads (tenant_id, id)
  ON DELETE SET NULL (thread_id) NOT VALID;

CREATE INDEX agent_runs_thread_wake_idx ON agent_runs (tenant_id, thread_id, wake_seq);
