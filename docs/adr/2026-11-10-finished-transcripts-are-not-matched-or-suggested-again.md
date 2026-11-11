---
status: accepted
date: 2026-11-10
area: [backend]
supersedes: []
superseded-by: null
---

# A finished transcript is not matched to an Event or asked about its speakers again

## Context

A transcription job runs every pipeline step each time it runs and relies on
each step to skip work that is already done. Two steps create things a user
sees and acts on:

- The match step links the one Event in the recording's window or creates the
  transcript's pairing card
  ([[2026-09-23-transcription-worker-writes-event-match-results]]). It skips a
  transcript that has an Event edge or already has its card.
- The speaker suggestion step creates speaker cards and may pay one gateway
  call ([[2026-09-23-speaker-mappings-are-edges-proposed-on-transcript-cards]]).
  It skips a source file that has the `suggestSpeakers` checkpoint.

Neither condition says that the transcript is finished. Both describe what an
earlier run left behind, and that can be missing on a finished transcript:

- The Transcripts `event` relation belongs to the user. A transcript that was
  linked directly has no pairing card, so after the user removes the edge the
  match step finds neither and links the Event again, or creates a card.
- A pairing card that was purged from the Trash no longer holds its
  idempotency key, so the match step creates it again.
- Until issue #1640 the suggestion step wrote no checkpoint and no card when
  the transcript had no linked Event, or that Event had no named participant
  left to propose. The speaker ADR states the intent: "With no linked Event it
  asks nothing and checkpoints nothing, so a later run can still ask." Since
  #1640 the step writes a card for every unmapped speaker and the checkpoint
  on the first run, so a transcript processed since then is not asked about
  again. A transcript finished before that still has no checkpoint and no
  speaker card.

Until now a finished transcript's job ran again only at a user's request (for
example `POST /api/transcriptions/:id/rerun`). Issue #1712 enqueues the job of
every finished transcript that has no meeting notes, from a tenant cutover at
deploy. For a transcript in one of the states above that run would link an
Event again or create cards, and it could pay a speaker suggestion call. The
issue asks for the opposite: the re-run stores the notes and nothing else.

Alternatives considered:

- Mark the backfill's jobs in the payload and skip the two steps for them
  only. Every producer enqueues under the one key `transcription-job:<fileId>`
  and a later enqueue replaces the payload of a queued job, so a manual rerun
  or the daily requeue would silently remove the mark.
- Write the missing `suggestSpeakers` checkpoints in a cutover. That makes the
  cutover a second writer of the worker's checkpoint, and it does not cover a
  removed Event edge or a purged card.

## Decision

The match step and the speaker suggestion step do nothing for a transcript
whose `status` is `done`: no Event is linked, no card is created, no gateway
call is made and no checkpoint is written. This holds for every run of the
job, whoever enqueued it.

`status` is system-owned and only the finalize step sets it to `done`; in a
run that step comes after both of these steps have returned. Each step reads
the status from the transcript row that its transaction has locked `FOR UPDATE`
([[2026-11-01-transcription-stop-guards-lock-items-before-automation]]):

- The match step is one transaction. The status is read before the match, and
  the row lock is held until the transaction ends.
- The speaker suggestion step is two transactions around the gateway call
  ([[2026-09-10-bracket-non-transactional-calls-with-staleness-checked-transactions]]).
  The first reads the status before the call is made. The second reads it
  again before the cards and the checkpoint are written, because another run
  can finish the transcript while the call is out.

A transcript in any other status is matched and asked about as before: a first
run, a retry of a failed attempt, a run resumed after a shutdown, and the
requeue or rerun of a transcript whose `status` is `error`.

## Consequences

This narrows [[2026-09-23-speaker-mappings-are-edges-proposed-on-transcript-cards]]
without replacing it. "A later run can still ask" now holds only until the
transcript is finished. A transcript finished before issue #1640 without the
checkpoint gets no speaker cards from a rerun or from the meeting-notes
backfill, and a transcript whose Event is linked after it finished gets no
suggestions from a rerun. Its speakers are mapped by hand through the
`speakers` relation. Suggesting speakers for finished transcripts would be a
separate, explicit operation and a new decision.

A user's removal of a finished transcript's Event edge is final for the
pipeline. The transcript stays without an Event until the user links one.

A manual rerun of a finished transcript stores only what the summarize step
is still missing. Its `item_automation` counts the attempt and is settled
again.

A gateway call that is already out when another run finishes the transcript
is still paid; its answer is discarded. No lock is held across the call, so
this cannot be prevented.

The cards, edges and checkpoints of unfinished transcripts are unchanged, and
so are their convergence rules: a retry still finds the existing edge, card or
checkpoint.
