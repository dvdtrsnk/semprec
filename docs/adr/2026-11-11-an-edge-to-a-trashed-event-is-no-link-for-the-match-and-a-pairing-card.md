---
status: accepted
date: 2026-11-11
area: [backend]
supersedes: []
superseded-by: null
---

# An edge to a trashed Event is no link for the match and for a pairing card's confirm

## Context

Moving an item to the Trash is a soft delete. Its relations stay until the
item is purged, so a restore finds them again.

[[2026-10-29-events-hold-many-transcripts]] gives a transcript at most one
Event. The cardinality trigger of
`backend/packages/data/src/db/migrations/0013_relation_cardinality.sql`
enforces it and does not read `deleted_at`. The match step
([[2026-09-23-transcription-worker-writes-event-match-results]]) treated every
`event` edge of a transcript as a link. A transcript whose Event is in the
Trash therefore could not get another Event: the match answered
`alreadyLinked`, and the confirm of its pairing card failed with
`cardinality_violation` (issue #1743).

Alternatives considered:

- Delete the edge when the Event is trashed. A restore could then not give the
  Event its transcript back, and the issue requires that a restore puts the
  original edge back in effect when nothing replaced it.
- Let the trigger ignore an edge whose Event is in the Trash. The transcript
  would hold two edges, and a restore of the first Event would leave it with
  two live Events, the one shape the relation forbids.
- Replace the edge in the generic relation write as well. That write is a
  deliberate user or agent write. Whether it may replace an Event without
  saying so is a product decision that has not been made.

## Decision

For the match step and for the confirm of a pairing card (a
`kind = 'transcript'` card of role `event`), a transcript's `event` edge whose
Event is in the Trash is no link.

- `readTranscriptEventEdges` in
  `backend/packages/data/src/transcription/transcriptEventEdges.ts` sorts the
  Events of a transcript's edges into live and trashed. The match returns
  `alreadyLinked` only for a live one.
- When the match links its one candidate, and when a pairing card's confirm
  writes its edge (the `database` envelope that creates the Event and the
  `relation` envelope that links an existing one), `releaseTrashedEventEdges`
  first deletes the edge to the trashed Event. It uses
  `deleteRelationWithClient` on the caller's client, so the removal is part of
  the transaction that writes the new edge, and the hooks and announcements of
  an edge removal run for it. The writer is the writer of the new edge:
  `system` in the match, the confirming user in the confirm.
- A match that creates the pairing card instead of an edge deletes nothing.
  The edge stays until the card's confirm replaces it or the Event is
  restored.
- A speaker card's confirm deletes nothing.
- The generic relation write, `createRelationWithClient` behind
  `PUT /api/items/:id/relations/:propertyKey/:targetItemId` and Semp's
  `relation.put`, is unchanged and keeps answering `cardinality_violation` for
  such a transcript.

This adds one write to the surface that
[[2026-09-23-transcription-worker-writes-event-match-results]] gives
`semprec-transcribe`: the removal of its transcript's `event` edge to a
trashed Event, directly before the edge the match writes. That ADR is accepted
and is not edited.

It also narrows a consequence of
[[2026-11-10-transcription-create-writes-the-uploads-event]], which says that
the match never replaces the edge the create step wrote. That holds while the
upload's Event is not in the Trash. Once it is, the match treats the edge like
any other edge to a trashed Event.

The lock. An Event is read without a lock first. One that reads as trashed is
then locked `FOR SHARE` and read again (`itemsStore.lockItemTrashEpoch`), and
only an Event that is still in the Trash under that lock counts as trashed.
The lock is held until the transaction ends. A restore locks the Event's row
`FOR UPDATE` before it changes it (`restoreItemWithClient`), so:

- a restore that starts after the lock was granted waits until the match or
  the confirm has committed or rolled back;
- a restore that committed before the lock was granted leaves the Event live:
  the match returns `alreadyLinked`, and the confirm fails with
  `cardinality_violation`, as for any live Event.

A live Event is not locked. An Event whose trash has not committed when it is
read is treated as live by this run.

An Event whose row is gone is neither live nor trashed. The permanent purge
(`purgeExpiredTrashSubtree`) locks a trashed Event's row `FOR UPDATE` and
deletes the row and its edges in one transaction. A read that got the edge
before that purge committed finds no row afterwards: in the read without a
lock, or once the share lock is granted, where `lockItemTrashEpoch` returns no
trash epoch for a missing row just as for a live one. After a lock that
returned none the row is therefore read once more, and an Event without a row
is left out. Its edge went with it, so the match goes on as for a transcript
without an Event, and the confirm has no edge to delete. A purge that starts
after the share lock was granted waits like a restore.

The match holds the transcript's row lock when it takes the share lock, and
the confirm holds its card's row lock. Both run at READ COMMITTED, the level
`withTransaction` uses unless a caller asks for another: the match step of
`semprec-transcribe` (`runMatchStep`) and the confirm route
(`createConfirmProposalRouteHandler`) ask for none.

## Consequences

- A restore gives an Event its transcript back only while nothing replaced the
  edge. An Event whose edge was replaced is restored without that transcript,
  and nothing reconnects it.
- The project, the company and the people a transcript took over from the
  trashed Event stay its own values
  ([[2026-11-10-transcript-values-are-inherited-by-link-rules-whichever-process-writes-the-edge]]).
  The trash already ended their links, and a link rule fills only an empty
  property, so the new Event's values do not replace them.
- The removal of the edge to the trashed Event runs the release hook of that
  ADR like any removal of an `event` edge. It ends a `company` link the
  transcript got after the trash, for example from a project the user chose by
  hand while the company was empty; the company stays as an own value.
- While a transcript has only its pairing card, the edge to the trashed Event
  is still stored. A reader that needs the transcript's Event has to leave out
  an Event that is in the Trash, as the match now does.
- The generic relation write still refuses another Event for a transcript
  whose Event is in the Trash. An explicit action that assigns an Event, and
  any change to the generic relation write, is a separate product decision.
