---
status: accepted
date: 2026-11-06
area: [backend]
supersedes: []
superseded-by: null
---

# Validate Semp refs against observed tenant state

## Context

Gh-1682 stores descriptive references to independently mutable objects. Its existence checks span items, mail attachments, agent runs, approval requests and Yjs blocks. Retaining every target until a message commits would introduce a cross-owner locking order after the existing Inbox/card/thread reservations. A document-loading write path can also compact state, which is unrelated to accepting a reference. The earlier [[2026-11-02-markdown-item-links-are-validated-by-tenant-write-owners]] covers a different consumer; its exception is not inherited here.

## Decision

Gh-1682 checks the submitted reference against tenant-visible state observed by its validation reads on the same managed transaction client that sends the message. This is a narrow exception to the state-writes row-reservation convention for descriptive reference admission only. It is not a permission, ownership, approval, idempotency or write-target guard. Those existing guards and their lock orders are unchanged.

Use the send transaction's existing READ COMMITTED behavior. Batch by kind, with at most 20 submitted references before deduplication. Conditions that define one referenced object's identity must be read together: item/database pair in one statement, transcript/database qualification in one statement, and document identity plus snapshot and ordered pending updates in one statement. The existing docsStore snapshot/update UNION read demonstrates the last shape; a narrowly scoped analogous document read may cover any existing document kind required by the block ref. Decode only the returned state in memory using existing block readers and destroy the temporary Y.Doc. Never create a document, call the locking/compacting loadDocWithClient, or repair document state for validation.

Do not take new target row/advisory locks or change isolation. The separate kind reads need not describe one common cross-kind snapshot. A deletion or reassignment committed after its read may precede the message commit, so a newly stored reference can already be unavailable. This is an accepted outcome, not a promise of referential integrity through commit. A change already visible to the check must be reflected in its result; missing, mismatched and foreign targets receive the same indexed validation refusal, and soft-deleted items remain valid. Refusal rolls back all send effects on messages, threads and jobs.

The reference confers no access. History resolution (gh-1684) and turn expansion (gh-1733) independently read in the caller's current tenant scope, handling unavailable targets according to their Tasks. No target content may be loaded with a system/admin client merely because an ID was once accepted. Malformed input and unsupported kinds fail before persistence.

## Alternatives and consequences

Rejected: cross-owner target reservations, serializable send retries, CRDT compaction during admission, or a new generic reference-integrity registry. These would broaden an ID-reference feature into a deletion/ownership protocol. The acceptance claim is point-in-time validation plus atomic refusal, not deletion exclusion.

Prove the normal kind/pair/foreign/random and no-effect cases through the actual HTTP owner. Add one bounded deletion-overlap control on the data-owner send path: deletion committed before the read is refused; deletion committed after a successful observation may leave an accepted unavailable ref. A strictly delegating SQL observer may provide the barrier, but no production read/write owner is replaced. Keep these observations distinct from a guarantee over all target kinds.
