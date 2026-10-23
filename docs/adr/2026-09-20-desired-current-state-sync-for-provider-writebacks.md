---
status: accepted
date: 2026-09-20
area: [backend]
supersedes: []
superseded-by: null
---

# Desired/current state sync for provider write-backs

## Context

User-owned Email flags are stored in Semprec but must converge with an external
mail provider. An after-commit provider call can be lost between commit and
execution, while an in-memory retry queue disappears on restart. A generic job
queue would add a second ownership and idempotency surface for each mutable
provider field.

## Decision

For a provider-backed user state that requires durable convergence, store the
desired value in the same transaction as the generic item mutation and store
the last provider-confirmed value separately. The sync owner lists rows where
the two values differ, performs every provider-edge write for that value, and
updates current state only after all writes succeed. Provider observations
update current state but never replace a differing desired value.

The desired/current gap is the durable pending-write queue. This pattern is
limited to provider-backed state with a single declared sync owner; it is not a
replacement for the generic choke point or for background jobs that do not
converge external mutable state.

## Consequences

Retries and restarts are idempotent because a confirmed value leaves the
pending set. A partial multi-edge provider write remains pending until all
copies succeed, so later reconciliation may safely repeat already-applied
writes. The additional durable state and explicit owner are required for each
new provider-backed write surface.
