---
status: accepted
date: 2026-11-10
area: [backend]
supersedes: []
superseded-by: null
---

# The calendar timeline is one read merged from a list of sources

## Context

The calendar views need everything that happens in a date range in one call: Events and Tasks now
(#1717), and later birthdays, public holidays, sleep nights, recurring occurrences and subscribed
events, each from its own issue. Before #1717 there was no such read. The generic query reads one
database at a time and its item envelope carries no relations. Its date filters cast the stored
value, so one unreadable stored date fails the whole query. Events and Tasks store their days and
times as text in `items.properties`, and Events stored before #1598 can still hold a date with a
time.

The timeline route needs these entries now. The agenda list (#1762) and an assistant tool (#1952)
will need the same entries in the same order, and several later issues will add a kind of entry
each. Without a decision, each of them would either add its own range query or edit one growing
merge function.

## Decision

1. **One read.** `readCalendarTimeline` in `backend/packages/data/src/calendar/timelineRead.ts` is the
   only place that assembles a calendar range. `GET /api/calendar/timeline` is a custom route of the
   calendar module ([[2026-09-11-module-manifest-custom-routes]], justification
   `single-consumer-read`) and only validates the query string before it calls the read. A later
   consumer calls the same function and does not query Events or Tasks for a range on its own.
2. **A list of sources.** `backend/packages/data/src/calendar/timelineSources.ts` declares the source
   type `{ id, readItems(client, context) }` and the list `CALENDAR_TIMELINE_SOURCES`. The read calls
   every listed source with the same context (the range, the tenant time zone, `today` and `now`),
   concatenates what they return and sorts the result once. A new kind of entry is a new source
   module and one entry in that list; it does not change the merge. The merge, not a source, decides
   the order of the result.
3. **Batched sources.** A source reads with a number of statements that does not depend on the number
   of rows. The two core sources send one statement for the rows of their database and batched
   lookups for the rows' relation edges, the linked items and the calendars.
4. **Unreadable stored values are skipped, not failed.** A source compares stored days as text and
   never casts them. A stored row whose date or time is not valid is left out of the result, and the
   source writes one log line with the row's id and the name of the property, never its value
   (`backend/review-rules/rules.md`: logs are not tenant-scoped, so they carry ids and counts). The
   read still answers.
5. **What the server does not do.** It does not filter hidden calendars: every item carries its
   `calendarId` and the client hides by the calendar's flag. It returns a multi-day Event once, with
   its range, not once per day. It reports an Event without a calendar edge with the id of the live
   default calendar and writes no edge. It caches nothing.
6. **Derived entries.** A source whose entries are not stored rows gives them an `id` that is not an
   item id and `readOnly: true`.

## Alternatives rejected

- **Each new kind of entry edits the merge.** Rejected: every later issue would change the same
  function and its ordering.
- **One SQL statement over all databases.** Rejected: derived entries (holidays, occurrences) are
  computed in code and have no rows to select.
- **Casting stored dates in SQL, or failing the read on an invalid row.** Rejected: one old row
  would blank every calendar view of the tenant.
- **Filtering hidden calendars on the server.** Rejected by the product owner: the assistant works
  with hidden calendars too, and hiding is a display choice.
- **Writing the default calendar edge while reading.** Rejected: a read stays a read; the calendar
  cutover of #1600 owns that write.

## Consequences

- The order inside a day is defined in one comparator in `timelineRead.ts`. A source that adds a new
  `kind` extends that comparator in its own issue.
- `timelineRead.ts` and `timelineSources.ts` import each other: the list names the two core readers,
  and the merge reads the list. The core readers are function declarations and the merge reads the
  list only when it is called, so either module can be loaded first.
- The range rules (calendar dates, at most 93 days) are the route's. `readCalendarTimeline` does not
  repeat them, so another caller bounds its own range.
- A row that is skipped stays invisible in the calendar until its stored value is repaired; the log
  line is the only signal.
- A source that needs many statements per row would break the batching rule and has to be reshaped
  before it is listed.
