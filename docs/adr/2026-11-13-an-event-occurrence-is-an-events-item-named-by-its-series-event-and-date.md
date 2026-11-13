---
status: accepted
date: 2026-11-13
area: [backend]
supersedes: []
superseded-by: null
---

# An Event occurrence is an Events item named by its series Event and its date

## Context

[[2026-10-25-task-and-event-recurrence-model]] decides that an occurrence that has a state of its own is a real item and
that the shared identifiers `seriesId` and `occurrenceDate` name it, and [[2026-11-13-an-event-recurrence-rule-is-a-user-owned-json-property]]
stores an Event series as one Event, the first occurrence, that carries the rule. That ADR leaves `seriesId` and
`occurrenceDate` on Events to "the materialization of an occurrence", which is the first time a date of a series is
changed or linked (gh-1843). Three things were undecided: what `seriesId` is for an Event series, who writes the two
properties, and how two requests for one occurrence stay one item.

## Decision

1. **The series is named by its Event.** An Event series has no row of its own, so its `seriesId` is the id of the
   Event that carries the `recurrence` rule. The virtual id of an occurrence is `<seriesId>@<YYYY-MM-DD>`, as the
   recurrence model says. A live Event is a series only when it has a readable rule and no `seriesId` of its own: an
   occurrence item is never a series, even if a rule is written to it.
2. **Two system-owned properties.** The Events database has `seriesId` (`text`) and `occurrenceDate` (`date`), both
   `owner: 'system'` with the owner process `calendar` (the calendar module, `CALENDAR_MODULE_ID`). Only
   `calendar/materializeEventOccurrence.ts` writes them, through the choke point with `allowedSystemKeys` and
   `systemOwnerProcess`; every other writer is refused with `owner_violation`, so moving an occurrence never changes
   its identity. They are declared in `seedTenDatabases.ts`, and `calendar/eventsOccurrenceCutoverMigration.ts` adds the
   same definitions to an existing tenant by direct SQL, because the Events schema is locked.
3. **An occurrence item is a copy of the series Event.** It is created in the series' calendar with the series' name,
   type, place, URL, description, alert and travel minutes, times, project, people, area, files (and company when the
   series has no project). `date` is the occurrence day and `endDate` is moved with it so the occurrence keeps the
   series' length. It has no `recurrence`. Participant invitations are not copied.
4. **At most one item per occurrence, serialized by an advisory lock.** The materialization takes
   `pg_advisory_xact_lock` keyed by the tenant, the series id and the date, then looks for an item with that
   `seriesId` and `occurrenceDate`, in the Trash or not, and creates one only when there is none. The lock is
   released at commit or rollback. The tenant is part of the key, so a request for another tenant's series id never
   waits for that tenant's work. When it creates an item, it locks the series row `FOR UPDATE` before reading it, so two
   occurrences of one series are also created one after the other.
5. **Cancelling an occurrence is trashing its item.** A materialization that finds the item in the Trash returns it as
   it is stored and does not create another, because the Trash holds the cancellation. Restoring the item brings the
   occurrence back. Readers of occurrences treat a date whose item is in the Trash as cancelled.
6. **Idempotent route.** `POST /api/events/series/:seriesId/occurrences/:date` answers 201 when it created the item and
   200 with the same item afterwards. A date the rule does not give is `400 validation_failed` on `date`; an unknown,
   foreign, trashed or non-series Event is the same 404.

## Alternatives rejected

- **A `series` table with one row per Event series**, as `task_recurrence` has for Tasks. A Task series needs it
  because its open item changes; an Event series is one stable Event. A table would add a write path beside the
  choke point and a lock order against item rows (see the rule ADR above).
- **A unique index on `(seriesId, occurrenceDate)`.** Items store their properties in one JSON column shared by every
  database, so a partial unique index for one database would be a migration for one module. The advisory lock gives the
  same guarantee for the one writer that creates occurrences.
- **User-owned `seriesId` and `occurrenceDate`.** A user could then move an occurrence into another series or give
  two items the same identity, which the single-item guarantee above rules out.

## Consequences

- Every reader that needs the occurrences of a series looks the items up by `seriesId` and `occurrenceDate` and
  includes the Trash, or it shows a cancelled date again.
- The lock is held until the caller's transaction ends, so a caller that wraps the materialization in a long
  transaction holds up other requests for the same occurrence.
- The Events `seriesId` is an Event id and the Tasks `seriesId` is a `task_recurrence` series id. Code that handles
  both kinds of occurrence by their virtual id decides which database to ask from the series it finds.
- Nothing in this decision trashes or changes the occurrence items of a series Event that is deleted; what happens to
  them is a later issue.
