---
status: accepted
date: 2026-11-15
area: [backend]
supersedes: []
superseded-by: null
---

# The voice notes of an Inbox item are transcribed into a property the transcribe process owns

## Context

A short voice note ("at the doctor: blood pressure 135/85, measure it for two weeks") should become text the assistant
can read and a card can quote. The Inbox item already has `text`, which the person owns; the single-writer rule
([[2026-09-10-single-writer-ownership-model]]) forbids the server from writing it. The metadata job
([[2026-11-14-inbox-attachment-facts-are-computed-by-semprec-transcribe-and-recorded-once]]) classifies each audio
attachment as `voiceNote` (under `INBOX_RECORDING_MIN_SECONDS`) or `recording`, and `semprec-transcribe` is the process
that already calls the gateway's transcription route. What is left to settle is where the transcript lives, who writes
it, when the job runs, and what a run may do while the item changes under it.

## Decision

**The property.** `Inbox.transcribedText` is a `text` property with owner `system` and owner process
`TRANSCRIPTION_OWNER_PROCESS` (`transcribe`). A user write, a user create that sets it, and a write by another system
process are refused with 403 `owner_violation` by the generic ownership check; the transcribe process writes it through
`updateItemWithClient` with `allowedSystemKeys` and `systemOwnerProcess`, the way it writes Transcripts. It is the only
property that write patches, and `text` is never read or written by the job. The seed declares it for a new tenant and
`seed/inboxTranscribedTextCutoverMigration.ts` adds it to an existing one (raw SQL under `LOCK TABLE properties IN
EXCLUSIVE MODE`, because the Inbox database is schema-locked).

**The job.** `inboxVoiceNoteTranscribe` (affinity `transcribe`, tenancy `tenant`) has the key
`inbox-voice-note:<inboxItemId>` in the replace mode and runs in the tenant's lane with three attempts. The metadata
job enqueues it, in the transaction that records the metadata of an attachment whose `audioKind` is `voiceNote`, so the
job exists exactly when that metadata does ([[2026-09-10-side-effects-follow-the-commit]]); a recording, an unreadable
file, a photo and a PDF enqueue nothing. The job is keyed by the item, not by the attachment, so a second voice note
replaces the waiting job, and a run covers every voice note of the item at that time: the voice notes in position order,
each sent to `AudioGatewayClient.transcribe` with its probed length, the non-empty trimmed transcripts joined with a
blank line. It runs on the runner of the short model tasks. A voice note larger than `MAX_VOICE_NOTE_BYTES` is not read
or sent and the others are; the log names its attachment id.

**The write.** The slow work (download, gateway call) runs outside any transaction. One transaction then locks the Inbox
item row (`FOR UPDATE`), reads the item's voice notes again and writes only when they are the same attachments, in the
same order, that the text was made from. Every writer of the voice notes of an item (`insertInboxAttachments`,
`recordInboxAttachmentMetadata`, `deleteInboxAttachment`) takes that row lock first, so the set cannot change between
the re-read and the commit. When it did change during the gateway calls, the run writes nothing and fails, so the queue
retries it with the notes of then: a text made from notes that are no longer the item's would be wrong, and a retry is
cheap compared with a wrong text. A text equal to the stored one (a missing value counts as the empty text) writes
nothing, so a rerun that finds the same transcript changes no row and announces nothing; a different text is an
ordinary item update, which announces the update to the item's `onItemEvent` heartbeats. An item that is gone or in the
Trash, and one with no voice note, end the job successfully. A gateway failure, a budget refusal included, fails the job
for retry and leaves the property as it was.

## Alternatives rejected

- Writing the transcript into `text`: a second writer of the person's field.
- Storing one transcript per attachment so a second voice note does not transcribe the first again: it needs a column
  on `inbox_attachments` and a migration the product did not ask for, and the issue decides one property written by a
  job that is keyed per item and replaces itself.
- Transcribing inside the metadata job: the gateway call would hold the metadata runner, which exists so that an
  `ffmpeg` run to its timeout blocks nothing else.
- Writing the text whatever the set of voice notes is: a note deleted during the gateway calls would leave a transcript
  that nothing corrects, because deleting an attachment enqueues no job.

## Consequences

Every run pays for one gateway call per voice note of the item, including notes a previous run already transcribed. A
voice note that is deleted does not queue a run, so its transcript stays in `transcribedText` until the next run over the
item. `semprec-api` reads `text ?? transcribedText` (issue gh-1987) and the fingerprint covers `transcribedText`
(issue gh-1606) in their own issues; until then the property is only stored. Proof: the
job tests with real M4A files, a fake gateway and the real metadata job on the runtime role pool with two tenants
(`inboxVoiceNoteTranscribe.test.ts`), the store tests of the read and the guarded write, and the cutover and ownership
tests.
