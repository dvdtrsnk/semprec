---
status: accepted
date: 2026-11-08
area: [backend]
supersedes: []
superseded-by: null
---

# The nightly Tasks rollover writes the user-owned schedule through one handover function, in two bounded passes

## Context

Issue #1674 moves every unfinished one-off task whose day has passed to the new day at midnight in the tenant's
system time zone, as an all-day task, so every reader sees the moved date (a read model that computes the day without
writing was considered and not adopted). The task's `date`, `timeFrom` and `timeTo` are `owner: 'user'`;
[[2026-09-10-single-writer-ownership-model]] allows a second writer of such a field only through an explicit handover.
The existing handover of that kind is `convergeObservedEmailFlagsWithClient` in `chokePoint/itemWrites.ts`.

The rollover is a background sweep over possibly many rows of one tenant. [[2026-09-28-chunked-transactions-for-large-background-sweeps]]
pages the heartbeat sweep with `FOR UPDATE SKIP LOCKED` chunks, each committed on its own, capped by
`MAX_SWEEP_CHUNKS_PER_TENANT`, and leaves a skipped row for a later tick. The rollover runs once a day, so a task a user
was editing at midnight must not wait a whole day; [[2026-09-28-two-pass-skip-locked-module-data-migration]] already
solves that for data migrations with a second pass that waits for the skipped rows.

## Decision

- `rolloverTaskWithClient` in `chokePoint/itemWrites.ts` is the one system write of Tasks' `date`, `timeFrom` and
  `timeTo`: it writes `date` and clears both times through `updateItemWithClient`. The Tasks transform therefore sets
  `since`/`sinceTime` by the first-planned-day rule and derives `time` as for any write of `date`. It passes no acting
  user, so each moved task announces an invalidation to every socket of the tenant, and it writes no `status`, so the
  series advance does not run. Only the rollover action calls it.
- The action `core.tasksDayRollover` (`tasks/tasksDayRolloverAction.ts`) runs from a `dailyTime` 00:00 heartbeat of
  the tenant's Semprec project, in that tenant's scope. A candidate is a live `notDone` task without `seriesId` whose
  effective day (`effectiveDate` when set, otherwise `date`) is a calendar day before today, whose `hiddenUntil` is
  empty or before now, and which has no `completedInEvent` edge.
- Pass one pages through the candidates by id, `CHUNK_SIZE` (100) rows per committed transaction, with
  `FOR UPDATE SKIP LOCKED`. Pass two then repeats from the start with `FOR UPDATE`, waiting for each row another
  transaction holds, until a chunk finds no candidate. Each pass runs at most `MAX_SWEEP_CHUNKS_PER_TENANT` chunks
  (exported from `scheduler/sweep.ts`, the heartbeat sweep's cap); candidates beyond that wait for the next night.
- A moved task's day is today, so it is no candidate again that day: a rerun changes nothing, and after an outage of
  several days one run writes each task once, with the date of the run.

## Consequences

- The cap bounds the number of chunks each pass commits, not wall-clock time: a chunk of pass two waits as long as
  another transaction holds one of its rows. The run ends only when those transactions do.
- The rollover is the second writer of three user-owned Tasks fields, recorded here and in the function's doc comment;
  any other system process that needs to move a task's schedule needs its own decision.
- A moved task's `since` keeps the first planned day across later moves, because the first-planned-day rule records it
  only while it is empty.
- Until the event-derived effective day (#1780) and the Tasks today view (#1798) exist, nothing writes `effectiveDate`
  or `hiddenUntil`; the rollover reads them as described and falls back to `date`. Recurring series are not moved;
  closing their stale occurrences is #1677, which extends this action.
