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

## Blob references racing collection

The worker reproduced the JSONB item-reference race against `12c671ab`,
including the stale DELETE snapshot after waiting for a writer. Evidence:
`batch-07-run/race-diagnostic.ts` and `race-diagnostic-complete.log`, four
deliberately asserted unsafe/contrast outcomes; storage deletion was a no-op.
This establishes the row/reference defect, not physical deletion evidence.

Apply `2026-11-01-blob-reference-writes-coordinate-with-collection`: a new
blob-owned first-registered transactional create/update hook, sorted KEY SHARE
locks, and a separate collector UPDATE lock before the fresh reference check.
Use the existing domain composition seam; do not refactor the choke point or
rewrite FK-protected attachment writers. Count declared file/image references
consistently with accepted UUID spellings. Missing/foreign references are
refused without exposing another tenant's existence. The ADR records precise
scope, lock ordering, strict tenant setting, compatibility and limitations.

Add only the blob hook, its composition registration and the existing standalone
blob integration test path to gh-1401 Touches, alongside its existing blob
store/test paths and the new ADR. Existing one-to-one derived-blob deletion is
outside this protocol. The expanded Task and AC require production overlap,
rollback, effective-value and isolation evidence; the diagnostic or an intended
implementation is not acceptance.

## Historical read fixtures and UUID metadata lookup

Authorize `backend/packages/data/src/__tests__/relationExpansion.test.ts` for
the fixture repair required by the new blob-reference guard. Create valid blank
items through production writes, then inject explicitly historical dangling or
foreign JSONB references through a typed, tenant-scoped test fixture. Preserve
the original projected values and runtime-role read/isolation assertions. The
new production write refusal remains; no guard bypass is added to production.

Within existing gh-1412 Task 1 and its approved paths, normalize valid UUID
lookup keys in `blobMetadata.ts` to lowercase so accepted uppercase or
mixed-case references find PostgreSQL's canonical UUID row IDs. Stored item
properties remain unchanged, metadata uses the actual blob row ID, and missing
or foreign metadata remains omitted. Keep batched reads and add discriminating
evidence in the existing blob metadata test. This is an implementation fix
within the current metadata contract, not a new projection or storage format.
