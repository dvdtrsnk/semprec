---
status: accepted
date: 2026-11-10
area: [backend]
supersedes: []
superseded-by: null
---

# The transcription create step writes the upload's Event edge

## Context

[[2026-09-23-transcription-worker-writes-event-match-results]] lets
`semprec-transcribe` write a transcript's Event only as the outcome of its
match step: the Transcripts <-> Events edge, or one proposal card. It states
that any further write the worker needs is a new decision.
[[2026-11-05-transcription-create-writes-requested-project]] added one such
write, the project a recording request names.

Since [[2026-11-05-recording-intake-coordinates-files-and-transcription]] an
upload can name its Event, stored as `recording_requests.event_item_id`. That
decision links the Event only when the transcript already exists and leaves
the initial Event of a new transcript to a later issue. A new recording
therefore reached the Event its upload named only through the match step, by
time window. Until that step it had no Event. When the named Event did not
start inside the window, the match did not link it: it linked another Event
or produced a proposal card, and speaker suggestion did not read the named
Event's participants.

The alternatives were to read the request in the match step, which leaves the
transcript without its Event until the paid media steps are done, or to write
the edge from `semprec-api`, where the transcript of a new recording does not
exist yet when the upload commits. This decision is an exception to the limit
stated in the first ADR; that ADR's body and the match step are unchanged.

## Decision

The transcription worker may write the Transcripts `event` edge in the create
step, using only the Event recorded in `recording_requests.event_item_id` for
the transcript's source file. It writes the edge through the choke point
(`createRelationWithClient`), in the transaction that creates the Transcripts
row and its create checkpoint.

The Event must be a row of the tenant's Events database that is not in the
Trash. The worker reads it with a row lock before the write. An Event that is
in the Trash, was purged, or is not in that database gets no edge and raises
no error; the transcript is then left to the match step like a recording
uploaded without an Event.

The edge is written after the requested project. Issue #1697 plans rules that
fill only an empty transcript value from the Event; with this order they will
find the explicit project already in place.

## Consequences

The edge, the Transcripts row and the create checkpoint commit together or
not at all. The lock on the Event is held until that transaction ends, so a
live Event cannot be moved to the Trash between the check and the write. A
create step that runs again returns at its checkpoint before any write and
adds no second edge.

The create step takes its row locks in the order source Files item,
transcript, requested project, requested Event. This decision claims no
global deadlock freedom for that order. While the create transaction holds
the Event's row lock, the intake's `NOWAIT` reservation of that Event
([[2026-11-05-recording-intake-coordinates-files-and-transcription]]) fails,
so an upload naming the same Event at that moment is answered
`recording_busy`, as it is while any other transaction holds a lock on that
row.

The match step finds the edge and returns `alreadyLinked`: it creates no
proposal card and never replaces the edge. Speaker suggestion reads the
participants of the linked Event. An Event can now hold a transcript whose
recording does not overlap it in time, because the upload's choice is not
checked against the time window.

The relation-edge hooks registered in the worker process run for this edge
inside the create transaction, as they do for the match step's edge
([[2026-09-30-choke-point-domain-hooks-through-a-per-process-registry]]):
every process that loads `@semprec/data` registers them, so `serve.ts` needs
no wiring of its own. A hook that rejects rolls the whole create step back,
the Transcripts row included, and the queue retries the job within its
attempts. The rules that inherit a transcript's project, company and people
from its Event (issue #1697) will attach to this edge through that registry.

Other worker write permissions remain unchanged.
