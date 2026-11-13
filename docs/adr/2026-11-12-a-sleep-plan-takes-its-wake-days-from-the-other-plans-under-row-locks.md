---
status: accepted
date: 2026-11-12
area: [backend]
supersedes: []
superseded-by: null
---

# A sleep plan write takes its wake days from the other plans under row locks, and a deadlock answers 409

## Context

A sleep plan lists the weekdays on which it applies (`wakeDays`), and a weekday belongs to at most one plan, so a
client moves a day with one PATCH of the receiving plan. The invariant spans the rows of one database. The
validation hooks of the sleep module judge one item at a time and the settings and night rules use an advisory
lock per key ([[2026-09-30-choke-point-domain-hooks-through-a-per-process-registry]]); a day is held by a plan
row, so the rows that hold it are the natural thing to lock. Issue #1799 fixes the design: after the write, a hook
locks the other plans' rows with `SELECT ... FOR UPDATE` and a `40P01` raised by that select is answered as a 409.

The pre-lock registry of [[2026-11-12-an-update-takes-the-module-locks-before-it-locks-the-row]] is not used. A
pre-lock hook receives the caller's patch and runs before the written row is locked, so for an update whose patch
names `wakeDays` it could already tell which days are taken. It does not help the two cases it cannot see: a create
has no pre-lock hook, and a patch that does not name `wakeDays` (a rename, a move to another `position`) still
writes a plan whose stored days overlap others, so no point before the write knows which plans to lock. A row
lock taken before the write on the plans the patch names would also leave the cycle in place, because two plans
that exchange days still wait for each other's row.

That differs from the calendar default mark
([[2026-11-12-calendar-rows-keep-one-default-under-an-advisory-lock]]). There one advisory lock stands in front
of every writer of the mark, so the order of locks could be fixed and the deadlock was removed, and that ADR
rejected mapping the deadlock to a conflict because a request that did nothing wrong would fail. Here the lock
needed is on the other plans' rows, the set of rows depends on the data, and no fixed order covers a create and
every patch; the deadlock between crossing moves is answered with a retry instead.

## Decision

The sleep module registers one function as create and update hook for `sleepPlans`
(`keepWakeDaysInOnePlan`, after its validation hooks). After a write whose merged item has non-empty `wakeDays`:

- It selects the other non-deleted plans of the database that hold any of those days with
  `SELECT ... ORDER BY id FOR UPDATE`, and removes the taken days from each through `updateItemWithClient` without
  `ifVersion`, so the plan's hooks, realtime invalidation and `updatedAt` apply. A plan that loses all its days
  keeps `wakeDays` `[]`.
- It repeats the select as a new statement until two statements in a row return no plan. Under READ COMMITTED a
  statement that waited for a plan another transaction was changing rechecks that plan against its new version
  but does not see a plan that transaction committed meanwhile and that now holds the day; the second statement
  starts after the first one ended and sees it.
- The nested update runs the update hooks again. A transaction that is removing days skips this hook, so a plan
  that lost days does not take its remaining days from a third plan.
- A `40P01` (deadlock detected) raised by the select statement is rethrown as `ConflictError` (HTTP 409). Two
  writes that take days from each other's plans hold their own plan's row lock (the choke point took it) and wait
  for the other's, so PostgreSQL ends one; the client repeats the request, which succeeds. No other statement's
  error is mapped.

## Alternatives rejected

- An advisory lock per tenant, taken by a pre-lock hook. It makes every plan write wait for every other one, so
  non-crossing writes would not proceed together, and it removes the lock cycle instead of answering it.
- Looping once per statement only until the first empty result. It leaves a day in two plans when the select
  waited for another transaction that moved the day into a plan the statement could not see.

## Consequences

- Two writes that take the same day from a third plan serialize on that plan's row; non-crossing writes do not
  wait for each other.
- A day that no committed plan holds is not locked: two transactions that put the same free day into two plans
  can both commit. The decision does not cover it.
- A restore from the trash is not checked, and an overlap it brings back stays until the next write of one of the
  plans: that write takes the day from the others.
- A write of a plan, a rename included, takes row locks on every other plan that overlaps its days.
