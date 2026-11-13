---
status: accepted
date: 2026-11-13
area: [backend]
supersedes: []
superseded-by: null
---

# The timeline expands an Event series into virtual and real occurrences

## Context

[[2026-11-10-calendar-timeline-merges-a-list-of-sources]] makes every kind of timeline entry a source in
`CALENDAR_TIMELINE_SOURCES`, and [[2026-11-13-an-event-occurrence-is-an-events-item-named-by-its-series-event-and-date]]
decides that a recurring Event is one stored row, that an occurrence with a state of its own is an item, and that a
trashed occurrence item is a cancelled date. The core Events source returns every stored Event, so it would return a
series row once as itself, and its materialized occurrences once each, while the series' other dates have no row at
all. Something has to decide, for a requested range, which dates are virtual, which are real and which are cancelled,
and two later readers (the Events collection order and subscribed events) need the same answer.

## Decision

1. **One expansion function.** `expandEventOccurrences` in `calendar/eventOccurrences.ts` turns the rows of the live
   recurring series into timeline entries for a range. The timeline source `timelineEventOccurrenceSource.ts` batch-loads
   the series (`readLiveEventSeries`) and calls it; another reader calls the same function and does not expand a rule
   itself.
2. **Rule dates decide what exists.** A date is an occurrence when the series' rule gives it (`occurrenceDatesInRange`,
   the day matching of `eventRecurrenceOccursOn`). A rule date with no occurrence item is a virtual entry: id
   `<seriesId>@<date>`, `readOnly: true`, `overridden: false`, the series' details with the occurrence's `date` and
   `endDate`. A rule date whose occurrence item is in the Trash gives no entry. A rule date with a live item gives no
   virtual entry.
3. **A real item is placed by its own days.** A live occurrence item is an entry (`overridden: true`) of the ranges its
   own `date` and `endDate` overlap, not of the range its rule date falls in. A moved occurrence is therefore shown
   where it now is, once, and not where it was.
4. **The series row and its items are not core entries.** The core Events source leaves out an Event that is a recurring
   series (`readEventSeries`) and one that has a `seriesId`; this source returns them, so each is shown once. An Event
   whose stored `recurrence` is not a rule is not a series and stays a stored Event.
5. **Bounds.** The caller bounds the range (the route allows 93 days). One series gives at most 100 entries per
   request, the earliest first, so a long series cannot make one request unbounded; a series that spans several days is
   searched from as many days before the range as it is long.
6. **Wall-clock, not instants.** Dates and times are stored and compared as dates and wall-clock times, so a daylight-saving
   change moves nothing.

## Alternatives rejected

- **Placing a real item by its rule date.** It would show a moved occurrence in the range it left and hide it in the one
  it moved to.
- **Letting the core Events source return the series row and filter later.** Every reader would have to know which
  rows to drop.
- **Materializing the occurrences of a range on read.** A read stays a read, and materialization is the writer's step
  (gh-1843).

## Consequences

- A series that is in the Trash gives no entries, and neither do its live occurrence items: they are left out of the core
  source and the series is not expanded.
- A series whose first `date` does not match its own rule has no occurrence on that date, because the start date is an
  occurrence only when the rule matches it.
- An occurrence item whose rule date is outside a range and which was moved into it is shown; one whose rule date is
  inside the range but which was moved out of it is not.
- The Journal day response, which reads the timeline, receives the virtual entries of a day.
