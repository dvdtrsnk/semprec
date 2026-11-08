-- Issue #1066, step 2 of 2: validate the tenant-consistent foreign keys that 0083 added NOT VALID.
-- VALIDATE CONSTRAINT scans each child table under SHARE UPDATE EXCLUSIVE, which does not block
-- reads or writes on it, and fails the migration if any existing row references another tenant's
-- parent. Additive only: no constraint is dropped or relaxed.

ALTER TABLE properties VALIDATE CONSTRAINT properties_database_id_tenant_fkey;
ALTER TABLE rollup_dependencies VALIDATE CONSTRAINT rollup_dependencies_source_database_id_tenant_fkey;
ALTER TABLE item_search_index VALIDATE CONSTRAINT item_search_index_database_id_tenant_fkey;
ALTER TABLE views VALIDATE CONSTRAINT views_database_id_tenant_fkey;
ALTER TABLE relation_definitions VALIDATE CONSTRAINT relation_definitions_property_id_a_tenant_fkey;
ALTER TABLE relation_definitions VALIDATE CONSTRAINT relation_definitions_property_id_b_tenant_fkey;
ALTER TABLE rollup_dependencies VALIDATE CONSTRAINT rollup_dependencies_rollup_property_id_tenant_fkey;
ALTER TABLE item_relations VALIDATE CONSTRAINT item_relations_relation_definition_id_tenant_fkey;
ALTER TABLE rollup_dependencies VALIDATE CONSTRAINT rollup_dependencies_relation_definition_id_tenant_fkey;
ALTER TABLE view_items VALIDATE CONSTRAINT view_items_view_id_tenant_fkey;
ALTER TABLE doc_snapshots VALIDATE CONSTRAINT doc_snapshots_doc_id_tenant_fkey;
ALTER TABLE doc_updates VALIDATE CONSTRAINT doc_updates_doc_id_tenant_fkey;
ALTER TABLE doc_snapshot_history VALIDATE CONSTRAINT doc_snapshot_history_doc_id_tenant_fkey;
ALTER TABLE doc_history_updates VALIDATE CONSTRAINT doc_history_updates_doc_id_tenant_fkey;
ALTER TABLE agent_runs VALIDATE CONSTRAINT agent_runs_heartbeat_id_tenant_fkey;
ALTER TABLE heartbeat_occurrences VALIDATE CONSTRAINT heartbeat_occurrences_heartbeat_id_tenant_fkey;
ALTER TABLE agent_runs VALIDATE CONSTRAINT agent_runs_parent_run_id_tenant_fkey;
ALTER TABLE agent_run_events VALIDATE CONSTRAINT agent_run_events_agent_run_id_tenant_fkey;
ALTER TABLE approval_requests VALIDATE CONSTRAINT approval_requests_agent_run_id_tenant_fkey;
ALTER TABLE ai_gateway_calls VALIDATE CONSTRAINT ai_gateway_calls_agent_run_id_tenant_fkey;
ALTER TABLE agent_run_mcp_credentials VALIDATE CONSTRAINT agent_run_mcp_credentials_agent_run_id_tenant_fkey;
ALTER TABLE mail_message_meta VALIDATE CONSTRAINT mail_message_meta_thread_id_tenant_fkey;
ALTER TABLE mail_attachments VALIDATE CONSTRAINT mail_attachments_blob_id_tenant_fkey;
ALTER TABLE push_deliveries VALIDATE CONSTRAINT push_deliveries_notification_id_tenant_fkey;
ALTER TABLE project_mcp_grants VALIDATE CONSTRAINT project_mcp_grants_mcp_tool_registration_id_tenant_fkey;
ALTER TABLE notifications VALIDATE CONSTRAINT notifications_user_id_tenant_fkey;
ALTER TABLE agent_runs VALIDATE CONSTRAINT agent_runs_actor_user_id_tenant_fkey;
ALTER TABLE approval_requests VALIDATE CONSTRAINT approval_requests_decided_by_tenant_fkey;
ALTER TABLE project_agent_guidance VALIDATE CONSTRAINT project_agent_guidance_owner_user_id_tenant_fkey;
ALTER TABLE tenant_exports VALIDATE CONSTRAINT tenant_exports_requested_by_tenant_fkey;

-- items is partitioned, and Postgres 16 (production, deploy/docker-compose.yml) rejects a NOT VALID
-- foreign key on a partitioned table, while the embedded Postgres 18 of the test tier accepts one, so
-- CI would not catch it. This twin is therefore an ordinary constraint, validated as it is added:
-- that holds a SHARE ROW EXCLUSIVE lock on items (every partition) and on databases for the length of
-- the scan, blocking writes to both, but not reads, until it finishes.
ALTER TABLE items ADD CONSTRAINT items_database_id_tenant_fkey
  FOREIGN KEY (tenant_id, database_id) REFERENCES databases (tenant_id, id);
