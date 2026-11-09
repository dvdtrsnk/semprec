---
status: accepted
date: 2026-11-09
area: [backend]
supersedes: []
superseded-by: null
---

# Generic task recurrence patches use the series owner

## Context

[[2026-10-29-item-pre-write-transforms-per-module-registry]] composes domain transforms without importing domains into the choke point. [[2026-11-04-flagged-agent-writes-require-approval]] requires each flagged write to define its snapshot and replay. Task recurrence is a system-owned projection of a series and needs a controlled command rather than a direct field write.

## Decision

A module may register an update command and its pure validation alongside its transform. The generic write admits a command only for a matching module-owned system property on update; Tasks declares only `recurrence`. The command is consumed and the series owner returns generated fields for the enclosing item write. The item and its version are checked before the series is reserved. The owner locks item then series, defers an agent's change or end of an active series, and treats an identical command-only rule as a no-op. Creation and unrelated system fields remain forbidden.

A registered item-patch projection reserves the series after the item and contributes its identity, active state, mode, rule and task date to the approval snapshot. The approval description is derived from the same reservation. Existing approved-request replay rechecks that snapshot and retains the original input and version. Pure proposal preparation does not allocate or mutate a series; unsupported command preparation fails closed.

## Consequences

Human recurrence routes share the same series owner. A stale approval conflicts without changing the series. This coordination covers the registered command, not a general grant to write system properties or a global deadlock-freedom guarantee.
