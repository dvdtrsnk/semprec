---
status: accepted
date: 2026-11-04
area: [backend]
supersedes: []
superseded-by: null
---

# Reserve relation snapshot inputs before approved execution

## Context

Gh-1713 adds approval snapshots for relation.put and relation.set. An item-row lock does not serialize ordinary relation.put writers: item_relations has no endpoint-item foreign key and ordinary edge writes do not acquire that caller lock. The existing 0013 cardinality BEFORE INSERT trigger does acquire a transaction advisory keyed by hashtextextended(definition_id::text, 0), including INSERT ON CONFLICT. Existing edge UPDATE and DELETE acquire their own row locks but not that advisory.

This extends [[2026-09-18-exactly-once-execution-of-approved-destructive-operations]] for these two snapshot kinds. It preserves ordinary writers and the protected value-link protocol in [[2026-11-01-value-link-relations-use-nonblocking-admission-and-scoped-lock-waits]]. It introduces no alternative edge writer, trigger, schema or lock key.

## Decision

Only the dedicated relation approval projection reserves its read set, on its exact active managed client under a real tenant scope and READ COMMITTED. Reject unsupported ownership/scope/isolation rather than imply a fresh view. Load and authorize visible relation context first; unknown/foreign resources retain normal indistinguishable refusal.

1. Use the existing tryLockRelationDefinition to acquire the EXACT transaction advisory used by the cardinality trigger, nonblocking. False is transient busy. This prevents every supported INSERT/ON CONFLICT on that definition from committing between the accepted projection and the approved mutation. It is reentrant when the same client later executes the ordinary writer.
2. Acquire required metadata rows with FOR SHARE NOWAIT: the addressed property, its definition and the two databases used by the projection/authorization. Re-read the existing typed context after reservation. A vanished row is its ordinary domain refusal; if the initially discovered definition/endpoints changed before reservation, abort the attempt for a fresh complete retry rather than proceed under the wrong reservation.
3. Reserve the source and explicit target item rows with the existing NOWAIT item helper. For relation.set, also reserve existing old endpoint rows that the mutation's unlink/link side effects can touch; a missing historical old endpoint keeps the unlink owner's existing tolerance. A missing/deleted source or requested target remains a domain refusal. Use stable normalized identity order for multi-row acquisition.
4. Lock the current source edge set with an internal relationsStore query using deterministic id order and FOR UPDATE NOWAIT. Hash the fresh normalized projection only after these reservations. Edge UPDATE/DELETE, including inverse calls and supported bulk cleanup/cascade, then conflicts with the physical row locks; newly inserted edges are excluded by the existing cardinality advisory. Keep the exact side filtering and runtime row validation. No public lock helper is exported.

Locks last until this managed transaction ends. Preflight holds them only through snapshot/request insertion; no lock is held during the human decision. Replay reacquires them before checking the persisted snapshot and holds them through its one approved mutation and terminal write.

A dedicated ApprovalResourceBusyError has status 409, code approval_resource_busy, fixed message Approval resource is busy and no dynamic details. Only a false admission and an actual pg.DatabaseError 55P03 from the narrowly owned NOWAIT reservations select it. Mark the managed invocation rollback-only before raising it, preserving the first failure. Do not map arbitrary objects, messages, failures from hooks/queues or 40P01/57014/other driver errors to busy. Do not change session/transaction timeouts or clear rollback-only state.

Busy is not a terminal resource conflict: preflight propagates it with no request insert; the replay's pre-mutation domain-error catch explicitly rethrows it, so the entire attempt rolls back and the already-approved request remains queued. Existing queue retry owns a later fresh attempt. There is no internal retry, savepoint, compensation, new transaction or success acknowledgment. Actual drift or authorization refusal remains terminal conflict before mutation. Mutation-stage failures keep the already-decided full rollback semantics.

## Consequences

Ordinary relation put/update/delete/set, cardinality trigger, internal value-link admissions and callback ownership remain unchanged. Do not add definition locks to ordinary metadata/delete paths, require every caller to acquire a new shared gate or weaken protected nonblocking behavior. A rare approved operation temporarily excludes all inserts on its definition; a contended approval can be refused/starved rather than waiting while holding unrelated locks. Distinct definitions normally retain their existing independence; the existing 64-bit hash's collision limitation is unchanged.

This is a reservation of the declared snapshot inputs, not a universal application lock hierarchy or a claim of global deadlock freedom. Any unreserved input added to a projection needs its own justified reservation. Infrastructure errors retain their identity and cause whole rollback. Accepted ADR bodies remain historical and unchanged.

Verify real ordinary INSERT/ON CONFLICT, metadata UPDATE and DELETE overlapping the actual approved executor in both orders, including normalized inverse access. Show the competing actual backend and blocking or immediate busy outcome as appropriate; after ordinary commit, retry must conflict on changed input without approved mutation. After an approved commit, the contender has its logically later normal result. Cover rollback/retry release, unrelated tenant/definition progress and the existing protected value-link busy semantics. Assert persisted edge identity/metadata, request/outcome, actual jobs and committed/rolled-back callbacks; do not infer serialization from a caller lock alone.
