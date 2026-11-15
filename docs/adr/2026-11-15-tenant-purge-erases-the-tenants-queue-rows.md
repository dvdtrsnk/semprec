---
status: accepted
date: 2026-11-15
area: [backend]
supersedes: []
superseded-by: null
---

# The tenant purge erases the tenant's idle queue rows

## Context

[[2026-10-08-per-tenant-queue-lanes]] names the queue of serialized and bulk work `<lane>:<tenantId>`.
graphile-worker 0.17.3 creates the row of that queue in `graphile_worker._private_job_queues` on
`add_job` and never deletes it. [[2026-10-18-tenant-purge-erases-outside-the-choke-point]] removes the
tenant's unlocked jobs and says that only a tombstone remains. A rehearsal of the purge on a scratch
cluster found one queue row per lane the tenant had used, so the deleted tenant's id survived in three
more places than the tombstone.

The purge does not own the queue table, and it cannot delete a queue row naively:

- `add_job` takes no lock on a queue row (`insert into _private_job_queues ... on conflict do nothing`),
  and `_private_jobs.job_queue_id` has no foreign key (`sql/000011.sql`: `job_queue_id int null, -- not adding 'references' ...`).
- A job that a still-open transaction enqueued into the lane is therefore invisible to a `NOT EXISTS`
  check. Deleting its queue row leaves a job whose `job_queue_id` points nowhere. The worker selects
  only jobs whose queue is null or available, so that job is never selected.
- Measured on two connections: a row-locking `SELECT ... FOR UPDATE OF q SKIP LOCKED` plus `DELETE`
  removed the queue row while the enqueue was open, and after both commits the job had no queue row and
  was not selectable.

## Decision

**The purge is the one writer outside graphile-worker that deletes `_private_job_queues` rows.** It
deletes only rows that are idle, as the last statements of the finalisation transaction, after the
`tenants` delete. Idle means all of:

- the name ends with `':' || tenantId` (`right(queue_name, 37)`; a name that only contains the id
  elsewhere is not the tenant's lane),
- `locked_at IS NULL` (no running job holds the queue),
- no `_private_jobs` row refers to it through `job_queue_id`.

**The delete runs under a table lock.** Before it, the transaction sets `lock_timeout` to `2s` (as
`set_config(..., true)`, so it ends with the transaction) and takes
`LOCK TABLE graphile_worker._private_jobs IN SHARE ROW EXCLUSIVE MODE`. `add_job` inserts into the job
table, which takes `ROW EXCLUSIVE`, and that mode conflicts with `SHARE ROW EXCLUSIVE`. So the lock waits for
every transaction that has enqueued a job and not yet finished, and while it is held no new `add_job`
can insert one. The `NOT EXISTS` then sees every job that can refer to a queue, and a job that arrives
after the lock is released finds no queue row and creates a new one. Measured on two connections: with
the lock, the purge failed with `55P03` while the enqueue was open, deleted nothing once the enqueue had
committed, and an `add_job` that started while the purge held the lock waited and then created the queue
row again with a selectable job.

**A remaining queue row defers finalisation.** Right after the delete, in the same transaction, any
remaining queue row whose name ends with `':' || tenantId` fails the run with
`Tenant purge left rows behind in: graphile_worker._private_job_queues`. The message names the table and
never a queue name. The failure rolls the whole transaction back: the identity erase, the tombstone and
the `tenants` delete included. The tenant stays `deleting` and the next sweep retries, as for any other
remaining row. A queue held by a running job, or that still holds a job, is erased on a later run once
the job has finished.

**The purge logs the count only**, as step `queues`.

## Consequences

- Every `add_job` of every tenant waits while the purge holds the table lock, that is until the commit
  of the finalisation transaction, which follows the `DELETE` and the check at once. The purge itself
  waits at most 2 s for the table lock (and for any row lock the `DELETE` needs), then fails with
  `55P03` and gives up until the next sweep, so each stall is bounded. It happens once per finalisation
  attempt: a tenant that is deferred by a held queue retries, and takes the lock again, on each sweep.
- The lock is taken last, after the identity and tombstone writes, so the transaction holds it only for
  two statements. A transaction that enqueued a job in the tenant's lane and then waits for a row the
  finalisation holds (the tenant's `tenants` row, for a foreign key check) can wait on the purge while
  the purge waits on it; Postgres resolves that as a deadlock and aborts one of them, which at worst
  fails this run and is retried by the next sweep.
- This decision adds no write to another `graphile_worker` table: it only reads `_private_jobs` and takes
  its table lock (the jobs step already completes the tenant's jobs through `complete_jobs`).
  It depends on graphile-worker 0.17.3's private table names and columns (`queue_name`, `locked_at`,
  `job_queue_id`); a library upgrade has to recheck the statement. The tests read the same tables
  through one helper for that reason.
- Existing backups and restored snapshots keep the queue rows of a tenant that was deleted after they
  were taken, as they keep all its other data ([[2026-10-18-tenant-purge-erases-outside-the-choke-point]]).
