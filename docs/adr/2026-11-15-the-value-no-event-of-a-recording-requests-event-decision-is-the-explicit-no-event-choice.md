---
status: accepted
date: 2026-11-15
area: [backend]
supersedes: []
superseded-by: null
---

# The value noEvent of a recording request's event decision is the explicit no-event choice

## Context

After a transcript is created, step 6 of the transcription pipeline links it to the one Event that overlaps the
recording, asks for a recommendation when several overlap, and creates the "recording without an event" card when none
does ([[2026-09-23-transcription-worker-writes-event-match-results]],
[[2026-11-13-transcription-recommends-the-event-of-an-ambiguous-recording]]). A user who shares a recording and says
that it belongs to no Event had no way to record that, so the card came back after every rerun of the transcription.

The recording request carries the context of an uploaded recording
([[2026-11-05-recording-intake-coordinates-files-and-transcription]]). Its column `event_decision` was created as
`text NOT NULL DEFAULT 'none'` with no CHECK constraint, and nothing wrote or read it. Every request therefore holds
`'none'` unless a writer sets another value, and `'none'` means that the user did not decide. The card that proposes
transcribing an audio attachment and its confirm
([[2026-11-14-inbox-recording-cards-confirm-into-recording-intake]]) had no representation of the explicit choice:
an `eventId` left unset or cleared is `null`, which means the same as an absent one. That ADR also says that a later
change of the recording request's writers needs its own decision, and `recordRecordingIntake` is the only writer of
the request's other columns.

## Decision

**The value.** The column keeps its definition. `'none'` is its default and means the user did not decide; it is also
an `event_decision`. The explicit decision that the recording belongs to no Event is the value `noEvent` (an English
camelCase key), exported as `RECORDING_EVENT_DECISION_NO_EVENT`. No migration changes the column, its default or its
constraint, and no Transcripts property stores the decision. Any stored value other than `noEvent`, the default
included, means no explicit decision.

**The card.** The envelope of a recording card gets one more property, the boolean `noEvent`. `true` is the choice;
`false`, `null` and an absent property mean that nothing was chosen, which is what an Event left unset means.
`noEvent: true` together with an `eventId` is refused with a `ValidationError` on the field `noEvent` by the
envelope's schema, so an edit, a revise and a confirm all refuse it. A revise keeps the user's `noEvent: true` like any other manual
value (the key is one of `RECORDING_PROPERTY_KEYS`), so a revise whose assistant envelope names an `eventId` while the
kept value is `noEvent: true` is refused on `noEvent`, and the user switches by editing `noEvent` and `eventId`
together.

**The write.** `confirmRecordingCard` calls `setRecordingEventDecision`, a function of the store of the recording
intake (`recordingIntake.ts`), right after `recordRecordingIntake` returned, in the confirm's own transaction, and
only when the card's `noEvent` is true. The intake has locked the Files item `FOR UPDATE NOWAIT` by then and holds the
lock until the transaction ends, so another intake of the same Files item cannot interleave and answers
`recording_busy`. The decision commits with the request and with the transcription jobs, so the worker cannot run the
match before it is visible. The function updates exactly one row of the tenant's request and fails when none matched.
A confirm that makes no such choice writes nothing: nothing clears a stored decision, and a request that already
exists keeps its first accepted values, an Event it names included, as the intake's `ON CONFLICT DO NOTHING` has it.

**The read.** The shared read half of the match step (`readOpenMatch`, used by `matchTranscriptToEvent` and by
`readEventRecommendationContext`) first reads `readRecordingEventDecision` for the Files item that the transcript's
`link` names. When the decision is `noEvent` the match returns the new outcome `noEventChosen`, which
`runEventMatch` of `semprec-transcribe` already treats as a finished step like every string outcome. The check comes
before the transcript's edges and card are read, so `noEventChosen` is returned before `alreadyLinked` and
`alreadySuggested`: nothing is written, an existing edge or card stays as it is, no card is created, no Event is
linked, and `readEventRecommendationContext` returns `null`, so the paid recommendation call is not made. The
transcript stays without an Event, and the user can still pair it by hand. The check also runs before
`readTranscriptEventEdges`, so an edge to a trashed Event
([[2026-11-11-an-edge-to-a-trashed-event-is-no-link-for-the-match-and-a-pairing-card]]) is neither released nor counted
when `noEvent` is stored: it is left as it is like any other edge. A transcript whose Files item has no request, a
transcript without a `link`, and any other stored value behave as before.

## Consequences

The name `none` reads as the opposite of its meaning in this column: the explicit "no event" is `noEvent`, and `none`
is the absence of a decision. The older epic summaries that say `none` are history that this record supersedes. A
decision stored after the transcript was matched does not undo what the match wrote, but the match is a no-op for
the transcript from then on. Besides `readRecordingRequest`, `recordRecordingIntake` and `deleteRecordingRequestForFile`, the store now holds the
setter and the reader; `recordRecordingIntake` stays the only writer of the request's other columns (the delete removes
the whole row on undo).
