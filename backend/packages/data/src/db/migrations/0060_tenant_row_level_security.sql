-- Issue #973: row-level security with the transitional restrictive tenant policy on the 43 tables
-- classified `semprec:tenancy=tenant` (0058), keyed on the tenant_id column 0059 added.
--
-- Per table: RLS is enabled, a RESTRICTIVE policy `tenant_isolation` confines every command to rows
-- whose tenant_id equals app_tenant_default(), and a PERMISSIVE policy `tenant_rows` (USING true)
-- exists because RLS denies everything when no permissive policy exists. The isolation policy is
-- restrictive, so no permissive policy added later can widen it. The `(SELECT ...)` wrapper makes
-- Postgres evaluate the function once per statement (an init plan) instead of once per row.
-- The table list is explicit on purpose: a table is brought under RLS by naming it here, never by
-- reading catalog comments.
--
-- No FORCE ROW LEVEL SECURITY, deliberately and permanently: every table is owned by the migrating
-- superuser, and owners and superusers bypass RLS. That keeps migrations, pg_dump (run as the
-- compose superuser) and the restore test unaffected, and confines the policies to the runtime
-- roles semprec_data and semprec_side, which own nothing and hold no BYPASSRLS.
--
-- The previous release is unaffected. While exactly one tenant exists and no `app.tenant_id` is
-- set, app_tenant_default() resolves to the sole tenant, which is the tenant of every row, so its
-- scope-less reads, writes and the SECURITY INVOKER relation-cardinality trigger see exactly what
-- they saw before. Once a second tenant exists without a scope, the default is NULL and the
-- policies match nothing (fail closed).
--
-- The strict switch later redefines app_tenant_default() as `SELECT app_current_tenant()`, which
-- tightens every policy below at once without touching them.
--
-- Partitions of `items` are not covered by the parent's policy when addressed directly; they are
-- created by the migrating role (or the SECURITY DEFINER partition function) and granted to no
-- runtime role, which tenancyCatalog.test.ts pins.

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
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tenant_table);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I AS RESTRICTIVE FOR ALL
         USING (tenant_id = (SELECT app_tenant_default()))
         WITH CHECK (tenant_id = (SELECT app_tenant_default()))',
      tenant_table
    );
    EXECUTE format(
      'CREATE POLICY tenant_rows ON %I AS PERMISSIVE FOR ALL USING (true) WITH CHECK (true)',
      tenant_table
    );
  END LOOP;
END
$$;
