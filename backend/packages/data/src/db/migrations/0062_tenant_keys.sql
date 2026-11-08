-- Issue #1031: one wrapped data key per tenant (docs/adr/2026-10-05-per-tenant-envelope-encryption.md).
--
-- Additive only (a new table nothing reads yet), so the previous release keeps working against this
-- schema after a rollback.
--
-- wrapped_key/wrap_nonce hold the tenant's data key sealed under the master key version named by
-- master_key_version; the associated data binds it to tenant_id, so a row copied to another tenant
-- does not unwrap.
--
-- There is no UPDATE grant: rewriting a key row would orphan every credential sealed under the old
-- key. DELETE is the crypto-shred that account deletion uses. There is no ON DELETE CASCADE from
-- tenants for the same reason: the key is deleted deliberately, never as a side effect.
CREATE TABLE tenant_keys (
  tenant_id uuid NOT NULL DEFAULT app_tenant_default() REFERENCES tenants(id) PRIMARY KEY,
  wrapped_key bytea NOT NULL,
  wrap_nonce bytea NOT NULL,
  master_key_version smallint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE tenant_keys IS 'semprec:tenancy=tenant';
ALTER TABLE tenant_keys ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_keys AS RESTRICTIVE FOR ALL
  USING (tenant_id = (SELECT app_tenant_default()))
  WITH CHECK (tenant_id = (SELECT app_tenant_default()));
CREATE POLICY tenant_rows ON tenant_keys AS PERMISSIVE FOR ALL USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, DELETE ON tenant_keys TO semprec_side;
