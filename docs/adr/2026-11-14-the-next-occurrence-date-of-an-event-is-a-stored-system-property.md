---
status: accepted
date: 2026-11-14
area: [backend]
supersedes: []
superseded-by: null
---

# The next occurrence date of an Event is a stored system property that a daily heartbeat keeps current

## Context

The Events collection shows each Event once, grouped and ordered by day. A recurring Event is one row that occurs on
many days ([[2026-11-13-an-event-recurrence-rule-is-a-user-owned-json-property]]), so its own `date`, the first day of
the series, puts it in the past. The generic view query sorts, groups and filters by stored properties only
(`views/sortCompiler.ts`, `views/filterCompiler.ts`), so a value that depends on today has to be stored and kept fresh.
A derived system property that must always reflect other properties of the item is computed by a pre-write transform of
the owning module ([[2026-10-29-item-pre-write-transforms-per-module-registry]]); that mechanism knows the item but not
the passing of days.

## Decision

The Events database has a property `nextOccurrenceDate`: type `date`, owner `system`, locked, declared like the
derived `time` (no owner process, no name; its label is `property.events.nextOccurrenceDate.name`). Its value is the
day of the nearest occurrence on or after today in the tenant's system time zone, as a `YYYY-MM-DD` text. Three writers
keep it, all through the choke point:

- **On a write of the Event.** The Events pre-write transform `calendar/nextOccurrenceDateTransform.ts`, registered
  after the time and iCalendar transforms, computes the value on every create and on an update that names `date`,
  `endDate` or `recurrence`. An update that names none of them is left alone, because the daily action writes the value
  alone. A caller's own value is never kept: a generic write that names the property is refused by the ownership
  check with 403 `owner_violation`, and a system writer's value is replaced when the write names a day.
- **When an occurrence changes.** The Events update, delete and restore hooks in `calendar/nextOccurrenceSeriesHooks.ts`
  recompute the series' value in the transaction of the write that cancelled (trashed), restored or moved (`date` or
  `endDate` of) an occurrence item, and of a series that is restored from the Trash. The series row is locked first, and
  it is written, as the system writer with the key allowed, only when the value differs. A series in the Trash is left
  alone.
- **As days pass.** The heartbeat action `calendar.refreshNextOccurrence` runs daily, five minutes after midnight in the
  tenant's time zone, on the calendar module's system project. For its tenant it recomputes the value of every live
  Event that has a rule object and a stored value before today, in batches of 200 Events per transaction, each batch
  locked first and paged by id. It writes with the system writer and `allowedSystemKeys`, so the update hooks, the
  version and the invalidations run as for any write. It does not read an Event whose value is current.

The value is computed by `computeNextOccurrenceDate`, a function of the Event's properties, today and the zone: for a
stored series the first entry on or after today of the timeline expansion `expandEventOccurrences` of gh-1877, looked
for within 366 days, so a rule date whose occurrence item is in the Trash (cancelled) is skipped and an item moved to
another day is named on that day, exactly as the timeline shows them; else the last occurrence on or before today; else
the Event's own `date`. The refresh and the cutover expand a whole batch of series with one call
(`computeNextOccurrenceDates`). An Event that is not stored yet (a create) has no occurrence item, so its days come from
the rule matching the expansion itself uses (`occurrenceDatesInRange`); so do the days of a read-only proposal
preparation, which has no client. An Event without a rule, with a rule that is not readable, or that is an occurrence
item has its own `date`. An Event without a `date` has no value.

A tenant seeded before this decision gets the property definition, the value of every Event (trashed ones included,
by direct SQL, in batches of 500, without moving `updated_at`) and the heartbeat from
`calendar/nextOccurrenceDateCutoverMigration.ts`.

## Alternatives rejected

- Computing the value in the query. The sort, filter and group compilers read stored properties; a value that needs the
  recurrence expansion and the tenant zone would need its own path through each of them.
- Storing the value without the daily action. A series would show at a day in the past from the day after its stored
  occurrence until somebody edited it.
- An owner process on the property, so that only the calendar module's process writes it. The transform adds the key on
  behalf of the Events module, and the choke point accepts a key a transform adds only when its owner process is unset
  or the module's own, so the property declares none, like `time`. The occurrence hooks and the daily action are
  therefore writers beside the transform of a system property that has no declared owner process; they write as the
  system writer with the key allowed.

## Consequences

- A series' value names a day the timeline shows: a cancelled occurrence is never named and a moved one is named on
  its new day. It is kept so by the three writers above, so it is correct from the commit of the write that changed the
  occurrence. A write that changes an occurrence item another way, directly in SQL, is not seen; the daily refresh moves
  the value on once it has passed.
- An occurrence write takes the series row lock after its own row lock, and a write of the series row, the
  materialization of an occurrence and the daily refresh do not lock an occurrence row after it, so none of them can
  wait for such a write in a cycle. The trash or restore of a calendar locks all of its Events in id order, which can
  put an occurrence before its series, so it can deadlock with a concurrent write of one of its occurrences; PostgreSQL
  then rolls one of the two back and the caller retries. The occurrence's write also moves the series' `updated_at`, once
  for each cancelled, restored or moved occurrence that changes the value.
- A proposal for an Events write is prepared with the value the rule alone gives; the property is system-owned, so a
  proposal never depends on it, and the write stores the value the expansion gives.
- A series has no end condition in this version, so every readable rule has an occurrence within the 366 days and the
  fallbacks to the last occurrence and to the Event's own `date` are reached only by a rule with none in that window.
  When a later issue gives a series an end, those fallbacks give an ended series its last occurrence.
- An Event that has no stored value is not refreshed; the transform and the cutover give every Event one.
- The refresh writes one update per stale series per day, so each series' `updated_at` moves once a day.
