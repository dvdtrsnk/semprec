---
status: accepted
date: 2026-11-15
area: [backend]
supersedes: []
superseded-by: null
---

# A restore creates the cluster roles before the dump and imports no key of a deleting tenant

## Context

[[2026-11-03-offline-compatible-tenant-key-restore]] built the offline key import and a monthly restore test that
restores the main dump with `--no-owner --no-privileges` into a disposable cluster, "because the restored dump
intentionally omits ownership/grants". [[2026-11-03-restored-services-wait-for-successful-deletion-replay]] keeps the
restored services offline until the ledger validation and the replay succeed. A rehearsal on a scratch
`postgres:16-alpine` cluster (gh-1086) and the application review found four defects that those decisions left open.

- `--no-privileges` skips `GRANT`s but not row-level security policies. A dump of a database migrated by the real CLI
  holds `CREATE POLICY semprec_side_all ON graphile_worker._private_job_queues TO semprec_side` (created by
  `grantQueueSchemaPrivileges`), and a restore into a cluster that has no `semprec_side` stops with
  `role "semprec_side" does not exist`. The monthly test would fail its `pgRestore` check on every run, and the
  permanent `backup_restore_failed` alert would hide real failures.
- The production runbook named no command for the database restore. A fresh cluster fails the default restore at the
  first `OWNER TO semprec_router`; with `--no-owner --no-privileges` the restored `semprec_data` has no table
  privileges and the activation block then fails with a content-free line while the cause is a missing privilege.
- The runbook named no command that selects the key dump, and an older key dump brings back the key of a tenant whose
  deletion already erased it.
- The key import checked only that the tenant row exists in the restored main snapshot. A tenant whose status is
  `deleting` has had its key deleted by `beginTenantDeletion`, and a tenant that is tombstoned in `tenant_deletions` may
  still have its `tenants` row in a snapshot taken before the deletion finished.

## Decision

**Every restore into a cluster creates the three cluster roles first.** Row-level security policies and ownership in a
dump name `semprec_side`, `semprec_data` and `semprec_router`, and a cluster role belongs to no database, so no dump
carries it. Before `pg_restore` runs, the cluster has `semprec_side`, `semprec_data` (a member of `semprec_side`) and
`semprec_router`, with the attributes of migrations 0040 and 0069 (`NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`,
and `BYPASSRLS` for the router).

- The monthly test creates them `NOLOGIN` in its disposable cluster with `CLUSTER_ROLES_SQL`, in a check of its own
  (`clusterRoles`) between `postgresStart` and `pgRestore`, and keeps `--exit-on-error --no-owner --no-privileges`. The
  test needs no login on them, and a role it never uses to connect holds no password.
- The production restore creates them when they are missing with the logins of migration 0040, sets the passwords of
  `semprec_data` and `semprec_side` through `\getenv` so no password is placed in a command-line argument, and keeps owners
  and privileges: it never passes `--no-owner` or `--no-privileges`, because the restored services connect as those roles
  and hold only the privileges the dump grants them. The cluster must have been initialised with the backed-up
  `POSTGRES_USER`, because the dump records the owner of its tables as that superuser (a few objects name the roles above), and the runbook block fails before `pg_restore`
  when that role is missing.
- A test that restores a dump into a role-less cluster must run the monthly script's role statement first. The test of the
  statement reads it from the script, so a changed statement is the statement that is tested.

**The key import refuses a tenant that is deleting or tombstoned.** `importStagedTenantKeys` inserts a staged key only
when the tenant exists in the restored main database, its status is not `deleting`, and `tenant_deletions` holds no row
for it. A refused row is skipped like the row of an absent tenant: zero affected rows and no error, so one refused key
does not fail the import of the others and the offline target stays consistent with the deletion that erased the key. The
import target role therefore needs `SELECT` on `tenants` and on `tenant_deletions`, as the monthly test's role already has.
This reads the restored database's own state only; it neither replays a deletion nor consults the later ledger of
[[2026-11-03-restored-services-wait-for-successful-deletion-replay]], which still decides the replay.

**The ledger validator reports a fixed failure class and no content.** `validateRestoreLedgerCli.js` prints one of four
fixed lines and exits 1: the restore role lacks a privilege (SQLSTATE `42501`), the restore database is unreachable or
refused the login (SQLSTATE class `08` or `28`, or a Node connection error), the ledger does not cover the restored
snapshot (a dedicated error class, recognised without reading a message), or the generic line. The mapping inspects an
`AggregateError`'s errors and the `cause` chain within a fixed bound, and the printed line carries no tenant id, SQL text or
error message. The validator's own verdict wins over a connection error beside it, because a mismatch is raised only after
the query ran.

## Consequences

The monthly test passes on a dump of the real migrated catalog, and a catalog that names one more cluster role fails
that test at `pgRestore` until its role is added to `CLUSTER_ROLES_SQL`, to the runbook block and to this decision's list.
The recorder accepts `clusterRoles` as a failed check, so an alert names the step.

A key snapshot older than the newest still brings an erased key into the staging database, and the import now refuses it
only for a tenant that is `deleting` or tombstoned in the restored main snapshot. A tenant whose deletion completed after
the main snapshot and whose `tenants` row is still `active` in it is refused by neither check; the runbook therefore
requires the newest key dump, and the key snapshots expire after 7 days. A creation timestamp inside the key dump and a
refusal of an older dump by the CLI are not part of this decision.

Because the key import reads `tenant_deletions`, the offline key import role needs that privilege in a real recovery too;
the CLI still does not alter roles, grants or policies to make a role fit.
