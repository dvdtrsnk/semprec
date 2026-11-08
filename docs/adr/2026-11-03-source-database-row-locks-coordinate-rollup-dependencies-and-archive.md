---
status: accepted
date: 2026-11-03
area: [backend]
supersedes: []
superseded-by: null
---

# Coordinate rollup dependency writes with source database archive and restore

## Context

Gh-1359 queues dependent full recomputes in the archive/restore transaction. Its READ COMMITTED dependency scan cannot see an uncommitted or later dependency. A measured production schedule held archive after an empty scan, committed a new rollup property, completed that property's actual full/cell jobs against the still-visible unarchived source, then committed archive. The stored count stayed 1 with no queued full job. The opposite order and ordinary archive/restore control produced correct values. These are finite runtime-role schedules, not a general concurrency proof.

[[2026-09-29-withtransaction-is-the-sole-transaction-opener]] owns transaction lifetime. [[2026-10-03-tenant-isolation-through-row-level-security]] owns tenancy. [[2026-09-10-side-effects-follow-the-commit]] governs visibility; the existing queued writes remain in their triggering transaction.

The source FK's key-share check does not conflict with the non-key `archived_at` update. Moving enqueue into an after-commit callback would abandon the Task's transactional queue guarantee. A global advisory lock, new queue task/outbox, SERIALIZABLE retries or a public busy response would introduce a wider protocol than this measured defect requires.

## Decision

1. Before `upsertRollupDependency` inserts/repoints its dependency, acquire `FOR SHARE` on the exact new source `databases` row in that same transaction. Keep it through the caller's existing full-job enqueue and commit/rollback. Concurrent configurations may hold compatible shared locks. Do not replace this with `FOR KEY SHARE`.
2. Archive and restore retain their existing `databases` UPDATE and later dependency scan/enqueue. That non-key update conflicts with `FOR SHARE`. After a wait, the dependency scan is a separate READ COMMITTED statement, not a snapshot captured before waiting or a single-statement CTE containing the update.
3. The participating archive/restore and dependency-upsert entry points require the active invocation's managed transaction, actual PostgreSQL transaction status `T` and actual `transaction_isolation` equal to `read committed`. A small private database-row locking module uses the existing managed-owner check and checks state/isolation. Unsupported ownership/isolation fails with a fixed plain operational error before the protected step; public owners propagate it and roll back. Do not silently change isolation, retry, add a domain error or claim a JavaScript throw forces rollback if an arbitrary supplied-client caller deliberately catches it.
4. Put typed database-row locking SQL in `chokePoint/databaseRowLocks.ts`, the database owner's private locking slice. Dependency code calls it; do not import `databasesStore` back into `rollup/dependencies.ts`, since `databasesStore` already imports dependencies for purge. Keep helpers out of the public barrel. No new table, transaction owner, per-tenant global lock or framework is needed. No propertyOps/config rewrite is required: their current production upsert entry point covers create and config update.
5. Preserve the existing tenant policy and transaction-pinned scope; no new system exemption or RLS bypass. The lock lookup is tenant-visible and returns zero rows for an invisible/missing source; it does not create a new existence/error response. Preserve the subsequent existing FK/validation refusal and rollback. Existing configuration against an archived source remains allowed: its own post-commit worker computes the archived-source empty value. Do not add archive-based config refusal.
6. Dependency-first: archive waits for configuration's source lock; after config commits it updates and scans the now-committed dependency, enqueueing the required recount. Archive-first: config waits before dependency upsert; its own job becomes visible after archive commits and reads the archived state. Restore follows the same ordering with the unarchived result. The queue's current keys, worker implementation and computed-item row locks remain unchanged.

This covers each current single-source rollup configuration operation versus archive/restore of that source. Existing property-row and FK locks remain. A caller composing multiple such operations or entering with earlier database/queue locks must assess its own order; this record establishes no global lock hierarchy, deadlock freedom, arbitrary cancellation, physical purge protocol or correctness for unrelated schema races. Reconfiguration need not lock the former source solely to prevent an extra obsolete enqueue: the property-change job already recomputes its final configuration. Source/property deletion behavior is unchanged.

## Consequences and validation

Keep the original defect-asserting diagnostic separate from acceptance evidence. Permanent tests use real create/config-update, archive/restore and queued full/cell production paths under runtime roles, with bounded owned coordination and exact holder/waiter PIDs and `pg_blocking_pids` when proving the new wait. Test both acquisition orders, correct final count/sum after actual queue drain, rollback/release and existing tenant/missing/refusal behavior. Cover the supplied-client ownership and non-READ-COMMITTED refusal without inventing raw transaction openers. Preserve approved-operation archive coverage through its actual approval replay.

Do not wait inside a held-barrier test for an operation whose release is deferred to unreachable cleanup. Settle owned operations before restoring hooks/pools. These required finite schedules are included in the batch's existing two-round grouped review budget; this ADR does not authorize another review loop or convert development evidence into a frozen gate PASS.
