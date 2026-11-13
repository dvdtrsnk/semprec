---
status: accepted
date: 2026-11-12
area: [backend]
supersedes: []
superseded-by: null
---

# An item update runs the owning module's pre-lock hooks before it locks the written row

## Context

The choke point registries of `chokePoint/hooks.ts` let a domain add work to an item write without
the choke point knowing the domain
([[2026-09-30-choke-point-domain-hooks-through-a-per-process-registry]],
[[2026-10-29-item-pre-write-transforms-per-module-registry]]). Every one of them runs after the
update has locked the written row. A pre-write transform receives that locked row; an update hook
runs after the row was changed.

A module whose rule spans several rows needs a lock that stands in front of all of them, and the
order of locks matters between writers. The Calendars default mark
([[2026-11-12-calendar-rows-keep-one-default-under-an-advisory-lock]]) is held by one row of a
tenant. A switch takes an advisory lock and then locks the row that holds the old mark; a write of
`isDefault` on that row, which locked the row first, then asked for the advisory lock. Each waited
for the other and PostgreSQL ended one with a deadlock error, which no layer answers as a domain
error.

## Decision

`chokePoint/hooks.ts` has a registry of **update pre-lock hooks** per owning module id:
`registerItemUpdatePreLockHook(moduleId, hook)` and `runItemUpdatePreLockHooks(moduleId, context)`.
A hook receives the client of the write's transaction, the database, the item id and the caller's
patch, returns nothing and may throw.

`updateItemWithClient` runs the hooks of the database's `ownerModuleId`, in registration order,
after it has checked the patch against the database's properties (archived database, ownership,
colour, markdown and title checks) and before the first lock on the written row, which the
pre-write transform path and the row update take. A database whose module registered none runs
nothing. A hook that throws rolls the update back before any row was locked or changed.

A pre-lock hook takes a lock that has to come before the written row, and nothing else: it writes
no row and reads no row it does not lock. The hook registers in `domainWriteHooks.ts` like every
other hook. Create has no pre-lock hook: a created row is invisible to other transactions until
commit, so no other writer can hold it while it waits.

Calendars registers `calendarItemUpdatePreLockHook`, which takes the advisory lock of the default
mark when the patch names `isDefault`.

## Alternatives rejected

- A pre-write transform. On an update the choke point locks the row before it runs a module's
  transforms, so the lock would still come after the row lock, and registering one makes every
  update of the module lock the row.
- An update hook that takes the lock. It runs after the row was changed, which is the order that
  deadlocks.
- Mapping the deadlock error to a conflict. A request that did nothing wrong fails.

## Consequences

- An update of a module that registered a pre-lock hook runs the hook's statements before its first
  row lock. A hook that waits holds no row of the written item while it waits.
- The pre-lock hook sees the patch as the caller sent it. It runs before the pre-write transforms and
  update commands, so it cannot see a key they add; a hook that depends on such a key is not a
  pre-lock hook.
- A transaction that writes a row of the module before it makes the write that takes the lock has
  locked that row first. The hook cannot reorder what the caller already did.
- A hook adds one registry read to every item update of every module.
