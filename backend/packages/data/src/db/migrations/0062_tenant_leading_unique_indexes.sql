-- Issue #974: tenant-leading unique indexes beside every global uniqueness on a tenant table
-- (the expand step). Unique checks ignore row-level security, so a global key lets a second tenant
-- probe for another tenant's values; every key on a tenant table therefore leads with tenant_id.
--
-- Only CREATE UNIQUE INDEX statements: each new index is a superset of its legacy key's columns, so
-- it cannot fail on existing data and it never changes ON CONFLICT arbiter inference (Postgres
-- infers only indexes whose column set equals the conflict target). The legacy global keys stay in
-- place for the previous release and today's code; #1065 (the contract step) drops them. Not
-- CONCURRENTLY: a migration file runs in one transaction, and these tables are small.

-- Tenant-leading keys beside the legacy ones.
CREATE UNIQUE INDEX databases_tenant_key_uq ON databases (tenant_id, key);
-- databases_tenant_system_module_uq is the one index with no legacy global counterpart: it is a new
-- rule (one system database per module per tenant), named in issue #974's Task. It formalizes what
-- getDatabaseByModuleId (databasesStore.ts) already assumes and what the seeds already produce, so
-- it cannot fail on existing data.
CREATE UNIQUE INDEX databases_tenant_system_module_uq ON databases (tenant_id, owner_module_id) WHERE system;
CREATE UNIQUE INDEX idempotency_keys_tenant_key_uq ON idempotency_keys (tenant_id, key);
CREATE UNIQUE INDEX person_email_index_tenant_email_uq ON person_email_index (tenant_id, email);
CREATE UNIQUE INDEX mail_message_meta_tenant_provider_msg_uq ON mail_message_meta (tenant_id, provider_message_id)
  WHERE provider_message_id IS NOT NULL;
CREATE UNIQUE INDEX blobs_tenant_content_hash_uq ON blobs (tenant_id, content_hash) WHERE content_hash IS NOT NULL;
CREATE UNIQUE INDEX notifications_tenant_dedupe_idx
  ON notifications (tenant_id, user_id, source_table, source_id, kind, transition_instance);
CREATE UNIQUE INDEX manifest_drift_findings_tenant_active_idx ON manifest_drift_findings (tenant_id, kind, dedupe_key)
  WHERE resolved_at IS NULL AND dedupe_key IS NOT NULL;
CREATE UNIQUE INDEX module_migrations_tenant_uq
  ON module_migrations (tenant_id, module_id, database_key, from_version, to_version);
CREATE UNIQUE INDEX module_migration_progress_tenant_uq
  ON module_migration_progress (tenant_id, module_id, database_key, from_version, to_version);
CREATE UNIQUE INDEX docs_tenant_item_id_uq ON docs (tenant_id, item_id);
CREATE UNIQUE INDEX resource_grants_tenant_uq
  ON resource_grants (tenant_id, resource_type, resource_id, grantee_user_id);

-- Parent keys for the composite foreign keys (tenant_id, x_id) -> parent (tenant_id, id).
CREATE UNIQUE INDEX databases_tenant_id_id_uq ON databases (tenant_id, id);
CREATE UNIQUE INDEX properties_tenant_id_id_uq ON properties (tenant_id, id);
CREATE UNIQUE INDEX relation_definitions_tenant_id_id_uq ON relation_definitions (tenant_id, id);
CREATE UNIQUE INDEX agent_runs_tenant_id_id_uq ON agent_runs (tenant_id, id);
CREATE UNIQUE INDEX project_heartbeats_tenant_id_id_uq ON project_heartbeats (tenant_id, id);
CREATE UNIQUE INDEX views_tenant_id_id_uq ON views (tenant_id, id);
CREATE UNIQUE INDEX docs_tenant_id_id_uq ON docs (tenant_id, id);
CREATE UNIQUE INDEX notifications_tenant_id_id_uq ON notifications (tenant_id, id);
CREATE UNIQUE INDEX mcp_tool_registrations_tenant_id_id_uq ON mcp_tool_registrations (tenant_id, id);
CREATE UNIQUE INDEX mail_threads_tenant_id_id_uq ON mail_threads (tenant_id, id);
CREATE UNIQUE INDEX blobs_tenant_id_id_uq ON blobs (tenant_id, id);
