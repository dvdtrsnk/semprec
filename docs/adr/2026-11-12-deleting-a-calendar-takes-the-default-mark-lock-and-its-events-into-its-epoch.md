---
status: accepted
date: 2026-11-12
area: [backend]
supersedes: []
superseded-by: null
---

# Deleting a calendar takes the default-mark lock and its Events into its deletion epoch

## Context

A calendar is an item of the Calendars system database, and its Events are the items on its `Calendars.events`
edges. Before issue gh-1803 `DELETE /api/items/:id` trashed a calendar like any other item: the cascade follows inline
databases only, so the Events stayed live with an edge to a trashed calendar, a system calendar could be trashed,
and so could the only own calendar and the default one, which leaves a new Event without a calendar
([[2026-11-11-new-events-get-their-calendar-in-a-create-hook]]).

The choke point runs delete and restore hooks inside the trash or restore transaction, once for each row the cascade
trashes or restores, and a hook may veto ([[2026-11-07-item-delete-and-restore-domain-hooks]]). A hook can trash a
related item into the epoch of the row it runs for, as `deletedAtExact` allows
([[2026-11-10-a-mailbox-removal-job-joins-the-mailbox-trash-epoch]]), and a restore hook receives that epoch at full
precision ([[2026-11-08-restore-hooks-carry-exact-deletion-epochs]]). The hooks for the subpages of a host do this
([[2026-11-12-a-trashed-host-takes-its-subpages-into-its-deletion-epoch]]).

The default mark is held by one row, and "the last own calendar" is a statement about several rows. Rules about
several rows need a lock that stands in front of all of them
([[2026-11-12-calendar-rows-keep-one-default-under-an-advisory-lock]]).

## Decision

`backend/packages/data/src/calendar/calendarTrashHooks.ts` exports `calendarItemDeleteHook` and
`calendarItemRestoreHook`, registered in `domainWriteHooks.ts`. They act on an item of the system database whose
`ownerModuleId` is `calendars` and return at once for any other database.

**Lock order.** The Calendars rules order their locks as the advisory lock of the default mark first and the rows
after ([[2026-11-12-calendar-rows-keep-one-default-under-an-advisory-lock]]). A delete or a restore of a calendar
locks the calendar's row before any hook of the cascade runs, so the cascade's own hooks would take the lock too
late. `chokePoint/hooks.ts` therefore has a registry of **delete pre-lock hooks** and one of **restore pre-lock
hooks**, per owning module id, beside the update pre-lock registry of
[[2026-11-12-an-update-takes-the-module-locks-before-it-locks-the-row]]:
`registerItemDeletePreLockHook(moduleId, hook)`, `registerItemRestorePreLockHook(moduleId, hook)`, and the matching
`runItemDeletePreLockHooks` and `runItemRestorePreLockHooks`. A hook receives the client, the database and the id of
the item the caller names, returns nothing and may throw; it takes a lock and nothing else. `itemDeleteWithClient`
and `restoreItemWithClient` run the hooks of the root's `ownerModuleId`, in registration order, after the archived
check and before the first lock on the root row; a database whose module registered none runs nothing. They run for
the root the caller names, not for the rows the cascade reaches later, whose subtree is known only after the root is
locked. Calendars registers `calendarItemDeletePreLockHook` and `calendarItemRestorePreLockHook`, which take the
advisory lock of the default mark for any calendar. They do not read the row, so they take it for a system or
subscription calendar as well; its delete is refused afterwards. The calendar is the root of its own delete and
restore, since the Calendars database has no parent item.

**Delete.** After the calendar's own soft delete:

1. A calendar whose `kind` is `system` or `subscription` is refused with 403 `forbidden`. Every other `kind`, an
   absent one included, is one of the user's own calendars.
2. The hook holds the advisory lock of the default mark that the Calendars update rules take (the pre-lock hook took
   it before the row was locked; taking it again returns at once), then reads the oldest
   other live own calendar, by creation time with ties by id. When there is none, the delete is refused with 409 and
   the code `last_own_calendar` (`ConflictError` takes an optional code, `version_conflict` by default). Every
   calendar delete takes the lock, not only the delete of the default, because two deletes of the last two own
   calendars would otherwise both read the other as live: neither sees the other's uncommitted trash. Taken in turn,
   the second delete reads the first's committed trash and is refused.
3. When the calendar was the default, that oldest other live own calendar gets `isDefault` true through the choke
   point's update as the system writer, in the same transaction. The update rules of the Calendars database clear the
   mark on every other live calendar. The deleted calendar is no longer live, and the choke point refuses to update a
   trashed row, so its own stored `isDefault` stays true until it is restored. No read of the default mark looks at a
   trashed row.
4. Every live Event on the calendar's edges is locked `FOR UPDATE` in id order and trashed through
   `itemDeleteWithClient`, with this trash's writer and acting user and with the calendar's deletion epoch as its
   `deleted_at`. Each Event therefore runs the usual delete hooks, heartbeats and after-commit invalidations, so a reaction
   to an Event's own delete (the cancellation of its invitations, which issue #1774 will add) needs no knowledge of
   the calendar. An
   Event that was in the Trash before is not live, keeps its own deletion time and is not touched.

**Restore.** After the calendar's own restore, every Event on its edges that is in the Trash with exactly the
calendar's epoch is restored through `restoreItemWithClient`; an Event trashed at another instant stays in the Trash.
A restored calendar whose stored `isDefault` is true gets `isDefault` false through the choke point's update, so it
comes back without the mark. The Calendars update rules refuse that write when no other live own calendar holds the
mark; the restore then fails. That is the state of a default calendar that was trashed before this decision with no
other default, and the failure is the visible outcome: the hook does not repair it.

The two hooks write the successor and the restored calendar with the system writer, not the writer of the delete. The
default mark moves as a consequence of the delete or the restore, not as a patch the user or agent made. The Events
are trashed and restored with the writer of the delete or the restore.

A failure of any step, including a nested Event trash, rolls the whole delete or restore back.

## Alternatives rejected

- Moving the Events to the default calendar. The product decision is that they go to the Trash with the calendar, so
  that a restore brings both back.
- Writing the cascade outside the hook, in the delete route. The hook point exists for this and also covers the
  agent and MCP delete paths.
- Clearing `isDefault` on the trashed calendar with a direct SQL write. It would be a state write outside the choke
  point; the restore clears the mark through the choke point instead.
- A lock for the delete of the default calendar only. It leaves the last-own-calendar check unserialized.

## Consequences

- A delete or a restore of a calendar waits for the advisory lock of the default mark while it holds no row of the
  calendar, so it cannot wait for a write of `isDefault` that holds the lock and needs the calendar's row, and the
  two cannot deadlock. A delete of any calendar is serialized with every write of the mark, which is short.
- A delete or a restore of a calendar that runs as a member of another item's cascade, and not as the root a caller
  named, would lock the row before the lock. No such cascade exists, because the Calendars database has no parent
  item. A registry user whose rows can be nested has to say so in its own decision.
- Every database delete and restore reads the registry of its module once, and a module without a hook runs nothing.
- Deleting a calendar with many Events trashes them one after the other in one transaction, each with its own
  hooks.
- A calendar trashed before this decision still has its Events live. They are not repaired.
- The stored `isDefault` of a trashed default calendar is true until the restore. A reader that wants the default
  calendar reads live rows only, as `lockDefaultCalendar` and the update rules do.
