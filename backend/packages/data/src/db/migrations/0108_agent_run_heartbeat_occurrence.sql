-- Issue #1458, step 1 of 2: link an agent run to the scheduled heartbeat occurrence it was started
-- for. Additive only: a nullable column, a parent key, an index and a NOT VALID foreign key, so
-- existing runs are unchanged (0109 validates the key). Default NO ACTION: tenant purge orders
-- tables from the foreign-key catalog.

-- Parent key for the composite reference.
CREATE UNIQUE INDEX heartbeat_occurrences_tenant_id_id_uq ON heartbeat_occurrences (tenant_id, id);

ALTER TABLE agent_runs ADD COLUMN heartbeat_occurrence_id uuid;

ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_heartbeat_occurrence_id_fkey
  FOREIGN KEY (tenant_id, heartbeat_occurrence_id) REFERENCES heartbeat_occurrences (tenant_id, id) NOT VALID;

CREATE INDEX agent_runs_occurrence_idx ON agent_runs (tenant_id, heartbeat_occurrence_id, attempt);
