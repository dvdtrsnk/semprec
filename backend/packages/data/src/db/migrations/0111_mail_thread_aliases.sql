-- Issue #1493: a merged-away mail thread id stays resolvable. `reassignThread` records
-- `from_thread_id -> to_thread_id` before it deletes the old `mail_threads` row, and rewrites every
-- alias that pointed at the old thread, so the translation is always one step.
--
-- Additive and rollback-safe: a new table the previous release never reads or writes. Merges that
-- happened before this migration are not backfilled; those ids are already lost.
--
-- `from_thread_id` has no foreign key: the row it names was deleted by the merge. The composite foreign
-- key on `to_thread_id` removes the alias when its target thread is deleted. It is named *_fkey, not
-- *_tenant_fkey, because the tenancy catalog pairs every *_tenant_fkey with a single-column twin and this
-- key has none (the same reason as agent_runs_retry_of_run_id_fkey in 0105).
CREATE TABLE mail_thread_aliases (
  tenant_id uuid NOT NULL DEFAULT app_tenant_default() REFERENCES tenants(id),
  from_thread_id uuid NOT NULL,
  to_thread_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, from_thread_id),
  CONSTRAINT mail_thread_aliases_not_self CHECK (from_thread_id <> to_thread_id),
  CONSTRAINT mail_thread_aliases_to_thread_fkey
    FOREIGN KEY (tenant_id, to_thread_id) REFERENCES mail_threads (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX mail_thread_aliases_to_thread_idx ON mail_thread_aliases (tenant_id, to_thread_id);
COMMENT ON TABLE mail_thread_aliases IS 'semprec:tenancy=tenant';
ALTER TABLE mail_thread_aliases ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON mail_thread_aliases AS RESTRICTIVE FOR ALL
  USING (tenant_id = (SELECT app_tenant_default())) WITH CHECK (tenant_id = (SELECT app_tenant_default()));
CREATE POLICY tenant_rows ON mail_thread_aliases AS PERMISSIVE FOR ALL USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON mail_thread_aliases TO semprec_side;
