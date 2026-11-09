---
status: accepted
date: 2026-11-10
area: [backend]
supersedes: []
superseded-by: null
---

# Task rollover preselects due series before locked recheck

## Context

An open recurring occurrence may be old while its next calendar date is still in the future. Counting such occurrences against the bounded sweep can hide later due work.

## Decision

The Tasks rollover uses a pure, invoker-scoped SQL predicate to select due candidates. It performs bounded calendar computations and rejects malformed rules. Selection does not reserve the series: the existing item-then-series transaction reads the current rule and recalculates the due date through the TypeScript recurrence owner before writing. An existing latest occurrence is reserved with the existing NOWAIT protocol in [[2026-11-09-nightly-recurring-occurrences-use-the-missed-status-handover]].

## Consequences

Nondue occurrences do not use the selected-item budget. The existing per-pass bound applies to selected work, not to the database optimizer's examined rows. Previously committed item transactions remain committed if a later one fails. The SQL and TypeScript date semantics need paired regression coverage when either rule implementation changes.
