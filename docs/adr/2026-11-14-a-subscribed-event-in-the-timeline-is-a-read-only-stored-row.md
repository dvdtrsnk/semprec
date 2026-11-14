---
status: accepted
date: 2026-11-14
area: [backend]
supersedes: []
superseded-by: null
---

# A subscribed event in the calendar timeline is a read-only stored row

## Context

[[2026-11-10-calendar-timeline-merges-a-list-of-sources]] (decision 6) gives `readOnly: true` to the entries of a
source whose entries are not stored rows, with an `id` that is no item id.
[[2026-11-12-a-sleep-night-in-the-timeline-is-a-derived-entry-the-user-edits]] keeps `readOnly: true` for every derived
entry with no owner a client can write, and reads `readOnly: false` on a stored Event as "the item routes accept its
id". [[2026-11-13-the-timeline-adds-task-in-event-state-after-its-sources-are-read]] skips an entry that is `readOnly`
and not an occurrence, because it is no stored Event.

A subscribed event (issues gh-1962 and gh-2005) is a third combination none of them describes. It is a stored row of the
`subscribedEvents` system database, whose properties are all owned by the calendar module, so the generic write path
refuses every user, agent and `/mcp` write to it. The timeline source of gh-2005 returns it as an Event entry whose `id`
is that row's item id. Without a decision, the consumers of `readOnly` (the agenda gh-1762, the Semp timeline tool
gh-1952, a client) would have to read the meaning of this combination out of a code comment.

## Decision

1. **What the entry is.** A subscribed event is an entry with `kind: 'event'`, `readOnly: true`, an `id` that is the item
   id of the stored row, and a `databaseId` that is the id of the `subscribedEvents` database. A client or consumer tells
   it from an Event by `databaseId`, not by `kind`.
2. **How it narrows decision 6 of the timeline-sources ADR.** `readOnly: true` means that no client may edit the entry
   through the generic item routes. For a derived entry the `id` is no item id; for a subscribed event it is, because the
   row exists, and a write with it is refused with 403 `owner_violation` by the owner check of the choke point. A reader
   of `readOnly` must not infer from it that the `id` is no item id; the item routes still read that row.
3. **No task state.** The task-in-event step leaves the entry as it is (`tasks` and `counts` stay `null`), because it
   treats `readOnly` as "not a stored Event" (`storedEventId` in `timelineTaskInEvent.ts`). That is accurate for a
   subscribed event: it is not a row of Events and no Task is added to it by that step.
4. **A later source with the same shape follows this.** A source that returns the stored row of another read-only
   system database sets `readOnly: true`, the item id and that database's `databaseId`, and says so in its own ADR or
   extends this one.

## Alternatives rejected

- **A derived-style id for a subscribed event.** Rejected: the row is stored, it has a calendar edge and it is the unit
  the import (gh-2004) soft-deletes and the 30-day purge removes; the id has to be the item id to point at it.
- **`readOnly: false` with the write refused by the route.** Rejected: a client would show an edit control that always
  answers 403.
- **A new `kind` for a subscribed event.** Rejected by the issue: it is shown like an Event and told apart by `readOnly`
  and `databaseId`, so every consumer that lists Events needs no new case.

## Consequences

- `readOnly: true` no longer implies "no item id". A consumer that needs to know whether an item route accepts the id
  checks `databaseId` (or a missing item) as well, not `readOnly` alone.
- `storedEventId` keeps reading `readOnly` as "not a stored Event". A future read-only entry that is a stored row of
  Events itself has to change that step in its own decision.
