---
status: accepted
date: 2026-11-14
area: [backend]
supersedes: []
superseded-by: null
---

# A recurring task series is trashed and restored as one cascade, through a registered cascade expansion

## Context

[[2026-11-07-item-delete-and-restore-domain-hooks]] gave the trash cascade of `itemDeleteWithClient` and the restore
cascade of `restoreItemWithClient` their hooks and fixed the rule that decides which rows a restore brings back: the rows
that share the root's `deleted_at`, the cascade epoch. The rows a cascade reaches, however, are only the item and the
items of the inline databases nested under it (`collectItemSubtree`).

A recurring task series is a set of separate Tasks rows, one per occurrence, with the same `seriesId`, and one
`task_recurrence` row that points at the current open instance ([[2026-10-25-task-and-event-recurrence-model]]). Deleting
any instance of a series has to delete the whole series, and restoring any one of them has to bring the whole series back
and turn the repeat rule on again. `chokePoint/itemTrash.ts` must not learn about Tasks: the `chokepoint-knows-no-domain`
rule keeps a domain out of the choke point, and [[2026-11-07-item-delete-and-restore-domain-hooks]] narrowed the file's
exception to the permanent purge.

The confirmation of a delete also has to say what else the delete affects: how many instances the series has, how many
attachments stay in Files, and how many Events stop showing the task. The preview of issue #1856
(`GET /api/items/:id/delete-impact`) knows neither series nor those two relations, and the approval snapshot of an agent's `item.delete` covers only the root item.

## Decision

**Cascade expansion.** `chokePoint/hooks.ts` gains a registry of cascade expansions, keyed by owning module id and
holding at most one per module (`registerItemCascadeExpansion`). An expansion receives the cascade's root and its database
and returns more rows, in any state, that the module trashes and restores together with the root. `collectCascadeRows`
(`chokePoint/itemSubtreeAccess.ts`) returns the plain subtree of the root and then each row the expansion adds, with the
rows of that row's own inline databases; a row appears once. The delete, the restore and the purge in `itemTrash.ts` and the
agent access check of the approval projection walk it instead of `collectItemSubtree`. The cascade applies its own rules to
the added rows exactly as to any other: a delete skips a row that is already in the Trash, a restore takes the rows of the
root's epoch (so an instance trashed in another transaction stays where it is), and a purge takes the rows past its cutoff.
Every row runs the delete or restore hooks, the heartbeat triggers, the rollup recomputes and the after-commit invalidations
of the cascade. The impact preview keeps counting the plain subtree.

**Tasks.** `tasks/taskSeriesTrash.ts` registers the expansion for the Tasks module: the other rows of the Tasks database
with the root's `seriesId`. A task without a `seriesId` has no expansion, and its delete and restore are unchanged.
Restoring an instance restores the instances of its epoch and creates no instance.

**The repeat rule.** While a series is in the Trash its repeat rule is off, so the series projects no virtual occurrence.
The Tasks delete hook sets `task_recurrence.active` to false for the series and records, in the new column
`task_recurrence.trashed_active_item_id`, the `item_id` the row pointed at while it was active; it changes nothing for a
rule that is already off. The Tasks restore hook sets `active` back to true, and clears the column, only for the instance the
column names, so exactly one instance holds an active rule after a restore and a rule the user had turned off before the
trash stays off. The column is the one record of why the rule is off; `active` stays the one source of whether it is on.
If the recorded instance is not among the rows the restore brings back, the rule stays off.

**Locks.** The Tasks module registers an item delete pre-lock hook, an item restore pre-lock hook
([[2026-11-12-deleting-a-calendar-takes-the-default-mark-lock-and-its-events-into-its-epoch]]) and an item purge pre-lock hook
(`registerItemPurgePreLockHook`, run by `purgeExpiredTrashSubtree` once it found the root eligible and before it walks the
cascade or locks a row). Before the cascade locks the named task they lock every instance of its series `FOR UPDATE` in id
order and then the series' `task_recurrence` row, which is the order of the recurrence model (items before
`task_recurrence`), and read the instances again until a pass returns the ids the previous one locked. The advance of a
series and the materializing of an occurrence store a new instance only while holding the current instance or the series
row, so once the cascade holds both, no instance is added until it ends, and the expansion sees every instance. A trash, a
restore and a purge of one series therefore take the same rows in the same order whichever instance each names; the purge
needs the hook because its delete loop locks the root first, which is not the lowest instance when the root is a later
one, and its delete of the root's dependents removes the series row. Nothing here claims serialization of a delete with a
write that holds none of these rows.

**Delete impact.** `chokePoint/hooks.ts` also gains a registry of delete impact readers, one per owning module
(`registerItemDeleteImpactReader`, `readItemDeleteImpact`). A reader receives the item, its database and the reader of
the answer (an agent's project, an external client, or none for a person and the system) and counts nothing that reader
may not read. The Tasks reader counts `seriesInstanceCount` (the live instances of the task's series, itself included; 0
for a task without one; a series is the task's own, so it is not filtered), `attachmentCount` (live targets of
`Tasks.files`, whose inverse is `Files.tasks`) and `hostEventCount` (live targets of `Tasks.hostEvents`). Files and Events
are non-sensitive system databases that every reader may read, but a Files item inherits the sensitivity of a sensitive
item it is linked to ([[2026-11-13-items-linked-to-a-sensitive-record-inherit-its-sensitivity]],
`agentGrants/inheritedSensitivity.ts`), so for an agent's project the two counts leave out a target in a database the
project may not read and a target of a sensitivity-inheriting database that is linked to a database it may not read, the
decision of the point check and of the lists; an external client is held to the first part only, as it is by the point
check. The preview adds the three numbers to its answer, 0 for an item whose module has no reader. The `item.delete`
projection first takes the owning module's delete pre-lock locks, as `itemDeleteWithClient` does and holds them to the end
of the transaction that also runs the delete of an approved request, so no instance can be stored between the impact it reads
and the delete; it then reads the item and adds the numbers, counted for the writer's reader, to the projected resource as
`impact` when the module has a reader, so they are hashed into the approval snapshot and shown as `currentResource` of a
stale-snapshot conflict. The approval description `approval.itemDelete` carries them as `seriesInstanceCount`,
`attachmentCount` and `hostEventCount`, and the `approval_pending` notification renders them with the body entry
`approval.itemDeleteImpact`, selected by `approvalNotificationBody` for a description that carries all three; an item whose
module has no reader keeps the projection, the snapshot, the description and the body entry it had.

## Consequences

- Another module that trashes more than its inline subtree registers its own expansion and, if its writers need an order,
  pre-lock hooks; `itemTrash.ts` gains no domain import.
- A delete or restore of a series instance locks every instance of the series and its recurrence row for the whole
  cascade. A concurrent completion of an instance waits for it, and a series has few stored instances.
- The request-time and the replay-time projection of an agent's `item.delete` take the owning module's delete pre-lock
  locks, so for a Tasks item they wait for a writer that holds the series, and for a calendar they take the default-mark
  lock, as the delete itself does.
- The migration adds one nullable column; it is expand-only, and a previous release that does not name it keeps working.
- An approval request that was granted for a Tasks item before this change carries a snapshot without `impact`; executing it
  ends as the stale-snapshot conflict, as any change of the resource does, and the request is raised again.
- The purge of a series removes the instances that are past the cutoff and, with the instance it points at, the series'
  recurrence row; an instance that was trashed after the cutoff is not part of that purge.
