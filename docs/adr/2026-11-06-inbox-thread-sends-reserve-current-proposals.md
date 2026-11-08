---
status: accepted
date: 2026-11-06
area: [backend]
supersedes: []
superseded-by: null
---

# Inbox thread sends reserve the source and its current proposal cards

## Context

Gh1620 rejects a send after the Inbox proposal is confirmed or rejected. A thread's nullable subject_proposal_id and a client-supplied proposalId are hints, not a current association proof. The supported association is Processing proposals.sourceInbox; several historical cards may exist, while soft-deleted cards are ignored by current proposal lookup.

Confirmation already reserves its proposal first and can then need the source. [[2026-11-01-inbox-fingerprint-inputs-locked-through-proposal-write]] forbids waiting for a proposal while holding that source. This record extends the same existing row-reservation protocol to message admission and sourceInbox association mutations. No epoch, advisory lock or generic retry framework is added.

## Decision

Keep one managed READ COMMITTED send transaction. For an item thread, use the existing Inbox source-row reservation and fresh statements to validate a live Inbox item in the tenant. Resolve all live Processing proposal cards through the actual sourceInbox relation owner APIs, in stable ID order. Lock each current card with the existing FOR UPDATE NOWAIT item reader. Re-read its current live status after reservation. Any current live associated card in confirmed/rejected makes this Inbox thread read-only with 409 proposal_locked.

A missing/foreign Inbox subject is the same 400 validation_failed. A supplied proposalId must identify a live card actually associated with that source; an unrelated, unknown or foreign ID is the same 400. A nullable or stale stored thread hint cannot bypass current association resolution. No relation to the JSON aiProposal field is inferred, no arbitrary first edge is trusted, and no second card is created by admission.

A busy card is not a decided card. Map only actual SQLSTATE 55P03 from the nonblocking reservation to existing ConflictError, 409 version_conflict, with a fixed safe message and subject field detail. Use the existing savepoint pattern to restore transaction usability before mapping; every other error propagates. Refusal rolls back the whole send, creating no thread/message/job. There is no automatic retry and no waiting on a card while holding the source.

For a reused thread ID, an initial unlocked tenant-scoped read may identify its Inbox source, but do not reserve the thread before the source/card admission. Then reserve/recheck the thread, including the same subject, before message writes. All item-thread sends follow source, nonblocking cards, thread order; chat/tick paths retain their own existing protocol.

Extend the existing Inbox domain pre-edge write/delete hook owner narrowly for Processing proposals.sourceInbox, from either caller direction. Every actual association insert/removal reserves the same Inbox source before changing the edge, so absence and the current card set stay stable through send commit. Keep nil proposed-item validation as a nonwrite skip. Propagate existing lockMode for nonblocking admissions. A removal may include a trashed source, and owned purge after source deletion must still remove edges instead of treating a gone source as permission to leave them behind. Do not change relation ownership, cardinality, generic writers or unrelated edge semantics.

These guards coordinate supported production item/card/association writers. They do not promise protection from arbitrary direct SQL or a global deadlock-free graph. Preserve the fingerprint writer's existing busy-card skip; this send path returns its distinct retryable conflict instead.

## Evidence

Use actual runtime-role source/card/relation/send owners with deterministic overlap in both relevant orders: confirmation holding a card versus send holding source; association insert/delete versus send, including an initially absent card; null and stale hints; decided, soft-deleted, unrelated, foreign and unknown cards; new/reused thread; rollback with no messages/jobs or invalidation. Observe actual holder/competitor identities and settle owned transactions. No mocked admission owner or artificial owner change is required.
