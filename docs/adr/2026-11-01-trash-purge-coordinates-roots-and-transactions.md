---
status: accepted
date: 2026-11-01
area: [backend]
supersedes: []
superseded-by: null
---

# Trash purge coordinates storage roots and concurrent subtrees

## Context

Gh-1564 makes Inbox attachments counted references. The production trash tasks
pass only mail storage, although standalone uploads use Files storage. Force
removal in the wrong root can silently leave the actual bytes. Content-hash
dedup preserves the first key, so item type does not determine its root.

The blob locks from
[[2026-11-01-blob-reference-writes-coordinate-with-collection]] also exposed a
reproduced deadlock between two subtree purges acquiring shared attachment blobs
in opposing orders. Sorting one array does not order a whole multi-item subtree.

## Decision

Keep row deletion transactional and bytes best-effort after commit, per
[[2026-09-28-blob-bytes-deleted-best-effort-after-the-commit]]. Both trash task
aliases pass both already-composed storage writers. For each committed returned
key, independently attempt deletion in both distinct writers; one failure must
not skip the other. Skip the second attempt for the identical writer object.
Preserve leading purge arguments; the alternate writer can be trailing/optional
for existing single-storage callers. Production supplies both.

This uses the canonical key across the same supported roots as
[[2026-10-18-tenant-export-cross-root-blob-lookup]]. Introduce no location column,
prefix heuristic or decision based on removed attachment rows. Supported writes
generate tenant-prefixed keys. Delete no bytes for rolled-back mutations or
blobs whose references kept the row. New cleanup diagnostics use fixed text and
safe error codes, not paths/raw exceptions. Cleanup failure leaves unreachable
bytes without undoing a committed purge.

At entry to `purgeExpiredTrashSubtree`'s transaction, before root/subtree reads or
item/document/blob locks, acquire `pg_advisory_xact_lock(hashtextextended($1::text,
0))` with exact key `trash-purge:v1:<lowercase tenant UUID>`. Resolve the tenant
from the transaction's strict `app_tenant_default()`; reject null before mutation.
No sole-tenant fallback or caller-payload tenant is allowed. Keep the lock until
transaction end, including empty roots. Participating same-tenant purge calls
then enter the existing mutation sequence serially; other tenants have separate
keys. Preserve item-then-dependent ordering. No storage/provider I/O is added
inside this transaction.

## Alternatives rejected

- A per-array sort cannot order mixed file/attachment and multi-item candidates.
- Prelocking all blobs before items adds stale-candidate handling and can invert
  ordinary item-then-blob order.
- Inferring one root from item type fails for cross-root dedup; force-delete is
  not an existence probe.
- A general location migration or global blob lock exceeds these requirements.

## Consequences

Same-tenant purges trade parallelism for one entry guard. Ordinary item writers,
every collector and tenant erasure are not serialized by it. This is no proof
of global deadlock freedom; derived-blob one-to-one ownership is unchanged.

Acceptance needs actual dual-root worker deletion, both dedup origins,
rollback/no-delete, both purge orders, mixed candidates, multi-item subtrees,
observed advisory blocking and other-tenant progress. Diagnostics prove the
old defect, not the implemented repair or final acceptance.
