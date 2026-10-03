-- Issue #971: classify every existing table for tenant isolation
-- (docs/adr/2026-10-03-tenant-isolation-through-row-level-security.md). `tenants` was classified by 0056.
--
-- Comments only, so the previous release has nothing to notice after a rollback.

-- Identity plane, scoped to the user in code rather than by tenant.
COMMENT ON TABLE users IS 'semprec:tenancy=global';
COMMENT ON TABLE sessions IS 'semprec:tenancy=global';
COMMENT ON TABLE login_attempts IS 'semprec:tenancy=global';
COMMENT ON TABLE password_reset_tokens IS 'semprec:tenancy=global';
COMMENT ON TABLE push_subscriptions IS 'semprec:tenancy=global';

-- The run token is resolved before the tenant is known.
COMMENT ON TABLE agent_run_mcp_credentials IS 'semprec:tenancy=global';

-- Operator process and check keys, not tenant data.
COMMENT ON TABLE process_heartbeats IS 'semprec:tenancy=global';
COMMENT ON TABLE observability_checks IS 'semprec:tenancy=global';

-- Created by the migration runner before any file runs.
COMMENT ON TABLE schema_migrations IS 'semprec:tenancy=global';

-- Core data model.
COMMENT ON TABLE databases IS 'semprec:tenancy=tenant';
COMMENT ON TABLE properties IS 'semprec:tenancy=tenant';
COMMENT ON TABLE relation_definitions IS 'semprec:tenancy=tenant';
COMMENT ON TABLE items IS 'semprec:tenancy=tenant';
COMMENT ON TABLE item_relations IS 'semprec:tenancy=tenant';
COMMENT ON TABLE views IS 'semprec:tenancy=tenant';
COMMENT ON TABLE view_items IS 'semprec:tenancy=tenant';
COMMENT ON TABLE idempotency_keys IS 'semprec:tenancy=tenant';
COMMENT ON TABLE rollup_dependencies IS 'semprec:tenancy=tenant';
COMMENT ON TABLE task_recurrence IS 'semprec:tenancy=tenant';
COMMENT ON TABLE item_automation IS 'semprec:tenancy=tenant';
COMMENT ON TABLE item_search_index IS 'semprec:tenancy=tenant';
COMMENT ON TABLE blobs IS 'semprec:tenancy=tenant';

-- Collaborative documents and their history.
COMMENT ON TABLE docs IS 'semprec:tenancy=tenant';
COMMENT ON TABLE doc_snapshots IS 'semprec:tenancy=tenant';
COMMENT ON TABLE doc_updates IS 'semprec:tenancy=tenant';
COMMENT ON TABLE doc_snapshot_history IS 'semprec:tenancy=tenant';
COMMENT ON TABLE doc_history_updates IS 'semprec:tenancy=tenant';

-- Heartbeats, agent runs, approvals, MCP and guidance.
COMMENT ON TABLE project_heartbeats IS 'semprec:tenancy=tenant';
COMMENT ON TABLE heartbeat_occurrences IS 'semprec:tenancy=tenant';
COMMENT ON TABLE agent_runs IS 'semprec:tenancy=tenant';
COMMENT ON TABLE agent_run_events IS 'semprec:tenancy=tenant';
COMMENT ON TABLE approval_requests IS 'semprec:tenancy=tenant';
COMMENT ON TABLE mcp_tool_registrations IS 'semprec:tenancy=tenant';
COMMENT ON TABLE project_mcp_grants IS 'semprec:tenancy=tenant';
COMMENT ON TABLE project_agent_guidance IS 'semprec:tenancy=tenant';
COMMENT ON TABLE agent_guidance_drift_findings IS 'semprec:tenancy=tenant';
COMMENT ON TABLE manifest_drift_findings IS 'semprec:tenancy=tenant';

-- Notifications and push deliveries.
COMMENT ON TABLE notifications IS 'semprec:tenancy=tenant';
COMMENT ON TABLE push_deliveries IS 'semprec:tenancy=tenant';

-- Mail.
COMMENT ON TABLE mail_account_sync_state IS 'semprec:tenancy=tenant';
COMMENT ON TABLE mail_folder_sync_state IS 'semprec:tenancy=tenant';
COMMENT ON TABLE mail_threads IS 'semprec:tenancy=tenant';
COMMENT ON TABLE mail_message_meta IS 'semprec:tenancy=tenant';
COMMENT ON TABLE mail_attachments IS 'semprec:tenancy=tenant';
COMMENT ON TABLE mail_message_flag_sync_state IS 'semprec:tenancy=tenant';
COMMENT ON TABLE person_email_index IS 'semprec:tenancy=tenant';

-- Credentials, AI gateway ledger and module migrations.
COMMENT ON TABLE external_credentials IS 'semprec:tenancy=tenant';
COMMENT ON TABLE credential_access_log IS 'semprec:tenancy=tenant';
COMMENT ON TABLE ai_gateway_calls IS 'semprec:tenancy=tenant';
COMMENT ON TABLE module_migrations IS 'semprec:tenancy=tenant';
COMMENT ON TABLE module_migration_progress IS 'semprec:tenancy=tenant';

-- The dormant sharing ACL; tenant until its contract-step drop.
COMMENT ON TABLE resource_grants IS 'semprec:tenancy=tenant';
