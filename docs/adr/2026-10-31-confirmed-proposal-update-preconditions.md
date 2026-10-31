---
status: accepted
date: 2026-10-31
area: [backend]
supersedes: []
superseded-by: null
---

# Check proposal update preconditions under write locks

## Context

[[2026-10-25-multi-step-proposal-envelope]] records the values shown to a person
before an update. Those values may become stale before confirmation. Comparing them
without coordinating with item and relation writers would leave a race after the check.
Some transforms add user-owned writes. Projects allocates a pin order under its own
database lock, so running its allocator as a preflight probe would take that lock
early and could predict a value that changes before the actual write.
This decision extends [[2026-10-29-item-pre-write-transforms-per-module-registry]] and
narrows its blanket purity assumption for the existing Projects allocator: actual
transaction-bound allocation is stateful; proposal preparation must remain read-only.

## Decision

Within the confirming transaction, lock the existing update items in sorted id order,
then acquire the relation-definition advisory keys in sorted id order. These are the
same keys used by the relation cardinality insert trigger. Lock existing incident
edges before comparing, including definitions named only in declared before values.
The advisory keys also protect an empty edge set from inserts;
the edge row locks coordinate with deletes. Immediately before each update compare
the changed properties, treating an absent property as null, and compare relation
targets as sets after rejecting duplicates. A mismatch returns a validation error
identifying the step and field and rolls back the confirmation.

Preflight validates every existing target through the relation choke point. When an
existing caller is supplied, only the identical persisted caller/definition/target
edge is excluded from the new-edge cardinality collision check; target, ownership,
database, tenant and hook checks still run. A caller-supplied before list is never
evidence that an edge exists. This check does not replace the locked confirmation
preconditions and does not claim to serialize preflight with concurrent writers.

Proposal validation uses registered read-only preparation alongside each write
transform. Preparation shares deterministic checks and normalization, receives no
database client, and runs neither mutation hooks nor allocators. A registered write
transform without a preparation fails proposal validation closed. Caller fields and
deterministically changed user-owned fields added by preparation need before and
matching after values; system-derived fields do not. Confirmation repeats preparation
under the item lock and checks every declared before value, including a key no longer
produced by preparation.

A module may declare a deferred allocation. Projects declares `pinnedOrder` only for
its implicit pin allocation: the proposal supplies its before value without predicting
the numeric after value, which must be absent. Explicit caller values and automatic clears require ordinary
coverage. The real write receives the original patch and allocates once using the
existing item lock followed by the Projects allocation advisory lock.

## Consequences

The precondition and its writes share the caller's transaction. These locks cover
the affected items and relation definitions; they do not impose a universal lock
order on other operations or guarantee freedom from deadlocks. Database deadlock
errors remain errors, and callers may retry the whole transaction.
Legacy multi-step updates lacking newly required user-field preconditions fail closed;
single-step proposals and ordinary direct writes retain their existing behavior.
