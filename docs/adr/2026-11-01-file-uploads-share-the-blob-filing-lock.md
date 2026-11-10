---
status: accepted
date: 2026-11-01
area: [backend]
supersedes: []
superseded-by: null
---

# File uploads share the blob filing lock

## Context

`ingestUploadedFile` deduplicates bytes through `findOrCreateBlob`, then looks
for an existing live Files item. A conflict on a newly inserted blob can make
another upload wait, but an already committed standalone blob does not provide
that serialization. Batch 07 reproduced two concurrent real uploads both
observing no Files item and committing separate Files items for that blob. The
diagnostic executed one test that deliberately asserted this defect; nine
other tests were skipped.

[[2026-10-29-file-from-attachment-proposal-step]] already uses a blob row lock
before deciding whether to reuse or create a Files item. Extend that same
filing protocol to the ordinary upload path. Keep the reference-collection
coordination from
[[2026-11-01-blob-reference-writes-coordinate-with-collection]].

## Decision

Inside the existing upload database transaction, after obtaining the blob and
before looking for a Files item, acquire `FOR UPDATE` on that blob. The lookup
is tenant-qualified using the strict transaction tenant setting as well as
RLS. Check the lock helper's existence result. A blob removed by concurrent
collection causes the existing missing-blob/property-key validation refusal;
it does not permit a successful filing against a missing row. Do not add an
automatic retry policy.

After acquiring the lock, use a separate statement to look for the live Files
item. If present, return it unchanged with the reused result. Otherwise create
the Files item through the choke point while retaining the lock until commit.
A waiting participating filer then sees the committed item; if the preceding
transaction rolled back, it can create its own item instead.

Reuse the existing blob lock helper, with explicit current-tenant qualification
and checked existence on this upload path. No new lock table, advisory key,
grant or security-definer function is introduced. The attachment-filing path
retains its existing protocol. This is convergence among participating filing
paths, not a uniqueness guarantee for arbitrary Files property writes.

Streaming and content detection remain outside the database transaction.
Duplicate bytes are cleaned after commit; failed transactions clean their own
newly uploaded bytes without removing the reused blob's storage. Preserve
existing response status, dedup metadata and item properties.

## Alternatives rejected

- Rely on content-hash conflict handling alone: the committed standalone-blob
  case has no insertion conflict that orders both Files-item lookups.
- Add a Files-specific schema uniqueness constraint over generic item JSONB:
  a wider storage change than the existing shared filing lock requires.
- Lock a reusable existing Files item before its blob: unnecessary for a
  read-only reuse and inconsistent with the established filing decision order.

## Consequences

Same-blob filings contend for the blob row even when it already existed.
Unrelated blobs are not deliberately serialized by this protocol. New-item
creation occurs while holding the blob lock; mutations of existing items retain
their established item-then-blob order. This is not a claim of global deadlock
freedom across arbitrary multi-step transactions.

Acceptance requires bounded production-path tests for both controlled filing
orders, observed blocking, one created and one reused result with the same
item/blob IDs, and no duplicate committed Files row. Cover rollback of the
first filer and failure cleanup. The old diagnostic proves the defect; final
independent review and frozen verification must cover the implemented fix.
