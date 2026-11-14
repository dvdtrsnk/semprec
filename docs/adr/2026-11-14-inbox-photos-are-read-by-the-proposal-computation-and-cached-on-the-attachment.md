---
status: accepted
date: 2026-11-14
area: [backend]
supersedes: []
superseded-by: null
---

# Inbox photos are read by the proposal computation and the result is cached on the attachment

## Context

A photo of an invoice attached to an Inbox item should fill the proposal with the supplier, the amount and the dates.
`semprec-transcribe` already computes the facts of an attachment, including a reduced JPEG of a photo, and records them
once ([[2026-11-14-inbox-attachment-facts-are-computed-by-semprec-transcribe-and-recorded-once]]). Reading the
document is a model call, so it goes through the gateway ([[2026-09-10-ai-gateway-monopoly-on-provider-calls]]) and
cannot hold a transaction ([[2026-09-10-bracket-non-transactional-calls-with-staleness-checked-transactions]]). The
result has to be stored somewhere, which settles who may write it.

## Decision

**Who reads.** The proposal computation of `semprec-api` (`createProposalComputation`) reads the photos before its own
`inbox_proposal` call, through `resolveAttachmentDocuments`. The model call that reads one photo is
`extractAttachmentDocument` in `packages/data/src/inbox/attachmentExtraction.ts`: operation
`inbox_attachment_extraction`, temperature 0, attributed to the Semprec project, one user message of a text block (the
capture date and time, the tenant's time zone and the person's text, cut at 4000 characters) and an image block with the
reduced copy. The text of the person and the printed text of the document are data in the prompt, never instructions.
The answer is validated against `attachmentExtractionSchema`; an answer that does not match is an `AiGatewayFailedError`
with reason `invalid_response`.

**Which attachments.** At most four per Inbox item, the first by position that are images with a reduced copy. A PDF,
audio and an image the metadata job could not read are not read. The results go into the user message of the proposal
call as `Attachment documents (JSON)`, with a line in the system message that they are data.

**The cache.** `inbox_attachments.extraction` (nullable `jsonb`, migration `0174`) is written by
`recordInboxAttachmentExtraction` of the Inbox attachment store, once, and only by the proposal computation of the API
runtime. The write is one `UPDATE ... WHERE extraction IS NULL` on a row that must belong to the given Inbox item, so
two runs that start together store one value and both return it; no row lock is taken, because the condition is part of
the statement. The cache belongs to the attachment row: its blob and its reduced copy are fixed, so nothing is
re-read when the same photo is computed again. The person's text is a hint and is not part of the key, so editing the
text does not read the photo again. A failed call writes nothing.

**Brackets.** The computation reads the plan (the attachments, the stored extractions, the reduced blobs' storage keys
and the time zone) in one short transaction, makes each gateway call with no transaction open, and stores each answer
in a transaction of its own. When one photo of several fails, the extractions stored before it stay and the proposal
call is not made, so no proposal is computed from a half-read item; the next run reads only the photos still missing.

**Failures.** A gateway failure, a budget refusal included, leaves the computation as the `AiGatewayFailedError` it is,
and the Inbox tick handles it as any compute failure: a budget refusal or the final attempt is recorded on the card as
`computeFailed`, another failure is rethrown so that the queue retries. A reduced copy whose bytes are missing, larger than the 1.5 MiB the
gateway accepts or not a JPEG or PNG fails the job with a plain error and is retried like any other job failure.

**The tick waits.** The tick's read transaction returns no snapshot, and writes nothing, while an image attachment has
no metadata (`hasAttachmentAwaitingMetadata`), because its reduced copy does not exist yet. The metadata job announces
its write to the item's `onItemEvent` heartbeats, which starts the tick again. An image whose metadata job fails
every attempt therefore keeps its item from being computed.

## Alternatives rejected

- Reading the photo in `semprec-transcribe` after the metadata job: it would make the job that runs `ffmpeg` also a
  caller of the gateway, with the person's text and the Semprec project, which only the tick context has.
- Storing the result in the Inbox item's properties through the choke point: the result belongs to the attachment, is
  not the person's edit, and would write the item for every cache fill.
- Keying the cache on the person's text as well: every edit would be a new paid call for the same picture.

## Consequences

`inbox_attachments` gains `extraction`; the attachment reader returns it (`null` until stored). The data package exports
`extractAttachmentDocument`, `attachmentExtractionSchema`, `classifyForExtraction`, `recordInboxAttachmentExtraction`
and `hasAttachmentAwaitingMetadata`. `createProposalComputation` takes an `openBlob` port, built in the API composition
root over the files root and the mail attachments root. Proof: the extraction tests over a stubbed gateway, the store
tests of the once-only write on the runtime role pool with two tenants, and the tick tests of the wait.
