---
status: accepted
date: 2026-11-11
area: [backend]
supersedes: []
superseded-by: null
---

# A new Event gets its calendar in a create hook, and a caller's choice reaches the hook through an async scope

## Context

Issue #1600 gave every tenant a `calendars` database with one default calendar and the single-valued
relation `Events.calendar`, the inverse of `Calendars.events`
([[2026-11-07-calendar-cutover-uses-bounded-transactions]]). Its cutover linked the Events that
existed. An Event created afterwards had no calendar.

Events are created by many paths: the generic REST endpoint, the generic operations that agents and
MCP clients call, the Inbox confirm, and internal code. None of them knows calendars, and a path that
linked the calendar in a second write of its own would leave an Event without a calendar whenever
that write failed or a new path forgot it.

[[2026-10-09-item-create-domain-hooks]] gives a domain a place for this: a create hook runs inside
the insert's transaction after a real insert and not on an idempotency-key replay.

A few callers must choose the calendar instead of taking the default: the invitation answer of issue
#1944 and the atomic Event create of issue #1777. The hook context carries the inserted row and the
writer, not one domain's per-call input, and `createItemWithClient` is called with an open client
from many sites. Passing a calendar through its options and the hook context would put one domain's
argument into the generic signature of the choke point, which `chokepoint-knows-no-domain` and
[[2026-09-30-choke-point-domain-hooks-through-a-per-process-registry]] keep free of domains.

## Decision

**The hook.** `defaultCalendarCreateHook`
(`backend/packages/data/src/calendar/defaultCalendarCreateHook.ts`) is an item create hook. It is
registered in `domainWriteHooks.ts` after the create hooks that hold the Events rules
(`eventValidationItemCreateHook`, `eventReminderValuesItemCreateHook`), so it runs for an Event those
rules accepted. For a new item of the Events system database it does one of these:

- The tenant has no calendars database (its calendars cutover has not run): it writes nothing.
- The Event already has an edge in its `calendar` relation when the hook runs: it writes nothing.
  That edge wins, whatever calendar was chosen.
- Otherwise it links the Event to the chosen calendar, or without a choice to the tenant's default
  calendar: the live item of the calendars database whose `isDefault` is true. Should several be
  marked, it takes the one with the lowest id, the choice the calendars cutover makes.

The default calendar is read only in the last case, when no calendar was chosen. There, a calendars
database without a live default calendar fails the create with a plain error, which a transport
answers as a server error, after the error log line `default_calendar_missing` with the calendars
database id and the Event id. A create with a chosen calendar is judged by that calendar alone, and
a create whose Event already has a calendar edge writes nothing: neither reads the default, so a
missing default fails neither. A calendars database without the `Events.calendar` relation fails
the create with a plain error in every case, with a chosen calendar or without.

**The edge is a system write through the choke point.** The hook writes the edge with
`createRelationWithClient` and names no writer, whoever created the Event. The write runs that
function's guards, the cardinality trigger, the rollup enqueue, the edge hooks and the realtime
invalidation. It is part of the create's transaction: it commits or rolls back with the Event.

**A caller's choice travels in an async scope.** `withChosenCalendar(calendarId, fn)` runs `fn` with
the calendar in an `AsyncLocalStorage` that is private to the hook's module, the mechanism the tenant
scope uses ([[2026-10-05-tenant-scope-propagation]]). The hook reads it. The scope applies to every
Event insert that runs inside `fn`, an inner scope replaces the outer one for its own `fn`, and
outside any scope the default applies. `createEventInCalendar(client, input, calendarId, options?)`,
exported from `@semprec/data`, is the helper callers use: it resolves the tenant's Events database
and runs `createItemWithClient` inside the scope, so the scope covers that one create.

**The chosen calendar is checked by the hook.** It must be a live item of the calendars database of
the tenant in scope whose `kind` is empty or `own`. An id that is not a UUID, an unknown id, another
tenant's calendar, a calendar in the trash and a system or subscription calendar are refused with the
same `validation_failed` on `calendarId`, so another tenant's calendar reads like an unknown id. The
check runs only when the hook writes the edge: not when the tenant has no calendars database, not
when the Event already has a calendar edge, and not on an idempotency-key replay, which runs no hook
and returns the Event with the calendar it has.

**The hook locks the calendar row it decides on.** The read of the chosen calendar, and the read of
the calendars marked default, take the rows `FOR SHARE` in the create's transaction, which runs at
READ COMMITTED. The lock is held until that transaction ends. A trash or an update of that calendar
by another transaction waits for the create to end, and a create that starts while such a change is
uncommitted waits for it and then judges the committed row: a chosen calendar that was trashed
meanwhile is refused. A shared lock is enough because the hook writes no calendar row, and it lets
the creates of one tenant read the same calendar at the same time.

A locking read that waited checks the rows it had read again and no others. When the default mark
moved from one calendar to another in the change it waited for, the read of the default therefore
returns nothing although a default exists. The hook runs that read a second time when the first
returns nothing; the second reads the committed rows. Two reads are the bound: a default that moves
again during the second read fails the create like a missing default.

## Consequences

- Every path that ends in `createItemWithClient` is covered by one hook: REST, the agent and MCP
  operations, the Inbox confirm and internal code.
- An Event insert that the hook links also inserts one edge of the `Calendars.events` definition.
  That insert takes the definition's transaction-scoped advisory lock, which the cardinality trigger
  of `0013_relation_cardinality.sql` takes for every edge insert, and holds it until the create's
  transaction ends. Event creates of one tenant therefore wait for each other from that insert on.
  A transaction that creates an Event and then waits for a lock that another Event-creating
  transaction holds can deadlock with it; PostgreSQL ends one of the two with a deadlock error.
- The hook takes the calendar's row lock before that advisory lock. The calendars cutover, which
  inserts edges of the same definition, takes the advisory lock and no calendar row lock.
- An Event create has more side effects than before: the relation invalidations for the Event and
  the calendar, the rollup recompute enqueue and the changed-edge hooks, among them the search
  reindex of both items.
- The create-with-relations path (`createItemWithRelationsWithClient`) writes its `relations` after
  the create hooks ran. Until issue #1777 changes that order or passes the relations to the hook, a
  create of an Event whose `relations` name `calendar` meets the edge the hook already wrote and is
  refused with `cardinality_violation`, unless it names the calendar the hook linked. The proposal
  confirm (`inbox/proposalActions.ts`) writes the `relations` of an envelope after its create as
  well, with the same outcome for an Event proposal whose `relations` name `calendar`.
- Tests that create an Event through the choke point with the domain hooks registered now get an
  Event that has a calendar edge. A fixture that needs an Event without one removes the edge with the
  single-valued relation set.
- The scope is ambient: any Event inserted inside `fn` takes the chosen calendar, not only the one
  the caller means. A caller keeps `fn` to that create, which `createEventInCalendar` does.
- A calendar chosen for a tenant without a calendars database is ignored without a check, like the
  default, so Event creation does not break while a tenant waits for its cutover. An Event whose
  create read that no calendars database exists and committed after the tenant's cutover linked its
  last batch has no calendar edge; the next run of `runCalendarsCutoverMigration` links it.
- The single default calendar and the protection of system calendars are guarded by issue #1778.
  Until then a user can mark a second calendar as default or leave none; the hook's answers to both
  states are above.
- Changing the calendar of an existing Event stays a relation write by the user. The hook runs on
  create only.
