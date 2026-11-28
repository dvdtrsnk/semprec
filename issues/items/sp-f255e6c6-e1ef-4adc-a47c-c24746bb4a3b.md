---
schemaVersion: 1
id: "sp-f255e6c6-e1ef-4adc-a47c-c24746bb4a3b"
title: "[security-gate 03/06] Make the offline restore work on a fresh cluster and never import the key of a deleting tenant"
kind: "implementation"
state: "closed"
stateReason: "completed"
labels: ["execution:batch-source","delivery:sp-36136548-e5b0-4c76-a0e6-d765c19b08bb","spec:approved"]
parent: "sp-62331d42-78af-4b93-ae97-d5ccbe3324df"
assignees: []
milestone: null
createdAt: "2026-11-15T12:15:18.707Z"
updatedAt: "2026-11-15T13:35:57.453Z"
closedAt: "2026-11-15T13:35:57.453Z"
source: null
approval: {"specSha256":"1c5046fc28d1513b8828e1527012b3bfe9d3922425a6deac3401d468c5331775","source":"repository","actor":"claude-delegated-by-david","at":"2026-11-15T12:15:19.228Z"}
resolution: {"pullRequests":[],"commit":"71afa79db34b8364d1442522f1ebf0fce6b2aa5b","at":"2026-11-15T13:35:57.453Z"}
---
**Blocked by:** none
**Model tier:** high

## Context

Model tier rationale: The offline restore is the only way back after a disaster and the place where an erased tenant key could come back. A wrong role statement keeps the monthly restore test failing forever, a wrong runbook command leaves the restored services without privileges, and a wrong import condition re-imports a key the deletion already erased.

The gh-1086 rehearsal on a scratch `postgres:16-alpine` 16.15 cluster (`issues/decisions/gh-1086.md`, evidence in the gate's `rehearsal.md`) and the application review found four defects of the restore path, verified for this source at `e6387779b` (identical tree to the integration tip):

- RH-2 (high). `restore_postgres` in `deploy/systemd/scripts/alldots-restore-test.sh` runs `pg_restore --exit-on-error --no-owner --no-privileges` into a freshly started disposable cluster and creates only `alldots_restore` afterwards. `--no-privileges` skips `GRANT`s but not `CREATE POLICY ... TO <role>`: a dump of a database migrated by the real CLI holds `CREATE POLICY alldots_side_all ON graphile_worker._private_job_queues TO alldots_side ...` (created by `grantQueueSchemaPrivileges` in `backend/packages/queue/src/index.ts`), and the restore stops with `role "alldots_side" does not exist`, exit 1. The rehearsal showed that the same command exits 0 once `alldots_side`, `alldots_data` (member of `alldots_side`) and `alldots_router` exist. The monthly job would therefore fail its `pgRestore` check on every run and raise a permanent `backup_restore_failed` alert that hides real failures. The script's own tests use synthetic dumps that name no production role (`backupKeyRestore.test.ts` "runs the monthly script with real owned bridge, compiled owner and synthetic snapshots"; `alldots-restore-test.test.sh` fakes `docker`), so nothing catches it.
- RH-3 (medium). `deploy/README.md` ("Disaster recovery needs both halves") says "Restore a selected main snapshot and its schema" with no command. On a fresh cluster the default `pg_restore --exit-on-error` fails at `ALTER FUNCTION public.ai_global_spend() OWNER TO alldots_router`; with `--no-owner --no-privileges` into a cluster that has the roles, `alldots_data` has no table privileges and the activation block stops at `validateRestoreLedgerCli.js` with only `Restore ledger validation failed`, while the cause was `permission denied for table tenant_deletions`. Role passwords and the restore of the two blob directories are not in the runbook.
- RH-4 (low). The runbook asks for "the newest independent `/var/backups/alldots/tenant-keys.dump` snapshot" without a command. An older key dump imported tenant B's already erased key in the rehearsal (the replay removes it again, and key snapshots expire after 7 days).
- R2-APP-2 (low). `importStagedTenantKeys` (`backend/packages/data/src/tenancy/restoreTenantKeys.ts`) inserts a staged key `WHERE EXISTS (SELECT 1 FROM public.tenants WHERE id = $1::uuid)` only. The review imported a key for a tenant whose status is `deleting` (its key had been deleted by `beginTenantDeletion`); a tombstoned tenant was refused only because its `tenants` row is gone.

The monthly test's `alldots_restore` role already holds `SELECT` on `tenants` and `tenant_deletions`; `alldots_data` holds `SELECT` on `tenant_deletions` (through `alldots_side` today, directly after `[security-gate 02/06]`).

## Task

Load `io-hardening`, `error-handling`, `testing`, `state-writes` and `adr-conventions`.

1. `deploy/systemd/scripts/alldots-restore-test.sh`:
   - Add `readonly CLUSTER_ROLES_SQL=...` holding exactly: `CREATE ROLE alldots_side NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;`, `CREATE ROLE alldots_data NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION IN ROLE alldots_side;`, `CREATE ROLE alldots_router NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS;`. The roles are `NOLOGIN` in the disposable cluster; the attributes otherwise match migrations 0040 and 0069.
   - Add `create_cluster_roles` (`CURRENT_CHECK=clusterRoles`) that runs it through `pg_query`, and call it in `main` after `start_postgres` and before `restore_postgres`. Keep `--exit-on-error --no-owner --no-privileges` and replace the comment above `restore_postgres` with the reason the roles are created first (policies name roles; `--no-privileges` does not skip them).
   - `deploy/systemd/scripts/alldots-restore-test.test.sh`: the fake `docker` records the role statement; assert that the `CREATE ROLE alldots_side` statement is recorded before the first `pg_restore` and that a failing role statement fails the run with check `clusterRoles` and no `pg_restore`.
   - `backend/packages/data/src/observability/restoreTestResultArgs.ts`: add `"clusterRoles"` to `RESTORE_TEST_FAILED_CHECKS` between `"postgresStart"` and `"pgRestore"` (the list is in script order), and extend `restoreTestResultArgs.unit.test.ts` so `failed <runId> clusterRoles` parses.
2. `backend/packages/data/src/__tests__/backupKeyRestore.test.ts`:
   - The synthetic main database of the file gains the shape of the production catalog that names roles: on the fixture server create `alldots_side`, `alldots_data` (member of `alldots_side`) and `alldots_router` if missing, and in the dumped database add one table with row-level security and `CREATE POLICY alldots_side_all ON <table> TO alldots_side USING (true) WITH CHECK (true)`, and one function owned by `alldots_router`. The monthly-script test then fails at `pgRestore` on the unfixed script and passes on the fixed one.
   - New test "restores a dump of the real migrated catalog into a role-less cluster with the script's role statement": on the fixture server, migrate a new database with `runMigrations`, `ensureQueueSchema` and `grantQueueSchemaPrivileges` (the schema steps of `runMigrationsCli.ts`), dump it with the backup script's flags (`--format=custom --exclude-table-data=public.tenant_keys`), start a second fixture (a fresh cluster with no alldots role), and `pg_restore --exit-on-error --no-owner --no-privileges` into it twice: without the roles it fails naming `alldots_side`; after running `CLUSTER_ROLES_SQL` read from `alldots-restore-test.sh` (extracted from the file, not copied) it exits 0.
3. `restoreTenantKeys.ts`: the insert condition of `importStagedTenantKeys` becomes `WHERE EXISTS (SELECT 1 FROM public.tenants WHERE id = $1::uuid AND status <> 'deleting') AND NOT EXISTS (SELECT 1 FROM public.tenant_deletions WHERE tenant_id = $1::uuid)`. A refused row is skipped like a row of an absent tenant (zero rows, no error). Update the doc comment. In `backupKeyRestore.test.ts` the synthetic `tenants` table gains `status text NOT NULL DEFAULT 'active'`, and a new case stages keys for an `active` tenant, a `deleting` tenant and a tenant that is present and tombstoned: only the `active` tenant's key is imported, through the target's RLS as today. Both fixture grant blocks of `backupKeyRestore.test.ts` (the `beforeAll` block and the `restored_cli` block) also grant `SELECT ON public.tenant_deletions` to `alldots_restore`, as the script does.
4. Add `backend/packages/data/src/tenancy/restoreLedgerFailure.ts` exporting `restoreLedgerFailureMessage(error: unknown): string`, which maps a failure to one fixed, content-free line: a PostgreSQL error with SQLSTATE `42501` to `Restore ledger validation failed: the restore role lacks a privilege`; SQLSTATE class `08` or `28`, or a Node connection error (`ECONNREFUSED`, `ETIMEDOUT`, `ENOTFOUND`, a connection timeout) to `Restore ledger validation failed: the restore database is unreachable or refused the login`; the mismatch that `validateRestoreLedger` raises to `Restore ledger validation failed: the ledger does not cover the restored snapshot`; anything else, including an invalid ledger file, to `Restore ledger validation failed`. It inspects an `AggregateError`'s errors and an error's `cause` chain, and never includes an id, a SQL text or an error message. Make the mismatch recognisable without parsing a message (for example a dedicated error class thrown by `validateRestoreLedger.ts`). `validateRestoreLedgerCli.ts` prints `restoreLedgerFailureMessage(error)` instead of the fixed line, still exits 1. Add `backend/packages/data/src/tenancy/__tests__/restoreLedgerFailure.unit.test.ts` covering each branch, an `AggregateError` and a `cause` chain, and that no input text appears in the output.
5. `deploy/README.md`, "Disaster recovery needs both halves": add a marked block `<!-- restore-database-command:start -->` ... `<!-- restore-database-command:end -->`, a directly executed Bash script under `set -euo pipefail` and `umask 077`, which in this order: requires its inputs through `: "${VAR:?...}"` (one of them is `ALLDOTS_RESTORE_OWNER`, the superuser name the backed-up database was migrated with; the block fails before `pg_restore` when that role does not exist in the target cluster, and the prose says the new cluster must be initialised with the same `POSTGRES_USER`); creates `alldots_side`, `alldots_data` (member of `alldots_side`) and `alldots_router` when missing, with the attributes of migrations 0040 and 0069, and sets the `alldots_data` and `alldots_side` passwords from `ALLDOTS_DATA_DB_PASSWORD` and `ALLDOTS_SIDE_DB_PASSWORD` without placing a password in a command-line argument; restores the selected main dump with `pg_restore --exit-on-error` and default owner and privilege handling (never `--no-owner` or `--no-privileges`); restores the files and mail-attachment directories from the same snapshot; selects the newest key dump with `restic dump --path /var/backups/alldots/tenant-keys.dump latest /var/backups/alldots/tenant-keys.dump > "$ALLDOTS_RESTORE_KEY_DUMP"`; and runs `restoreTenantKeysCli.js` on it. The prose states that the activation block of "Re-applying account deletions after a restore" follows it, that the key import target role needs `SELECT` on `tenants` and `tenant_deletions` and `SELECT, INSERT` on `tenant_keys`, and that an older key dump must never be chosen. Extend `deploy/systemd/scripts/alldots-restore-activation.test.sh` to extract this block the same way as the activation block, run it with shims for `psql`, `pg_restore`, `restic` and `node`, and assert the order of the steps, that no `pg_restore` call carries `--no-owner` or `--no-privileges`, that the key dump is selected with `--path /var/backups/alldots/tenant-keys.dump latest`, that no password appears in any recorded argument, and that the block stops before `pg_restore` when the `psql` shim reports the owner role missing. In "Monthly restore test", add the `clusterRoles` step (the three roles are created in the disposable cluster before `pg_restore`) to the described checks, and state the key-import rule: no key is imported for a tenant that is absent from the main snapshot, `deleting` or tombstoned in `tenant_deletions`.
6. Run `node .github/scripts/adr.mjs --platform backend` and check the restore ADRs (`2026-11-03-offline-compatible-tenant-key-restore`, `2026-11-03-offline-restore-owns-execs-on-an-authenticated-loopback-bridge`, `2026-11-03-restored-services-wait-for-successful-deletion-replay`). Add `docs/adr/<date>-a-restore-creates-the-cluster-roles-before-the-dump-and-imports-no-key-of-a-deleting-tenant.md` (`status: accepted`, `area: [backend]`, `supersedes: []`) that extends them without editing them: every restore into a cluster creates the three cluster roles before `pg_restore`; the production restore keeps owners and privileges; the key import refuses a `deleting` or tombstoned tenant; the ledger validator reports a fixed failure class without content.

## Touches

- deploy/systemd/scripts/alldots-restore-test.sh (`CLUSTER_ROLES_SQL`, `create_cluster_roles`, `main`, the comment above `restore_postgres`)
- deploy/systemd/scripts/alldots-restore-test.test.sh
- deploy/systemd/scripts/alldots-restore-activation.test.sh (the new block's extraction and assertions)
- deploy/README.md ("Disaster recovery needs both halves", and in "Monthly restore test" the role-creation step and the key-import rule)
- backend/packages/data/src/tenancy/restoreTenantKeys.ts (`importStagedTenantKeys`)
- backend/packages/data/src/tenancy/validateRestoreLedger.ts (the mismatch error)
- backend/packages/data/src/tenancy/validateRestoreLedgerCli.ts (the printed line)
- backend/packages/data/src/tenancy/restoreLedgerFailure.ts (new)
- backend/packages/data/src/tenancy/__tests__/restoreLedgerFailure.unit.test.ts (new)
- backend/packages/data/src/__tests__/backupKeyRestore.test.ts
- backend/packages/data/src/observability/restoreTestResultArgs.ts (one list entry)
- backend/packages/data/src/__tests__/restoreTestResultArgs.unit.test.ts
- docs/adr/ (one new ADR)

## Scope

### In scope

- A monthly restore test that restores a production-shaped dump in a fresh cluster.
- The exact production restore commands, including roles, passwords, blob directories and key-dump selection, tested by extraction.
- A key import that never brings back the key of a `deleting` or tombstoned tenant.
- A content-free failure class from the ledger validator.

### Out of scope

- A creation timestamp inside the key dump, a refusal of an older key dump by the CLI, and any change of `alldots-backup.sh` or of the dump formats.
- `replayTenantDeletionsCli.ts`, `replayTenantDeletionsCommand.ts` and the activation block's own commands.
- The purge residue of RH-1 (source `[security-gate 04/06]`) and the graphile-worker pool warning of RH-5.
- Running a restore on a production host, any production deployment, and any change to gh-1086 itself.
- Any change under `web/` or `mobile/`, and web or mobile verification.

## Acceptance criteria

- When the monthly restore test runs on a dump whose catalog has a policy for `alldots_side` and a function owned by `alldots_router`, then its `pgRestore` check passes, because the three roles were created in the disposable cluster first; on the unfixed script the same test fails at `pgRestore`.
- When a dump of the really migrated catalog (migrations plus the queue schema steps) is restored with the monthly test's flags into a cluster without the roles, then it fails naming `alldots_side`; after the script's `CLUSTER_ROLES_SQL` it exits 0.
- When the role statement of the monthly test fails, then the run fails with check `clusterRoles` and `pg_restore` is not called; the recorder accepts `clusterRoles` as a failed check.
- When staged keys include a tenant whose status is `deleting` or a tenant that is tombstoned in `tenant_deletions`, then neither key is imported and the import still succeeds for the active tenant.
- When the ledger validator fails because the role lacks a privilege, because the database is unreachable or refuses the login, or because the ledger does not cover the snapshot, then it prints the matching fixed line and exits 1; no id, SQL text or error message is printed in any case.
- When the README's restore block is extracted and run with shims, then it creates the roles before `pg_restore`, calls `pg_restore` without `--no-owner` and `--no-privileges`, restores both blob directories, selects the newest key dump by path, runs the key restore CLI last, and puts no password into any argument, and stops before `pg_restore` when the owner role is missing.
