-- Findings R2-DB-2 and R2-DB-3 of gh-1086 (external review): the side role could mint an actor and
-- read credentials it does not need.
--
-- R2-DB-2: docs/operations/database-roles.md and 0057_identity_tables_api_role_only.sql state that a
-- compromised side-role process (semprec-ai-gateway, semprec-restore-test) must not be able to mint a
-- session. But semprec_side held full DML on agent_runs and approval_requests (0040) and on
-- agent_run_mcp_credentials (0055). As semprec_side, inside another tenant's scope, a process could
-- insert a running agent_runs row for that tenant's user and an agent_run_mcp_credentials row holding
-- the SHA-256 of a token it chose, and the API's own lookups then resolved that token to the tenant
-- and the actor: an actor whose writes semprec_data executes, which bypasses the tier "the side role
-- cannot write items".
--
-- R2-DB-3 (the side-role part): the global tables have no row-level security, and semprec_side could
-- read sessions, password_reset_tokens, login_attempts, invites, admin_audit_log, tenant_deletions and
-- agent_run_mcp_credentials of every tenant, and held full DML on push_subscriptions (0040), so it
-- could register an endpoint for any user's push notifications.
--
-- No side-role process writes agent_runs or approval_requests, or reads or writes
-- agent_run_mcp_credentials, push_subscriptions, sessions, password_reset_tokens, login_attempts,
-- invites, admin_audit_log or tenant_deletions. The AI gateway reads agent_runs (it checks that the
-- run it attributes a call to exists), so semprec_side keeps SELECT on agent_runs and
-- approval_requests. It keeps SELECT on users, tenants and tenant_ai_budgets as well.
--
-- semprec_data reached agent_runs, agent_run_mcp_credentials, approval_requests and push_subscriptions
-- only through its membership in semprec_side, and SELECT on invites, admin_audit_log and
-- tenant_deletions only through it too (0074, 0077 and 0079 grant semprec_data the writes directly),
-- so each revoke below is preceded by the direct grant, as 0057 did for the identity tables.
--
-- Backward compatible: the previous release's side-role processes use none of the revoked privileges,
-- and its semprec_data processes receive the privileges directly, so a rollback of the release finds
-- the grants it needs. No table, column, policy, sequence or function changes.

GRANT SELECT, INSERT, UPDATE, DELETE ON agent_runs, agent_run_mcp_credentials, approval_requests, push_subscriptions TO semprec_data;
GRANT SELECT ON invites, admin_audit_log, tenant_deletions TO semprec_data;
REVOKE INSERT, UPDATE, DELETE ON agent_runs, agent_run_mcp_credentials, approval_requests, push_subscriptions FROM semprec_side;
REVOKE SELECT ON agent_run_mcp_credentials, push_subscriptions, sessions, password_reset_tokens, login_attempts, invites, admin_audit_log, tenant_deletions FROM semprec_side;
