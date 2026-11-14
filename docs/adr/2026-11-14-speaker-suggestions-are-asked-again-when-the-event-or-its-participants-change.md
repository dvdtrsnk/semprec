---
status: accepted
date: 2026-11-14
area: [backend]
supersedes: []
superseded-by: null
---

# Speaker suggestions are asked again when a transcript's Event or the Event's participants change

## Context

[[2026-09-23-speaker-mappings-are-edges-proposed-on-transcript-cards]] has `semprec-transcribe` ask for speaker
suggestions once per pipeline run, in step 7 (`suggestSpeakers`), and states as a consequence that a transcript whose
Event was linked after that run gets none. The step's checkpoint on the source Files item is written even when nothing
could be suggested, so a later run of the step asks nothing either. The Event is linked later in ordinary use: the user
confirms the Event card, uploads with an Event later, links it by hand, or the Event gains a participant after the
pipeline ran.

Edges are written by three processes (the transcription worker's match step, `semprec-api` for the confirm route and the
generic relation endpoint, `semprec-agents` for Semp). The relation-edge-changed hook of issue #1530
([[2026-09-30-choke-point-domain-hooks-through-a-per-process-registry]]) runs in the writing process after the write and
never in the dry-run validation of `assertRelationCreatableWithClient`, so one registered hook sees every writer.
[[2026-11-10-finished-transcripts-are-not-matched-or-suggested-again]] keeps the pipeline's own steps from touching a
finished transcript; the new trigger is not a pipeline run.

## Decision

- **The trigger is the changed-edge hook.** `transcriptSpeakerSuggestionEdgeChangedHook`, registered in
  `domainWriteHooks.ts`, reacts to the creation or deletion of an edge of the Transcripts `event` property (for the edge's
  transcript) and of the Events `people` property (for every live transcript linked to the edge's Event: transcripts can
  share an Event). In the writing transaction it enqueues the core task `transcriptSpeakerSuggestion` with payload
  `{ transcriptId }` and job key `transcript-speaker-suggestion:<transcriptId>`, `maxAttempts: 3` and the tenant's lane,
  so many edge writes in a short time converge on one run. An update of an edge, any other relation and a transcript
  in the Trash enqueue nothing, and the dry-run validation never reaches the hook.
- **The task runs the pipeline's suggestion.** It runs on the short-model-task runner of `semprec-transcribe`, which
  [[2026-11-14-transcript-cards-are-recomputed-by-their-producer-on-instruction]] introduced, and shares its body
  (`runSpeakerSuggestion`) with step 7: a repeatable-read snapshot, one gateway call outside any transaction, one
  transaction that re-locks the run, creates or refreshes the cards and writes the checkpoint. Unlike step 7 it also asks
  about a transcript whose `status` is `done`, which is the point of it; step 7 still leaves a finished transcript alone.
  It does nothing for a transcript without `segments`, without an unmapped speaker, in the Trash, whose source
  Files item is gone, or that a user locked. It takes the locks of a pipeline step (source, transcript, then the
  `item_automation` row, to see a user's lock) but writes nothing to `item_automation` and counts no attempt.
- **The checkpoint is bound to what was asked.** It stores `{ proposedSpeakers, eventId, candidateIds }`: the keys
  that got a card (this run's and earlier runs'), the transcript's Event id (`null` without one) and the sorted ids of
  the candidate people. The model call is skipped only when the checkpoint holds the Event and candidates of now. An old
  checkpoint without the binding counts as different. The binding stored is the one the call was asked for, so
  a participant added while the call was out is asked about by the next job, which that edge write queued.
- **A card that asks for clarification is refreshed by its producer; no other card is rewritten.** A card that
  exists is never duplicated (its idempotency key stays). A card that is `needsClarification` and has no history entry by
  the user is refreshed with the new `context` (`alternatives`, `reason`) and, when the model is now confident, a
  `relation` envelope in `proposal` and `aiProposal` (`aiVersion` one up) and the status `proposed`, with one
  `recompute` history entry; a refresh that would change nothing writes nothing. A card that is `proposed`,
  `confirmed`, `rejected` or invalid, one in the Trash, and one the user touched are left as they are.
- **The refresh takes the card after the transcript, without waiting.** `proposeSpeakerMappings` locks the transcript
  first; a confirm locks the card first and the transcript second
  ([[2026-11-12-a-manual-speaker-assignment-settles-the-key-card-in-the-confirm-lock-order]]). To avoid the opposite
  order, the refresh takes the card with `NOWAIT` in a savepoint and leaves a busy card as it is, which is a card a user
  is deciding on.
- **The production sites of `transcript` cards are unchanged.** The suggestion step stays the one site that creates
  speaker cards and now also runs from the task; a refresh rewrites `context`, `proposal`, `aiProposal`, `aiVersion`,
  `status` and `history` of a card of that same site, under the card's row lock.

## Consequences

- This changes the stated consequence of [[2026-09-23-speaker-mappings-are-edges-proposed-on-transcript-cards]] that a
  transcript whose Event was linked after its pipeline run gets no suggestions, and the last consequence of that ADR (an Event
  linked by confirming its card). The other decisions of that ADR stand.
- A change of an Event's participants now costs one paid call per linked transcript with unmapped speakers, once per
  distinct Event and candidate set. The task makes no call when the candidates are the ones the checkpoint holds.
- A job races with the pipeline only through the row locks above: whichever commits first writes the checkpoint and the
  other finds it current.
- The job needs no latency guarantee: it runs when the runner is free. Remembering rejected speakers across a diarization
  rerun is not decided here.
