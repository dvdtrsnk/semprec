# Runtime Postgres roles and least-privilege service connections

Issue #243. Two roles, created by migration `0040_least_privilege_roles.sql`
(`backend/packages/data/src/db/migrations/`):

- **`semprec_data`** — full `SELECT`/`INSERT`/`UPDATE`/`DELETE` on the tables the generic
  choke-point (`backend/packages/data/src/chokePoint/*.ts`) writes inside its own
  transactions: `databases`, `properties`, `relation_definitions`, `items`, `item_relations`,
  `views`, `view_items`, `idempotency_keys`, `rollup_dependencies`. It is also a member of
  `semprec_side`, so it inherits full access to every module side table and the queue too —
  necessary because the processes that host the choke-point (`semprec-api`,
  `semprec-transcribe` and `semprec-agents`) also perform their own side-table writes in the same
  connection pool (its own `process_heartbeats` row,
  mail ingest, doc persistence, the blob-plus-item transaction in `fileUploadStore.ts`).
- **`semprec_side`** — read-only (`SELECT`) on the choke-point tables above, full DML on
  every module side table, and full access to graphile-worker's own `graphile_worker` schema
  (granted by `grantQueueSchemaPrivileges` in `backend/packages/queue/src/index.ts`, called
  once right after `ensureQueueSchema`, since that schema doesn't exist yet at migration time).
  `INSERT`/`UPDATE`/`DELETE` against a choke-point table under this role fails outright — a
  bug that tries to bypass the choke-point from a `semprec_side`-only process is caught by
  Postgres itself.

## Which connection string each service gets

| Service                | Role           | Why                                                                                                                                                                                     |
| ---------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `semprec-api`          | `semprec_data` | Hosts the choke-point (every `*Handler.ts` route calls `createChokePoint(pool)`), the mail queue jobs and the mail live-sync root.                                                      |
| `semprec-ai-gateway`   | `semprec_side` | Only ever writes `ai_gateway_calls`, a side table.                                                                                                                                      |
| `semprec-agents`       | `semprec_data` | Hosts the generic-operation gateway its agent runs' tools write through (`createChokePoint` in-process); destructive operations still become approval requests.                         |
| `semprec-transcribe`   | `semprec_data` | Hosts the narrow in-process choke-point writer for Transcriptions pipeline state and its Event-match result (`docs/adr/2026-09-23-transcription-worker-writes-event-match-results.md`). |
| `semprec-restore-test` | `semprec_side` | Records the monthly restore test's result: `observability_checks` and `notifications` only (issue #178).                                                                                |

Only `semprec-api`, `semprec-transcribe` and `semprec-agents` are configured with the
`semprec_data` connection string (`docs/adr/2026-10-03-agents-worker-choke-point-access.md`). Each service's `.env.example` documents which role its `DATABASE_URL` must
authenticate as, for local development. In production, the actual per-environment connection
strings (with real passwords) live in the secret group files under `/opt/semprec/shared/env/`
(templates in `deploy/shared/env/`) — never committed here. `SEMPREC_API_DATABASE_URL`
(`semprec_data`) is in `data-role.env`, loaded by `semprec-api`, `semprec-agents` and
`semprec-transcribe`. `SEMPREC_SIDE_DATABASE_URL` (`semprec_side`, shared by every
side-table-only process) is in `side-role.env`, loaded by `semprec-ai-gateway` and
`semprec-restore-test`. The roles created by this migration have no password until an operator
sets one with `ALTER ROLE ... WITH PASSWORD`, using the distinct `SEMPREC_DATA_DB_PASSWORD` (in
`data-role.env`) / `SEMPREC_SIDE_DB_PASSWORD` (in `side-role.env`) values.

## Extending the grants

Both roles' table lists are maintained by explicit `GRANT` statements in the migration that
introduces a new table — there is no default-privilege rule that grants new tables
automatically, so adding a new choke-point or side table always requires a visible, reviewable
grant change in the same migration. A new table the choke-point writes goes in both the
`semprec_data` (full) and `semprec_side` (`SELECT`-only) grant lists; every other new table
goes only in the `semprec_side` (full) grant list. A new identity-plane table (see below) is the
exception: it is granted full DML directly to `semprec_data` and `SELECT` only to `semprec_side`, never
through `semprec_side`'s full grant.

## Identity tables

`users`, `sessions`, `password_reset_tokens`, `login_attempts` and `tenants` make up the identity
plane: they decide who a request is and which tenant it belongs to. Only `semprec-api` writes them
(login, logout, session touch, first-account setup, password reset), so:

- `semprec_data` holds `SELECT, INSERT, UPDATE, DELETE` on them directly — granted to the role itself,
  not inherited from `semprec_side`. Its `login_attempts.id` sequence access still comes through the
  inherited `USAGE, SELECT` on all sequences.
- `semprec_side` holds `SELECT` only (the restore-test recorder and `app_sole_tenant()` read them).

The reason is containment: a compromised side-role process (`semprec-ai-gateway`,
`semprec-restore-test`) must not be able to mint a session, rebind a user to another tenant, promote a
user to `admin` or change a tenant's status. Migration
`0057_identity_tables_api_role_only.sql` applies the split.

## DDL the API role needs

`semprec_data` owns no table and has no `CREATE` on schema `public`, so it cannot run DDL itself.
The one DDL statement the choke-point needs at runtime — creating a new database's `items`
partition inside `createDatabase`'s transaction — goes through `create_items_partition(uuid)`,
created by migration `0048_create_items_partition_function.sql`:

- It is `SECURITY DEFINER` with `search_path = pg_catalog, public`, owned by the migrating role
  (the owner of `items`), and runs
  `CREATE TABLE public.items_p_<hex> PARTITION OF public.items FOR VALUES IN ('<id>')` — the same
  partition name the application built before the function existed.
- `EXECUTE` is revoked from `PUBLIC` and granted to `semprec_data` only; `semprec_side` cannot
  call it, because a side-table-only process must never create a partition.
- Since migration `0072_attach_items_partitions.sql` it creates the partition as a standalone table
  and attaches it, so it holds `SHARE UPDATE EXCLUSIVE` on `items` (item reads and writes proceed)
  and `ACCESS EXCLUSIVE` only on the new table, until the caller commits. Concurrent creations
  still serialize on that lock.

**Rule:** any further DDL the API role ever needs goes through a `SECURITY DEFINER` function of
this shape — owned by the migrating role, `EXECUTE` revoked from `PUBLIC` and granted only to the
role that needs it — never through a schema-level `CREATE` grant or a change of table ownership
(decision record: `docs/adr/2026-09-27-runtime-ddl-through-security-definer-functions.md`).

## Cross-tenant router functions (semprec_router)

`semprec_router` is `NOLOGIN` and `BYPASSRLS`, and holds only column-level `SELECT` on the columns
its functions read (no table-level privilege). It owns the router functions below, which are
`SECURITY DEFINER` with a pinned `search_path` and schema-qualified objects.

**Rule:** an external identifier that must be mapped to a tenant before any tenant is known goes
through such a function. `EXECUTE` is revoked from `PUBLIC` and granted to exactly one runtime role,
and the function returns only ids or numbers, never content. The caller then enters
`runInTenant(<returned tenant>)` and re-reads everything else under RLS. No runtime role ever gets
`BYPASSRLS` (decision record: `docs/adr/2026-10-07-cross-tenant-router-functions.md`).

| Function                         | Executing role | Returned value                                                                  | Columns read                                                                        |
| -------------------------------- | -------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `route_graph_subscription(text)` | `semprec_data` | a tenant id, or `NULL`                                                          | `mail_account_sync_state(graph_subscription_id, tenant_id)`                         |
| `route_gmail_address(text)`      | `semprec_data` | `(tenant_id, mailbox_item_id)` rows, one per Gmail mailbox watching the address | `mail_account_sync_state(item_id, tenant_id, sync_mode, gmail_watch_email_address)` |
