---
status: accepted
date: 2026-11-01
area: [backend]
supersedes: []
superseded-by: null
---

# Capture server preconditions when forming computed update proposals

## Context

Gh-1492 lets the model propose an update inside a multi-step answer. The model
receives bounded IDs and names, not the current property and relation values.
Consequently it cannot provide trustworthy `before` values. Rejecting every
update would leave that operation unusable; inventing preconditions or relaxing
confirmation would defeat
[[2026-10-31-confirmed-proposal-update-preconditions]].

This decision extends that record and
[[2026-11-01-bounded-workspace-ids-for-inbox-proposals]] for fresh computed
proposals only. The ordinary-envelope rejection of a lone update/link remains.

## Decision

In the tick's post-model transaction, after source freshness and result-membership
checks, prepare accepted computed update steps before envelope validation and
card storage. A private data helper may read the at-most-six existing item IDs
in those steps under the current tenant. It performs no target writes, gateway
calls, write hooks, allocators or new locking. Missing, foreign, deleted,
archived or otherwise unsupported targets produce `needsClarification` through
the existing validation path. This is not authority to expand the model context.

Capture current values for every requested user-property key, treating absence
as null, and current target sets for changed relations in both edge directions.
Keep the original requested patch. Use the existing read-only
`prepareUserItemPatch` path to identify deterministic transform-added user keys
and matching `after` values. Capture deferred-allocation keys in `before` but
never predict their numeric `after`; Projects' implicit `pinnedOrder` allocation
still runs once only at the actual write. A relation-only update skips property
preparation. System-derived keys are not user-authored preconditions.

The server forms these values from its own reads, never from a model-supplied
baseline. They describe proposal formation after the gateway call, not a
transaction held open across that call or a historical model-request snapshot.
Before/after values are stored on the card for review, not sent back to the
model. This helper does not regenerate preconditions on manual revise, stored
card revalidation or confirm.

Repeated mutation steps for the same existing item are rejected to clarification;
this change adds no simulator of sequential intermediate target states.
Existing alias, graph, ownership and cardinality validation remains in force.
Confirmation still takes its established locks, repeats preparation and checks
the stored preconditions immediately before writing. A concurrent target change
after formation can therefore reject confirmation; unlocked drafting is not
represented as serialization with target writers.

## Alternatives rejected

- Trust model `before` values or omit them. The model did not read the baseline.
- Reject all multi-step updates indefinitely. That leaves a declared operation
  unusable although its server baseline is available.
- Hold target locks over gateway I/O or run actual transforms as probes. The
  existing preparation contract deliberately avoids these locks and allocators.
- Refresh stored baselines on confirm. That silently approves intervening changes.

## Consequences

Valid bounded multi-step updates become executable without weakening stale-write
guards or disclosing more records to the model. Tests must exercise actual
computation/tick storage and guarded confirm, late edits, relation baselines,
deterministic transform additions, deferred allocation without a prediction,
unsupported targets and no target writes during formation. This decision does
not add card-editor project moves, undo, duplicate merging or a new lock order.
