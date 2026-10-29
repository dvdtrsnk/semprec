---
status: accepted
date: 2026-10-29
area: [backend]
supersedes: []
superseded-by: null
---

# An Event holds many transcripts, and a transcript at most one Event

## Context

[[2026-09-23-transcription-worker-writes-event-match-results]] has the match step link a recording to its Event through the Transcripts <-> Events relation as a 1:1 edge. The relation was seeded as `one_to_one` (`backend/packages/data/src/seed/seedTenDatabases.ts`), and the match created a suggestion card instead of an edge when its single candidate Event already held another transcript.

A meeting recorded in several parts then needs one Event with several transcripts, each with its own summary. Under the 1:1 rule the second part either became a card or failed with `cardinality_violation`. Events have no recurrence, so each occurrence is its own item and the Event is the one record of the meeting.

This decision narrows the cardinality of that one relation. It leaves the decision of [[2026-09-23-transcription-worker-writes-event-match-results]] otherwise in force: the transcription worker still writes the match outcome in-process, and zero or several candidates still produce a card.

## Decision

`Events.transcript` is `one_to_many`, with Events as property A, the "one" side. An Event may have many transcripts. A transcript has at most one Event: the trigger from `backend/packages/data/src/db/migrations/0013_relation_cardinality.sql` still rejects a second Event for one transcript, with `cardinality_violation`.

The match step links a single candidate Event even when that Event already holds other transcripts. Zero or several candidates still create one `kind = 'transcript'` proposal card.

Each part keeps its own summary. A summary that combines all parts of a meeting is not built in v1; that is a product-owner decision.

The relation keys do not change: `transcript` on Events and `event` on Transcripts.

Populated tenants are cut over by `backend/packages/data/src/transcription/eventTranscriptCardinalityCutoverMigration.ts`, which runs once per maintained tenant in `runTenantCutoverMigrations`, the mechanism of [[2026-09-10-app-code-post-migration-steps]]. It changes only the `relation_definitions` row and writes no edge. It is idempotent.

## Consequences

- The database enforces one side only. An Event with many transcripts is valid, and the only refused shape is a transcript with two Events. Code that needs at most one transcript per Event has to check it itself; the match step no longer does.
- The cardinality trigger takes an advisory lock keyed on the relation definition, not on the Event. Concurrent inserts into `Events.transcript` therefore serialize on that lock, and each insert's check sees the edges committed before it.
- The match locks the transcript row before it reads that transcript's edges, so a retried or concurrent match for one transcript converges on one edge or one card.
- The cutover from `one_to_one` touches only the definition row. Every existing edge keeps its id, endpoints and metadata.
- Listing several transcripts per Event in a lightweight form is #1636. Matching by interval overlap is #1813. Recurring events and matching to virtual occurrences are #1850. Each is a separate decision.
