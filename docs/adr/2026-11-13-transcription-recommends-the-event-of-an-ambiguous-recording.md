---
status: accepted
date: 2026-11-13
area: [backend]
supersedes: []
superseded-by: null
---

# Transcription recommends the Event of an ambiguous recording from its content

## Context

[[2026-09-23-transcription-worker-writes-event-match-results]] describes the match step of
`semprec-transcribe` as deterministic and non-LLM: one overlapping Event is linked, anything else
becomes a `transcript` card for a human. Since issue #1813 the overlap is a strict interval
overlap, so a recording that overlaps two or more Events gets one card that proposes a new Event,
and the user has to work out which meeting it was. The recording's content usually settles it: a
recording about a sprint and iOS belongs to the sprint planning, not to the accountant call that
overlapped it.

The speaker suggestion already does something comparable
([[2026-09-23-speaker-mappings-are-edges-proposed-on-transcript-cards]]): it reads a snapshot,
calls `gateway.complete()` outside any transaction, and creates its cards and its checkpoint in
one transaction. Issue #1848 needs the same for the Event. The match step therefore stops being
purely mechanical, and no recorded decision covers a paid call inside it.

## Decision

- **The match step may make one paid recommendation call.** When two or more Events overlap the
  recording and the step has no `eventRecommendation` checkpoint, it calls `gateway.complete()`
  with `operation: 'transcript_event_match'`, `temperature: 0` and a response of
  `{ eventId: string | null, reason: string }`. The prompt carries the meeting notes' title, summary
  and short summary (speaker tokens replaced, as for any reader of the notes) and, for each
  candidate, its id, name, date, times, project name and participant names. The model answers
  `eventId: null` when it cannot tell, and writes the reason in the tenant user's UI language.
  Zero or one candidate never pays: one is linked and zero gets the new-Event card, as before.
- **The recommendation only ever shapes a card, never an edge.** It is used only when its
  `eventId` is one of the candidates found by the write transaction's own match; any other answer
  counts as no recommendation. With a recommendation the card's envelope is
  `{ entityKind: 'relation', target: <Event id>, properties: { propertyKey: 'event' } }`, the same
  shape the speaker cards use with `speakers`; without one it is the new-Event envelope. Either
  way a user confirms the card, and the `event` edge is written by that confirmation. The card's
  display data (candidates, reason, recommended id, recording facts) is stored only in its
  `context`.
- **The call is bracketed and checkpointed.** A repeatable-read snapshot decides whether a call is
  due, the call runs outside any transaction, and one transaction then locks the Files source and
  the transcript, runs the match again, creates the card and writes the checkpoint
  `{ recommendedEventId, reason }` on the source Files item. A replay after that commit makes no
  second call. A crash before it, or a second run that took its snapshot before the first one
  committed, can pay again; the locked transaction still leaves one card. A failed call, or an
  answer that does not parse, fails the step and the job retries it. A transcript that is already
  `done` or locked gets no call and no card, as in
  [[2026-11-10-finished-transcripts-are-not-matched-or-suggested-again]].
- **The checkpoint is a gate, not a source.** When it exists but the card is gone (purged from the
  Trash, which frees the card's idempotency key), a later run makes no call and creates the card
  without a recommendation.
- **The `transcript` card production sites do not change.** They stay the match step
  (`transcriptEventMatch.ts`, which now also hosts `createTranscriptEventCard`) and the suggestion
  step (`transcriptSpeakerSuggestion.ts`) of `semprec-transcribe`; the table in
  [[2026-09-23-speaker-mappings-are-edges-proposed-on-transcript-cards]] is unchanged.
- **The operation is not attributed to a project.** `transcript_event_match` is registered in the
  gateway with `projectItemId: null`, like the other transcript operations, and its calls are
  counted by the usage report under their operation key.

This extends [[2026-09-23-transcription-worker-writes-event-match-results]] without replacing it:
its write surface and idempotency are unchanged, and only its statement that the match step makes
no model call no longer holds for two or more candidates.

## Consequences

- A recording that overlaps several Events costs one more model call per transcript, once its
  checkpoint is written. Budget refusals reach the step as any gateway failure does.
- The step's tests have to cover the call, the checkpoint and each way the answer can be unusable;
  `matchTranscriptToEvent` no longer creates the card for two or more candidates, so a caller that
  wants one calls `createTranscriptEventCard` in the same transaction.
- Picking another candidate, taking over the Event's project and people after confirmation, and
  the usage-report label of the operation belong to later issues (#1870, #1697, #1477).
