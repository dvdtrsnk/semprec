---
status: accepted
date: 2026-11-14
area: [backend]
supersedes: []
superseded-by: null
---

# Inbox attachment facts are computed by semprec-transcribe and recorded once

## Context

An Inbox card shows an attachment as a preview with facts (type, size, image size, audio length, when a voice
recording was made), and the assistant reads a reduced copy of a photo. The bytes and the type are known after the
upload and the capture ([[2026-11-14-a-standalone-blob-upload-accepts-only-the-inbox-attachment-types]]), but
nothing computes dimensions, a preview or a length. Computing them needs `ffprobe` and `ffmpeg` over an untrusted
upload, which only `semprec-transcribe` may run and only from `mediaNormalization.ts`
([[2026-09-22-ffmpeg-confined-to-semprec-transcribe]]). `inbox_attachments` is a table of the Inbox module, written
through its store in `semprec-api`'s runtime ([[2026-09-10-single-writer-ownership-model]]); the facts are a second
process's output, so the table's write access has to be settled, as does who owns the two derived images.

## Decision

**The job.** The capture transaction enqueues one `inboxAttachmentMetadata` job per new attachment, under the key
`inbox-attachment-metadata:<attachmentId>`, in the tenant's lane (a job that exists exactly when its row does,
[[2026-09-10-side-effects-follow-the-commit]]). A replayed capture enqueues none. The job runs in the transcribe
runtime only (affinity `transcribe`, tenancy `tenant`), on a runner of one slot of its own, so an `ffmpeg` that runs up
to its timeout holds no slot that transcription creation or a model task waits for. It names the attachment and
nothing else; the tenant is the job envelope's.

**What it computes.** The probe is authoritative: nothing the client sent about a file is read. A JPEG or PNG gets
its width and height as the picture is shown (an EXIF rotation applied), a 128 px preview and a reduced copy of at
most 1568 px, both JPEG and never enlarged. M4A and MP3 get the duration, `recordedAt` from the container's
`creation_time` when it is a usable timestamp, and `audioKind`: `voiceNote` below `INBOX_RECORDING_MIN_SECONDS`
(120) seconds and `recording` at that length or longer. That constant and `audioKindForDuration` in
`inbox/inboxAttachmentMetadata.ts` are the only definition of the boundary. Any other attachment type (PDF, XLSX,
DOCX) gets `{ pages: null }` and is not opened. A file `ffprobe` or `ffmpeg` cannot read gets
`metadata.error = "mediaUnreadable"` and no images; the capture is long committed, so the job succeeds. A picture
of more than `MAX_IMAGE_PIXELS` (100 million) pixels is such a file: every `ffprobe` and `ffmpeg` call over an image
passes `-max_pixels`, so the decoder refuses the canvas before it allocates the frame (a small, highly compressed PNG
can declare one that decodes to gigabytes, and `ffprobe` decodes the first frame to learn a size). Failures that
are not a property of the file (the bytes missing from storage, `ffprobe` not starting, a database error) fail the
job, which graphile-worker retries within its three attempts.

**Who may write.** `semprec-transcribe` is the only process that writes the three columns `metadata`,
`thumbnail_blob_id` and `reduced_blob_id`, and it writes them only through
`recordInboxAttachmentMetadata` of the Inbox module's `inboxAttachmentsStore.ts`, never with its own SQL and never
any other column of the table. They are written once. The function takes the source Inbox item's row lock
(`FOR UPDATE`, an item in the Trash included), then the attachment row `FOR UPDATE`, and writes only when `metadata
IS NULL` is read under that lock; a second run, or one that lost a race, finds the metadata and writes nothing, and the
update itself repeats the `metadata IS NULL` condition and checks that it touched a row. The two locks are taken in
the order `deleteInboxAttachment` takes them, source item first and then the attachment row.

**Derived images.** They are ordinary `blobs` rows and counted references: `deleteBlobIfUnreferenced` counts
`thumbnail_blob_id` and `reduced_blob_id` next to `blob_id`, so a blob stays while any attachment names it in any of the
three roles. The images are created with `findOrCreateBlob`, so bytes the tenant already stores (the same photo
attached twice, or a preview and a reduced copy of a small picture, which are identical) share one blob row; the key
the job wrote for a duplicate is reported unused and removed. Naming a blob that already exists takes the key share of the
two composite foreign keys on it, which is how every other `inbox_attachments` reference coordinates with collection
([[2026-11-01-blob-reference-writes-coordinate-with-collection]]): a concurrent `deleteBlobIfUnreferenced` of that blob
either commits first, so the write stores its own blob or fails on the foreign key and the job is retried, or waits for
this transaction and then finds the reference in its fresh check. `deleteInboxAttachment` releases the row's derived blobs
through `deleteBlobIfUnreferenced` in its transaction and returns the keys that were freed; the permanent delete of an
Inbox item releases them with the attachment's own blob. The bytes follow the commit and are removed best effort
([[2026-09-28-blob-bytes-deleted-best-effort-after-the-commit]]): the trash purge with the storage it was given; the
confirmation of a proposal, which has no storage of its own, with the local-filesystem storage of `FILES_STORAGE_DIR`
(`removeBlobBytesAfterCommit`), logging when it is not configured. A derived blob that the
attachment's own blob deduplicated onto is never released by `deleteInboxAttachment`, which leaves the attachment's
own blob to its caller.

**Bytes before rows.** The images are written to storage before the transaction that records them, because the
transaction must not stay open across `ffmpeg`. Keys are fresh for each run (`<tenant>/inbox-attachments/<uuid>-...`),
never under `blobs/`, which the unreferenced sweep reads. When the transaction fails before the facts were written, the
job removes both files; when it fails at `COMMIT`, whether the rows committed is unknown and the files are kept,
because deleting bytes a committed row references is worse than leaving an unreferenced file. A crash between the
write and the transaction leaves unreferenced files, which no row can reach.

**Heartbeat.** In the same transaction the job announces an update of the source Inbox item to its `onItemEvent`
heartbeats (`triggerOnItemEventHeartbeats`, event `update`), whether the file was readable or not, so a card computed
before the facts is computed again with them. An item in the Trash is not announced. The announcement is part of the
write: it commits with the metadata or not at all.

## Alternatives rejected

- A job in `semprec-api`: it would run `ffmpeg` outside the process the confinement ADR names.
- The job writing `inbox_attachments` itself: a second writer of the Inbox module's table outside its store, which
  the ownership ADR forbids. The store's function is the one door.
- Writing the facts into the Inbox item's properties through the choke point: the facts belong to the attachment, are
  not a user's edit, and would write the item (version, updated-at, its own hooks) for a recording of a file.
- Deleting the derived blobs unconditionally with the attachment, as the transcription derivatives are deleted: the
  previews of two attachments of one photo are one blob when the tenant dedups content.
- Putting the job on an existing runner: it runs an untrusted file through `ffmpeg` for up to the tool timeout.

## Consequences

`inbox_attachments` gains `metadata`, `thumbnail_blob_id` and `reduced_blob_id` (migration `0173`); the attachment reader
returns them, `null` until the job has run. A new core task and a fourth runner exist in the transcribe runtime.
A reader that needs the facts treats `metadata = null` as "not computed yet", `metadata.error` as "cannot be read",
and relies on the job's heartbeat announcement to be told of the change. Proof: the job tests with real media on the
runtime role pool with two tenants, the store tests of the once-only write, the reference counting and the release, the
purge and confirmation tests that free the images and their bytes, and the capture tests of the enqueue and its
rollback.
