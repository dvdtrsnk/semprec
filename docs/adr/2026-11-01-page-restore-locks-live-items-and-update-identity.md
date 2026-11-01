---
status: accepted
date: 2026-11-01
area: [backend]
supersedes: []
superseded-by: null
---

# Page restore locks live items and compares update identity

## Context

Batch 07 reproduced restore waiting for its document lock and subsequently
appending to a concurrently trashed page. A second diagnostic established a
same-author/timestamp collision and actual approved replay over an intervening
update. It did not measure the collision's natural frequency.

This narrowly extends decisions 3–5 of
[[2026-10-29-page-restore-joins-approval-gated-destructive-operations]]; its
historical body stays unchanged. Capability, approval classification,
descriptions and forward user-authored restore behavior are retained.

## Decision

Both restore projection/preflight and mutation resolve the item partition,
then lock the item `FOR UPDATE` and recheck existence/deleted state before
resolving and locking the page's `doc_snapshots` row. Keep locks to transaction
end. Missing, trashed, foreign and non-page items retain identical not-found
behavior. KEY SHARE cannot guard a non-key soft-delete field.

Replay order is approval request, agent run, item, document. Direct restore and
preflight use item then document. Existing deletion mutates items before their
document dependents; do not lock the item after its document. This does not
retrofit every content writer or prove global multi-item deadlock freedom.

Retain identity, last-edit timestamp and author in the approval projection and
add `updateVersion`, a decimal string. Under the document lock, one tenant-scoped
SQL statement computes the greatest of this document's pending `doc_updates.id`,
mirrored `doc_history_updates.update_id`, checkpoint
`doc_snapshot_history.through_update_id`, and zero. Restrict each subquery to
the document and current tenant; never convert bigint through JavaScript Number.

Append allocates/mirrors IDs under the document lock. Compaction retains the
mirror; retention replaces removed history with a retained baseline carrying
its through-update ID. Thus maintenance does not lower this token, while a new
append changes it despite timestamp collisions or an earlier-start transaction.
Use one statement to avoid mixed maxima across maintenance.

No new revision column/table, content digest, timestamp rewrite or backfill is
introduced. Old pending approvals naturally conflict against the expanded
snapshot hash; do not accept a missing token or silently upgrade an approval.

## Alternatives rejected

- An unlocked live recheck leaves another deletion window.
- Item-after-document locking reverses item/dependent order.
- Timestamp/author alone miss the reproduced distinct update.
- A new counter or full CRDT hash is unnecessary when retained update identity
  supplies the scoped change token.

## Consequences

Restore may block deletion while waiting for its document. Deletion winning
first instead refuses restore without appending. Existing content writers keep
their document lock. No provider work belongs inside the new guard.

Acceptance needs direct restore and actual replay in both deletion orders,
runtime isolation, equal-millisecond and earlier-transaction updates, old
approval conflicts and token stability through real compaction/retention. Keep
the requested target readable so a 410 cannot disguise version checks. Edits
after maintenance must still invalidate approval. Fresh delta review and frozen
verification remain required.
