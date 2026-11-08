---
status: accepted
date: 2026-11-06
area: [backend]
supersedes: []
superseded-by: null
---

# Speaker confirmation inserts missing participants without replacing metadata

## Context

Gh1671 adds an Events.people edge during human speaker confirmation. The ordinary createRelationWithClient intentionally replaces the full metadata on a repeated normalized edge. A read-before-create would erase invitation metadata if a concurrent user inserted the participant between those statements. [[2026-09-10-single-writer-ownership-model]] and [[2026-09-23-speaker-mappings-are-edges-proposed-on-transcript-cards]] keep relation writes at their owner and human confirmation as the authority. An extra domain lock would not coordinate ordinary writers.

## Decision

Add an internal createRelationIfAbsentWithClient sibling in relationOps.ts, not the public facade or index. Share existing relation context, ownership/archival/endpoint validation, normalization, write-hook checks and mutation/value-link admission. Add the narrow insert-if-absent operation to relationsStore.ts. Use the existing normalized unique tuple and INSERT ON CONFLICT DO NOTHING RETURNING. No DO UPDATE, copied private SQL in proposalActions, new locks, default behavior change or generic transport option.

A returned row means this call inserted the edge. Only then run the existing inserted-edge value-link effects, rollup work, changed-edge hooks and post-commit invalidation. A conflicting row means no metadata replacement by this helper; read the existing tuple in a fresh statement using its owner. If it is no longer visible because a concurrent deletion won, fail with the existing conflict contract and roll back confirmation instead of returning a fabricated edge, retrying indefinitely or overwriting it. Keep actual validation/admission checks on the conflicting path; no bypass of endpoint or owner restrictions is authorized. Admission reservations are not a claim that every unrelated writer takes an item lock.

The unique insertion decision defines only this operation's linearization. Ordinary later relation replacement/deletion retains its current semantics. Human confirm uses its real writer/acting user and no system override. Speaker edge, optional participant insertion and card status/history remain in the same managed transaction; any actual failure rolls them all back. Reconfirming an already confirmed card stays a no-write return.

Extend proposalHistory.ts with optional addedRelations on a confirm entry: an array of {edgeId, relationPropertyId, callerItemId, targetItemId}, all UUIDs. Record only the actually inserted extra Event edge, not an existing participant. Entries lacking this field keep parsing; older readers may ignore it. No schema migration, new history kind or textual pseudo-structure. Existing speaker-card idempotency/rejected/trashed rerun behavior and stored keys remain unchanged.

## Evidence and consequences

Use the existing transcript proposal integration owner with real user relation writers and deterministic overlap in both orders: user insertion holding metadata before confirmation, and confirmation insertion before user write. Verify actual held competitor identities, metadata preservation at the conflict decision, exact single edge, writer ownership, insertion-only effects, confirm history and rollback. A later ordinary write may deliberately replace metadata and is not a helper defect. Test the finite conflict/deletion branch if claimed. No claim of global serializability, universal liveness or a new relation ownership policy follows.
