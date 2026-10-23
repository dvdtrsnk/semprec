---
status: accepted
date: 2026-09-28
area: [backend]
supersedes: []
superseded-by: null
---

# Blob bytes are deleted best-effort after the commit

## Context

A blob has two halves: the `blobs` row, which is what every reference in the
database points at, and the bytes in the object store under its
`storage_key`. The trash purge (issue #675) is the first path that removes
blobs, and it has to decide where each half's deletion runs.

The row cannot leave the transaction: whether it may be deleted at all
depends on nothing else referencing it, and that check is only sound inside
the transaction that hard-deletes the last referencing item. The object store
is not transactional, so the bytes cannot be deleted atomically with the row.

`2026-09-10-side-effects-follow-the-commit.md` names two post-commit shapes: a
synchronous `runAfterCommit` callback for announcing a write, and a queue job
for work that must be awaited, retried or survive a restart. Deleting the
bytes is awaited, so a callback does not fit. A queue job would fit, at the
cost of a job type, a payload carrying the storage key, and retry handling for
work whose failure harms nothing.

## Decision

The `blobs` row is the canonical ownership record. It is deleted inside the
transaction that removes its last reference, by its owning store
(`blobsStore.deleteBlobIfUnreferenced`), which returns the deleted row's
`storage_key`.

The bytes are deleted by the caller after that transaction has committed,
inline and awaited, with a storage failure logged and skipped. No queue job is
used: once the row is gone nothing can reach the bytes, so a failed delete
leaves unreachable orphaned bytes — wasted storage, never a dangling reference
or a user-visible error — and a retry would buy only reclaimed space.

The order is fixed: row first, bytes after the commit. Deleting the bytes
before or inside the transaction would leave a live row pointing at missing
bytes whenever the transaction rolls back.

## Consequences

- A later blob-deleting path (for example mail cleanup) follows the same
  shape: delete the row through `blobsStore` in the transaction, collect the
  storage key, delete the bytes after the commit, tolerate failure.
- Orphaned bytes can accumulate after storage outages. Reclaiming them is a
  separate sweep over storage keys with no `blobs` row, if it is ever needed;
  it is not required for correctness.
- If byte deletion ever gains a hard requirement (quota, legal erasure), this
  decision is superseded by a queue job written in the purge's transaction.
