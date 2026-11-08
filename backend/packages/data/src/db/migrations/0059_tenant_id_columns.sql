-- Issue #972: a defaulted tenant_id on every tenant-owned table (the 43 tables classified
-- `semprec:tenancy=tenant` by 0058), the column row-level security keys on.
--
-- No rewrite: `ADD COLUMN ... DEFAULT app_tenant_default()` has a STABLE (non-volatile) default,
-- which Postgres evaluates once and stores as the column's "missing value". No scope is set during
-- a migration and exactly one tenant exists, so that value is tenant zero and every existing row
-- reads as tenant zero without the table being rewritten. The partitioned `items` propagates the
-- column to every `items_p_*` partition, and to partitions create_items_partition makes later.
--
-- Backward compatible: the previous release never names the column, so its inserts take the
-- default (tenant zero) and its reads are unaffected. Once a second tenant exists, a scope-less
-- insert fails on NOT NULL (SQLSTATE 23502); that fail-closed behaviour is intended.
--
-- No index on tenant_id here; the tenant-leading unique keys come with a later issue.

DO $$
DECLARE
  tenant_table text;
  tenant_tables text[] := ARRAY[
    'databases',
    'properties',
    'relation_definitions',
    'items',
    'item_relations',
    'views',
    'view_items',
    'idempotency_keys',
    'rollup_dependencies',
    'task_recurrence',
    'item_automation',
    'item_search_index',
    'blobs',
    'docs',
    'doc_snapshots',
    'doc_updates',
    'doc_snapshot_history',
    'doc_history_updates',
    'project_heartbeats',
    'heartbeat_occurrences',
    'agent_runs',
    'agent_run_events',
    'approval_requests',
    'mcp_tool_registrations',
    'project_mcp_grants',
    'project_agent_guidance',
    'agent_guidance_drift_findings',
    'manifest_drift_findings',
    'notifications',
    'push_deliveries',
    'mail_account_sync_state',
    'mail_folder_sync_state',
    'mail_threads',
    'mail_message_meta',
    'mail_attachments',
    'mail_message_flag_sync_state',
    'person_email_index',
    'external_credentials',
    'credential_access_log',
    'ai_gateway_calls',
    'module_migrations',
    'module_migration_progress',
    'resource_grants'
  ];
BEGIN
  FOREACH tenant_table IN ARRAY tenant_tables LOOP
    EXECUTE format(
      'ALTER TABLE %I ADD COLUMN tenant_id uuid NOT NULL DEFAULT app_tenant_default() REFERENCES tenants(id)',
      tenant_table
    );
  END LOOP;
END
$$;
