---
status: accepted
date: 2026-11-05
area: [backend]
supersedes: []
superseded-by: null
---

# The transcription create step writes the requested project

## Context

[[2026-09-23-transcription-worker-writes-event-match-results]] extends the
transcription worker's write access to its event-match result. A recording
request can also contain a project explicitly chosen by the user. Deferring
that edge to event inheritance would lose the explicit choice.

## Decision

The transcription worker may write the Transcripts `project` relation in the
create step, using only the project recorded in `recording_requests`. It uses
the choke point and creates an ordinary relation, without a value link. A
missing or trashed project is ignored.

## Consequences

The edge and create checkpoint are written in the same transaction as the
transcript. The worker locks the project before writing the edge so a live
project cannot be trashed between the check and the write. Retrying an
already checkpointed create step does not add another edge. Other worker
write permissions remain unchanged.
