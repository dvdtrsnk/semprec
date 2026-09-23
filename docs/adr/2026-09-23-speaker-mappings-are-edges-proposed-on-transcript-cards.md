---
status: accepted
date: 2026-09-23
area: [backend]
supersedes: []
superseded-by: null
---

# Speaker mappings are validated `speakers` edges, proposed by the transcription worker on transcript cards

## Context

A transcript's `computed.segments` keep the diarization's anonymous keys (`SPEAKER_00`, ...)
forever. Who each key is lives on the user-owned Transcripts `speakers` -> People relation, one
edge per person with `metadata = { speaker }`. Issue #185 lets a user add, replace and remove
these mappings through the generic relation endpoint, and lets AI suggest them from the matched
Event's participants. Only a human confirmation may then write the mapping. Three things were
undecided:

1. The generic relation write accepted any metadata object. A `speakers` edge without a
   `{ speaker }` key, with a key the transcript does not have, or with a key another person
   already holds would be stored silently, and the transcript could then not be shown
   consistently. The alternative was to validate only in a dedicated write function. That
   function existed (`writeTranscriptSpeakerEdge`), but a user's `PUT /api/items/:id/relations/speakers/:personId`
   never went through it.
2. The AI needs a card shape for a mapping.
   [[2026-09-23-processing-proposals-card-creation-owned-per-kind]] makes `semprec-transcribe`'s
   match step the only producer of `transcript` cards. It also says a second producer for an
   existing kind is a new decision. The alternatives were a new card `kind` with its own schema
   change, a new Processing proposals property carrying the mapping, or reusing the `'relation'`
   envelope from issue #184.
3. [[2026-09-23-transcription-worker-writes-event-match-results]] limits the worker's writes to
   the match outcome, and a suggestion step needs a model call.

## Decision

- **The choke point validates `speakers` edge metadata.** `createRelationWithClient` and
  `updateRelationWithClient` (and `assertRelationCreatableWithClient`, the check `revise` uses)
  run `assertSpeakerEdgeWritable` when the relation property is Transcripts' `speakers`. The
  check needs metadata of exactly `{ speaker }`, a key that occurs in the transcript's
  `computed.segments`, and no other person already mapped to that key. It row-locks the
  transcript so that concurrent writes serialize, and every rejection is `validation_failed` on
  `metadata`. This follows the precedent of module-keyed rules inside the choke point
  ([[2026-09-19-derived-system-properties-computed-inline-at-choke-point]]): the rule applies to
  every writer, so it sits where every writer passes. Removing an edge needs no metadata and is
  not checked. `writeTranscriptSpeakerEdge` had no production caller and is removed.
- **A mapping suggestion is a `transcript` card with a `'relation'` envelope** through `speakers`:
  `{ entityKind: 'relation', target: personId, properties: { propertyKey: 'speakers', metadata: { speaker } } }`.
  The `'relation'` envelope gains an optional `metadata` object that `confirm` writes as the
  edge's metadata. One card maps one key. A transcript card keeps its role for life: `revise`
  may change the person or the Event, but never turn an Event proposal into a speaker mapping or
  back.
- **`semprec-transcribe` gets a second `transcript`-card production site.** After the match step,
  a `suggestSpeakers` step reads the linked Event's named participants who are not yet mapped and
  the unmapped keys. When both exist, it calls `gateway.complete()` once
  (`operation: 'transcript_speaker_suggestion'`, no project). It then creates one card per valid
  suggestion under a deterministic idempotency key, with its `sourceTranscript` edge, and writes
  the step's checkpoint in the same transaction. It never writes a `speakers` edge. With no
  linked Event it asks nothing and checkpoints nothing, so a later run can still ask.

## Consequences

- Any writer of a `speakers` edge gets the same canonical errors: the REST endpoint, a confirmed
  card, or a future caller. The render path (`listTranscriptSpeakers` and the
  `GET /api/transcripts/:id/speakers` route) can rely on one key per person and one person per key.
- Replacing who a key belongs to takes two writes: remove the current person's edge, then add
  the new one. Moving a person to another key is one metadata replace.
- The Processing proposals schema is unchanged. The `transcript` kind now has two production
  sites in one process (`transcriptEventMatch.ts`, `transcriptSpeakerSuggestion.ts`), and they
  are told apart by the envelope.
- A transcript whose Event is only linked later, by confirming its Event card, gets no speaker
  suggestions until the pipeline runs for it again.
