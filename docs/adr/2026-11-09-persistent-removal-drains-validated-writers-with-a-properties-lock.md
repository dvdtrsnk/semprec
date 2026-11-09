---
status: accepted
date: 2026-11-09
area: [backend]
supersedes: []
superseded-by: null
---

# The Tasks persistent removal drains validated writers with a properties lock, a Task-called-for contract exception

## Context

Issue #2009 removes the unused Tasks property `persistent`. A per-tenant cutover strips the stored values in
committed batches of at most 500 ids, then deletes the property definition. It follows
[[2026-09-10-app-code-post-migration-steps]] and runs from `runMigrationsCli` while the previous release still serves
traffic.

The generic item write validates the keys it writes against the definitions it reads in its own transaction
(`listPropertiesByDatabase` in `createItemWithClient` and `updateItemWithClient`). That read takes no row lock. A
writer can validate `persistent` while the definition exists, pause, and commit after the cutover's last strip. The
item then stores a key whose definition is gone.

Every production path that validates and writes Tasks item keys goes through these two functions inside a
`withTransaction` write transaction at READ COMMITTED. The owner SQL cutovers that write Tasks items directly (the
series cutover and this one) never write `persistent`. The transactions that run at repeatable read or serializable (the
Inbox tick's read phase and project agent guidance) do not write Tasks items. A `SELECT` on `properties` holds ACCESS
SHARE on the table until its transaction ends.

The previous release still copies `persistent` from the series template into the next instance of a recurring task.
Once the definition is gone, that copy fails validation (`Unknown property key 'persistent'`), so the previous
release cannot complete a recurring task. [[2026-09-10-expand-contract-forward-only-migrations]] and
[[2026-09-24-rollback-one-release-back-with-checked-migrations]] require the previous release to keep working.
Issue #2009's Task orders the deletion in this cutover and was reconciled to call for this break explicitly.

Rejected alternatives:

- Locking property rows `FOR SHARE` in every write is a generic write protocol.
- A trigger or CHECK on `items` is generic, and a CHECK cannot name a tenant's Tasks database.
- Refusing the key in the Tasks transform does not cover the previous release.
- Stopping services during deploy is a deploy workaround.
- A cutover-side lock on `items` cannot catch a writer that has validated but not yet written.
- Splitting the removal over two releases would defer the approved acceptance criteria that the definition is gone
  and that `GET /api/schema` lists no `persistent`.

## Decision

- **Deleting transaction.** The cutover deletes the definition in a transaction of its own:
  `SET LOCAL lock_timeout = '5s'`, then `LOCK TABLE properties IN ACCESS EXCLUSIVE MODE`, then the `DELETE`.
  - The lock is granted only when every transaction that has read `properties` has ended, so a writer that validated
    `persistent` has committed or rolled back by then.
  - Writers arriving later queue behind the lock. Once the deletion commits, they no longer see the definition and
    are refused.
- **Strips.** Batched strips of at most 500 ids, each its own committed transaction, run before the deletion and
  again after it.
  - The strips after the deletion remove any value a drained writer stored.
  - No value is stripped inside the locked transaction.
- **Lock attempt.** One lock attempt, no retry.
  - A timeout (SQLSTATE 55P03) rolls the deleting transaction back and fails the tenant's cutover, so the migration
    run fails before activation.
  - Batches already stripped stay committed, the definition stays, and a rerun continues.
  - A run that finds the definition already gone takes no lock.
- **Compatibility exception.** This is the expand/contract exception issue #2009's Task calls for, and it is limited
  to `persistent`.
  - After the deletion, the previous release's recurring completion fails, during the deploy window and after a
    rollback, until a fix-forward.
  - This record grants no deployment or rollback clearance. It waives nothing else: no other field, tenant isolation
    or privacy rule.
- **Scope.** The lock is local to this cutover. It is not a general pattern for schema changes; a future contract
  step needs its own decision.

## Consequences

- No Tasks item stores `persistent` once the cutover completes. This rests on every validating writer reading
  `properties` inside its own READ COMMITTED write transaction; a writer that broke this would need its own decision.
- The lock is global: `properties` holds every tenant's definitions.
  - Every tenant's schema reads and item writes queue behind it while it is waited for and held.
  - `lock_timeout` bounds each wait to acquire it. It does not bound how long the lock is held, the cost of the
    statements under it, or how long schema reads wait in total.
- A long transaction that has read `properties` makes the cutover fail rather than wait indefinitely; the deploy is
  rerun.
- The previous release's recurring completion is broken from the cutover until activation and after any rollback.
  The handover and acceptance must state this.
- The bodies of [[2026-09-10-expand-contract-forward-only-migrations]],
  [[2026-09-10-app-code-post-migration-steps]] and [[2026-09-24-rollback-one-release-back-with-checked-migrations]]
  are unchanged; this record is their scoped exception.
