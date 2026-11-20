---
schemaVersion: 1
id: "sp-c659fbbb-bb9a-4a8e-a463-7daada4fc91a"
title: "[internet-accounts 04/18] Store event time zones and full recurrence for synced events"
kind: "implementation"
state: "open"
stateReason: null
labels: ["spec:approved"]
parent: "sp-85e6cbc4-7de7-4385-81a9-a493c421b817"
assignees: []
milestone: null
createdAt: "2026-11-20T15:00:25.886Z"
updatedAt: "2026-11-20T15:00:45.335Z"
closedAt: null
source: null
approval: {"specSha256":"64771a63e781b61df3c8ed21a1b7c02de6a95e9787d63f944f9d90a1a0ae848f","source":"repository","actor":"dvdtrsnk via thr_g256fb7y6m: plan and decisions approved in chat 2026-11-20","at":"2026-11-20T15:00:45.335Z"}
resolution: null
---
**Blocked by:** sp-e7c79cd9-5f81-44db-a341-1c79fb277418
**Model tier:** high

## Context

Model tier rationale: Extends the event time model that the timeline, reminders and invitations read; a mistake shifts or loses occurrences.

Events store wall-clock times in the tenant zone and a narrow recurrence (`weekdays`, `monthDates`, `nthWeekday`). Provider events carry their own zone, any RRULE, EXDATEs and overridden occurrences. Subscribed events already expand RRULE read-only (`subscribedEventRecurrence.ts`).

Decision: an event may carry `timeZone` (IANA, system-owned, null = tenant zone). Times stay wall-clock in that zone.
Decision: an event in an account calendar may carry `recurrenceRule` (raw RRULE text) and `exceptionDates` (JSON array of local dates or date-times) instead of `recurrence`; overridden occurrences are separate events with `seriesId` and `recurrenceId`. Both are system-owned by `calendarSync`; users change them only through the simple `recurrence` editor, which writes a rule the sync serializes.

## Task

Load `state-writes`, `db-migrations`, `error-handling`, `io-hardening`, `canonical-keys` and `testing`.

1. Seed `timeZone`, `recurrenceRule`, `exceptionDates`, `recurrenceId` on Events (system-owned by calendarSync).
2. Timeline, agenda and reminders feed: convert an event's times from its `timeZone` to the tenant zone for display; expand `recurrenceRule` with `exceptionDates` and replace occurrences that have an override, reusing the subscribed-events expansion code moved to a shared module.
3. When a user edits `recurrence` on a synced event with a `recurrenceRule`, clear `recurrenceRule` and let the sync serialize the simple rule; editing other fields of a complex series keeps the rule.
4. Editing one occurrence of a synced series creates an override event (`seriesId`, `recurrenceId`) instead of materializing a plain occurrence.
5. Update `docs/architecture/domain-calendar-tasks-and-media.md` (Times, Event recurrence).

## Touches

- backend/packages/data/src/seed/seedTenDatabases.ts (Events)
- backend/packages/data/src/calendar/eventOccurrences.ts
- backend/packages/data/src/calendar/recurrenceExpansion.ts (new, moved from subscribedEventRecurrence.ts)
- backend/packages/data/src/calendar/timelineRead.ts
- backend/packages/data/src/calendar/remindersFeedRouteHandler.ts
- backend/packages/data/src/calendar/materializeEventOccurrence.ts
- docs/architecture/domain-calendar-tasks-and-media.md
- backend/packages/data/src/__tests__/syncedEventTimes.test.ts (new)

## Scope

### In scope

- Zone, raw rule, exceptions, overrides, display and editing rules.

### Out of scope

- Parsing provider payloads (adapter issues).

## Acceptance criteria

- An event at 09:00 in America/New_York shows at 15:00 in a Europe/Prague tenant (outside DST transitions) in the timeline and reminders feed.
- A series with `FREQ=WEEKLY;INTERVAL=2;COUNT=5` and one EXDATE shows four occurrences; an override replaces its occurrence.
- Editing the title of a complex series keeps its rule; switching it to "every Monday" in the editor clears the raw rule.
