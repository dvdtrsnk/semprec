---
status: accepted
date: 2026-11-13
area: [backend]
supersedes: []
superseded-by: null
---

# The timeline adds task-in-event state after its sources are read

## Context

[[2026-11-10-calendar-timeline-merges-a-list-of-sources]] makes each kind of entry a source and says a new kind does not
change the merge. A Task that sits in an Event (`Tasks.hostEvents`) is shown differently from any other Task: while
its last host Event has not ended it is shown only inside the Event, and afterwards on the day
[[2026-11-12-task-host-state-is-recomputed-in-the-writing-transaction]] stores in `effectiveDate`. Each Event entry
needs the tasks inside it with their per-event state and counts, the ones `GET /api/events/:id/tasks` answers
(`taskStateInEvent.ts`), and each visible Task entry needs the host Event that decided its day.

The Events of a range come from two sources (the core Events source and the Event occurrence source of
[[2026-11-13-the-timeline-expands-an-event-series-into-virtual-and-real-occurrences]]), and a Task's host Event may be
outside the range. A source sees only its own rows, so neither could batch the lookups for all Events and all host Events
in one read.

## Decision

1. **A step after the sources.** `readCalendarTimeline` calls `attachTaskInEventState`
   (`calendar/timelineTaskInEvent.ts`) once on the concatenated entries, before it sorts them. It adds `tasks` and
   `counts` to every Event entry and `hostEvent` to every Task entry that has a live host Event with a date. Every
   other entry, including an Event or Task a source made up (`readOnly` and no occurrence), is returned as it is. The
   merge still does not know any kind of entry: the step reads the stored Events and Tasks only.
2. **One batch, one clock.** The step reads the host edges of all Tasks, then `readEventsTasks` once for the stored
   Events of all entries and the host Events together, in a number of statements that does not depend on how many there
   are. It evaluates states and `hostEvent.ended` at the context's `at`, the instant the read took `today` and `now`
   from, so a state and `ended` never disagree. `CalendarTimelineContext` therefore carries `at`.
3. **The state is the function of the route.** Event `tasks` and `counts` and `hostEvent.state` come from
   `taskStateInEvent` through `readEventsTasks`, the batched reader that `readEventTasks` and `eventTaskCounts` also
   use. The timeline does not decide a state itself, so it and the route cannot differ.
4. **The core Tasks source selects by display day.** It places a Task on `taskDisplayDay`, so its entry's `date` is that
   day, and leaves out a Task whose stored `hiddenUntil` is later than `at` and a Task that has a `completedInEvent`
   edge: both are shown only inside their Event. A stored `hiddenUntil` that is not an instant does not hide a Task.
5. **The host Event is the last dated one.** A Task's `hostEvent` is the live host Event with a `date` that the Task was
   added to last, the Event `computeTaskHostState` takes its day from. An Event without a date is ignored for the
   choice but still counts as the last host Event in `taskStateInEvent`, so the state in the chosen Event can be `moved`.
6. **Occurrences carry their stored Event's tasks.** A real occurrence carries the tasks of its own item, a virtual
   occurrence those of its series Event.
7. **The compact shape carries `counts` only.** It already carries a Task's `status`; it gets the task counts of an
   Event and `null` for a Task, and neither `tasks` nor `hostEvent`.

## Alternatives rejected

- **Each source adds the data to its own entries.** Rejected: the Events of one read would be looked up in more than
  one batch, and a Task's host Event outside the range would need a source of its own.
- **Compute the state in the timeline from the stored `hiddenUntil` and `effectiveDate`.** Rejected: a second
  implementation of the state function would drift from the route's.

## Consequences

- A new source that returns stored Events or Tasks gets their task-in-event data from the step without code of its own.
  A source whose entries are not stored rows keeps `readOnly: true` and an `id` that is no item id, and is skipped.
- `hiddenUntil` and `effectiveDate` are stored values: a Task whose last host Event has just ended is shown from that
  instant on the day the stored `effectiveDate` names, which the delayed `taskHostEventEnded` job brings in line with
  the end; until it runs the stored day can be earlier than the day the recomputation would store.
- Every item of the agenda (`agendaRouteHandler.ts`) carries the same fields, because it returns timeline items.
