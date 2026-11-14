---
status: accepted
date: 2026-11-14
area: [backend]
supersedes: []
superseded-by: null
---

# The calendar timeline tool leaves out the sleep nights a caller may not read

## Context

`calendar.timeline` (issue gh-1952) answers what `GET /api/calendar/timeline` answers, so Semp and an external client
over `/mcp` can read the user's days. The timeline merges a list of sources
([[2026-11-10-calendar-timeline-merges-a-list-of-sources]]), and one of them derives a planned night (`bedTime`,
`wakeTime`, `alarm`, `bedAt`, `wakeAt`, `prepReminderAt`) from the three sleep databases, which are sensitive
([[2026-11-12-a-sleep-night-in-the-timeline-is-a-derived-entry-the-user-edits]]). The source returns those nights for
every tenant whose sleep settings have `enabled` and `showInCalendar` true, which a seeded tenant has.

The route answers the user, who has no per-database grant. The tool is called by callers the accepted decisions treat
differently: a run is read-checked per database against the grants of its project
([[2026-11-12-per-database-agent-grants]]), a human `/mcp` session is an external AI client that is refused every
sensitive database ([[2026-11-13-an-external-ai-client-on-mcp-is-refused-sensitive-databases]]), and a tool whose
answer carries sensitive content marks it so that the stored result is redacted
([[2026-11-13-sensitive-tool-results-are-marked-by-the-tool-and-stored-redacted]]). The capability `calendar.read` is
decided by the project owning the calendar databases, which says nothing about the sleep databases. Returning the whole
timeline would be a second read path to sleep data that skips all three.

## Decision

**The tool answers the route's items except the sleep nights a caller may not read.** `readCalendarTimeline` takes
`includeSleep` (default `true`, which every route keeps); with `false` the sleep source returns nothing and reads none
of the sleep databases, so nothing is read for a caller that may not see it.

- A run: the tool reads the project from the stored run, never from an argument, and passes `includeSleep: true` only
  when the project holds read access on the sleep settings, plans and nights databases (`assertSleepAccess`, the check
  of the sleep tools). The check and the read share one transaction, and the check locks the decision rows
  `FOR SHARE`, so a revoke waits for the transaction that passed. A refusal or a tenant without the sleep module means
  no sleep nights, not a failed call. A run without a project is refused like in the other calendar tools. The
  one-turn allowance of an attached sleep night
  ([[2026-11-13-a-sleep-night-ref-opens-the-sleep-data-for-one-turn]]) does not apply: it opens named items, and the
  tool's answer holds derived entries of a whole range.
- A human `/mcp` session: never `includeSleep`. An external client has no way to be granted sensitive data.
- The answer is marked `sensitive: true` when it holds at least one entry of kind `sleep`, and not otherwise.

**Why not the same items as the route for everyone.** The issue's "same items as the route" was written for the user's
own view; it does not decide the sensitive-data question, and the accepted decisions leave no exception. A caller that
holds the grant, or the user in the app, still receives every item.

## Consequences

A tenant that shows sleep in the calendar gets a timeline over `/mcp` without sleep nights and, for a project without
a sleep grant, without them in Semp too; granting the project read access on the three sleep databases adds them.
Another timeline source that ever derives entries from a sensitive database has to be switched the same way.
