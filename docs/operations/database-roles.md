# Runtime Postgres roles and least-privilege service connections

Issue #243. Two roles, created by the baseline migration `0001_baseline.sql`
(`backend/packages/data/src/db/migrations/`):

- **`alldots_data`** — full `SELECT`/`INSERT`/`UPDATE`/`DELETE` on the tables the generic
  choke-point (`backend/packages/data/src/chokePoint/*.ts`) writes inside its own
  transactions: `databases`, `properties`, `relation_definitions`, `items`, `item_relations`,
  `views`, `view_items`, `idempotency_keys`, `rollup_dependencies`. It is also a member of
  `alldots_side`, so it inherits full access to every module side table and the queue too —
  necessary because the processes that host the choke-point (`alldots-api`,
  `alldots-transcribe` and `alldots-agents`) also perform their own side-table writes in the same
  connection pool (its own `process_heartbeats` row,
  mail ingest, doc persistence, the blob-plus-item transaction in `fileUploadStore.ts`).
- **`alldots_side`** — read-only (`SELECT`) on the choke-point tables above, full DML on
  every module side table except the ones listed under "Identity tables" below, and full access to
  graphile-worker's own `graphile_worker` schema
  (granted by `grantQueueSchemaPrivileges` in `backend/packages/queue/src/index.ts`, which
  `installQueueSchema` runs right after `ensureQueueSchema`, since that schema doesn't exist yet at
  migration time).
  `INSERT`/`UPDATE`/`DELETE` against a choke-point table under this role fails outright — a
  bug that tries to bypass the choke-point from a `alldots_side`-only process is caught by
  Postgres itself.

## Which connection string each service gets

| Service                | Role           | Why                                                                                                                                                                   |
| ---------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `alldots-api`          | `alldots_data` | Hosts the choke-point (every `*Handler.ts` route calls `createChokePoint(pool)`), the mail queue jobs and the mail live-sync root.                                    |
| `alldots-ai-gateway`   | `alldots_side` | Only ever writes `ai_gateway_calls`, a side table.                                                                                                                    |
| `alldots-agents`       | `alldots_data` | Hosts the generic-operation gateway its agent runs' tools write through (`createChokePoint` in-process); destructive operations still become approval requests.       |
| `alldots-transcribe`   | `alldots_data` | Hosts the narrow in-process choke-point writer for Transcriptions pipeline state and its Event-match result (`docs/architecture/domain-calendar-tasks-and-media.md`). |
| `alldots-restore-test` | `alldots_side` | Records the monthly restore test's result: `observability_checks` and `notifications` only (issue #178).                                                              |

Only `alldots-api`, `alldots-transcribe` and `alldots-agents` are configured with the
`alldots_data` connection string (`docs/architecture/agents-approvals-and-ai.md`). Each service's `.env.example` documents which role its `DATABASE_URL` must
authenticate as, for local development. In production, the actual per-environment connection
strings (with real passwords) live in the secret group files under `/opt/alldots/shared/env/`
(templates in `deploy/shared/env/`) — never committed here. `ALLDOTS_API_DATABASE_URL`
(`alldots_data`) is in `data-role.env`, loaded by `alldots-api`, `alldots-agents` and
`alldots-transcribe`. `ALLDOTS_SIDE_DATABASE_URL` (`alldots_side`, shared by every
side-table-only process) is in `side-role.env`, loaded by `alldots-ai-gateway` and
`alldots-restore-test`. The roles created by this migration have no password until an operator
sets one with `ALTER ROLE ... WITH PASSWORD`, using the distinct `ALLDOTS_DATA_DB_PASSWORD` (in
`data-role.env`) / `ALLDOTS_SIDE_DB_PASSWORD` (in `side-role.env`) values.

## Extending the grants

Both roles' table lists are maintained by explicit `GRANT` statements in the migration that
introduces a new table — there is no default-privilege rule that grants new tables
automatically, so adding a new choke-point or side table always requires a visible, reviewable
grant change in the same migration. A new table the choke-point writes goes in both the
`alldots_data` (full) and `alldots_side` (`SELECT`-only) grant lists; every other new table
goes only in the `alldots_side` (full) grant list. A new identity-plane table (see below) is the
exception: it is granted full DML directly to `alldots_data`, never through `alldots_side`'s full
grant, and `SELECT` to `alldots_side` only when a side process has to read it (as `users` and
`tenants` are read today). A table that holds a credential, token or session secret follows the next
paragraph and gets nothing to `alldots_side`.

A new table that holds a bearer credential, a session secret, a delivery endpoint or a row that makes
an actor is granted directly to `alldots_data` and nothing to `alldots_side`: no side process needs
it, and a side-role compromise must not read or mint it. The side tables that already hold encrypted
credentials, wrapped keys or grant rows (`external_credentials`, `tenant_keys`, `mail_oauth_states`,
`agent_database_grants`, `project_mcp_grants`, `agent_run_read_allowances`) keep their grants; the
tenancy rules list them as the accepted remainder
(`docs/architecture/tenancy-and-security.md`).

## Identity tables

`users`, `sessions`, `password_reset_tokens`, `login_attempts` and `tenants` make up the identity
plane: they decide who a request is and which tenant it belongs to. Only `alldots-api` writes them
(login, logout, session touch, first-account setup, password reset). Four more tables turn a database
row into an actor the API accepts or into a delivery endpoint: `agent_runs`,
`agent_run_mcp_credentials`, `approval_requests` and `push_subscriptions`. They are written only by
`alldots_data` as well, so:

- `alldots_data` holds `SELECT, INSERT, UPDATE, DELETE` on them directly — granted to the role itself,
  not inherited from `alldots_side`. Its `login_attempts.id` sequence access still comes through the
  inherited `USAGE, SELECT` on all sequences.
- `alldots_side` cannot write any of them. It cannot read `agent_run_mcp_credentials`,
  `push_subscriptions`, `sessions`, `password_reset_tokens`, `login_attempts`, `invites`,
  `admin_audit_log` or `tenant_deletions` at all (no privilege of any kind). It reads `users`,
  `tenants`, `tenant_ai_budgets`, `agent_runs` and `approval_requests` (`SELECT` only), plus its own
  side tables: `app_sole_tenant()`, the operator alert and the restore-test recorder read `users` and
  `tenants`, and the AI gateway reads `agent_runs` to check that the run it attributes a call to
  exists.

The reason is containment: a compromised side-role process (`alldots-ai-gateway`,
`alldots-restore-test`) must not be able to mint a session or an MCP run credential, rebind a user to
another tenant, promote a user to `admin`, change a tenant's status or register a push endpoint for
another user. The baseline applies the split to the identity plane and to the four actor and endpoint
tables, and gives the side role no read of the credentials and tokens (rules: `docs/architecture/tenancy-and-security.md`).

## DDL the API role needs

`alldots_data` owns no table and has no `CREATE` on schema `public`, so it cannot run DDL itself,
and the choke point needs none at runtime: creating or deleting a database writes rows only.

**Rule:** any DDL the API role ever needs goes through a `SECURITY DEFINER` function owned
by the migrating role, `EXECUTE` revoked from `PUBLIC` and granted only to the
role that needs it — never through a schema-level `CREATE` grant or a change of table ownership
(rules: `docs/architecture/tenancy-and-security.md`).

**Rule:** the `search_path` of a `SECURITY DEFINER` function ends with `pg_temp` and lists no schema
a runtime role can create objects in. Without `pg_temp` PostgreSQL searches the session's temporary
schema first for relation and type names, so a runtime role could shadow a type the function body
names (finding R2-DB-1 of gh-1086). The deploy-time
verifier (`db/tenancyInvariants.ts`) refuses any other shape in every schema (rules: `docs/architecture/tenancy-and-security.md`).

## Cross-tenant router functions (alldots_router)

`alldots_router` is `NOLOGIN` and `BYPASSRLS`, and holds only column-level `SELECT` on the columns
its functions read (no table-level privilege). It owns the router functions below, which are
`SECURITY DEFINER` with `search_path = pg_catalog, public, pg_temp` and schema-qualified objects. The
rule above applies to them too: `pg_temp` is last, and no schema a runtime role can create objects
in is listed.

**Rule:** an external identifier that must be mapped to a tenant before any tenant is known goes
through such a function. `EXECUTE` is revoked from `PUBLIC` and granted to exactly one runtime role,
and the function returns only ids or numbers, never content. The caller then enters
`runInTenant(<returned tenant>)` and re-reads everything else under RLS. No runtime role ever gets
`BYPASSRLS` (rules: `docs/architecture/tenancy-and-security.md`).

| Function                                  | Executing role | Returned value                                                                                       | Columns read                                                                                       |
| ----------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `route_graph_subscription(text)`          | `alldots_data` | a tenant id, or `NULL`                                                                               | `mail_account_sync_state(graph_subscription_id, tenant_id)`                                        |
| `route_gmail_address(text)`               | `alldots_data` | `(tenant_id, mailbox_item_id)` rows, one per Gmail mailbox watching the address                      | `mail_account_sync_state(item_id, tenant_id, sync_mode, gmail_watch_email_address)`                |
| `route_mail_oauth_state(text)`            | `alldots_data` | `tenant_id` rows, one per tenant with an open (unused, unexpired) OAuth state of that hash           | `mail_oauth_states(tenant_id, state_hash, used_at, expires_at)`                                    |
| `route_google_calendar_channel(text)`     | `alldots_data` | `tenant_id` rows, one per tenant with a Google calendar push channel of that id                      | `calendar_push_channels(tenant_id, provider, channel_id)`                                          |
| `route_graph_calendar_subscription(text)` | `alldots_data` | `tenant_id` rows, one per tenant with a Graph calendar subscription of that id                       | `calendar_push_channels(tenant_id, provider, channel_id)`                                          |
| `ops_health_counts()`                     | `alldots_data` | one row of three counts: agent-run errors (7 days), `item_automation` errors, alerting tenant checks | `agent_runs(status, started_at)`, `item_automation(status)`, `tenant_observability_checks(status)` |
| `ai_tenant_spend()`                       | `alldots_data` | one row per tenant with calls: its id, spend today and spend this month (UTC windows)                | `ai_gateway_calls(tenant_id, at, cost_usd)`                                                        |
