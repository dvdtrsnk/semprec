---
status: accepted
date: 2026-11-08
area: [backend]
supersedes: []
superseded-by: null
---

# Upload attach rechecks the Files item's blob under its reservation

## Context

[[2026-11-08-upload-attach-reserves-source-and-target]] reserves the target and
the uploaded Files item `FOR UPDATE NOWAIT` in the upload's ingest transaction
and rechecks their liveness under those locks. It lists as a limit that the
binding of that Files item to the uploaded blob is not re-verified there: the
ingest finds the item through an unlocked lookup by blob
([[2026-11-01-file-uploads-share-the-blob-filing-lock]]), and nothing in the
attach compares the item it reserves with the blob it filed.

That gap is concrete. After the lookup returns Files item F for blob B, an
ordinary update can commit `F.file = { blobId: C }` before the attach reserves
F. The update takes F and then its new blob C, so it does not wait on the
upload, which holds B. The attach then links F, which now files C, to the target
while the upload's answer names F for the bytes of B. A pre-existing edge would
also be answered 200 for that item. This is the same class of defect as linking
a Files item trashed after the lookup.

This decision closes that one listed limit. The accepted body of the reservation
decision stays as it was written; this record narrows it.

## Decision

`attachUploadedFileWithClient` takes the blob the ingest filed as a required
argument. Its only production caller, the `POST /api/files` callback, passes
`file.blob.id` from the ingest's own result. The value never comes from a header
or the request body, and there is no form of the call without it.

Under the Files item reservation, before the existing-edge check and before
`createRelationWithClient`, the attach reads the reserved row's `file` property.
It must be an object whose `blobId` is a string naming the expected blob; UUIDs
are compared case-insensitively, as blob reference writers accept any case. A
missing or malformed `file`, or one naming another blob, answers the same fixed
409 `upload_attach_conflict` as a reservation conflict or a trashed Files item,
naming no id. As for every attach failure, the managed upload transaction is
marked rollback-only before the error propagates, so the filing, edge, jobs and
after-commit callbacks of the upload all roll back. There is no automatic retry.

The target's 404, the reservation order and modes, the writer identity and the
propagation of every other error are unchanged. Headerless uploads, the ingest
lookup and generic relation writes are unchanged.

## Alternatives rejected

- Rechecking the binding in the ingest owner. It would change the filing
  protocol for every upload, headerless ones included, to close a gap only the
  attach acts on.
- Taking the blob from the client, or keeping the argument optional. Either
  lets a caller skip or forge the check.
- Linking the item anyway and answering with its current file. The upload's
  bytes would not be what the answer and the new edge describe.

## Consequences

An upload whose deduplicated Files item is repointed at another blob between
the lookup and the reservation answers 409, and the caller may send a new,
complete request. A row that already names the blob in another letter case still
matches.

This decision closes only the binding limit. It gives no deadlock-freedom
guarantee beyond the reservation decision and does not change headerless
uploads.

Tests drive the real authenticated upload with a pass-through pause before the
Files item reservation, and a real update that repoints the item from B to C, for
a new edge and for an existing edge. Each is checked against the exact rows,
edges, jobs, invalidations and stored bytes as they stood after the update. The
existing matching-blob uploads, new and reused, keep their 201 and 200.
