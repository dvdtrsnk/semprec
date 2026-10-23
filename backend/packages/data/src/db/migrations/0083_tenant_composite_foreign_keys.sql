-- Issue #1066, step 1 of 2: a tenant-consistent twin beside every single-column foreign key
-- between tenant-owned rows. Foreign-key checks ignore row-level security, so a single-column key
-- such as properties.database_id -> databases(id) is satisfied by another tenant's database; a
-- write path that forgets an existence check could link a row to a foreign parent, and 23503
-- versus success would tell one tenant whether another tenant's id exists. Each twin
-- (tenant_id, <column>) -> <parent>(tenant_id, id) refuses that, as the tenant-isolation ADR
-- requires (docs/adr/2026-10-03-tenant-isolation-through-row-level-security.md).
--
-- Additive only: new constraints and one new index; every existing single-column key stays. The
-- twins are NOT VALID, so adding them takes a brief SHARE ROW EXCLUSIVE lock without scanning the
-- child tables; 0084 validates them under the lighter SHARE UPDATE EXCLUSIVE lock. Each twin
-- repeats its single-column key's ON DELETE action, so deleting a parent behaves as before.
--
-- items.database_id is not here: Postgres 16 (production) rejects a NOT VALID foreign key on a
-- partitioned table, so 0084 adds that one as an ordinary, immediately validated constraint.

-- users is global, so #974 gave it no (tenant_id, id) key, and users_tenant_id_key on tenant_id
-- alone cannot serve a two-column reference. users is small, so no CONCURRENTLY (a migration file
-- runs in one transaction).
CREATE UNIQUE INDEX users_tenant_id_id_uq ON users (tenant_id, id);

-- databases(id)
ALTER TABLE properties ADD CONSTRAINT properties_database_id_tenant_fkey
  FOREIGN KEY (tenant_id, database_id) REFERENCES databases (tenant_id, id) ON DELETE CASCADE NOT VALID;
ALTER TABLE rollup_dependencies ADD CONSTRAINT rollup_dependencies_source_database_id_tenant_fkey
  FOREIGN KEY (tenant_id, source_database_id) REFERENCES databases (tenant_id, id) NOT VALID;
ALTER TABLE item_search_index ADD CONSTRAINT item_search_index_database_id_tenant_fkey
  FOREIGN KEY (tenant_id, database_id) REFERENCES databases (tenant_id, id) NOT VALID;
ALTER TABLE views ADD CONSTRAINT views_database_id_tenant_fkey
  FOREIGN KEY (tenant_id, database_id) REFERENCES databases (tenant_id, id) ON DELETE CASCADE NOT VALID;

-- properties(id)
ALTER TABLE relation_definitions ADD CONSTRAINT relation_definitions_property_id_a_tenant_fkey
  FOREIGN KEY (tenant_id, property_id_a) REFERENCES properties (tenant_id, id) ON DELETE CASCADE NOT VALID;
ALTER TABLE relation_definitions ADD CONSTRAINT relation_definitions_property_id_b_tenant_fkey
  FOREIGN KEY (tenant_id, property_id_b) REFERENCES properties (tenant_id, id) ON DELETE CASCADE NOT VALID;
ALTER TABLE rollup_dependencies ADD CONSTRAINT rollup_dependencies_rollup_property_id_tenant_fkey
  FOREIGN KEY (tenant_id, rollup_property_id) REFERENCES properties (tenant_id, id) ON DELETE CASCADE NOT VALID;

-- relation_definitions(id)
ALTER TABLE item_relations ADD CONSTRAINT item_relations_relation_definition_id_tenant_fkey
  FOREIGN KEY (tenant_id, relation_definition_id) REFERENCES relation_definitions (tenant_id, id)
  ON DELETE CASCADE NOT VALID;
ALTER TABLE rollup_dependencies ADD CONSTRAINT rollup_dependencies_relation_definition_id_tenant_fkey
  FOREIGN KEY (tenant_id, relation_definition_id) REFERENCES relation_definitions (tenant_id, id)
  ON DELETE CASCADE NOT VALID;

-- views(id)
ALTER TABLE view_items ADD CONSTRAINT view_items_view_id_tenant_fkey
  FOREIGN KEY (tenant_id, view_id) REFERENCES views (tenant_id, id) ON DELETE CASCADE NOT VALID;

-- docs(id)
ALTER TABLE doc_snapshots ADD CONSTRAINT doc_snapshots_doc_id_tenant_fkey
  FOREIGN KEY (tenant_id, doc_id) REFERENCES docs (tenant_id, id) ON DELETE CASCADE NOT VALID;
ALTER TABLE doc_updates ADD CONSTRAINT doc_updates_doc_id_tenant_fkey
  FOREIGN KEY (tenant_id, doc_id) REFERENCES docs (tenant_id, id) ON DELETE CASCADE NOT VALID;
ALTER TABLE doc_snapshot_history ADD CONSTRAINT doc_snapshot_history_doc_id_tenant_fkey
  FOREIGN KEY (tenant_id, doc_id) REFERENCES docs (tenant_id, id) ON DELETE CASCADE NOT VALID;
ALTER TABLE doc_history_updates ADD CONSTRAINT doc_history_updates_doc_id_tenant_fkey
  FOREIGN KEY (tenant_id, doc_id) REFERENCES docs (tenant_id, id) ON DELETE CASCADE NOT VALID;

-- project_heartbeats(id)
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_heartbeat_id_tenant_fkey
  FOREIGN KEY (tenant_id, heartbeat_id) REFERENCES project_heartbeats (tenant_id, id) NOT VALID;
ALTER TABLE heartbeat_occurrences ADD CONSTRAINT heartbeat_occurrences_heartbeat_id_tenant_fkey
  FOREIGN KEY (tenant_id, heartbeat_id) REFERENCES project_heartbeats (tenant_id, id) ON DELETE CASCADE NOT VALID;

-- agent_runs(id); agent_run_mcp_credentials is global but carries tenant_id since #994.
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_parent_run_id_tenant_fkey
  FOREIGN KEY (tenant_id, parent_run_id) REFERENCES agent_runs (tenant_id, id) NOT VALID;
ALTER TABLE agent_run_events ADD CONSTRAINT agent_run_events_agent_run_id_tenant_fkey
  FOREIGN KEY (tenant_id, agent_run_id) REFERENCES agent_runs (tenant_id, id) NOT VALID;
ALTER TABLE approval_requests ADD CONSTRAINT approval_requests_agent_run_id_tenant_fkey
  FOREIGN KEY (tenant_id, agent_run_id) REFERENCES agent_runs (tenant_id, id) NOT VALID;
ALTER TABLE ai_gateway_calls ADD CONSTRAINT ai_gateway_calls_agent_run_id_tenant_fkey
  FOREIGN KEY (tenant_id, agent_run_id) REFERENCES agent_runs (tenant_id, id) NOT VALID;
ALTER TABLE agent_run_mcp_credentials ADD CONSTRAINT agent_run_mcp_credentials_agent_run_id_tenant_fkey
  FOREIGN KEY (tenant_id, agent_run_id) REFERENCES agent_runs (tenant_id, id) NOT VALID;

-- mail_threads(id), blobs(id), notifications(id), mcp_tool_registrations(id)
ALTER TABLE mail_message_meta ADD CONSTRAINT mail_message_meta_thread_id_tenant_fkey
  FOREIGN KEY (tenant_id, thread_id) REFERENCES mail_threads (tenant_id, id) NOT VALID;
ALTER TABLE mail_attachments ADD CONSTRAINT mail_attachments_blob_id_tenant_fkey
  FOREIGN KEY (tenant_id, blob_id) REFERENCES blobs (tenant_id, id) NOT VALID;
ALTER TABLE push_deliveries ADD CONSTRAINT push_deliveries_notification_id_tenant_fkey
  FOREIGN KEY (tenant_id, notification_id) REFERENCES notifications (tenant_id, id) NOT VALID;
ALTER TABLE project_mcp_grants ADD CONSTRAINT project_mcp_grants_mcp_tool_registration_id_tenant_fkey
  FOREIGN KEY (tenant_id, mcp_tool_registration_id) REFERENCES mcp_tool_registrations (tenant_id, id) NOT VALID;

-- users(id): users is global but carries tenant_id, so a tenant row may only reference its own
-- tenant's user.
ALTER TABLE notifications ADD CONSTRAINT notifications_user_id_tenant_fkey
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id) NOT VALID;
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_actor_user_id_tenant_fkey
  FOREIGN KEY (tenant_id, actor_user_id) REFERENCES users (tenant_id, id) NOT VALID;
ALTER TABLE approval_requests ADD CONSTRAINT approval_requests_decided_by_tenant_fkey
  FOREIGN KEY (tenant_id, decided_by) REFERENCES users (tenant_id, id) NOT VALID;
ALTER TABLE project_agent_guidance ADD CONSTRAINT project_agent_guidance_owner_user_id_tenant_fkey
  FOREIGN KEY (tenant_id, owner_user_id) REFERENCES users (tenant_id, id) NOT VALID;
ALTER TABLE tenant_exports ADD CONSTRAINT tenant_exports_requested_by_tenant_fkey
  FOREIGN KEY (tenant_id, requested_by) REFERENCES users (tenant_id, id) NOT VALID;
