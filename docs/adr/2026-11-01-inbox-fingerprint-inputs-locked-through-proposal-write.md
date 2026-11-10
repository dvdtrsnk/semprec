---
status: accepted
date: 2026-11-01
area: [backend]
supersedes: []
superseded-by: null
---

# Hold Inbox fingerprint inputs stable through a computed proposal write

## Context

Gh-1606 compares a model request's source fingerprint with the source before
storing the answer. An unlocked repeatable-read check can miss a source,
attachment or type change that commits after that check. Locking the item alone
cannot cover attachment or type-edge writers that do not share its lock.
Moreover, an attachment writer can hold that row lock without updating its
MVCC tuple: a repeatable-read waiter can retain a snapshot from before the
writer committed.

This is a narrow extension of
[[2026-09-10-bracket-non-transactional-calls-with-staleness-checked-transactions]]
and [[2026-09-30-choke-point-domain-hooks-through-a-per-process-registry]].
The existing fingerprint contents and dispatch ownership are unchanged.

## Decision

Keep the tick's initial read transaction at repeatable read and its bounded
serialization-failure retry. Run only the post-model write transactions at read
committed, including recognition and final computation-failure branches. The
model call stays outside transactions. In each write transaction, lock the
source Inbox item FOR UPDATE before separate queries that read its current
properties, type edge and attachment hashes. Missing/deleted source or a
fingerprint mismatch skips the result. Hold the source lock through commit.

The attachment owner takes the same source lock before insertion/removal in the
same caller transaction. Mutation entrypoints use PoolClient, with production
and test callers opening a transaction; two independent Pool.query calls are
not a transaction. Insertion cannot create an attachment for a missing/foreign
source. A missing attachment removal remains a no-op. Permanent purge already
deletes/locks the source before dependent cleanup: delete-all must still remove
attachment rows after that owned source deletion, not skip because it is gone.
The previous no-source-lock concurrent insertion policy is narrowed: appenders
for one source now serialize and derive position after acquiring its lock.

Register narrow pre-write and pre-delete relation hooks for the Inbox module's
actual type property. They take the source lock before the edge mutation;
ordinary source-property updates and soft-delete/restore/hard-delete already
lock or update that item row. The type-edge hook skips the nil proposed-item placeholder before acquiring a
source lock. For existing callers, creatability validation may lock but performs
no state change, version bump, enqueue or speculative allocation.
Do not add type cardinality, decided-card validation or change-trigger enqueue
ownership assigned to later issues. Multi-source type deletion uses a stable
source-ID order for its own source acquisitions.

After locking the source, the post-model writer also protects the raw linked
type row with FOR SHARE, including a soft-deleted or unrecognized type.
FOR KEY SHARE is insufficient to block ordinary updates. Its live/deleted state
can change the recognized typeId even without changing the edge. Use a
nonblocking lock and skip a busy type, preserving the transaction on any NOWAIT
error. Shared type locks allow distinct sources using that type to proceed. Type names and otherwise-valid processing
configuration are not added to the v2 hash by this decision.

A tick holding the source must not wait for an existing proposal row: use a
nonblocking row lock and explicitly skip a busy card. Never interpret that
outcome as permission to create a second card. Preserve the existing locked,
changed, deleted and missing-card guards. This avoids the new source-to-card
wait cycle with confirmation, which already holds its proposal first.
File-from-attachment confirmation takes its source lock before its blob lock
and attachment removal, preserving source-before-blob order against purge.
The helper taking the source lock may be reused by these owners; generic
choke-point modules do not import Inbox domain code.

The source lock prevents coordinated source/attachment/type-edge mutations
from committing between the fresh check and this proposal write. Writer-first
waits must use fresh read-committed queries after lock acquisition; tick-first
writers wait for the tick transaction to settle. Busy-card/type skips are safe
nonwrites, not success claims about freshness or a promise to enqueue another
tick. The next invocation still uses the existing fingerprint gate. This is not
a global deadlock-freedom claim or a consistent snapshot of every destination
catalog or proposed target; existing target confirmation guards remain.

## Alternatives rejected

- Lock only the tick's source row. Uncoordinated attachment and edge mutations
  remain, and repeatable read can retain old attachment data after waiting.
- Add an epoch column/table or make attachment/type writers issue no-op item
  UPDATEs to force MVCC conflicts. This adds persisted state or hidden item
  writes where shared owner locks and a fresh statement snapshot suffice.
- Hold source locks across the gateway call, or serialize all tenants/items.
  Neither is necessary for this short per-source write-phase guard.
- Wait on proposal rows while holding the source. Confirmation can hold that
  card and need the same source; a busy-card skip avoids this introduced cycle.

## Consequences

The post-model phase no longer relies on one repeatable-read snapshot: it
relies on explicitly coordinated fingerprint-input locks and fresh statements.
Unrelated sources and tenants remain independent. All actual mutation callers
must retain one transaction and resource owner. No new retry framework,
migration, automatic heartbeat trigger or public result contract is introduced.

Use bounded production-path overlap tests with identified holder/competitor
PIDs and complete settlement. Cover writer-first and tick-first property,
attachment insert/remove and type-edge changes; raw-type delete/restore and
busy-card/type skip controls; same-source appends; confirm/purge lock order and
rollback. Keep unchanged/foreign-tenant positive and refusal controls. Retain
any pre-fix negative control separately; a defect-asserting pass is not a fix
verification. Independent review and clean-candidate gates decide acceptance.
