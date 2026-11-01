# Batch 07 specification reconciliation

Authority: owner-delegated parent controller `thr_pz39tcih5r`, under
`2026-10-31-owner-delegated-backend-program-supervision`. This records the
approved contract before implementation acceptance; it accepts no test result
and changes no completion state.

## Standalone blob MIME detection

The gh-1410 Context requires standalone uploads to use its shared detector,
while its scope assigns the standalone route to gh-1401. Both requirements are
in this batch. Make that ownership explicit in both sources and their aggregate
snapshots; retain the original dependency order.

The gh-1401 route still requires an `image/*` Content-Type header and enforces
its existing streaming size limit. After writing bytes, and before its database
transaction, the standalone store reads at most the first 64 KiB through the
existing storage seam and invokes the gh-1410 detector. A newly inserted blob
stores the detected MIME or `application/octet-stream` when unrecognized.
Header admission does not assert that the bytes are an image: recognized PDF
bytes with an image header are admitted and stored as `application/pdf`.
No additional content-based image rejection is introduced.

A content-hash deduplication hit returns the existing blob and its persisted
metadata unchanged, even when historical MIME differs from current detection.
The response describes that actual blob. Preserve duplicate-byte cleanup and
failure cleanup, and create no Files item on this path. This adds no backfill,
client work, new detector format or broader accepted header type.

Authorize the existing API `filesAndBlobsHandler.test.ts` alongside the already
scoped data upload tests for genuine recognized, unknown, mismatched-header and
deduplicated standalone HTTP evidence. Use valid binary image fixtures when
claiming image detection; arbitrary strings labeled as images prove only the
header-admission and unknown-content branches.
