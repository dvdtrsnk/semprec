---
status: accepted
date: 2026-11-07
area: [backend]
supersedes: []
superseded-by: null
---

# The task series cutover backfills as the Tasks owner in bounded, resumable transactions

## Context

Issue #1605 gives every active legacy `task_recurrence` row a series (`series_id`, `anchor_date`, `template`) and
writes `seriesId`, `occurrenceDate` and `recurrence` onto the row's Tasks instance. The step is the per-tenant cutover
`tasks/taskRecurrenceSeriesCutoverMigration.ts`, run by `runTenantCutoverMigrations`.

Three accepted decisions meet in this step:

- [[2026-09-10-choke-point-api-for-state-writes]] routes item writes through the choke point. The three properties
  are system-owned Tasks properties that only the Tasks module writes, inline in the choke point
  ([[2026-10-25-task-and-event-recurrence-model]], Ownership). A historical backfill written through the choke point
  would change `updated_at`, run the item hooks, enqueue search and rollup jobs and announce invalidations and
  heartbeat events for rows that no user changed.
- [[2026-09-10-expand-contract-forward-only-migrations]] asks for batched backfills that do not hold long locks. The
  first implementation of the step held the row locks of every candidate item and recurrence row in one transaction
  per tenant, for as many rows as the tenant has.
- Issue #1605 requires that a missing Tasks instance or an invalid or missing date fails the cutover rather than
  inventing an anchor or reporting a skipped row as success.

[[2026-11-07-calendar-cutover-uses-bounded-transactions]] made the same trade for the calendars cutover's Event
edges: bounded transactions, valid partial progress, resume on the next run.

## Decision

1. **Narrow exception to the choke point.** This step, acting as the Tasks owner, writes with SQL exactly two
   things: the `task_recurrence` columns `series_id`, `anchor_date` and `template` of the row it converts, and the
   keys `seriesId`, `occurrenceDate` and `recurrence` of that row's Tasks instance, merged into `properties` with
   `jsonb ||`. It writes no other item key, leaves `updated_at` as it is and emits no event, job, invalidation or
   notification. The exception covers this step only and is not a writer other code may call. The advance, client
   writes and the future recurrence routes keep writing through the choke point and the Tasks owner.
2. **Preflight.** Before any conversion write the step reads every candidate (an active row without a series) in
   keyset chunks of at most 500 rows by `item_id`, each chunk in its own transaction, without locks. A candidate
   whose instance is done is not converted. Any other candidate must have an instance in the tenant's Tasks database
   with a valid calendar `date`. When one does not, or active candidates exist and the tenant has no Tasks database,
   the step throws with the offending item ids and writes nothing. The preflight is a check of the stored state when
   it ran, not a reservation: it holds nothing, and rows may change after it.
3. **Conversion.** Each conversion transaction takes the next at most 500 candidates after the last one handled. It
   locks their Tasks instances `FOR UPDATE`, then their `task_recurrence` rows `FOR UPDATE` (still active and without
   a series), each in `item_id` order, the lock order of [[2026-10-25-task-and-event-recurrence-model]]. It decides
   only from what it read under those locks, writes the rows that pass and commits. No lock is held from one
   transaction to the next. A row that fails the check under the locks, such as an instance whose date was cleared
   after the preflight, makes that transaction throw and roll back, and the error reaches the tenant runner.
   Transactions committed before it stay committed. Nothing is retried within a run.
4. **Resume.** A later run selects only rows that still have no series and converts what is left. A run after a
   complete one writes nothing.

## Consequences

- A failed or interrupted run leaves valid partial progress: some instances carry their series and some do not. A
  converted instance is in the state a series started by the Tasks owner is in, and an unconverted one is in the
  pre-#1605 state, where completing it advances nothing. Readers between transactions see a partly converted tenant.
- A run that fails in a later transaction reports the failure even though earlier transactions committed. It is not
  reported as complete. The rows of the failed transaction keep no series until the cause is repaired and the step
  runs again.
- A second run of the step that overlaps the first waits on the row locks. Once the first transaction commits, the
  `series_id IS NULL` condition of the waiting `task_recurrence` lock no longer matches the converted rows, so they
  are not converted twice.
- A deploy that converts n candidates in a tenant runs about n / 500 conversion transactions after the preflight
  chunks, and holds at most 500 item and 500 recurrence row locks at a time.

## Alternatives considered

- **Backfilling through the choke point.** It would stamp `updated_at` and emit events, jobs and invalidations for
  history no user wrote, and run the item hooks once per historical row.
- **One transaction per tenant (the first implementation).** It meets "fail unchanged" literally, but it holds the
  locks of every candidate for the whole run, which the expand/contract decision asks backfills to avoid.
