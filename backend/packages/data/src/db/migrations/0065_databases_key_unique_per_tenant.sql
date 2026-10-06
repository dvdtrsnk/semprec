-- Issue #1001: key databases per tenant. Every tenant gets its own copy of the system databases with
-- the same canonical keys, so databases_key_unique must be unique per (tenant_id, key), not globally.
--
-- Swaps the legacy UNIQUE (key) for the tenant-leading index #974 added (databases_tenant_key_uq),
-- under the legacy constraint's name. ADD CONSTRAINT ... USING INDEX renames the index to
-- databases_key_unique, so exactly one unique index covers (tenant_id, key) afterwards. The runner
-- wraps the file in one transaction, so there is no instant without a key uniqueness.
--
-- Rollback-safe: the previous release only depends on the constraint name (createDatabase maps a
-- 23505 on databases_key_unique to ConflictError), which is unchanged, and no ON CONFLICT uses
-- (key) as an arbiter. The new key is a superset of the old one's columns, so it cannot fail on
-- existing data.
ALTER TABLE databases DROP CONSTRAINT databases_key_unique;
ALTER TABLE databases ADD CONSTRAINT databases_key_unique UNIQUE USING INDEX databases_tenant_key_uq;
