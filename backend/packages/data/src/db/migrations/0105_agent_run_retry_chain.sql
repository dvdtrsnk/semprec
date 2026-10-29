-- Issue #1448, step 1 of 2: chain agent run retries. A retry points to the run it retries
-- (retry_of_run_id) and carries its attempt number. Additive only: a nullable column, a column
-- with a default, a tenant-composite foreign key and a unique index.
--
-- The chain is linear: the unique index lets a run be retried at most once, so two concurrent
-- retries of one run create one successor. Nulls stay distinct, so runs that are not retries are
-- unaffected. The key is tenant-composite, so a link cannot cross
-- tenants. It is named *_fkey, not *_tenant_fkey, because the tenancy catalog pairs every
-- *_tenant_fkey with a single-column twin and this key has none. It is NOT VALID so adding it does not scan agent_runs; 0106
-- validates it. Existing rows read as attempt 1 through the default.
--
-- No INSERT ... ON CONFLICT on agent_runs existed before this migration, so no existing
-- statement's arbiter is affected by the new unique index.
ALTER TABLE agent_runs ADD COLUMN retry_of_run_id uuid NULL;
ALTER TABLE agent_runs ADD COLUMN attempt integer NOT NULL DEFAULT 1 CHECK (attempt >= 1);

ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_retry_of_run_id_fkey
  FOREIGN KEY (tenant_id, retry_of_run_id) REFERENCES agent_runs (tenant_id, id) NOT VALID;

CREATE UNIQUE INDEX agent_runs_tenant_retry_of_run_id_uq ON agent_runs (tenant_id, retry_of_run_id);
