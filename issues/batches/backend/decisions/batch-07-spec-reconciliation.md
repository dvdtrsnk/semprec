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

## Filing an already committed standalone blob

The worker reproduced two successful `ingestUploadedFile` calls creating two
Files rows for one previously committed standalone blob. The held lookup
barrier establishes the overlap; `dedup-diagnostic.ts` and
`dedup-diagnostic.log` record one deliberately defect-asserting test passed and
nine skipped. Content-hash conflict handling alone does not serialize this
case.

Apply `2026-11-01-file-uploads-share-the-blob-filing-lock`, a narrow extension of
the existing attachment-filing row lock. In the upload transaction, lock the
tenant's blob and check existence before a fresh Files-item lookup, then reuse
unchanged or create through the choke point. Keep streaming/detection outside
the transaction and existing byte cleanup ordering. No new retry policy,
generic Files uniqueness constraint or arbitrary-write convergence guarantee
is introduced.

The implementation and tests remain within existing gh-1410 upload paths and
gh-1401 blob-store scope; add the new ADR path to gh-1410 and the aggregate.
The existing dedup requirement is retained. Acceptance needs real bounded
both-order overlap, committed-row identity and rollback/cleanup evidence, not
the diagnostic's intentionally unsafe assertions.

## Persist the initial property list order

The literal gh-1592 example exposed alphabetical property reads instead of its
required input order. Retain that acceptance criterion and apply
`2026-11-01-atomic-collection-creation-preserves-property-order`: additive
nullable internal positions for the atomic title/list cohort, both catalog
read forms honoring them, and an alphabetical null-position tail for later
ordinary properties. Existing all-null databases retain key order. No backfill,
append allocator or public reorder field is authorized.

Extend gh-1592 scope to the owning property store, the additive migration,
existing real-runner migration compatibility test and the new ADR. The current
database operation can assign positions through the property store on its
existing transaction client after ordinary/relation creation. Preserve all
authorization, rollback and invalidation behavior. Compress only redundant
historical Context prose in the source snapshot to retain the aggregate size
bound; preserve the frozen Tasks, decisions and AC with this explicit addition.

The localhost `ETIMEDOUT` in the same diagnostic run remains a separate observed
failure. This decision does not resolve, attribute or waive it.

## Complete static review and reproduced follow-ups

The independent segmented review of `d17a39f2` covers 39 Tasks, 45 AC and six
aggregate gates, with verdict NOT CLEAR. Its static coverage is complete;
final-candidate execution and acceptance are not. Preserve the original and
segmented reports and distinguish executed diagnostics from static schedules.

### Standalone deduplication and purge

R1 reproduced a reused blob disappearing before upload commit, including real
local byte deletion. Take a checked tenant blob lock after `findOrCreateBlob`
and before return/duplicate cleanup registration. Refuse a vanished blob with
the existing missing-reference validation and remove only this attempt's bytes.
Keep original creation age and metadata: a successful repeated upload grants no
lease or attachment grace, and a later sweep may remove the old unreferenced
blob. No renewal, new schema or automatic retry policy is authorized.

R2 reproduced two real subtree purges deadlocking on reversed shared blob
orders, with rollback and successful retry. Apply
`2026-11-01-trash-purge-coordinates-roots-and-transactions`: one tenant-keyed
transaction entry guard before subtree locks, rather than claiming a per-array
sort establishes global ordering. Its physical-byte diagnostic limit remains.

F1's production composition uses only mail storage for trash cleanup. Pass both
existing roots and independently attempt post-commit deletion in each, as the
same ADR specifies. Keep leading purge arguments compatible and best-effort
semantics; add actual dual-root worker, dedup-origin and rollback evidence.

### Validate the new operation UUID inputs

F3 reproduced HTTP 500/SQL 22P02 for the new atomic relation target and actual
MCP calls with malformed item IDs. In shared input schemas validate gh-1592
`targetDatabaseId`, `relation.list` item/optional property IDs, and
`page.restoreVersion.itemId` against the existing case-insensitive canonical
UUID-shape convention. Preserve all hex-group UUID spellings, missing-field
diagnostics and well-formed unknown/foreign equivalence. Do not impose a new
RFC version restriction or retrofit every legacy operation. Typed field
validation happens before SQL; do not log supplied values through a DB failure.
Add real REST/MCP/agent boundary evidence within the explicit test paths.

F7 is a valid-image fixture repair in already approved API tests: use complete
PNG bytes for image claims and retain signature-only cases as detector-boundary
evidence. It adds no complete-image admission policy to production.

### Page restore lifetime and approval identity

F4 reproduced restore appending after concurrent soft deletion. F5 reproduced
actual approved replay over a real update with deliberately colliding old
author/time fields: one defect-asserting diagnostic passed, 43 skipped. These
are not acceptance results or measurements of natural collision frequency.

Apply `2026-11-01-page-restore-locks-live-items-and-update-identity`: lock/recheck
the live item before the document in projection and restore, and add the
retained bigint update identity token as a decimal string in the approval
projection. Use one tenant-scoped query under the document lock. Keep historical
ADR bodies, timestamps, authorship, capability and other operation semantics.
Old snapshots without the new token conflict; no approval backfill or schema
revision counter. Require runtime isolation, real replay, both deletion orders,
timestamp collisions, earlier transactions and compaction/retention evidence.

### Relation target lifetime assessment

F6 remains unconfirmed. The atomic-create path attaches its partition before
looking up relation targets; existing `items` SHARE UPDATE EXCLUSIVE and
`databases` SHARE ROW EXCLUSIVE locks conflict with purge's partition-drop and
database deletion. Prove both real production acquisition orders and observed
DDL blocking before closing this finding. Add no target lock before partition
DDL: it can invert ordering. Ordinary relation creation is a separate path;
this batch does not promise targets cannot be removed after creator commit.

These decisions authorize fixes and evidence, not a merge, completion, failure
waiver or next-batch dispatch. Compress only redundant historical Context prose
where needed for the aggregate size bound; retain decisions and Task/AC text
with the explicit additions above.

## Full-run fixture compatibility after the blob guards

The frozen `b455631b` integration run confirms two existing fixtures no longer
reach the behavior they describe. Authorize these exact gh-1401 test paths:

- `backend/services/semprec-api/src/__tests__/blobsPerTenant.test.ts`: create a
  legitimate tenant B Files item, then inject only its deliberately historical
  foreign blob reference through a typed, tenant-scoped fixture with checked
  affected rows. Preserve the real successful tenant A download and blob-ID
  filename fallback, without leaking tenant B's filename. The normal production
  foreign-reference refusal stays.
- `backend/packages/data/src/__tests__/remainingLookupPruning.test.ts`: supply an
  existing tenant-owned blob to the actual lookup. Use the already referenced
  tenant B blob for its partition case and create a scoped blob in the tenant
  with no databases for the zero-partition case. The separate blob lock must
  succeed so the real fresh reference-check DELETE is sent and EXPLAINed.
  Preserve all partition, false-filter, RLS and reference assertions.

No production guard bypass, mail rewrite, checker baseline change or broader
fixture exception is authorized. The new reference/lock behavior invalidates
these old setup assumptions; it does not authorize weakening their tests.
The complete frozen run and manifests settled before this refreeze. Preserve
its integration FAIL and E2E PASS separately; neither grants acceptance or a
failure waiver. The rowCount fix, repaired fixtures and any new candidate still
require affected checks, independent delta review and a complete frozen gate.

## Permanent evidence for the remaining exact clauses

The final per-clause audit found execution gaps despite complete static review.
The local MCP exception for `878d9cba` does not accept those gaps or transfer to
a changed candidate. Preserve the original Tasks and AC and add permanent tests:

- Gh-1404 Task 3: count actual production SQL for one versus many nonempty
  real relation sets under runtime tenant scope, with correct returned edges.
  Authorize the exact existing `data/src/__tests__/itemRelationList.test.ts`.
  An external temporary harness alone would not retain this regression guard.
- Gh-1401 AC 7: demonstrate UPDATE-versus-collection in both lock orders, not
  only CREATE. The existing scoped `blobs/__tests__/unreferencedBlobs.test.ts`
  supplies bounded runtime-role barriers, observed blocking and full settlement;
  a refused update must retain its original item state and prior reference.
- Gh-1519 Task 2: directly assert no invalidation or relevant heartbeat/job
  publication for rejected user/agent creation, plus no row and a valid-create
  positive control proving the same event harness is connected. Its existing
  `data/src/__tests__/itemWrites.test.ts` is already scoped.
- Gh-1412 Task 2 and AC 5: use actual authenticated item/query responses for
  foreign metadata omission, preserving original historical JSONB and an
  own-blob positive control under runtime RLS. Also exercise real VIEW query
  and generic item create/PATCH response metadata and batch behavior. Existing
  API envelope-test scope covers these; explicitly list
  `tenantIsolationRoutes.test.ts` and `filesAndBlobsHandler.test.ts` for clarity.
  Historical fixture injection remains checked and tenant-scoped, never a
  production write bypass.

No new production behavior or Task/AC relaxation is authorized here. Finish the
entire 39-Task/48-AC execution-coverage audit and consolidate remaining gaps
before another full pipeline. Bundle repairs, appropriate targeted checks and
fresh independent delta review first; then freeze the new clean candidate.
Static-only evidence suffices for actual documentation/type declarations, not
for named routes, query counts, publication refusals or concurrency scenarios.
