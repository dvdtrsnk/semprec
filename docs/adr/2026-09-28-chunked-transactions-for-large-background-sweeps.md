---
status: accepted
date: 2026-09-28
area: [backend]
supersedes: []
superseded-by: null
---

# Chunked, independently-committed transactions for large background sweeps

## Context

`handleHeartbeatSweepTask` runs once a minute and must fire every heartbeat
whose `next_fire_at` is due. The version it replaced ran the whole sweep —
every due row, however many — inside one transaction: `sweepDueHeartbeats`
selected all due rows with `FOR UPDATE SKIP LOCKED`, computed each row's next
occurrence from the application's `new Date()`, and committed once at the
end.

That shape had two problems, one of resilience and one of correctness:

- **All-or-nothing commit.** One row whose rule failed to parse, or one
  `enqueueJob` call that threw, rolled back every other row's advance in the
  same tick — heartbeats that fired successfully in memory were rolled back
  along with the one that failed, and would fire again (or stay stuck) on
  the next tick.
- **Application-clock skew.** `next_fire_at` was computed from the
  application server's own clock, not the database's. An application clock
  lagging the database clock could recompute a fixed rule's occurrence as
  still in the future when the database considered it due, stalling the
  heartbeat on the `(heartbeat_id, scheduled_for)` occurrence conflict.

Alternatives considered:

- **Keep one transaction, add per-row `SAVEPOINT`s.** This isolates a single
  bad row's failure from the rest of the batch without splitting the
  transaction, but the whole batch's row locks (`FOR UPDATE SKIP LOCKED`)
  are still held for the entire sweep's duration, and an unbounded number of
  due rows (a backlog after downtime) still means an unbounded transaction.
- **One transaction per row.** Maximal isolation, but one round trip per due
  row instead of one per up-to-100 rows; at typical heartbeat volumes this
  is unnecessary overhead for no isolation benefit the chunk size below
  doesn't already give.

## Decision

`sweepDueHeartbeats` takes an `afterId` cursor and does one keyset-paginated
page of work: `SELECT ... WHERE next_fire_at <= now() AND ($1::uuid IS NULL
OR id > $1) ORDER BY id LIMIT SWEEP_CHUNK_SIZE FOR UPDATE SKIP LOCKED`
(`SWEEP_CHUNK_SIZE = 100`), computing each row's next occurrence from that
row's own `now()` (selected as `db_now` in the same query) instead of the
application clock. It returns `{ fired, lastId, exhausted }`.

`handleHeartbeatSweepTask` loops, running each page in its own transaction
via `withTransaction`, feeding `lastId` back in as the next page's `afterId`,
until a page reports `exhausted` (fewer rows than `SWEEP_CHUNK_SIZE`, meaning
no more due rows exist) or `MAX_SWEEP_CHUNKS` (50) pages have run. A page
that throws propagates the error as-is: the task fails and the remaining due
rows wait for next minute's tick, but every page that already committed
stays committed.

**Cursor and `SKIP LOCKED` interaction.** The cursor is a plain `id >
afterId` bound, not a lock. A row a page skips because it is locked by a
concurrent transaction is not "consumed" by the cursor — it keeps `next_fire_at
<= now()` and so is still selected by a later page's `WHERE` clause (subject
to the same `id > afterId` ordering) or by the next tick, once the
concurrent transaction releases it. A row a page successfully fires has its
`next_fire_at` advanced (or cleared, for a floating rule) inside that same
page's transaction, so once committed it drops out of `next_fire_at <=
now()` and is never re-selected by a later page or tick — the cursor and the
due-row predicate are independent, and it is the predicate, not the cursor,
that prevents re-firing.

`MAX_SWEEP_CHUNKS` bounds one tick to `MAX_SWEEP_CHUNKS * SWEEP_CHUNK_SIZE`
(5 000) rows; a backlog beyond that waits for the next minute's tick rather
than one tick running unbounded.

## Consequences

- A sweep's rows are no longer all-or-nothing: a failure partway through
  commits every earlier page and leaves the rest due for the next tick,
  instead of rolling back a whole tick's progress for one bad row.
- Two heartbeats that were due in the same tick, and land in different
  pages, are no longer guaranteed to be visible to readers atomically — a
  reader between pages sees the first page's advances but not the second's.
  Nothing in this codebase currently depends on whole-sweep atomicity; if a
  future consumer needs it, that consumer must not assume this sweep
  provides it.
- Computing `next_fire_at` from each row's own `db_now` instead of the
  application clock removes the failure mode where an application-clock lag
  stalls a heartbeat, at the cost of one extra selected column; nothing else
  in the query changes.
- This pattern — cursor-paginated `SKIP LOCKED` pages, each its own
  transaction, looping until a short page or a chunk cap — is not applied
  automatically to other sweeps (mail sync, notification fanout, trash
  purge). Each of those should evaluate this ADR against its own volume and
  atomicity needs rather than assume the pattern transfers; none is changed
  by this decision.
