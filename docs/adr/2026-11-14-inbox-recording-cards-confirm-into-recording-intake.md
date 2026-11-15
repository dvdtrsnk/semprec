---
status: accepted
date: 2026-11-14
area: [backend]
supersedes: []
superseded-by: null
---

# Inbox recording cards confirm into the recording intake

## Context

A recording shared into the Inbox is an attachment row of its Inbox item
([[2026-11-14-inbox-attachment-facts-are-computed-by-semprec-transcribe-and-recorded-once]] gives it its duration and
recording time). Nothing may be transcribed, and so paid for, until the user has seen what is known about it and
confirmed, with the name, language, speaker count, Event and project they want. The transcription pipeline starts from
a recording request that the shared recording intake writes
([[2026-11-05-recording-intake-coordinates-files-and-transcription]]), and the file reaches Files by the
`fileFromAttachment` rule ([[2026-10-29-file-from-attachment-proposal-step]]).
[[2026-09-23-speaker-mappings-are-edges-proposed-on-transcript-cards]] fixes one producer per card `kind` and gives
`semprec-transcribe` every `transcript` card, so the new card must not become a second producer of that kind.
[[2026-11-03-confirm-results-report-only-enqueued-follow-ups]] assigned the `transcriptionQueued` result to this
decision. The recording intake ADR said that the name, language, speaker and project columns of `recording_requests`
stay NULL because its only caller was the upload endpoint, which does not carry them; this decision gives them a
writer.

## Decision

**The card.** An `inbox` card (`kind = 'inbox'`) may hold an envelope with `entityKind: "transcription"`. Its `target`
is the id of an audio attachment of the card's source Inbox item, and its `properties` are exactly a non-empty `name`
and the optional `language` (ISO 639-1), `numSpeakersExact` (integer from 1), `numSpeakersMin` (integer from 2, at most
one of the two, each at most 2147483647, the top of the `integer` columns that store them), `eventId` (a live Events item) and `projectId` (a live Projects item). A parameter the user cleared is
`null`. Any other key is refused, a client-supplied `recordedAt` or `durationSeconds` included: the duration and the
recording time are the attachment's metadata, which the card only reads. A manual `eventId` or `projectId` is valid
whether or not the card suggested it. The envelope has no steps and no relations. The card kind derived for it is
`recording`.

**Producer.** `semprec.tick` is the only producer. Before any model computation it routes the item by its attachments
(`routeInboxAttachments`, issue gh-1985): an audio attachment without metadata means the tick does nothing (the metadata
job runs it again); otherwise the first audio attachment whose `audioKind` is `recording` makes the tick build the card
for it and make no model call, whatever else the item holds; every other item goes through the computation as before.
The card is built from that attachment, with no model call: it proposes a name from the first line of the item's text, otherwise
"Recording D. M. HH:mm" in the tenant's zone when the metadata has a recording time, otherwise "Recording". The card's
`context` is `{ role: "recording", candidates, recording: { durationSeconds?, recordedAt?, source } }`: the duration and
the recording time are the metadata's, left out when it has none, and `candidates` are the live Events of the
recording's local day whose type is `meeting`, `standup` or empty, empty when the recording time is unknown. No
capture, upload or current time is used in place of a missing recording time. The tick stores the card with the writes
it already makes for a computed card.

**Confirm.** `confirmProposalWithClient` of `semprec-api`, in its one transaction: validates the envelope again,
including that the attachment belongs to the card's source Inbox item; locks that Inbox item and reads the
attachment's metadata under the lock; moves the attachment into Files as a `fileFromAttachment` step does (a live Files
item with the same blob is linked instead of duplicated); writes the recording request of the Files item through
`recordRecordingIntake` with the card's parameters and the metadata's recording time; and lets the intake enqueue
`transcriptionCreate` and `transcriptionJob` under their keys. `recordRecordingIntake` gains optional
`parameters` (`name`, `language`, `numSpeakersExact`, `numSpeakersMin`, `projectId`); the upload endpoint passes none,
so its requests still store NULL for them. The request keeps its first accepted values
(`ON CONFLICT DO NOTHING`), so a Files item that already has a request keeps it.

**Project.** The card's `projectId` is written into the request only when it differs from the project of the chosen
Event, so a recording whose project the user left as the Event's takes it from the Event when the transcript's Event
edge is written ([[2026-11-10-transcript-values-are-inherited-by-link-rules-whichever-process-writes-the-edge]]) and
follows the Event afterwards. The Event row is locked `FOR UPDATE` before its project is read, which orders the read
against a write that locks the Event as the edge's caller; an edge written from the project's side is not ordered
against it, and the transcript then keeps the project the card showed.

**Result.** The confirmation result's `followUp` is `transcriptionQueued` only when the Files item had no transcript
and the confirm read both jobs back after the intake; a Files item that already has its transcript gets neither jobs
nor the flag. The enqueue, the result, the card's `confirmed` status and the moved attachment commit or roll back
together in the confirm's transaction, and a replay of a confirmed card returns its stored results and enqueues
nothing.

**Ownership.** `semprec-transcribe` still creates every `transcript` card and every Transcripts row; the recording
card's confirm only writes the request that its create step reads. The Files create trigger skips the Files item
through its request row and its `inbox` origin.

## Consequences

A rejected card transcribes nothing and the attachment stays with its Inbox item. A confirm that fails after the move
(for example the intake refuses an Event the existing request does not allow) rolls the move back and leaves the card
`proposed`. Atomicity here means one transaction, not serialization: two confirms of different cards for the same
bytes wait on the blob lock of the move and the second links the first one's Files item. A later change of the
recording request's writers needs its own decision.
