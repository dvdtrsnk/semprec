---
status: accepted
date: 2026-11-08
area: [backend]
supersedes: []
superseded-by: null
---

# Search-lane enqueues flush in order under a tenant lock before commit

## Context

Issue #1652 queues `itemSearchReindexDependents` jobs from the choke point's edge, title, trash and Inbox hooks, keyed by item, on each tenant's `item-search-index` lane. Issues #1520 and #1658 queue `itemSearchBackfill` and `itemSearchPageText` (`preserve_run_at`, 30-second debounce) on the same lane. Each producer called `graphile_worker.add_job` inline, at the point of the write. graphile-worker 0.17.3's `add_jobs` (`sql/000018.sql`) acquires, per call:

- the task row: insert, do nothing on conflict;
- the queue row: insert, do nothing on conflict;
- a same-key row that is running: `UPDATE … SET key = NULL`;
- the job-key row: insert, update on conflict while unlocked.

Two concurrent creates, X linking A then B and Y linking B then A, each hold one item's uncommitted job row and wait on the other's. That is the R1 finding F3, a real `40P01` schedule.

An inline enqueue inside the protected value-link body ([[2026-11-01-value-link-relations-use-nonblocking-admission-and-scoped-lock-waits]]) also waits on such rows under that body's 1 ms lock budget.

A worker's own identifier registration does not close the gap:

- graphile-worker writes `_private_tasks` on a worker's first job fetch (`dist/sql/getJobs.js` → `dist/taskIdentifiers.js`), after `run()` already returned;
- so a runner's return, or an HTTP listen, proves nothing about registration;
- sorting the worker's task list does not help: a transaction can hold an inline, cold, non-search identifier row, the worker's registration statement can hold a cold search identifier and wait on it, and the transaction's later search enqueue then waits on the registration.

Rejected alternatives:

- the inline status quo;
- sorting the whole task list;
- creating a missing identifier lazily inside the domain transaction, which re-creates the cold cycle;
- warming through `runOnce` or a fake job;
- one global flush lock, which costs more than a per-tenant one;
- retries or remapping a deadlock to a busy error, which mask the cause.

## Decision

1. **Registration, not SQL, in the body.**
   - The three item-search producers (`search/itemSearchFanout.ts`, `search/itemSearchBackfill.ts`, `docs/docPersistence.ts`) queue only through `search/searchLaneEnqueue.ts`. It is the only code that names the lane.
   - It prepares the call immediately with `@semprec/queue`'s `prepareJob`:
     - the envelope (payload, producer tenant, trace) is stamped and serialized as `enqueueJob` stamps it;
     - the lane, key, mode, attempts and run time are captured, the run time as a number.
   - It then registers the call on the caller's managed invocation (`db/pool.ts` `registerSearchJob`).
   - The prepared handle is opaque: `addPreparedJob` refuses anything `prepareJob` did not return.
   - `enqueueJob` keeps its full contract, including `unsafe_dedupe`, for every other caller.
2. **Admission.** A registration is refused before anything is registered when:
   - its client is not the active owner's: an unmanaged client, another transaction's, a body that already returned, work started from it after it returned, or an after-commit callback;
   - its task is outside `SEARCH_TASK_IDENTIFIERS`;
   - it carries another tenant than the one the invocation was opened in;
   - its key is already registered for another task.

   Registration closes when the body returns.

3. **Flush, between a successful body and COMMIT.**
   - A body failure or a recorded rollback-only failure skips it.
   - The flush:
     - reads `SEARCH_TASK_IDENTIFIERS` through `@semprec/queue`'s `assertSearchTaskIdentifiersRegistered` and fails closed when any is not visible;
     - takes the invocation's two-key advisory transaction lock: `(2332, hashtext(tenant id))` for a tenant, `(2333, 0)` for a system or unscoped invocation;
     - adds the jobs grouped by physical key, groups in (identifier, key) code-unit order and calls within a group in registration order.
   - Replaying every call keeps graphile-worker's own same-key semantics: the later call replaces payload and options; `preserve_run_at` keeps the run time while `attempts = 0`; a running same-key job gets its key cleared and a new job is created.
   - A flush error and a COMMIT error keep their identity and roll back as a body error does.
   - Registrations are discarded on every exit.
   - The flush runs only these statements: no owner callback and no domain lock.
4. **Bootstrap.**
   - `@semprec/queue`'s `ensureQueueSchema` registers exactly the three identifiers right after graphile-worker's migrations. It uses graphile-worker 0.17.3's native statement: one idempotent `INSERT … SELECT unnest(…) ON CONFLICT DO NOTHING`, committed on its own, in code-unit order, creating no job and no queue.
   - This narrows the earlier rule against depending on graphile-worker's private tables. The queue package alone may insert those three rows and read them back. No data, search or store module writes graphile-worker metadata, assumes a row id or touches a private job or queue row.
   - `runMigrationsCli.ts` and `testSupport/globalSetup.ts` call `ensureQueueSchema` and `grantQueueSchemaPrivileges` right after the approval-request cutover and before the tenant cutovers, whose writes queue search jobs. Every other relative order stays.
   - The API, agents and transcribe queue runtimes already await `ensureQueueSchema` before their runners start, and `runSeedCli` follows the migrations as before.
5. **Scoped exception to [[2026-11-01-value-link-relations-use-nonblocking-admission-and-scoped-lock-waits]].**
   - A search enqueue inside the protected value-link body only registers. Its SQL runs at the flush, after the protected body restored the captured `lock_timeout`, while the lease and the admitted row and advisory locks stay held until the transaction ends.
   - The rollup enqueue and every other inline statement keep the 1 ms budget.
   - A caught busy error, or any rollback-only failure, prevents the flush.
   - A missing bootstrap and a flush error are never mapped to `value_link_busy`.
   - The accepted decision is otherwise unchanged; its text is not edited.

This extends [[2026-09-29-withtransaction-is-the-sole-transaction-opener]], whose sole owner now also runs the flush, and [[2026-11-04-keyed-after-commit-effects-belong-to-the-managed-invocation]]: like a keyed effect, a registration belongs to the active invocation. Unkeyed and keyed after-commit callbacks are unchanged and still run after COMMIT.

## Consequences

**Finite claim.** No wait-for cycle contains the wait of a search flush, among search flushes of any tenant or process and graphile-worker's own registration, `get_job`, `complete` and `fail` statements, under these premises:

- **(P1) Bootstrap.** The three identifier rows are committed by bootstrap and not deleted. A flush's task-row insert then takes no lock.
- **(P2) Completeness.** Only flushes enqueue the three tasks or use lane queues and lane keys.
- **(P3) Tenant lock.** A flush belongs to one tenant and holds that tenant's lock from before its first `add_job` until the transaction ends.
- **(P4) Disjoint keys.** Lane keys of different tenants are different physical keys. The backfill key embeds the tenant id; the other keys embed item ids that no code copies across tenants.
- **(P5) graphile-worker 0.17.3 lifecycle:**
  - `get_job` never waits, because it locks jobs and queues `SKIP LOCKED`;
  - a queue runs one job at a time;
  - production runners release jobs unbatched, so a `complete` or `fail` statement touches one job and its queue row, and waits only at that job row, holding nothing else.

**Reasoning.**

- Under P1–P3 and P5, a flush waits only on another flush (its tenant lock, or the lane and job rows it holds), or on a graphile-worker statement that already holds the row the flush needs: `get_job`, which never waits, or an unbatched `complete` or `fail`, which waits only before it holds any row.
- A flush never waits on the identifier registration, whose rows it does not lock under P1. The registration can still wait on a body's inline identifier row, but it holds nothing a flush takes.
- So a graphile-worker statement a flush waits on does not wait any more, and another flush it waits on waits only under these same rules. Under P2 no transaction body holds a lane row or a tenant lock, so no wait chain from a flush reaches a body's locks.
- Flushes of one tenant are mutually exclusive. Flushes of different tenants share no queue rows, and under P4 no job rows. A hash collision only serializes two tenants.
- A system flush and a tenant flush can share only keyed job rows, which both take in the same key order.

**Not claimed:**

- cycles among body-phase locks, including inline non-search enqueues (rollup, Journal recompute on create and proposal, value-link propagation, other owners), which remain the existing class;
- old-release processes that enqueue lane jobs inline while a deploy's new processes flush;
- concurrent deletion of graphile-worker metadata (no repository code runs its GC; the visibility check is not a lock against it);
- the batched release that this repository's `runOnce` uses (in tests), when two queue-less system-scope search jobs complete in one statement;
- raw COMMIT and detached work;
- whole-transaction deadlock freedom.

**Version coupling.** The bootstrap statement, the visibility read and the premises above are read from graphile-worker 0.17.3. An upgrade re-reads `taskIdentifiers.js`, `sql/000018.sql`, `getJobs.js`, `completeJobs.js` and `failJobs.js` and revises this decision.

**Costs:**

- **Serialization:** each tenant's flush-to-COMMIT tail is serialized, and all system-scope flushes share one lock. The wait is bounded only by the session's `statement_timeout`, with no new budget.
- **Availability:** search-row contention that used to end as a fast `value_link_busy` inside a protected body now waits at the flush.
- **Startup:** a database without the identifiers refuses every search write until `ensureQueueSchema` runs.
- **Journal days:** an `item` search job of a live Journal day now runs the Inbox owner's recompute of the day (cache, index and invalidation) instead of the index write alone. The Inbox update, trash and restore hooks queue that job instead of the recompute.
