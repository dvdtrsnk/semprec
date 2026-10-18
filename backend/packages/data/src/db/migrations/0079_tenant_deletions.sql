-- Issue #1055: the tombstone the tenant purge leaves behind once it has erased a deleted tenant.
--
-- Additive only: a new table the previous release never reads or writes, so a rollback keeps
-- working against this schema.
--
-- The row holds a tenant id and two timestamps: no email, no user id and no content. It is global
-- (no tenant_id default, no row-level security): the tenant it names no longer exists.
--
-- Grants: semprec_side reads; semprec_data (the purge job) only inserts. Nobody gets UPDATE or
-- DELETE, so the runtime roles can append a tombstone but never rewrite or drop one.
CREATE TABLE tenant_deletions (
  tenant_id uuid PRIMARY KEY,
  requested_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE tenant_deletions IS 'semprec:tenancy=global';
GRANT SELECT ON tenant_deletions TO semprec_side;
GRANT INSERT ON tenant_deletions TO semprec_data;
