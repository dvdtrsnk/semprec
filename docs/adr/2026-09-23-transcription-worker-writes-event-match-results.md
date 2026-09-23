---
status: accepted
date: 2026-09-23
area: [backend]
supersedes: []
superseded-by: null
---

# The transcription worker writes its Event-match result itself

## Context

[[2026-09-22-transcription-worker-choke-point-access]] lets `semprec-transcribe` use the
choke-point package only to create Transcriptions items and write its declared computed
checkpoints. The pipeline's match step (issue #247) has to record its outcome as well: either the
Transcriptions <-> Events 1:1 edge when exactly one Event falls inside the recording's window, or
a `kind = 'transcript'` Processing proposal card linked through `sourceTranscript` when zero or
several do. The alternatives were to enqueue a job for `semprec-agents` or `semprec-api` to write
it, or to write it from the worker's own transaction.

## Decision

`semprec-transcribe` also writes the match step's outcome in-process, through the choke-point
package: the Transcriptions <-> Events edge via `createRelationWithClient`, and the one Processing
proposal card per transcript via `createItemWithClient` (with a deterministic idempotency key) plus
its `sourceTranscript` edge under the Processing proposals' `SystemRelationWriteContext`. It is a
deterministic, non-LLM step, so the direct edge is not an agent write; everything ambiguous is left
to a human through the card's `confirm`. The decision of
[[2026-09-22-transcription-worker-choke-point-access]] is otherwise unchanged.

## Consequences

The match reads the checkpoint and writes its outcome in a single transaction that row-locks the
transcript, so a retried or concurrent job converges on one edge or one card instead of racing a
second process. The worker's write surface grows by exactly these two writes; any further write
it needs is a new decision.
