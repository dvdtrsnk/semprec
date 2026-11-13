---
status: accepted
date: 2026-11-12
area: [backend]
supersedes: []
superseded-by: null
---

# A sleep night in the calendar timeline is a derived entry the user edits

## Context

[[2026-11-10-calendar-timeline-merges-a-list-of-sources]] lets a source return entries that are not
stored rows and says, in its decision 6, that such an entry gets an `id` that is not an item id and
`readOnly: true`. The birthday source (#1800) and the public holiday source (#1804) follow it: a
birthday is edited on the person and a holiday cannot be edited at all.

The sleep source (#1806) returns the planned nights that `resolveSleepNights` computes from the sleep
plans and the per-night exceptions. A night is not a row either: it exists as a plan applied to a date,
and the only stored part of it is an optional exception item. The user changes one night by writing that
exception through the sleep module's own route (#1835), not by writing the entry. The calendar clients
need to tell a night they can open and change from a birthday or a holiday they cannot.

## Decision

1. A sleep entry has `kind` `sleep`, the `id` `sleep:<night>` (`night` being the calendar date of its
   evening) and `readOnly: false`. The `id` is not an item id, so `PATCH`, `DELETE` and the relation
   routes of `/api/items` refuse it with 400 `validation_failed` like any other derived id, and
   `readOnly: false` does not make those routes accept it. The flag tells a client that the entry can
   be edited through the sleep module.
2. `readOnly: true` stays the value of every derived entry that has no owner a client can write: birthdays
   and public holidays. Decision 6 of the timeline ADR is narrowed by this decision for the sleep kind
   only; the rest of that ADR holds.
3. The derived entries are separate shapes in the union `CalendarTimelineEntry`
   (`calendar/timelineSources.ts`), told apart by `kind`, and `CalendarTimelineItem` stays the shape of a
   stored Event or Task. A sleep entry has no `title`, `date` or `calendarId`: the merge orders it by its
   `night`, after the timed Tasks of that day, and the compact shape returns a derived entry unchanged.
4. The source reads the sleep settings, plans and exceptions with its own queries and leaves out a row
   whose stored values it cannot read, with one log line that carries ids, so one broken row does not
   fail the timeline (decision 4 of the timeline ADR). The settings item is read the same way: with
   `prepReminder` on and `prepReminderMinutes` missing or not a whole number from 0 to 1440 (a day), the
   nights carry no `prepReminderAt` and the source logs one line with the item id, its database and the
   property name, never the value.

## Alternatives rejected

- **`readOnly: true` for a night.** Rejected: a client could not tell a night that has an editor from a
  holiday that has none.
- **Two entries for a night that crosses midnight, one per day.** Rejected: the resolver returns one
  night, and the client draws the part that falls in each day.
- **Waiting for the loader of the sleep route (#1809).** Rejected: the loader is not delivered, and the
  response shape it is specified to return is not the timeline's. The loader can replace the source's own
  queries when it exists.

## Consequences

- `readOnly: false` on a stored Event or Task means the item routes accept its id. On a sleep entry it
  means only that the sleep module edits the night; the `kind` tells a client which editor a derived
  entry has.
- Two readers of the sleep rows exist (`findSleepMuteUntil` and this source), each with its own row parsing.
  The loader that #1809 will add is the place to unify them.
- A sleep entry has no `calendarId`; a hidden Sleep calendar does not change the response, and the client
  hides the entries by the calendar's flag.
