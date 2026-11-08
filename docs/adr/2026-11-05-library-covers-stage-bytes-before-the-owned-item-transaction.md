---
status: accepted
date: 2026-11-05
area: [backend]
supersedes: []
superseded-by: null
---

# Library covers stage bytes before the owned item transaction

## Context

CreateBlobInput describes stored metadata, not downloaded bytes. Creating a row
with an invented storage key leaves a broken image. The standalone upload owner
commits its own blob transaction; the Files callback additionally creates a
Files item and reserves blob before item. Neither is the library job's owner.
This extends [[2026-09-10-side-effects-follow-the-commit]] and the existing
reference-admission/collection and best-effort storage cleanup decisions.

## Decision

Fetchers return a typed downloaded cover (bounded bytes, image MIME and optional
safe source URL), never a fabricated CreateBlobInput. A small internal
library/libraryCoverStorage.ts prepares bytes using the injected existing files
BlobStorageWriter, its hashing/size cap and tenantBlobStorageKey with a fresh
`<tenant>/blobs/<uuid>` key. It performs no metadata transaction or Files filing.
No storage or network I/O occurs while job row locks are held.

The existing library transaction reserves automation, then the actual library
item, and rechecks locked/deleted and property/config conditions. Only if the
cover is applied does it use findOrCreateBlob and a checked blob-row reservation,
then the existing image-reference choke point. Row, reference, metadata and
outcome share that transaction. Preserve canonical cross-root dedup keys and
bytes; never delete the reused blob's key. This keeps the item-before-blob order
rather than importing the Files callback's reverse order. Existing additional
hooks remain lock participants; no global deadlock-freedom claim follows.

A synchronous runAfterCommit marker registered before other callbacks records
whether this invocation's key became canonical. A confirmed committed retained
key is never deleted, even if client release subsequently throws. Skips,
duplicates and confirmed rollbacks dispose only this invocation's key outside
the transaction. A COMMIT acknowledgement failure has an unknown outcome: retain
bytes rather than delete a potentially live cover. No retry, invented receipt,
generic transaction protocol or recovery sweep is added. A later row-backed
unreferenced cover uses the existing blobs namespace sweep; rowless failed
cleanup is not covered by that sweep.

Cleanup/reporting failures must not replace the primary failure or turn a
committed cover into reported rollback. Narrowly correct LocalFs writer's
partial-write cleanup to retain the original error if delete also fails. Keep
secondary diagnostics sanitized; metadata URLs, tokens and exception text must
not enter queue-visible errors/logs. Existing detected-MIME ownership stays
with fileUploadStore; cover admission adds no classification writer or root API.

## Consequences

Wire the existing files storage from worker/API composition, not a second root
or Files item. Test real bytes/reference, skip, rollback, duplicate/cross-root
retention, cleanup failure, post-commit release failure and ambiguous COMMIT
retention. Retained unreachable bytes are an explicit cleanup limit. A generic
upload callback or broad storage refactor was rejected as larger and incorrectly
ordered for existing library items.
