-- Issue #1037: append-only audit log of admin actions.
--
-- Additive only (a new table that no previous-release code touches), so a rollback keeps working
-- against this schema.
--
-- Deliberately no foreign keys: audit rows outlive the users and tenants they name. The table is
-- global (admin plane, no tenant content): ids and scalars only, no tenant_id column and no
-- row-level security.
--
-- Grants: semprec_side gets SELECT only; semprec_data gets INSERT. Nobody gets UPDATE or DELETE, so
-- the runtime roles can append but never rewrite history. The bigserial sequence privilege comes from
-- the default privileges of 0047_side_role_default_sequence_privileges.sql.
CREATE TABLE IF NOT EXISTS admin_audit_log (
  id bigserial PRIMARY KEY,
  actor_user_id uuid NOT NULL,
  action text NOT NULL,
  target_tenant_id uuid,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS admin_audit_log_created_at_idx ON admin_audit_log (created_at);
COMMENT ON TABLE admin_audit_log IS 'semprec:tenancy=global';
GRANT SELECT ON admin_audit_log TO semprec_side;
GRANT INSERT ON admin_audit_log TO semprec_data;
