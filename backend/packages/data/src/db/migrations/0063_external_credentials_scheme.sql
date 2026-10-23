-- Issue #1032: marks which scheme sealed each credential (docs/adr/2026-10-05-per-tenant-envelope-encryption.md).
--
-- Additive only: a constant default causes no table rewrite, and the previous release's inserts omit
-- the column and get 'master', which is exactly what they write. Every write still uses 'master';
-- the 'tenant' value is only read, so that a rollback from the release that starts writing it lands
-- on code that can open those rows.
ALTER TABLE external_credentials ADD COLUMN scheme text NOT NULL DEFAULT 'master';
ALTER TABLE external_credentials ADD CONSTRAINT external_credentials_scheme_check
  CHECK (scheme IN ('master', 'tenant'));
