-- expand-contract-exemption: contract step — every reader and arbiter uses the tenant-leading keys since the checkpoint release; resource_grants was never used.
--
-- Issue #1065, the contract step of #974. Unique checks ignore row-level security, so a global
-- key on a tenant table lets one tenant collide with, or probe for, another tenant's row. The
-- checkpoint release (#1058) switched every reader and ON CONFLICT arbiter to the tenant-leading
-- twins from 0064, so a one-release rollback lands on code that no longer uses these keys.
--
-- Primary keys: each twin is a plain unique index over NOT NULL columns, and USING INDEX renames
-- it to <table>_pkey. The blob content-hash key is not dropped here: migration 0080 dropped it.

ALTER TABLE idempotency_keys
  DROP CONSTRAINT idempotency_keys_pkey,
  ADD CONSTRAINT idempotency_keys_pkey PRIMARY KEY USING INDEX idempotency_keys_tenant_key_uq;
ALTER TABLE person_email_index
  DROP CONSTRAINT person_email_index_pkey,
  ADD CONSTRAINT person_email_index_pkey PRIMARY KEY USING INDEX person_email_index_tenant_email_uq;
ALTER TABLE module_migrations
  DROP CONSTRAINT module_migrations_pkey,
  ADD CONSTRAINT module_migrations_pkey PRIMARY KEY USING INDEX module_migrations_tenant_uq;
ALTER TABLE module_migration_progress
  DROP CONSTRAINT module_migration_progress_pkey,
  ADD CONSTRAINT module_migration_progress_pkey PRIMARY KEY USING INDEX module_migration_progress_tenant_uq;

-- No IF EXISTS: a wrong name fails the migration loudly instead of leaving a global key behind.
DROP INDEX mail_message_meta_provider_msg_uq;
DROP INDEX notifications_dedupe_idx;
DROP INDEX manifest_drift_findings_active_idx;
DROP INDEX docs_item_id_idx;

-- The dormant sharing ACL: no code reads or writes it, and sharing between users is excluded.
DROP TABLE resource_grants;
