# Transactions and side effects

How a write's transaction is opened, what may run inside it, what must wait for its commit, and how
concurrent writers are ordered. What may be written, and by whom, is in
[data-model-and-writes.md](data-model-and-writes.md). Paths are relative to the repository root;
`data/` means `backend/packages/data/src/`.

## withTransaction is the sole transaction opener

- `withTransaction(pool, fn, { isolation? })` (`data/db/pool.ts`) is the only way to open a
  transaction on a pooled client. No call site sends `BEGIN`/`COMMIT`/`ROLLBACK` itself, even when it
  registers no callback today: a store it calls may register one later.
- Default isolation is READ COMMITTED; `repeatable_read` and `serializable` are the only options.
  A new level is added to `withTransaction`, never as a raw `BEGIN` variant.
- Only `pool.ts` internals (the scoped single-statement `pool.query`) and the migration runner
  (`data/db/migrate.ts`) issue raw `BEGIN`.
- `withTransaction` owns the whole lifecycle:
  - sets the transaction-local `app.tenant_id` from the active tenant scope right after `BEGIN`;
  - runs `fn` under an invocation-scoped `TransactionOwner`;
  - flushes registered search-lane jobs, then `COMMIT`s, then fires after-commit callbacks;
  - on any failure discards callbacks, rolls back and rethrows the original error; a connection
    whose `ROLLBACK` failed is destroyed, never returned to the pool.
- `withClient` is the non-transactional sibling for a few related statements on one connection.

### Managed transaction ownership

- `requireManagedTransaction(client)` asserts that `client` belongs to the currently active
  `withTransaction` invocation. Protected writes (value-link relation writes, rollup dependency
  writes, guarded derived-relation creation, approval projections, keyed callbacks) require it and
  fail closed on an unmanaged client.
- `markManagedTransactionRollbackOnly(client, error)` marks the invocation rollback-only. Before
  `COMMIT`, `withTransaction` rethrows the first recorded failure instead of committing, so a caller
  that catches a busy/refusal error cannot commit earlier work. The mark survives savepoint rollback.
- An escaping error from `fn` stays primary; cleanup failures never replace it.

### Transaction-local state

- `TransactionLocal` (`data/db/pool.ts`) holds a module's state for one `withTransaction` invocation,
  keyed on the invocation itself, so nothing in it outlives the transaction or reaches another one.
  A savepoint rollback does not reset it; it may only hold facts that stay safe after one. The item
  store counts each transaction's property writes per item in it, so a create or update whose hooks
  wrote the same item again re-reads the row and answers with its current `version`.

### Savepoints

- `withSavepoint(client, fn)` runs one step of the active managed transaction between `SAVEPOINT`
  and `RELEASE`. When `fn` throws, the step's writes are rolled back and everything it queued
  (after-commit callbacks, keyed slots, search-lane jobs) is discarded; earlier work stays. The caller
  decides which errors are a refusal of the step and rethrows the rest.

## Side effects follow the commit

- An effect that announces a write (`NOTIFY`, realtime invalidation via `notifyInvalidation`, push,
  any delivery to the outside) is registered with `runAfterCommit(client, callback)` and runs only
  after `COMMIT` succeeded. On rollback it is discarded.
- `runAfterCommit` is internal to `@semprec/data`; it is not exported from the package root.
- A callback is synchronous. One that throws is logged and the rest still run; the committed caller
  never sees the failure. An effect whose delivery matters must report its own failure, or be a
  queue job instead.
- `runAfterCommitKeyed(client, namespace, key, callback)` reserves one slot per key in the callback
  sequence; a later registration with the same key replaces the callback (first position, last
  payload). Relation invalidations use it to emit one event per item/property key.
- Realtime relation messages stay under the `NOTIFY` payload limit
  (`backend/packages/realtime/src/pgNotifyPublisher.ts`): above 7000 serialized bytes `propertyKey`
  becomes `null`, which tells consumers to refetch all links of the item. A publication problem never
  rolls back a write.

### Work that must be durable

- Work that must be retried, awaited or survive a restart is a queue job enqueued **inside** the
  write's transaction (`enqueueJob(client, ...)`, `backend/packages/queue/src/index.ts`), so it
  commits or vanishes with the data it describes. Rollup recomputes, heartbeat fires and
  page-title-mirror jobs are enqueued this way.
- Search-index jobs are registered with `registerSearchJob(client, job)` and added at the pre-commit
  flush, grouped by job key in deterministic order under the tenant's search-flush advisory lock.
- `runBeforeCommitOnce(client, key, flush)` registers one pre-commit flush per key for the active managed
  transaction; the flushes run in registration order after the search-lane flush and right before `COMMIT`, a
  failing one rolls the transaction back, and a savepoint rollback does not withdraw one. Registration closes when
  the body returns. A flush takes its locks last, after every lock of the body. The mail thread change stamp is the
  one flush (`mail/mailThreadChanges.ts`, see `domain-mail-and-inbox.md`, Thread list changes).
- Blob bytes are deleted after commit, best-effort, for the storage keys the committed transaction
  returned; a failure leaves unreachable bytes but never undoes the commit.

### Guards and idempotency

- A guard that decides whether to write runs before the write.
- An idempotency check reads inside the transaction it protects (`insertItemWithReplay` reserves
  the key and checks for a live replay in the write transaction).
- A replay returns the stored result and runs no hooks, transforms, heartbeats or invalidations.

## Non-transactional calls

### Staleness-checked brackets

No transaction is held open across a provider call, AI gateway call, HTTP request or other
non-transactional work. Such work is bracketed:

1. **Read transaction** (typically `repeatable_read`) captures one consistent snapshot of the inputs
   plus the identity/state needed to detect change (row owner and `updatedAt`, derived values as exact
   strings).
2. **External call** outside any transaction; a failure writes nothing.
3. **Write transaction** reloads and re-derives the same values and requires an exact match before
   writing. A mismatch throws a distinct retryable error per stale input and writes nothing; the
   caller retries the whole sequence.

Reference implementation: project agent guidance drift
(`backend/packages/application/src/projectAgentGuidance/`, `GuidanceChangedError`,
`GuidanceContextChangedError`).

- Transforms and hooks run inside the transaction and therefore must not call external services.
- Byte and native I/O (blob reads, image decode) runs outside database transactions. A transferred
  blob stream has exactly one owner that settles it with `settleBlobReadStream`
  (`backend/packages/shared/src/settleBlobReadStream.ts`); a cleanup failure is fatal to the
  operation, unlike an ordinary unreadable-content outcome.

### Provider write-backs (desired/current state)

- Provider-backed user state that must converge (mail flags) stores the desired value in the same
  transaction as the item write and the last provider-confirmed value separately
  (`mail_message_flag_sync_state`, `data/mail/mailMessageFlagSyncStore.ts`).
- The declared sync owner lists rows where desired ≠ current, performs every provider write, and sets
  current only after all succeed. Provider observations update current but never overwrite a
  differing desired value. The gap is the durable retry queue.
- Account calendar Events record a user's or agent's change as a pending row of
  `calendar_event_push_state` (a revision every change raises) in the Event write's transaction, which
  holds the Event's row lock, and queue `calendarEventPush` in the same transaction
  (`data/calendar/sync/eventPushHooks.ts`). The job calls the provider with no transaction open and
  stores each result in its own transaction under the account's calendar sync guard, the Event's
  account calendar `FOR SHARE` and its row; it sets the status only while the revision it pushed is
  still current. A sync pass leaves an Event with a pending push unwritten (checked under the Event's
  row lock) and re-queues the push, which merges the provider's change per field against the last
  base, the provider winning a field changed on both sides
  (`data/calendar/sync/eventPushJob.ts`).

## Exactly-once approved operations

The approval flow itself is in [agents-approvals-and-ai.md](agents-approvals-and-ai.md); the
transactional contract is:

- `computeDestructiveResourceProjection` (`data/chokePoint/destructiveProjection.ts`) runs the same
  checks as the direct mutation and hashes a projection of the resource. The snapshot is stored on
  `approval_requests` when the request is created and recomputed at execution; a mismatch
  terminalizes the request as `conflict`.
- `execution_status` (`queued → succeeded | conflict`) is separate from the human decision.
  `replayApprovedGenericOperation` (`backend/packages/application/src/genericOperationGateway.ts`)
  locks the request, returns a terminal result unchanged on redelivery, and commits the mutation and
  the terminal status together.
- Direct and approved executions call the same `*WithClient` mutation; there is never a second
  implementation.
- An approval projection that must hold related state (item patch → its database row) reserves it
  with `FOR SHARE NOWAIT`, re-reads under the reservation, and holds it through the mutation;
  contention is the transient `ApprovalResourceBusyError`.

## Locking conventions

### General rules

- Writers run at READ COMMITTED. Protected paths that rely on fresh statement snapshots check the
  actual `transaction_isolation` and refuse anything else (`databaseRowLocks.ts`,
  `derivedValueAdmission.ts` → `ConflictError` `unsupported_isolation`); they never change it.
- Row locks are taken with typed helpers in the owning store (`itemsStore.lockItemById`,
  `lockTrashedItemBefore`, `lockItemTrashEpoch`, `databaseRowLocks.ts`, `lockLiveItem`).
- A writer locks an `items` row `FOR NO KEY UPDATE`, never `FOR UPDATE`, so the `FOR KEY SHARE` every
  foreign key to the item takes at commit for a dependent row written in the transaction (an edge, a view
  membership, ...) does not wait on it. Only a statement that deletes the item, and `lockTrashedItemBefore` ahead of the
  purge's delete, takes `FOR UPDATE`. Wherever these documents say an item is locked `FOR UPDATE`,
  that is this `FOR NO KEY UPDATE`; both conflict with each other and with `FOR SHARE` alike.
- Several rows of the same kind are locked in one statement, in id order, before the first of them
  is written.
- A predicate that decides whether to lock belongs in the locking statement itself (re-evaluated
  against the latest committed row), not in an earlier read.
- No lock is held across external work; no hook waits on a provider.
- A deadlock (`40P01`) or serialization failure (`40001`) is never mapped to a domain error inside the
  data layer. Inside `retryingTransientConflicts` (`data/db/pool.ts`), a READ COMMITTED
  `withTransaction` that fails with one is rolled back and its body run again in a fresh transaction,
  at most `TRANSIENT_CONFLICT_ATTEMPTS` (3) attempts; then the original error propagates. A
  transaction opened inside a body being retried is not retried on its own. Transactions with an
  explicit isolation level are never retried: their callers handle the conflict (the Inbox tick's
  own retry, the guidance routes' 409). The HTTP adapter runs every handler in this scope; workers,
  scripts and direct data-layer calls do not, so a lock-order test still sees the deadlock.
- A transaction body is therefore safe to re-run: it does no external work and keeps no state
  across attempts other than what it returns.

### Busy refusals

Paths that cannot impose a global order use nonblocking admission instead of waiting:

- Value-link relation writes (`data/chokePoint/valueLinkRelationAdmission.ts`): nonblocking hook
  locks, `pg_try_advisory_xact_lock` on the relation definition, `FOR UPDATE NOWAIT` on the edge, then
  a transaction-local `lock_timeout` of `1ms` (restored afterwards) around the authoritative
  `FOR SHARE NOWAIT` link check and the mutation. Contention is 409 `value_link_busy`.
- Guarded manual relation creation (`derivedValueAdmission.ts`): try-locks the relation definitions,
  `NOWAIT` row reservations, then a fresh statement assesses the graph. Contention is
  `ConflictError` `resource_busy`.
- Only an actual `pg.DatabaseError` with SQLSTATE `55P03` (or a false try-lock) is mapped to busy;
  every busy marks the invocation rollback-only.

### Mandatory lock orders

A change to any of these paths must keep the order:

- **Item update:** module pre-lock hooks (e.g. the Calendars default-mark advisory lock) → item row →
  value-link rows.
- **Value-link item write:** item row before any link row; required link keys checked in sorted order.
- **User/agent edge write on a link rule's via relation:** edge row → rule target item rows
  (`linkRuleEdgeLockHook`, before-link-break hook) → value-link rows (`project` → `people` →
  `company` for one item).
- **Rollup dependency vs. source archive:** `upsertRollupDependency` takes `FOR SHARE` on the source
  `databases` row; archive/restore's `UPDATE` of that row waits, then scans dependencies in a new
  statement.
- **Approval item patch:** database row (`FOR SHARE NOWAIT`) → item row (`NOWAIT`).
- **Pages:** host row → subpage rows (id order) → host document. The page title mirror, `page.rename`,
  `page.duplicate`, `page.createSubpage`, `page.replace` and host/page trash follow it. The mirror
  job locks only children whose `parentItemId` is its host.
- **Page documents:** `loadDocWithClient` and `mutateDocWithClient` lock the document's stored rows
  `FOR UPDATE`; a document is locked after the rows that precede it above.
- **Trash cascade:** root row (`lockItemById`) → cascade rows → per-row hooks.
- **Pre-commit:** every lock of the transaction body → the search-flush advisory lock → the tenant's
  `mail_thread_change_counters` row → its `mail_thread_changes` rows. The counter row is held from the flush to
  `COMMIT` and only ever waited for by a transaction that already finished its body, so it closes no cycle.
- **Permanent purge:** tenant purge advisory lock → item row (`lockTrashedItemBefore`) → its
  dependents.
- **Archived database purge:** `FOR NO KEY UPDATE` on the database row first in every deleting
  transaction.
- **Relation property vs. target database delete:** `createRelationPropertyWithClient` reads the
  target `databases` row `FOR KEY SHARE` and holds it to commit; a purge deleting that database
  (`deleteDatabaseWithItems`) either waits for the relation's commit or, having deleted the row first,
  makes the read wait and then miss it (`validation_failed`). This orders the two; it does not remove
  the relation: when the creation commits first, the purge has already listed (or, for an inline
  database of a purged item, never lists) the dependent schema, so the new relation property keeps
  naming the deleted database. That was already so with partitions.

### Advisory locks

| Key | Held by |
|---|---|
| `hashtextextended(relation_definition_id::text, 0)` | relation cardinality trigger on every edge insert; try-locked by protected relation admissions |
| `trash-purge:v1:<tenant uuid>` | `purgeExpiredTrashSubtree`, from entry to end of transaction; tenant from `app_tenant_default()` only |
| `pages-database:<tenant>` | first creation of the hidden Pages database |
| search-flush class + tenant hash | pre-commit search-lane flush |
| `calendars-default:<tenant>` | every writer of the Calendars default mark, before the calendar rows (`data/calendar/calendarRowHooks.ts`; `calendarItemUpdatePreLockHook` when a patch names `isDefault`) |

- Locks that guard a write are transaction-scoped (`pg_advisory_xact_lock`). Session-scoped
  try-locks are used only as single-runner guards for long jobs (tenant purge, module data
  migration, speech synthesis) and are released by their owner.

### DDL locks

- The choke point runs no DDL: creating or deleting a database writes rows only, so database writes of
  different tenants never wait on each other's locks.
- A schema change that must drain concurrent validating writers takes an explicit table lock with a
  bounded `SET LOCAL lock_timeout`, once, and fails rather than waits indefinitely.

## Chunked background sweeps

- A sweep over an unbounded set runs in keyset-paginated pages, each its own `withTransaction`:
  `WHERE <due predicate> AND id > $afterId ORDER BY id LIMIT <chunk> FOR UPDATE SKIP LOCKED`.
- The due predicate, not the cursor, prevents re-processing: a processed row leaves the predicate in
  its own committed page; a skipped locked row is picked up later.
- Each run is capped (heartbeats: `SWEEP_CHUNK_SIZE` = 100 in `data/scheduler/schedulerStore.ts`,
  per-tenant chunk cap in `data/scheduler/sweep.ts`); the rest waits for the next tick.
- Times are taken from the database (`now()` selected in the query), not the application clock.
- A failing page fails the task; committed pages stay committed. A sweep that needs whole-run
  atomicity must not use this pattern.
- System work fans out per tenant; each tenant's work runs in that tenant's scope.

## Queue

- Jobs run on graphile-worker through `backend/packages/queue/src/index.ts`. `enqueueJob` wraps the
  payload in an envelope whose `traceId` and `tenantId` come only from the producer's scope, never
  from the payload.
- Each task has an affinity (`CORE_TASK_AFFINITY`: `api`, `agents`, `transcribe`) that decides
  which service runs it; the routing table travels as `queueAffinity` through choke-point options.
- Per-tenant serial lanes use `tenantLane(lane)` (`data/tenancy/tenantLane.ts`), `<lane>:<tenantId>`.
- Debounced and deduplicated work uses a `jobKey` (`replace` or `preserve_run_at`); `cancelJob`
  removes a keyed job transactionally.
- A handler is idempotent: redelivery and retry must be safe, either by a terminal state it checks
  under lock or by an operation that converges.
