---
status: accepted
date: 2026-10-18
area: [backend]
supersedes: []
superseded-by: null
---

# The tenant purge erases a deleting tenant outside the choke point

## Context

Account deletion (#1049) moves a tenant to `deleting`, revokes its sessions and push registrations
and deletes its `tenant_keys` row. Every row, item partition and stored file of the tenant remains.
Issue #1055 erases them and leaves a tombstone, because deleting an account is an erasure
requirement.

Three accepted decisions point the other way, and this one carves an exception into each:

- [[2026-09-10-choke-point-api-for-state-writes]] routes every write to item and database state
  through the choke point, for auditability, undo and realtime sync. A `deleting` tenant has no
  session, no realtime subscriber and nothing to undo.
- [[2026-09-28-blob-bytes-deleted-best-effort-after-the-commit]] deletes the row first and the bytes
  after the commit, and skips failures. It states that a hard erasure requirement needs a different
  decision. This is that decision, for one case. It does not supersede the other ADR.
- [[2026-10-06-system-work-fans-out-per-tenant]] runs system work per active tenant. A `deleting`
  tenant is skipped by that fan-out, and its queued tenant jobs complete as no-ops, so the purge
  cannot be a tenant task.

## Decision

**Bulk deletion outside the choke point.** The purge deletes rows with plain `DELETE` statements,
in system scope, entering each tenant explicitly with `runInTenant`. Every statement that selects
or deletes rows of a tenant-classified table, and the delete of `agent_run_mcp_credentials`, carries
an explicit `tenant_id = $1` predicate in addition to row-level security; the chunked delete carries
it in the subquery that picks the chunk's `ctid`s. The other statements are scoped differently:
queued jobs are matched on `payload->>'tenantId'`, partitions are dropped by the id of one of the
tenant's `databases` rows, and the global identity rows are deleted by the purged user's id or
normalised email. Nobody can observe the
tenant, so no hook, audit row or notification is lost. This applies to a tenant in `deleting` only.

**Bytes before rows.** The tenant's blob keys, export keys and `<root>/<tenantId>` directories are
removed before any row that references them. Once the rows are gone, both `<root>/<tenantId>`
directories are removed again, right before finalisation, so bytes that a writer already running
at deletion time stored after the bytes step are erased too. A failure throws for that tenant, so the tenant is not
finalised and the next run retries. Missing bytes behind a surviving row harm nobody, because the
tenant is unreachable; surviving bytes without any row would be unrecoverable. Each blob key is
removed from both roots, because content-hash deduplication can leave the bytes in either
([[2026-10-18-tenant-export-cross-root-blob-lookup]]).

**Catalog-driven foreign-key ordering.** The tables to purge are the public tables whose comment is
`semprec:tenancy=tenant` and which are not partitions. Their order comes from `pg_constraint`, fed to
the pure function `orderTablesForPurge`: a table is deleted before every table it references.
A self-referencing foreign key is allowed, and such a table is deleted in one statement so the
foreign-key check sees the whole set. Any other cycle throws naming the tables. A new tenant table
is therefore purged without editing the purge. Partitioned tables (`items`) are excluded from chunked
deletion, since a `ctid` is unique only within one partition. Their partitions are dropped through
`drop_items_partition` first, one transaction per database with `lock_timeout = '5s'`, and again
right before `items` is deleted (it precedes `databases`, its parent), so a database created by a
writer already running at deletion time loses its partition too. The predicate delete that follows
is expected to affect nothing; rows it does find are deleted and logged rather than failing the
tenant, because their database's partition could not be dropped on a retry once the `databases` row
is gone.

**A per-minute sweep with a per-tenant try-lock.** `tenantPurge` is a system task on `* * * * *`.
It lists `deleting` tenants by `status_changed_at` and, for each, takes
`pg_try_advisory_lock(hashtextextended('semprec_tenant_purge:' || tenantId, 0))` on a dedicated
connection. A tenant whose lock is held is skipped for this run. The connection is unlocked and
released on every path; a failed unlock destroys the connection, which drops the session lock. After
the lock is held the tenant is re-read, so a run that finished it first is not repeated. The lock
serialises purge runs per tenant; it does not stop other writers, which is why finalisation
re-checks that no tenant row remains. Rows are deleted in chunks of 1000, one transaction each
([[2026-09-28-chunked-transactions-for-large-background-sweeps]]), so a crash leaves committed
progress and every step is idempotent. Between chunks the task checks `helpers.abortSignal`
and returns normally on shutdown ([[2026-09-30-graceful-shutdown-for-long-running-graphile-worker-tasks]]);
the next tick resumes. One tenant's failure is logged by class name, collected and rethrown together
after the loop, so the run reports failure while other tenants' progress stays committed.

**Finalisation and the tombstone.** In one transaction the purge asserts that no tenant table and no
`agent_run_mcp_credentials` row still carries the tenant id, deletes the tenant's user and the
user's `push_subscriptions`, `sessions`, `password_reset_tokens`, `login_attempts` and `invites`,
inserts the tombstone and deletes the `tenants` row (which cascades to `tenant_ai_budgets`). The
`users` delete, the tombstone insert and the `tenants` delete each require an affected row. The
deletes of the identity rows accept zero rows, because a user may have no push registration,
session, reset token, login attempt or invite.

The tombstone is a row in `tenant_deletions(tenant_id, requested_at, completed_at)`. `requested_at`
is the tenant's `status_changed_at` at deletion. It holds no email, no user id and no content. It
is global, `semprec_data` may only insert into it, and a backup restore will replay it (#1078, not yet implemented).

## Consequences

- The purge needs `DELETE` on every tenant table and the global identity tables from the role the
  `api` runtime uses; this already holds for `semprec_data`.
- Queued jobs of the tenant that are locked (running) when the purge removes the rest are not
  removed, and work already running when the deletion began (such a job, or an in-flight request)
  keeps running; only work that starts afterwards completes as a no-op. If it leaves a row,
  finalisation fails and the next tick retries. Bytes it stores under `<root>/<tenantId>` are erased
  by the second directory removal, and a database it creates loses its partition in the second
  partition pass (every key written since #1008 carries the `<tenantId>/` prefix). One narrow window
  remains: a database created between the second partition pass and the delete of `databases`
  leaves its partition behind, emptied by the predicate delete on `items`, so it holds no row of the
  tenant.
- `drop_items_partition` takes `ACCESS EXCLUSIVE` locks on the partition and on `items`. Other
  tenants' item queries wait for it, for at most the 5 s lock timeout per database; a timeout fails
  that tenant and the next tick retries.
- A failing file deletion blocks finalisation indefinitely until the cause is fixed. This is
  deliberate: the tenant stays `deleting` and unreachable.
- Data of the deleted tenant remains in existing backup snapshots until they age out; secrets are
  already unrecoverable because the tenant key was deleted at request time.
