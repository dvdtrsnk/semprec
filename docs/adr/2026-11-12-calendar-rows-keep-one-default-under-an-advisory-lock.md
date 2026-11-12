---
status: accepted
date: 2026-11-12
area: [backend]
supersedes: []
superseded-by: null
---

# Calendar rows keep one default calendar under an advisory lock on the calendars database

## Context

Issue #1600 gave every tenant a `calendars` system database. A calendar is an item of it with the
user-owned properties `name`, `color`, `notify`, `hidden` and `isDefault` and the system-owned `kind`
(`own`, `system`, `subscription`; an absent value is `own`) and `systemKey`. Since issue #1761 every
new Event without a chosen calendar is linked to the live calendar whose `isDefault` is true
([[2026-11-11-new-events-get-their-calendar-in-a-create-hook]]), and such a create fails when it
finds none.

Nothing guarded these rows. The choke point's ownership check refuses a generic write of `kind` and
`systemKey`, but a client could rename a system calendar, and could mark a second calendar as
default or clear the only mark. Issue #1778 asks for the rules as an item create hook and an item
update hook of the Calendars database
([[2026-10-09-item-create-domain-hooks]],
[[2026-09-30-choke-point-domain-hooks-through-a-per-process-registry]]).

The two hooks run after the row is written, inside the write's transaction. The generic item writes of
the choke point (`createItem`, `updateItem`) run that transaction at READ COMMITTED. An update hook
receives the row as the update left it and the written patch. It does not receive the row as it was
before.

"Exactly one default" is a statement about several rows. A row lock cannot hold it: two writers
that each mark another calendar both read the same previous default. The second waits for that row,
and when the first commits it finds the row no longer marked and clears nothing, so both new marks
stay.

## Decision

`backend/packages/data/src/calendar/calendarRowHooks.ts` exports `calendarItemCreateHook` and
`calendarItemUpdateHook`, registered in `domainWriteHooks.ts`. They act on an item of the system
database whose `ownerModuleId` is `calendars` and return at once for any other database. A refusal
is thrown after the row was written and rolls the write back. The same file exports a third hook,
`calendarItemUpdatePreLockHook`, which takes the lock described under **The lock** before an update
locks the written row ([[2026-11-12-an-update-takes-the-module-locks-before-it-locks-the-row]]).

**Name.** An update whose patch names `name` on a calendar whose `kind` is `system` or
`subscription` is refused with 403 `forbidden` on `name`, whoever writes: a user, an agent or the
system writer. Because the hook does not see the previous row, a patch that sends the stored name
again is refused as well. Every other `kind`, an absent one included, is one of the user's own
calendars and can be renamed.

**Colour.** A write that names `color` must give a string `#RRGGBB`, six hexadecimal digits in
either case; otherwise it is refused with 400 `validation_failed` on `color`. The choke point's
generic check of `color` properties already refuses a malformed string and lets `null` through. The
hooks refuse `null` too, so a write cannot remove a calendar's colour. A create that does not name
`color` stores a calendar without one.

**Default.** A calendar is marked default when its `isDefault` is the JSON value `true`.

- An update that names `isDefault` with `true`, and a create whose stored properties hold
  `isDefault` `true`, make that calendar the one default: the hook clears the mark on every other
  live calendar that holds it. On a system or subscription calendar the write is refused with 400
  `validation_failed` on `isDefault` instead.
- An update that names `isDefault` with any other value is refused with 400 `validation_failed` on
  `isDefault` unless another live own calendar holds the mark. The hook cannot tell whether the
  written calendar held the mark before, so the check is on what the write leaves: a tenant without
  any default cannot write `isDefault` `false` on a calendar until one is marked.
- An update that does not name `isDefault`, and a create without the mark, read no other calendar
  and take no lock.

**The lock.** Before a write reads or changes any calendar's `isDefault` it takes the
transaction-scoped advisory lock `pg_advisory_xact_lock(hashtextextended('calendars-default:' ||
<calendars database id>, 0))`. The calendars database id belongs to one tenant, so tenants do not
wait for each other. The lock is held until the write's transaction ends. Under it the hook reads
the other live calendars marked default with `SELECT ... FOR UPDATE`, in id order.

Every writer of the mark therefore orders its locks the same way: the advisory lock first, then the
rows.

- An update that names `isDefault` takes the lock in `calendarItemUpdatePreLockHook`, before the
  choke point locks or changes the written calendar's row. Without that, the written row would be
  locked first, and a write that holds the advisory lock and waits for that row (a switch that has to
  clear `Personal`) would wait for a write that holds the row and waits for the advisory lock (a
  write of `isDefault` on `Personal`). PostgreSQL would end one of them with a deadlock error, which
  a transport answers as a server error.
- A create takes the lock in `calendarItemCreateHook`, when it marks the new calendar. The new row
  is not visible to another transaction, so no other writer can hold it while it waits.
- The lock is taken again by the hooks that read the other marks; taking an advisory lock a
  transaction holds already returns at once.

**The clearing is a choke-point write.** The hook clears each other mark with
`updateItemWithClient` and the patch `{ isDefault: false }`, passing the writer and the human writer
id of the outer write. That update runs every update hook, this one included, and announces the row
after the commit like any other update. The new default's row is already written when the clearing
runs, so the check of the second bullet above finds it and passes.

## Alternatives rejected

- A row lock on the previous default without the advisory lock. It does not serialize two switches,
  as the Context describes, and a tenant without a default has no row to lock.
- A partial unique index over `items`. The mark is a key of the `properties` document of a table
  that holds every database's items, and writing the new default before clearing the old one would
  violate the index inside the transaction.
- SERIALIZABLE transactions. They turn the race into serialization failures that every caller of
  the generic item routes would have to retry.
- A pre-write transform that takes the lock. On an update the choke point locks the written row
  before it runs a module's transforms (it hands them the locked row), so the lock would still come
  second. A transform also would not need to exist for a module that has none, and registering one
  adds a row lock to every update of the module. The pre-lock hook runs before that lock and adds
  nothing to an update that does not name `isDefault`.
- A pre-write transform to compare the name with the stored one. Issue #1778 names the create and
  update hooks, and the clearing of the other rows has to follow the write of the new default in
  either case.
- Mapping the deadlock error to a conflict, or retrying the write. The write would still fail or run
  twice for a request that did nothing wrong, and a retry inside the transaction is not possible
  after PostgreSQL ended it.

## Consequences

- Two writes that each mark a calendar run one after the other from the advisory lock on. At READ
  COMMITTED the second reads the first's committed mark and clears it, so one mark is left: that of
  the write that took the lock last.
- A write that waits for another transaction's change of a calendar row while it holds the advisory
  lock does not make that transaction wait for the lock, so the two cannot deadlock: a transaction
  that holds a calendar row has either not asked for the lock, or has it. A transaction that writes
  a calendar row without naming `isDefault` and writes `isDefault` later, in the same transaction,
  still locks the row before the advisory lock. No request path of the repository does this: each
  generic item write is one transaction. A caller that composes such a transaction takes the lock
  first, as a later writer of the mark does (below).
- The `FOR UPDATE` read waits for a transaction that has changed or locked one of those rows. After
  an uncommitted trash of the previous default commits, the read no longer returns that calendar: a
  switch clears nothing on it, and a write of `isDefault` `false` that would have relied on it is
  refused.
- An Event create holds the default calendar's row `FOR SHARE` until it ends
  ([[2026-11-11-new-events-get-their-calendar-in-a-create-hook]]). A switch waits for the Event
  creates in flight before it clears the previous default, and an Event create that starts during
  an uncommitted switch waits for it.
- Changing the default writes two items. After the commit an item invalidation is announced for the
  calendar that was written and one for the calendar that lost the mark.
- The hooks see create and update only. The seed and the calendars cutover insert rows without the
  hooks, and trash, restore and purge of a calendar pass neither hook and do not take the advisory
  lock: the default calendar can still be trashed, which leaves the tenant without a default, and a
  restored calendar keeps the mark it was trashed with. Issue #1803 owns the rules for trash and
  restore. A later writer that changes `isDefault` outside these hooks takes the same advisory lock
  before it reads a mark, and before it locks a calendar row.
- A tenant that reached several defaults, or none, before these rules is not repaired by a
  migration. Marking a calendar clears every other mark, whichever `kind` holds it.
- The system writer is refused like a client when it renames a system or subscription calendar. A
  later source that has to rename one, for example from a subscription feed, needs a decision of its
  own.
