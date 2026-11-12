---
status: accepted
date: 2026-11-12
area: [backend]
supersedes: []
superseded-by: null
---

# A task's host state is stored, and recomputed in the transaction of the write that changes it

## Context

A task placed in an Event (`Tasks.hostEvents`, written by the routes of issue #1764) is hidden from lists, counts
and days until the last of its host Events has ended, and meanwhile its day is the day of the Event it was put into
last. Issue #1540 added two properties for this to the Tasks schema, both `owner: system` with the owner process
`tasks`: `hiddenUntil` (a date with time) and `effectiveDate` (a date). The nightly rollover already selects on
them in SQL ([[2026-11-09-task-rollover-excludes-its-current-result-state]]), and the lists and counts (issue
#1798) and the calendar (issue #1880) are to filter and sort by them. Computing them on every read from the edges and
the Events would put a join over two databases into each of those queries.

## Decision

**The values are stored.** `computeTaskHostState` (`tasks/taskHostEventState.ts`) is a pure function of the task's
`date`, its live host Events ordered by the edge's `addedAt`, the tenant zone and the clock. `hiddenUntil` is the
latest Event end (the event end of `calendarTime.ts`) as a UTC instant while that end is later than now, otherwise
`null`. `effectiveDate` is the task's `date` when it has no live host Event with a `date`; the `date` of the Event
added last while the task is hidden; and the later of the task's `date` and that Event's `date` once every Event has
ended. A trashed Event and an Event without a `date` do not count.

**Three triggers write them, each in the transaction of the write that makes them stale.**

- A relation edge changed hook on the `hostEvents` relation (any create, update or delete of an edge) calls
  `recomputeTaskHostState` for the task on the edge.
- An item update hook for the Events database, for a write whose stored patch names `date`, `endDate`,
  `timeFrom`, `timeTo` or `time`, calls it for every task that sits in the Event, in the order of the task ids.
- The Tasks pre-write transform stores `effectiveDate` in the same patch when a write names `date` and on create, from
  the task's host Events read through the write's own client. A create reads no Event, because the edges of a new
  task are written after the create.

`recomputeTaskHostState` locks the task row, computes, and writes the keys that differ through
`updateItemWithClient` as the Tasks process (`allowedSystemKeys`, `systemOwnerProcess: tasks`), so the Tasks
transform, the update hooks and the realtime invalidation run as for any other write. A missing or trashed task is
left alone. When the write changes the effective day of a task that is `notDone`, whose previous effective day was
before today and whose `since` is empty, it also records `since` and `sinceTime` with the first-planned-day rule of
issue #1602 (`firstPlannedDay`, the part of `taskSinceRule` that does not depend on the write naming `date`).

**The Events are read without a lock.** The recomputation holds the task's row lock and nothing on the Events it
reads. The route of issue #1764 locks the task before it writes an edge; an Event update locks the Event before the
Events hook locks the tasks. A recomputation that also locked the Event rows would take the two kinds of row in the
opposite order of the routes, and the two paths would deadlock. The cost is a window, not a serialization: a task
edge that another transaction has written but not committed is not found by the Events hook of a concurrent Event
update, and the recomputation that follows that edge reads the Event as it was committed before the update. The task
then keeps the state of the Event's earlier schedule until its next trigger: another edge change, a schedule write of
one of its Events, or a write of its own `date`.

**Time passing is not a trigger.** `hiddenUntil` and `effectiveDate` are the values as of the last trigger. When an
Event ends, nothing here changes them. The job that clears `hiddenUntil` at the end time (issue #1782) is the reader's
counterpart, and a reader compares a stored `hiddenUntil` with the clock.

**A data migration backfills the stored values of existing tasks.** `backfillTaskEffectiveDate` sets `effectiveDate`
to `date` on a task that has a string `date` and an empty `effectiveDate`, and changes nothing else. It is the Tasks
transition from 1.2.0 to 1.3.0 in the manifest of the system databases, run by the module data migration runner
([[2026-09-28-two-pass-skip-locked-module-data-migration]]). It reads no Event: a task that already sits in an Event
gets its state from the next trigger.

## Consequences

- Every path that writes an edge or an Event schedule is covered by one registration in `domainWriteHooks.ts`: the
  routes of issue #1764, the generic item endpoints and operations that change an Event, and internal code.
- Each of those writes now also writes the tasks it touches. An Event update with many hosted tasks writes each of
  them whose state changes, and announces each after the commit.
- A reader can rely on `effectiveDate` after the migration for every task with a `date` that sits in no Event; a task
  already in an Event is corrected by its next trigger. It cannot rely on `hiddenUntil` being cleared at the moment an
  Event ends.
- The window above is bounded by the next trigger. Closing it needs a common lock order between the routes and the
  Event writes, which is a change to the routes of issue #1764 and to the Event write path, not to this recomputation.
