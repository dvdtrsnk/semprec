---
status: accepted
date: 2026-11-14
area: [backend]
supersedes: []
superseded-by: null
---

# A subscribed event series is expanded from its stored rows on read

## Context

[[2026-10-25-task-and-event-recurrence-model]] makes occurrences virtual: they are computed when the timeline is read, and
nothing is materialized until a user changes one. [[2026-11-13-the-timeline-expands-an-event-series-into-virtual-and-real-occurrences]]
does that for the user's own Events, from a JSON rule in the vocabulary of Tasks. A subscribed event
([[2026-11-14-a-subscribed-event-in-the-timeline-is-a-read-only-stored-row]]) is imported from an ICS feed whose
repeating events carry an `RRULE`, `EXDATE`s and `RECURRENCE-ID` overrides, which that vocabulary cannot hold, and it can
never be materialized, because every property of it is owned by the calendar module. The import (gh-2004) stored such an
event once at its own start and skipped the overrides. Something has to decide what is stored of a series and where it
is expanded.

## Decision

1. **What is stored.** A master row (the VEVENT with the `RRULE`) holds three more system-owned text properties:
   `recurrenceRule` (the `RRULE` value as `ical.js` writes it back, which is the same parts and values, without the
   default `WKST=MO`, and with every part `ical.js` does not model, such as `RSCALE`, `SKIP` or an `X-` part, appended as
   the feed gave it, so that the rule is not read as one without that part), `exceptionDates` (the text of a JSON array of the original
   starts that `EXDATE` excludes, sorted) and, on an override row only, `recurrenceId`. An override (a VEVENT with a
   `RECURRENCE-ID`) is a row of its own with the master's `uid`, and a row is identified by `(calendar, uid,
recurrenceId)`, the `recurrenceId` being absent on a master. An original start is the tenant wall-clock text
   `YYYY-MM-DDTHH:mm` (the midnight of the day for a date value), converted from the feed's zone by the same function
   as `startsAt`, so the two can be compared as text.
2. **Where it is expanded.** In the timeline source of the subscribed events, not in the Events expansion: the rule
   texts are RRULE, which that vocabulary cannot express. `subscribedEventRecurrence.ts` reads the rule text and lists
   the days of a series (pure, on dates); `subscribedEventOccurrences.ts` places them in time; the source filters them. Nothing
   of an occurrence is stored.
3. **The supported rule.** `FREQ` (DAILY, WEEKLY, MONTHLY, YEARLY), `INTERVAL`, `COUNT`, `UNTIL`, `BYDAY`, `BYMONTHDAY`
   and `BYMONTH`. A rule with any other part, an invalid value, or a combination this expansion does not define (`COUNT`
   with `UNTIL`, an ordinal `BYDAY` outside a monthly rule or a yearly one with `BYMONTH`, `BYMONTHDAY` in a weekly rule,
   a yearly rule with `BYDAY` or `BYMONTHDAY` and no `BYMONTH`) is not expanded: the event is shown once at its own
   start with the row's id, the import goes on, and the import's log line counts it (`unsupportedRules`) without feed
   content. A day that a month lacks is no occurrence (it is not moved), the start is the first occurrence and counts
   towards `COUNT` whether or not the rule names it (RFC 5545, 3.8.5.3), and weeks start on Monday.
4. **Zones.** The days are computed in the series' own zone (`timeZone`, the tenant's zone for a floating time) from the
   local start, and each start is then converted to the tenant's wall clock; the end is the start plus the elapsed time
   between the stored start and end. A 09:00 New York series keeps 09:00 in New York across a daylight-saving change in
   either zone, and its tenant time moves. A local time that a change skips moves forward, as `calendarTime.ts` does.
   `UNTIL` is compared with the local start, a `Z` value after converting it to the series' zone.
5. **Exceptions and overrides.** An occurrence is left out when `exceptionDates` names its original start, or when a live
   override row of the same calendar and UID names it with `recurrenceId`; the override is shown as the row it is, where
   its own `startsAt` puts it, also when that is outside the range. An override without a master in the feed is an event of its
   own.
6. **Ids.** An occurrence of an expanded series has the id `<row id>@<date>` (`formatOccurrenceId`), `<date>` being its
   start day in the tenant's zone; the entry is still `readOnly: true` with the `databaseId` of `subscribedEvents`, and
   the id is no item id. Every other entry of the source (a row without a rule, a row whose rule is not expanded, an
   override) keeps the row's id.
7. **Bounds.** Only the requested range is expanded, so an unbounded series gives no more entries than the range holds, and
   one series gives at most 100 entries (as [[2026-11-13-the-timeline-expands-an-event-series-into-virtual-and-real-occurrences]]
   does). An iteration looks at no more than 20,000 periods of a rule, so a rule that never matches ends.

## Alternatives rejected

- **Materializing the occurrences as rows at import.** An unbounded series has no end, and each occurrence would be a row
  that the feed's next change has to update or trash.
- **Letting `ical.js` iterate the rule.** It rolls a day that a month lacks over into the next month (a yearly rule on
  29 February gives 1 March, and 31 February gives 3 March), where RFC 5545 gives no occurrence.
- **Using the Events rule vocabulary.** It cannot say `INTERVAL`, `COUNT`, `UNTIL` or a yearly rule, which the feeds use.

## Consequences

- A tenant whose zone changes keeps `startsAt`, `exceptionDates` and `recurrenceId` as computed in the old zone until the
  feed is imported again; the import then rewrites the rows whose text differs.
- An `EXDATE` or `RECURRENCE-ID` value that cannot be read makes its VEVENT unreadable, as an unknown zone does: the
  import goes on, counts it in `unreadable`, and keeps the stored row of a master, which has a key; an override without a
  readable `RECURRENCE-ID` has none. An `RRULE` value that cannot be read is stored as the parts the feed gave and is a
  rule that is not expanded.
- A feed is read for its first `RRULE` and its `EXDATE`s only: `RDATE` is ignored, and an override with
  `RANGE=THISANDFUTURE` replaces only the one occurrence it names.
- The `id` of an occurrence of a series is no item id, so a consumer that reads an entry's `id` as a row still tells a
  subscribed event by its `databaseId`, and reads the row id from the part before `@`.
- Two series of one UID in two calendars are kept apart by the calendar of each row.
