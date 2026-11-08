---
status: accepted
date: 2026-11-08
area: [backend]
supersedes: []
superseded-by: null
---

# Upload attach reserves its source and target without waiting

## Context

`POST /api/files` with `X-Attach-To-Item` and `X-Attach-Relation` (issue #1645,
tasks as targets in #1654) links the uploaded Files item to the target inside
the upload's own ingest transaction. Under
[[2026-11-01-file-uploads-share-the-blob-filing-lock]] that transaction holds
the blob `FOR UPDATE` from before its lookup of a live Files item until commit,
and the lookup itself takes no item lock. The attach first locked only the
target, with a waiting `FOR UPDATE`. A deduplicated Files item trashed after the
lookup could therefore still be linked, and answered 200, and an existing edge
returned early without checking the item at all.

Reserving that Files item with a waiting lock while the blob is held inverts an
order other supported writers already use:

- An item update holds the item row before `blobReferenceItemUpdateHook` takes
  `FOR KEY SHARE` on each blob its patch references
  ([[2026-11-01-blob-reference-writes-coordinate-with-collection]]). For a Files
  item the row is taken `FOR UPDATE` by its pre-write transform's lock, before
  the hook. A `PATCH` writing `file: { blobId }` of the deduplicated item holds
  that item and then waits on the upload's blob. An upload that holds the blob
  and then waits on the item completes a cycle: PostgreSQL aborts one of them
  with 40P01, and its client gets a 500.
- The trash purge deletes a trashed item and then locks its blob through
  `deleteBlobIfUnreferenced`
  ([[2026-11-01-trash-purge-coordinates-roots-and-transactions]]), the same
  item-then-blob order.

The target side has the same exposure in principle. `resolveUploadAttachTarget`
accepts any relation property of the Files database whose target database
holds the target, and the reference hook applies to any `file` or `image`
property, so a target update that references the upload's blob would wait on
it while holding the target row. Today every attach target is a schema-locked
system database without such a property, but the seeded declarations are not a
bound this owner can rely on.

[[2026-11-05-recording-intake-coordinates-files-and-transcription]] met the same
inversion for a Files item reserved under the blob lock and resolved it with
`FOR UPDATE NOWAIT` and a fixed 409. This decision applies that pattern to the
attach callback only. The accepted bodies above are unchanged; the waiting
target reservation the attach used before is replaced, not carried forward.

## Decision

The ingest order stays as it is: blob `FOR UPDATE`, then the Files item lookup
or creation. In the attach callback, still under the blob lock:

1. Reserve the target row `FOR UPDATE NOWAIT` in its resolved database, through
   the existing `lockItemByIdNowait`.
2. Reserve the uploaded Files item row `FOR UPDATE NOWAIT` in the Files
   database. A Files item created by this transaction is its own and is always
   reserved.
3. Under those locks, a missing or trashed target answers the same 404 as the
   read-only pre-check, naming no id, and a missing or trashed Files item answers
   the attach conflict below.
4. Only then is an existing edge between the two left as it is, or the edge
   written by `createRelationWithClient`, whose cardinality check, hooks and
   errors are unchanged.

Neither reservation waits, so the attach never waits for an item row while it
holds the blob.

PostgreSQL's lock-not-available error (a `pg` `DatabaseError` with code 55P03)
raised by one of these two statements, and a missing or trashed Files item,
answer one fixed 409 `upload_attach_conflict` with the message "The upload could
not be attached; send it again" and no resource details. Only those two
statements are mapped. Every other error, 40P01 and 57014 included, keeps its
identity. The error is constructed locally; no exported error class is added,
and lock contention is not reported as `version_conflict`.

Every failure inside the attach callback marks the managed upload transaction
rollback-only (`markManagedTransactionRollbackOnly`) before it propagates. A
caller that catches the error, or rolls back a savepoint, still commits no Files
item, edge, job or after-commit callback from the upload. The ingest owner keeps
its own marking and its deletion of the bytes it streamed; reused bytes are
never removed by a failed upload. There is no automatic retry and no timeout
change.

Headerless uploads, `fileUploadStore.ts`, `relationOps.ts`, `itemTrash.ts` and
generic relation writes are unchanged.

## Alternatives rejected

- A waiting reservation of either row, in any lock mode, while the blob is held.
  The Files item `PATCH` above holds the row `FOR UPDATE`, which conflicts even
  with `FOR KEY SHARE`, so every waiting mode can close the cycle.
- Reserving the Files item before the blob. That reorders the filing protocol of
  [[2026-11-01-file-uploads-share-the-blob-filing-lock]], which rejected
  locking a reusable Files item before its blob, and changes every upload.
- Keeping a waiting lock and mapping 40P01 to a 409. That makes a known
  deadlock part of the normal path and hides other deadlocks behind the same
  answer.
- Exempting target databases that declare no `file` or `image` property. It
  rests on seeded declarations, not on anything the attach owner controls.
- No reservation of the Files item. A trashed source keeps answering 200.

## Consequences

An upload whose target or Files item row is locked by another transaction at
that moment answers 409 instead of waiting. That happens with a concurrent item
update or trash of either row, or a concurrent attach to the same target that
files different bytes. The caller may send a new, complete request. Uploads of
identical bytes still serialize on their blob, so they do not conflict with each
other.

Limits:

- Only these two reservations are non-blocking. This is not a proof of deadlock
  freedom for any other path.
- The binding of the Files item to the uploaded blob is the ingest owner's
  unlocked lookup and is not re-verified under the reservation. An update that
  points the item's `file` at another blob before the reservation is not
  detected; headerless uploads share that read.
- The purge inversion needs a Files item trashed past its retention cutoff while
  one upload runs, so it is a theoretical case here.
- The target-side cycle is derived from the code, not reproduced. No seeded
  target can hold a `file` or `image` property.

Tests use the real authenticated upload on a runtime-role pool:

- a Files item `PATCH` that holds its row and waits on the upload's blob,
  correlated through `pg_blocking_pids`, while the upload answers 409 and rolls
  back and the `PATCH` then commits;
- lock-only holders of the target and of the Files item, each followed by a new
  request that succeeds;
- a Files item trashed between the lookup and the reservation, for a new edge
  and for an existing one;
- a target trashed before its reservation;
- identical-bytes serialization;
- a caller that catches the conflict yet commits nothing.

Each refused upload is checked against the exact Files, blob and edge rows, the
queued jobs, the emitted invalidations and the hashes of the stored bytes from
before it, apart from what the case's own concurrent writer commits.
