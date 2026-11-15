---
status: accepted
date: 2026-11-15
area: [backend]
supersedes: []
superseded-by: null
---

# The side role cannot create an actor or read credentials

## Context

[[2026-09-17-two-tier-runtime-database-roles]] gave `semprec_side` full DML on every module side
table, and `0057_identity_tables_api_role_only.sql` took the writes on the identity plane away from it
so that a compromised side-role process (`semprec-ai-gateway`, `semprec-restore-test`) could not mint
a session. The external review of gh-1086 found that the same containment was missing on the tables
that turn a database row into an actor the API accepts (finding R2-DB-2): `semprec_side` held full DML
on `agent_runs` and `approval_requests` (0040) and on `agent_run_mcp_credentials` (0055). As
`semprec_side`, after `set_config('app.tenant_id', <tenant B>)`, the review inserted a running
`agent_runs` row for a tenant-B user and an `agent_run_mcp_credentials` row holding the SHA-256 of a
token it chose; the API's two lookups in `mcp/mcpRunCredentialsStore.ts` resolved that token to tenant
B and its actor. The side role thereby obtained an actor whose writes `semprec_data` executes, which
bypasses the tier "the side role cannot write items". Finding R2-DB-3 added that the global tables
have no row-level security and that `semprec_side` read the credentials, tokens and admin-plane rows
of every tenant and held full DML on `push_subscriptions`, so it could register an endpoint for any
user's notifications.

Reading every reader and writer showed that no side process writes `agent_runs` or
`approval_requests`, or reads or writes `agent_run_mcp_credentials`, `push_subscriptions`, `sessions`,
`password_reset_tokens`, `login_attempts`, `invites`, `admin_audit_log` or `tenant_deletions`. The AI
gateway reads `agent_runs` (`reserveGatewayCall` checks that the attributed run exists). Every other
process that touches these tables connects as `semprec_data`, the role
[[2026-10-03-agents-worker-choke-point-access]] hands to the API, agents and transcription processes.

## Decision

A table that holds a bearer credential, a session secret, a delivery endpoint or a row that makes an
actor is granted directly to `semprec_data` and nothing to `semprec_side`. A new table of this kind
follows the rule in the migration that creates it, and `docs/operations/database-roles.md` states it
under "Extending the grants".

The rule covers these tables today (migration `0177_side_role_cannot_mint_actors.sql`):

- `semprec_side` holds no privilege at all on `agent_run_mcp_credentials`, `push_subscriptions`,
  `sessions`, `password_reset_tokens`, `login_attempts`, `invites`, `admin_audit_log` and
  `tenant_deletions`.
- `semprec_side` holds `SELECT` only on `agent_runs` and `approval_requests`, and keeps its `SELECT`
  on `users`, `tenants` and `tenant_ai_budgets`.
- `semprec_data` holds the `SELECT`, `INSERT`, `UPDATE` and `DELETE` of the four actor and endpoint
  tables (`agent_runs`, `agent_run_mcp_credentials`, `approval_requests`, `push_subscriptions`)
  directly, and `SELECT` on `invites`, `admin_audit_log` and `tenant_deletions` directly. Each revoke
  from `semprec_side` is preceded by the direct grant, as `0057` did, because `semprec_data` reached
  these tables only through its membership in `semprec_side`.

## Accepted remainder

The rule does not cover what `semprec_side` still reaches, and this record does not claim it does.
`issues/decisions/gh-1086.md` records the acceptance in writing as the residual risk of R2-DB-2: a
compromised `semprec-ai-gateway` or `semprec-restore-test` process reads and writes every module side
table of any tenant it names with `set_config`, among them

- document and mail content (`docs`, `doc_updates`, `mail_*`, `semp_messages`),
- `external_credentials` (encrypted rows; neither process holds the master key), `tenant_keys` (wrapped
  keys, which it can delete), `mail_oauth_states` and `mail_account_server_settings`,
- the grant rows `agent_database_grants`, `project_mcp_grants` and `agent_run_read_allowances`, and
  `mcp_tool_registrations` and `project_heartbeats`,
- every `graphile_worker` job of any tenant, enqueuing included,

and it reads `users`, whose `password_hash` column a column-level revoke could only take away in a
later release (the restore-test recorder's `getUserById` selects it). These tables are listed as the
accepted remainder, not as tables the rule already covers. Changing them is a later decision; the
conditions that reopen it are the ones `issues/decisions/gh-1086.md` names.

## Consequences

- A statement of `semprec_side` that writes one of the four actor and endpoint tables, or reads one of
  the eight tables above, fails with SQLSTATE 42501 at the database.
- The previous release's side-role processes use none of the revoked privileges, and its
  `semprec_data` processes receive the privileges directly, so a rollback of the release finds the
  grants it needs.
- A new process that needs one of these tables connects as `semprec_data`, or the decision is revisited
  in a new record; it is not given a grant on `semprec_side`.
