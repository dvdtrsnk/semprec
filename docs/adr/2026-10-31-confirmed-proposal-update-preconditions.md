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

## Decision

Within the confirming transaction, lock the existing update items in sorted id order,
then acquire the relation-definition advisory keys in sorted id order. These are the
same keys used by the relation cardinality insert trigger. Lock existing incident
edges before comparing. The advisory keys also protect an empty edge set from inserts;
the edge row locks coordinate with deletes. Immediately before each update compare
the changed properties, treating an absent property as null, and compare relation
targets as sets after rejecting duplicates. A mismatch returns a validation error
identifying the step and field and rolls back the confirmation.

## Consequences

The precondition and its writes share the caller's transaction. These locks cover
the affected items and relation definitions; they do not impose a universal lock
order on other operations or guarantee freedom from deadlocks. Database deadlock
errors remain errors, and callers may retry the whole transaction.
