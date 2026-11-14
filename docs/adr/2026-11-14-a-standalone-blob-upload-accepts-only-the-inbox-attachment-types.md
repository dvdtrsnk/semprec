---
status: accepted
date: 2026-11-14
area: [backend]
supersedes: []
superseded-by: null
---

# A standalone blob upload accepts only the Inbox attachment types

## Context

[[2026-11-04-blob-content-classification-preserves-legacy-metadata]] widened
`POST /api/blobs` to any well-formed media type and let unknown bytes be stored
and classified as unknown. Issue gh-1963 makes the upload the first step of an
Inbox capture: the client uploads bytes, then names the blob ids in
`POST /api/inbox/items`, and a capture accepts only the attachment types
(PDF, JPEG, PNG, XLSX, DOCX, M4A, MP3). The Task also requires an unsupported
upload to answer 415 and leave no bytes. This is an exception to the 2026-11-04
decision for the standalone upload, not a replacement: the verified
classification column, the preserved legacy `mime_type` and the Files
create-only transform stay as they are. Reference writes keep the protocol of
[[2026-11-01-blob-reference-writes-coordinate-with-collection]].

## Decision

`ingestUploadedBlob` accepts the Inbox attachment types plus HEIC (accepted
before the allowlist existed; a capture refuses it with its own error). The
type is decided from the leading bytes, never from the header: the audio
detector first (`audio/mp4` for an ISO-BMFF `ftyp` brand `M4A `, `mp42` or
`isom`; `audio/mpeg` for an ID3 tag or an MPEG frame sync), then the detector
of the 2026-11-04 decision. Bytes of any other type, unrecognised bytes and an
empty body answer 415 `unsupported_media_type`. The bytes just streamed are
removed before any row is written, so a refused upload leaves no blob and no
bytes. The `Content-Type` header is still only checked for being a well-formed
media type. As a consequence a standalone blob of unknown content can no longer
be created; historical ones remain readable and referenceable.

Dedup keeps the first row's `mime_type` (2026-11-04), which can be a sender's
header: a mail attachment is often stored as `application/octet-stream`. The
type a blob has as an attachment is therefore the verified
`detected_mime_type` when the detector recognised the bytes, else the stored
`mime_type` (`application/octet-stream` is the detector's "unknown" and never
hides a stored type). One SQL expression, `effectiveBlobMimeTypeSql`, is used
by the capture check and by the attachment reads that answer the capture, so a
capture accepts and reports the same type. The answer of a dedup-hit upload
stays the first row's stored metadata, unchanged, as 2026-11-04 requires. A blob
that has no verified type keeps being judged by its stored type. The `mime_type`
column itself is never rewritten.

A capture validates its blobs with `FOR KEY SHARE` in id order for the
transaction (`lockBlobsForReference`), the lock of the 2026-11-01 decision, so
`deleteBlobIfUnreferenced` (`FOR UPDATE`, then a fresh reference check) cannot
remove a blob between the check and the `inbox_attachments` insert. The foreign
key would also exclude the deleter, but only once the row is inserted; the lock
covers the read that decides which blobs may be attached. Lock order is the
blob rows in id order, then the new item's source lock taken by
`insertInboxAttachments`. No other transaction can hold the source lock of an
item that is not yet committed, and the paths that take a source lock and then
a blob lock (`deleteInboxAttachmentsForItem`) work on committed items, so the
orders cannot form a cycle. The upload's dedup path takes the blob row
`FOR UPDATE` first (`lockBlobById`) and therefore waits for a capture that
holds the key share, as it would for any share-mode lock.

## Alternatives rejected

- Keep accepting unknown bytes at the upload and refuse only at the capture:
  the Task requires 415 and no bytes at the upload.
- Rewrite the stored `mime_type` on a dedup hit: contradicts the preserved
  legacy metadata of 2026-11-04.
- Judge a capture by the stored `mime_type` only: an identical mail attachment
  stored as `application/octet-stream` could then never be attached, even after
  its bytes were uploaded and recognised.

## Consequences

An upload of bytes outside the list fails where it used to succeed, and the
Files create-from-blob path can only start from a blob of an allowed type. A
blob stored before this decision with unknown content is unaffected. Attachment
reads report the verified type when there is one, which can differ from the
blob's stored `mime_type`. Proof: the upload refusal table with no row and no
bytes left, a dedup hit on a mail attachment stored as
`application/octet-stream` that is then captured, a verified type outside the
list refusing a blob stored under an allowed one, and the blocking test of the
lock against the deleter.
