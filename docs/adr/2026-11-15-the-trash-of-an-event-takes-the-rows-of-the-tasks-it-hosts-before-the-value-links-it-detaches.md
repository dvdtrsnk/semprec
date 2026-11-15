---
status: accepted
date: 2026-11-15
area: [backend]
supersedes: []
superseded-by: null
---

# The trash of an Event takes the rows of the Tasks items whose value links it detaches before those links

The file name keeps the wording of the source that created this record, which says "the tasks it hosts"; the rows the trash takes are those of the Tasks items whose links it detaches, as the Decision states, and a hosted task is among them only when it is also sourced from the Event.

## Context

[[2026-11-15-a-user-edge-write-on-a-link-rules-via-relation-locks-the-rules-target-item-before-ending-value-links]] states that an item's row comes before its value link rows and lists three paths of the tree that do not follow it. This decision repairs the second of them, without editing that record: the trash of an Event that hosts a task which is also sourced from it.

Moving an Event to the Trash runs its item delete hooks in the order `domainWriteHooks.ts` registers them ([[2026-11-07-item-delete-and-restore-domain-hooks]]). `valueLinkSourceDeleteHook` is registered early and locks the value links the Event is a source of. `eventHostedTasksDeleteHook` (`tasks/eventHostedTasksHooks.ts`, [[2026-11-13-event-trash-and-restore-write-the-tasks-they-host]]) is registered much later, after the host-state hooks, and then recomputes each task the Event hosts, which locks the task rows in id order. A task that came from an action item of the Event (`Events.actionItems`, `Tasks.sourceEvents`) is also hosted in it (`Tasks.hostEvents`), and its `project` and `people` value links have the Event as a source (rules `taskProjectFromEvent` and `taskPeopleFromEvent`). For such a task the trash took the task's links first and the task row after them. The propagation job for the Event's project (`handleLinkPropagation`, rule `taskProjectFromEvent`) takes the task row and then its `project` link. With a third transaction holding the task row, the propagation started first and the trash second, the trash held the links and waited for the row, and the propagation got the row and waited for a link: `40P01`.

Moving the registration of `eventHostedTasksDeleteHook` ahead of `valueLinkSourceDeleteHook` does not repair it. The trash would then hold the row of a hosted task while it waits for the link of another task that the Event sources but does not host, and the propagation job, which locks item by item (row, link, next row), holds that link while it waits for the hosted task's row.

## Decision

The source detach takes the rows of every Tasks item whose value link it detaches, in item id order, before it takes any link. One statement does it: it selects the ids of the Tasks items (items of the database owned by the module `tasks`) that have a value link with an item source naming the trashed item, in id order, `FOR UPDATE OF i`. Then the detach takes the links in the order of [[2026-11-15-the-trash-of-an-event-locks-the-value-links-it-feeds-in-item-order-then-rule-order]]. The rows locked are those of the Tasks items the detach touches, hosted by the Event or not, so the order of the rows is the order in which the propagation job takes them.

`eventHostedTasksDeleteHook` keeps its place. It iterates every live task the Event holds a `Tasks.hostEvents` edge to. The rows of the hosted tasks that are also sourced from the Event (an action item of it, with a link whose source names it) it finds already locked by its own transaction. A task that is hosted but not sourced from the Event (put into it through the route of #1764 without being an action item of it) has no link the Event feeds, so the detach does not take its row, and the hook locks that row itself, after the links; the trash holds no link of the Event on such a task, so there is no order to invert. `eventHostedTasksRestoreHook` keeps its place. `domainWriteHooks.ts` is not edited. The order of the Event's delete hooks that matters is the order of their registrations:

1. `valueLinkSourceDeleteHook`: the rows of the Tasks items whose links are detached, in item id order, then the links in the order of the decision above;
2. `transcriptCompanyLinkReleaseItemDeleteHook`, registered after it: the `company` link of each transcript linked to the Event, taken last because the release of a removed `event` edge takes `project`, `people` and `company` in that order ([[2026-11-10-transcript-values-are-inherited-by-link-rules-whichever-process-writes-the-edge]]);
3. `eventHostedTasksDeleteHook`, registered much later: it locks the rows of the hosted tasks, of which the first hook already holds those that are also sourced from the Event, and takes the rows of the others itself.

The position of a registration is part of the contract. A later delete hook that locks a row of an item whose links the detach takes must take that row in the detach or before it, because a link that is locked before its item's row is the order this decision removes.

Transcript rows are not taken. A trash that locks them waits for an open transcription match, which `transcriptTrashedEventEdge.test.ts` forbids.

## Consequences

Measured, with production calls on pools of the runtime role `semprec_data`, one pool and one `application_name` per participant, in `tasks/__tests__/eventTrashHostedTaskLockOrder.test.ts`:

- With a third transaction holding the hosted task's row, the propagation of `taskProjectFromEvent` and a user `softDeleteItem` of the Event, in both start orders: both commit and neither ends with `40P01`. On the tree before this change the order with the propagation first ends the trash with `40P01`.
- With the Event sourcing two tasks and hosting only the one with the larger id, a third transaction holding the smaller task's `project` link row, the propagation started first and the trash second: both commit. This commits on the tree before this change, and ends with `40P01` when only the registration of `eventHostedTasksDeleteHook` is moved ahead of the source detach.
- With a third transaction holding the task's `project` link row, the trash waits for it and, while it waits, a `SELECT ... FOR UPDATE NOWAIT` of the task row on another connection fails: the trash holds the row before the link. On the tree before this change the same statement succeeds. After the trash the task has no `project` or `people` link, is back on its own day and the Event is in the Trash.
- `eventHostedTasksHooks.test.ts`, `eventTasks.test.ts`, `actionItemInheritance.test.ts`, `valueLinkSourceDeleteHook.test.ts`, `valueLinkEdgeBreakLockOrder.test.ts` and `transcriptTrashedEventEdge.test.ts` pass unchanged.

Not measured:

- A task that is hosted by the Event but not sourced from it. Its row is taken by the hosted-tasks hook after the detach; the argument that nothing orders against it (the Event feeds no link of that task) was not run as a schedule.
- The restore against the trash of the same Event. Both lock the Event row first, as the root of their cascade, so the Event row serializes them; no schedule was run.
- Other hooks reordered against the hosted-tasks hook.
- The source detach of an item other than an Event takes the rows of the Tasks items its links feed as well, because the statement does not look at what the trashed item is. No schedule was run for such a trash.
