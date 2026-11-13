---
status: accepted
date: 2026-11-13
area: [backend]
supersedes: []
superseded-by: null
---

# Trashing an Event recomputes its tasks and keeps the edges; restoring it deletes the edges, task row first

## Context

[[2026-11-12-task-host-state-is-recomputed-in-the-writing-transaction]] lists three triggers that write a task's
`hiddenUntil` and `effectiveDate`. Issue #1819 adds two more, on the delete and restore hooks of the Events
database ([[2026-11-07-item-delete-and-restore-domain-hooks]]), in `tasks/eventHostedTasksHooks.ts`. The Events
hook writes tasks and, on restore, deletes an edge of the relation `Tasks.hostEvents` (`Events.hostedTasks`, its
inverse), which only the Tasks process may write. That record is accepted and is not edited; this one adds the two
triggers and the contract of the restore.

## Decision

**Trashing an Event is a recompute trigger, and the edges stay.** The delete hook calls `recomputeTaskHostState` for
every live task the Event hosts, in the order of the task ids, in the cascade's transaction. The Event is trashed, so
it no longer counts as a host Event and each task returns to the day of the host Event added before it, or to its own
date. The `Events.hostedTasks` edges are not touched, so a reader can still count the tasks that return while the Event
is in the Trash (`countTasksReturningFromEvent`). The `completedInEvent` edges are never touched by either hook.

**Restoring an Event deletes the edges of its live tasks; it does not link them again.** This is the product rule that
restoring a source does not link things again. The restore hook deletes each `hostedTasks` edge with
`deleteRelationWithClient` as the Tasks process (`ownerProcess: tasks`), which recomputes the task through the edge hook
of the host state ADR. The edge's `addedAt` is discarded for good: restoring the Event cannot bring the task back into
it, and putting the task back is a new `PUT /api/tasks/:id/host-events/:eventId` with a new `addedAt`. An edge to a task
that is in the Trash stays.

**The restore hook locks the tasks before it deletes any edge.** The routes of issue #1764 lock the task row and then
write or delete its edges. A deletion that took the edge row first would reach the task's lock in the edge hook, the
opposite order, and a concurrent route for the same task and Event would deadlock with it (`40P01`, one of the two
transactions aborted). The hook therefore locks every hosted task row (`lockItemById`), in the order of the task ids,
and only then deletes the edges of the tasks that are still live after their lock; the edge hook's own lock of the
task is then a lock it already holds. The delete hook needs no such step: it takes task locks only, in id order.

## Consequences

- A reader of the host state ADR finds all five triggers across the two records. Any new writer of a `hostEvents` edge
  locks the task row before the edge.
- Restoring an Event is lossy by design: the tasks do not return and their `addedAt` is gone.
- A route that deletes the same edge between the hook's read of the edges and its lock of the task wins; the hook then
  deletes nothing for that task, which is the outcome the restore asks for.
- The restore takes one extra lock per hosted task and waits for a transaction that holds one of them, instead of
  failing with a deadlock.
