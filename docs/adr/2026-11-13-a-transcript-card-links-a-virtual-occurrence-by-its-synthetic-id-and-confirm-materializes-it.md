---
status: accepted
date: 2026-11-13
area: [backend]
supersedes: []
superseded-by: null
---

# A transcript card links a virtual occurrence by its synthetic id, and the confirm materializes it

## Context

[[2026-10-25-task-and-event-recurrence-model]] stores a recurring Event as one series Event, and
[[2026-11-13-an-event-occurrence-is-an-events-item-named-by-its-series-event-and-date]] gives an occurrence that has
no item the synthetic id `<seriesId>@<date>`; the item is created the first time something links to the occurrence.
The match step of `semprec-transcribe` finds only stored Events, so a recording of a daily Standup whose occurrence
nobody has touched finds nothing. [[2026-09-23-transcription-worker-writes-event-match-results]] limits the worker's
writes to the Transcripts <-> Events edge and the transcript card, and says that any further worker write is a new
decision. The worker must therefore not create the occurrence's Event itself, and the edge can only point at an
item that exists.

## Decision

- **The worker only names the occurrence.** The match step also considers the virtual occurrences of the live
  recurring Events of a matchable type (`standup`, `meeting`) that overlap the recording, by the same strict interval
  rule as a stored Event. A virtual occurrence is never linked directly, even when it is the only candidate: the
  worker always creates a card, with `{ seriesId, occurrenceDate }` among the `candidates` of the card's `context`,
  next to the unchanged variant of a stored Event. When it is the one candidate, the card proposes the relation
  `{ entityKind: 'relation', target: '<seriesId>@<date>', properties: { propertyKey: 'event' } }`. The worker writes
  no Event and no edge, so its write surface is the one the ADR above names.
- **The series Event is not a stored candidate.** Its occurrences are found as virtual ones, or as stored items once
  materialized; matching the series Event as well would offer its first day twice.
- **A proposal envelope's relation target may be a synthetic occurrence id.** `assertValidProposalEnvelope` accepts
  it when `parseOccurrenceId` succeeds and the series is a live recurring Event with an occurrence on that date;
  otherwise it is refused as a `ValidationError` on `target`. The check of the relation itself (database, cardinality,
  ownership) runs against the series Event, which an occurrence copies and which stands in for the item that does not
  exist yet.
- **The confirm materializes it, in its own transaction.** `confirmProposalWithClient` calls
  `materializeEventOccurrence` as the confirming user and writes the Transcripts <-> Events edge to the item it
  returns, in the caller's transaction: either both persist or neither does. The recording ends up linked only to that
  occurrence, and the other occurrences stay virtual. The materialization is idempotent under its own advisory lock, so
  a second card for the same occurrence links the same item. A card confirmed twice is returned as already confirmed.
  An occurrence cancelled after the card was made has its item in the Trash; the link to it is refused and the card
  stays proposed.
- **Rejected.** Storing the occurrence date as metadata of an edge to the series Event would link the recording to
  every occurrence, and a worker that materializes the occurrence itself would be a new worker write on a guess that
  the user may reject.

## Consequences

- A card's `context.candidates` may hold occurrences, so a card can carry one candidate; the model recommendation of
  [[2026-11-13-transcription-recommends-the-event-of-an-ambiguous-recording]] still considers only stored Events and
  never recommends an occurrence.
- The Inbox card listing reads the target of an occurrence card from its series Event, which is in the same database.
- A series whose first date does not match its own rule has no occurrence on that date, so a recording of that day
  finds neither the series Event nor an occurrence.
