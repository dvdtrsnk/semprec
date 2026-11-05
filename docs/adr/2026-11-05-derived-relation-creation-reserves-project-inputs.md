---
status: accepted
date: 2026-11-05
area: [backend]
supersedes: []
superseded-by: null
---

# Reserve project inputs while admitting a guarded manual relation creation

## Context

Gh-1662 refuses new manual area/company edges while a configured item has a
live project. Checking an unlocked graph in a transaction is insufficient:
a project INSERT can commit before the manual edge is written. Old manual
edges are expressly retained when a project is attached later, so this is an
ordering of creation admission, not a perpetual graph invariant.

Reuse the exact existing cardinality-trigger definition advisory reservation
as in [[2026-11-04-approval-relation-snapshots-reserve-inserts-and-existing-rows]].
That decision leaves ordinary writers unchanged; this standalone decision adds
a narrow exception for gh-1662's guarded manual creation. It does not change
its accepted body or the value-link admission owner. Transactions still belong
to [[2026-09-29-withtransaction-is-the-sole-transaction-opener]].

## Decision

A private choke-point derivedValueAdmission helper owns reservations only for
creating one of the configured manual relations. Determine both normalized
edge sides: the guarded item can be the target of an inverse call. Resolve its
project property/definition through existing typed tenant-scoped stores.
No new public lock API, table, trigger or shared all-writer gate is introduced.

Mutating admission requires the caller's managed READ COMMITTED transaction.
Check its actual isolation before reservations. A preexisting repeatable-read
or serializable snapshot cannot be refreshed by advisory locks, so refuse a
guarded mutation under those levels with ConflictError and fixed reason
unsupported_isolation, marking that managed invocation rollback-only. Do not
change isolation, open another transaction or promise fresh snapshot semantics.
Unaffected relation operations do not acquire this requirement.

Use existing tryLockRelationDefinition for both the addressed manual definition
and its project definition, deduplicated and sorted by normalized identity.
It uses the same transaction key as the INSERT/ON CONFLICT trigger. False is
busy; do not wait. Reserving the manual definition too prevents a later INSERT
from waiting for its cardinality key while holding the project key. Existing
ordinary project inserts, including inverse calls, participate through their
unchanged trigger, not a new application gate.

Reserve the addressed and project lookup metadata needed to identify these
inputs with FOR SHARE NOWAIT, then reread and check the identities. A changed
mapping is transient conflict, not permission to proceed under stale keys.
Reserve the guarded item, all its current project edges in deterministic order,
and every referenced project item, including trashed ones, with existing NOWAIT
row-lock helpers or narrow private typed queries. Use normalized stable item
identity order. Holding the project edge rows prevents concurrent unlink or
purge; holding the project items prevents trash or restore during the decision.
A missing historical endpoint is not a live project. No cross-tenant row is
looked up outside the trusted scope or inferred through a refusal.

After all reservations, execute a NEW READ COMMITTED statement to assess the
current graph. At least one not-trashed referenced project produces the existing
400 ValidationError with field area or company. If none exists, keep these
reservations through the actual manual edge INSERT and managed completion.
A project attached after this manual transaction is logically later and may
coexist with that retained old manual edge as the Task requires. Metadata,
project state and unrelated inputs are not claimed globally serialized.

A false advisory try-lock, changed reserved mapping or actual pg.DatabaseError
55P03 from these owned reservations is ConflictError with fixed reason
resource_busy. Mark the managed invocation rollback-only before throwing, so
catching the refusal after an earlier write cannot commit it. Preserve the
first failure under the existing managed owner, including across savepoint
rollback. Do not classify arbitrary objects, hook errors, timeouts, deadlocks
or other driver errors as busy. Do not modify lock/statement timeouts. A failed
statement remains failed; cleanup must not mask it with an aborted-transaction
query. No retry loop or compensation belongs in the helper.

loadCreatableRelationEdgeContext invokes the same semantic guard after endpoint
checks. Actual creation selects mutating admission. Proposal assertion/dry run
uses its supplied snapshot without reservations and promises only validation
of that snapshot; later confirmation always runs actual mutating admission.
Keep the exported assertNotDerivedValueWrite check usable in this read-only
mode, without requiring proposal reads to become writes or claiming a binding
future promise.

For relation.set changing to a non-null different target, run the creatable
checks/admission BEFORE deleting the old edge. The subsequent create reuses the
same transaction reservations. A same-target no-op, target-null deletion,
ordinary delete and metadata update do not introduce this creation guard.
Do not bypass value-link protected handoff/hooks, mutate existing manual edges,
change project writers, or touch generic item versions just for locking.

## Consequences

This deliberately uses coarse existing definition locks: unrelated items on
the same definitions can receive a transient busy result. Existing hash-key
collision limits remain; no global deadlock-freedom or arbitrary progress
claim is made. Infrastructure errors still abort under their existing policy.
The source tier becomes high for this bounded concurrency/transaction decision.

Prove actual ordinary project insertion in both orders and from inverse access,
actual trash/restore overlap, release after rollback, and progress on unrelated
scopes using captured backend identities and bounded barriers. Prove unchanged
old manual edges after later project attachment; deletion/metadata/no-op behavior;
set refusal before old-edge deletion; runtime-role tenant separation; dry-run
snapshot refusal; and fail-closed non-RC/caught-busy rollback. No third-party
service or production invocation is required. Preserve all original failures.
